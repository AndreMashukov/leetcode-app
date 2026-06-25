/**
 * DDB stream → EventBridge trigger for ProblemsTable.
 *
 * The DDB stream is the SOLE producer of ProblemCreated / ProblemDeleted
 * events on the bus. Mirrors pastebin-author-bff's src/trigger.ts.
 *
 * Why a single producer (design §6):
 *   - One event per row mutation, regardless of write source
 *     (handler, admin tool, backfill script).
 *   - Idempotency: the trigger is wired with batchSize=1 via the
 *     filterPatterns + ReportBatchItemFailures response type, so a
 *     partial batch failure surfaces only the failed items and the
 *     rest are checkpointed.
 *   - DDB stream ordering is per-shard; we use the existing
 *     shard-key (problemId partition) so events for the same problem
 *     arrive in order at downstream listeners (submissions-bff).
 *
 * What we emit:
 *   - INSERT (NEW_IMAGE)         -> ProblemCreated
 *   - REMOVE (OLD_IMAGE)         -> ProblemDeleted
 *   - MODIFY is filtered out at the EventSourceMapping level — we
 *     don't update problems at v1; if v1.1 adds edits, wire a
 *     ProblemUpdated event.
 *
 * Source identity:
 *   - id: "<problemId>:<streamRecordId>" -- unique per event, lets
 *     downstream listeners dedupe without an external KGS.
 *   - time: DDB stream event approximateCreationDateTime (ISO-8601).
 *
 * SDK quirk (workaround):
 *   EventBridge PutEvents accepts `EventBusName` per entry at RUNTIME,
 *   but @aws-sdk/client-eventbridge@3.1070.0's TypeScript types do NOT
 *   declare it on PutEventsRequestEntry (confirmed by inspecting
 *   dist-types/models/models_0.d.ts and an empirical
 *   `aws events put-events` call from boto3 which succeeded with
 *   `EventBusName: <bus>` per entry). We cast each entry to `any` to
 *   attach the field at build time. The runtime API has accepted
 *   per-entry EventBusName since EventBridge GA; the SDK type was
 *   simply never updated. See aws/aws-sdk-js-v3#3714 for the related
 *   (but distinct) issue.
 */

import type { DynamoDBStreamEvent, DynamoDBRecord, Context } from "aws-lambda";
import {
  EventBridgeClient,
  PutEventsCommand,
  type PutEventsRequestEntry,
} from "@aws-sdk/client-eventbridge";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";

import type {
  ProblemEvent,
  ProblemRow,
  ProblemEventType,
} from "./models/problem";

const eb = new EventBridgeClient({});
const _busNameEnv = process.env.BUS_NAME;
if (!_busNameEnv) throw new Error("Missing required env var: BUS_NAME");
// Narrowed once at module load — subsequent uses are typed `string`.
const BUS_NAME: string = _busNameEnv;

const SOURCE = "leetcode.problems-bff";
const DETAIL_TYPE_CREATED: ProblemEventType = "ProblemCreated";
const DETAIL_TYPE_DELETED: ProblemEventType = "ProblemDeleted";

/** Per-entry bus-name payload — the TS type is missing this field. */
type EntryWithBus = PutEventsRequestEntry & { EventBusName: string };

export async function handle(
  event: DynamoDBStreamEvent,
  _ctx: Context,
): Promise<void> {
  const entries: EntryWithBus[] = [];

  for (const record of event.Records ?? []) {
    const entry = toEntry(record);
    if (entry) entries.push(entry);
  }

  if (entries.length === 0) return;

  // PutEvents batches up to 10 entries per call. For a typical
  // DDB stream batch (batchSize=10 from the EventSourceMapping) we
  // fit in one call. If a batch is larger we chunk.
  for (let i = 0; i < entries.length; i += 10) {
    const chunk = entries.slice(i, i + 10);
    await eb.send(
      new PutEventsCommand({
        Entries: chunk as unknown as PutEventsRequestEntry[],
      }),
    );
  }
}

function toEntry(record: DynamoDBRecord): EntryWithBus | null {
  // Only emit on INSERT (create) and REMOVE (delete). MODIFY is
  // filtered out at the EventSourceMapping level but we double-check
  // here defensively.
  if (record.eventName === "INSERT") {
    const row = record.dynamodb?.NewImage
      ? (unmarshall(record.dynamodb.NewImage as Record<string, AttributeValue>) as ProblemRow)
      : null;
    if (!row || !row.problemId) return null;
    const detail: ProblemEvent = {
      problemId: row.problemId,
      slug: row.slug,
      authorSub: row.authorSub,
      title: row.title,
      difficulty: row.difficulty,
      tags: row.tags,
      createdAt: row.createdAt,
    };
    return {
      Source: SOURCE,
      DetailType: DETAIL_TYPE_CREATED,
      Detail: JSON.stringify(detail),
      EventBusName: BUS_NAME,
      Resources: [],
    };
  }

  if (record.eventName === "REMOVE") {
    const row = record.dynamodb?.OldImage
      ? (unmarshall(record.dynamodb.OldImage as Record<string, AttributeValue>) as ProblemRow)
      : null;
    if (!row || !row.problemId) return null;
    const detail: Pick<
      ProblemEvent,
      "problemId" | "slug" | "authorSub" | "createdAt"
    > = {
      problemId: row.problemId,
      slug: row.slug,
      authorSub: row.authorSub,
      createdAt: row.createdAt,
    };
    return {
      Source: SOURCE,
      DetailType: DETAIL_TYPE_DELETED,
      Detail: JSON.stringify(detail),
      EventBusName: BUS_NAME,
      Resources: [],
    };
  }

  // MODIFY or any other eventName -- emit nothing at v1.
  return null;
}
