/**
 * REST handlers for leetcode-submissions-bff.
 *
 * Routes (all JWT-required):
 *   POST /problems/{slug}/submission   submitSolution
 *   GET  /me/submissions                listMySubmissions
 *   GET  /health                        health
 *
 * Conventions:
 *   - All responses are JSON with the canonical envelope:
 *       success → { ok: true, ...data }
 *       failure → { error: string, message: string }
 *   - Status codes follow REST: 202 (accepted) for async submit,
 *     200 for reads, 400 for bad body, 401/403 for auth, 404 for
 *     unknown problems, 500 only for unexpected runtime errors.
 */

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
} from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { ulid } from "ulid";

import { parseJsonBody, requireClaims, requireSlug } from "../lib/lookup.js";
import type {
  Language,
  SubmissionAccepted,
  SubmissionRow,
  SubmissionStatus,
  SubmissionSummary,
  SubmissionWorkMessage,
} from "../models/submission.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});

const SUBMISSIONS_TABLE = process.env.SUBMISSIONS_TABLE ?? "";
const WORK_QUEUE_URL = process.env.WORK_QUEUE_URL ?? "";
const PROBLEMS_TABLE = process.env.PROBLEMS_TABLE ?? "";

if (!SUBMISSIONS_TABLE) {
  throw new Error("Missing required env var: SUBMISSIONS_TABLE");
}
if (!WORK_QUEUE_URL) {
  throw new Error("Missing required env var: WORK_QUEUE_URL");
}
if (!PROBLEMS_TABLE) {
  throw new Error("Missing required env var: PROBLEMS_TABLE");
}

// --- validation ---

const ALLOWED_LANGUAGES: ReadonlySet<string> = new Set<Language>([
  "python",
  "javascript",
]);

/** Design §9: 64 KiB max code (interpreted languages only). */
const MAX_CODE_BYTES = 64 * 1024;

function isLanguage(v: unknown): v is Language {
  return typeof v === "string" && ALLOWED_LANGUAGES.has(v);
}

function byteLengthUtf8(s: string): number {
  // TextEncoder is fine here; we only run in Node20 Lambda.
  return new TextEncoder().encode(s).byteLength;
}

/** Build a JSON response. */
function json(
  statusCode: number,
  body: unknown,
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

// --- handlers ---

export const health = async (): Promise<APIGatewayProxyResultV2> => {
  return json(200, {
    ok: true,
    service: "leetcode-submissions-bff",
  });
};

/**
 * POST /problems/{slug}/submission
 *
 * Body: { language: "python"|"javascript", code: string }
 * 202: { submissionId, statusUrl, status: "PENDING" }
 * 400: missing/invalid fields, code > 64 KiB
 * 401: no JWT (handled by the API Gateway authorizer)
 * 404: problem with the given slug does not exist
 *
 * Flow:
 *   1. Validate body (language enum, code present + ≤ 64 KiB).
 *   2. Look up the problem by slug (Query GSI1 by slug — the
 *      problems-bff table stores slug in the GSI1pk so this is
 *      a single Query, not a Scan).
 *   3. Build the SubmissionRow.
 *   4. PutItem the row (status=PENDING, gsi2pk unset).
 *   5. SendMessage to the work queue with the routing fields.
 *   6. Return 202 with statusUrl pointing at status-bff.
 */
export const submitSolution = async (
  event: APIGatewayProxyEventV2,
  _ctx: Context,
): Promise<APIGatewayProxyResultV2> => {
  const claims = requireClaims(event);
  const slug = requireSlug(event);
  const body = parseJsonBody<{
    language?: unknown;
    code?: unknown;
  }>(event);

  // --- validate ---
  const language = body.language;
  const code = body.code;
  if (!isLanguage(language)) {
    return json(400, {
      error: "bad_request",
      message: `field "language" must be one of: ${Array.from(ALLOWED_LANGUAGES).join(", ")}`,
    });
  }
  if (typeof code !== "string" || code.length === 0) {
    return json(400, {
      error: "bad_request",
      message: `field "code" must be a non-empty string`,
    });
  }
  const codeBytes = byteLengthUtf8(code);
  if (codeBytes > MAX_CODE_BYTES) {
    return json(413, {
      error: "code_too_large",
      message: `code is ${codeBytes} bytes; limit is ${MAX_CODE_BYTES}`,
    });
  }

  // --- look up the problem by slug ---
  // problems-bff exposes gsi3 = slugKey for cross-stack callers.
  // Projection is KEYS_ONLY — we GetItem on the base table for the
  // difficulty snapshot (denormalized into the submission row).
  const slugLookup = await ddb.send(
    new QueryCommand({
      TableName: PROBLEMS_TABLE,
      IndexName: "gsi3",
      KeyConditionExpression: "slugKey = :pk",
      ExpressionAttributeValues: {
        ":pk": `SLUG#${slug}`,
      },
      Limit: 1,
    }),
  );
  const slugRow = slugLookup.Items?.[0] as
    | { pk?: string; sk?: string }
    | undefined;
  if (!slugRow?.pk || !slugRow.sk) {
    return json(404, {
      error: "not_found",
      message: "problem not found",
    });
  }
  const problemFetch = await ddb.send(
    new GetCommand({
      TableName: PROBLEMS_TABLE,
      Key: { pk: slugRow.pk, sk: slugRow.sk },
      ConsistentRead: false,
    }),
  );
  const problem = problemFetch.Item as
    | { problemId?: string; slug?: string; difficulty?: string }
    | undefined;
  if (!problem?.problemId) {
    return json(404, {
      error: "not_found",
      message: "problem not found",
    });
  }

  // --- build row ---
  const submissionId = ulid();
  const submittedAt = new Date().toISOString();
  const row: SubmissionRow = {
    pk: `SUB#${submissionId}`,
    sk: "META",
    submissionId,
    userId: claims.sub,
    problemId: problem.problemId,
    problemSlug: slug,
    problemDifficulty:
      (problem.difficulty as SubmissionRow["problemDifficulty"]) ?? "easy",
    language,
    code,
    status: "PENDING" as SubmissionStatus,
    submittedAt,
    gsi1pk: `USER#${claims.sub}`,
    gsi1sk: submittedAt,
    // gsi2pk intentionally unset: PENDING rows are not sparse-indexed
    // because no worker is racing for them. Workers set gsi2pk on the
    // PENDING->RUNNING transition.
  };

  // --- persist + enqueue ---
  await ddb.send(
    new PutCommand({
      TableName: SUBMISSIONS_TABLE,
      Item: row,
      // Idempotency at the row level: the pk is unique per ULID,
      // so a duplicate POST with the same body would either be
      // a network retry (rare; we don't expose request-level
      // idempotency keys at MVP) or a client bug. We let the
      // second PutItem win — it would just be the user's second
      // submission, which is what they asked for.
    }),
  );

  const workMessage: SubmissionWorkMessage = {
    submissionId,
    problemId: problem.problemId,
    userId: claims.sub,
    language,
    submittedAt,
  };
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: WORK_QUEUE_URL,
      MessageBody: JSON.stringify(workMessage),
      // Standard queue — no MessageDeduplicationId / MessageGroupId.
      // (Those are FIFO-only fields; the standard queue rejects them.)
      // Idempotency is enforced downstream by workers (conditional
      // UpdateItem on status=PENDING) — see README.
    }),
  );

  const accepted: SubmissionAccepted = {
    submissionId,
    // The API endpoint of THIS stack. status-bff shares the same
    // host at MVP since both are deployed in the same account and
    // region; the path is what disambiguates.
    statusUrl: `/submissions/${submissionId}/status`,
    status: "PENDING",
  };
  return json(202, { ok: true, ...accepted });
};

/**
 * GET /me/submissions
 *
 * Lists the caller's submissions, newest first. Query on gsi1
 * (USER#<sub>), no Filter — projection ALL keeps the row intact
 * and we strip `code` in the projection below.
 *
 * 200: { count, items: SubmissionSummary[] }
 */
export const listMySubmissions = async (
  event: APIGatewayProxyEventV2,
  _ctx: Context,
): Promise<APIGatewayProxyResultV2> => {
  const claims = requireClaims(event);
  const items = await ddb.send(
    new QueryCommand({
      TableName: SUBMISSIONS_TABLE,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: {
        ":pk": `USER#${claims.sub}`,
      },
      ScanIndexForward: false, // newest first
      Limit: 50,
    }),
  );
  const rows = (items.Items ?? []) as SubmissionRow[];
  const summaries: SubmissionSummary[] = rows.map((r) => ({
    submissionId: r.submissionId,
    problemId: r.problemId,
    problemSlug: r.problemSlug,
    problemDifficulty: r.problemDifficulty,
    language: r.language,
    status: r.status,
    submittedAt: r.submittedAt,
    startedAt: r.startedAt,
    acceptedAt: r.acceptedAt,
    resultSummary: r.resultSummary,
    // Deliberately omits `code`. Listing source code across the
    // user's history is a leak we'd never want a list endpoint
    // to have — clients fetch the row by id if they want it.
  }));
  return json(200, { count: summaries.length, items: summaries });
};
