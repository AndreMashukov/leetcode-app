/**
 * REST handlers for leetcode-status-bff.
 *
 * Routes (all JWT-required):
 *   GET /health                                    health
 *   GET /submissions/{submissionId}/status         getStatus
 *
 * Design notes:
 *
 * 1. Ownership check (design §547): before returning any row we
 *    verify `row.userId === jwt.sub`. On mismatch we return 404
 *    rather than 403 so callers cannot probe for the existence of
 *    other users' submissions by guessing ULIDs.
 *
 * 2. No projection — we read the full row. The ownership field
 *    (`userId`) must be present and we save a round trip by reading
 *    the verdict fields in the same GetItem. Wire-level shaping
 *    happens at the response builder so the field set we return to
 *    the client can change without changing the IAM grant.
 *
 * 3. No bus subscription. Workers mutate the row directly; this
 *    stack polls DDB. (See serverless.yml header for the rationale.)
 */

import type { APIGatewayProxyResult, APIGatewayProxyEventV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

import type {
  SubmissionRow,
  SubmissionStatusResponse,
  SubmissionStatus,
} from "../models/submission.js";
import { getRequesterSub } from "./lib/auth.js";

// --- env ---------------------------------------------------------------------

const SUBMISSIONS_TABLE = process.env.SUBMISSIONS_TABLE;
if (!SUBMISSIONS_TABLE) {
  throw new Error("SUBMISSIONS_TABLE env var is required");
}

// --- DDB client (module-scoped, reused across invocations) -------------------

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

// --- helpers -----------------------------------------------------------------

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function isTerminal(status: SubmissionStatus): boolean {
  return (
    status === "ACCEPTED" ||
    status === "WRONG_ANSWER" ||
    status === "TIMEOUT" ||
    status === "RUNTIME_ERROR" ||
    status === "COMPILE_ERROR"
  );
}

/**
 * Map a DDB row to the wire shape. Pure function — kept module-level
 * so it can be unit-tested without standing up a handler.
 */
export function rowToResponse(row: SubmissionRow): SubmissionStatusResponse {
  const resp: SubmissionStatusResponse = {
    submissionId: row.submissionId,
    status: row.status,
    submittedAt: row.submittedAt,
  };
  if (row.startedAt) resp.startedAt = row.startedAt;
  if (row.acceptedAt) resp.acceptedAt = row.acceptedAt;
  if (row.resultSummary) resp.resultSummary = row.resultSummary;
  // Only expose logUrl on terminal-failure paths. ACCEPTED runs have
  // nothing useful in the log.
  if (
    row.s3LogKey &&
    row.status !== "ACCEPTED" &&
    isTerminal(row.status)
  ) {
    // v1: client requests a signed URL via a separate endpoint
    // (presigned-bff, future work). For now we return the key so
    // the client can render a "logs coming soon" placeholder.
    resp.logUrl = `s3://leetcode-submissions-logs/${row.s3LogKey}`;
  }
  return resp;
}

// --- handlers ----------------------------------------------------------------

export async function health(): Promise<APIGatewayProxyResult> {
  return json(200, {
    ok: true,
    service: "leetcode-status-bff",
  });
}

export async function getStatus(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResult> {
  // --- 1. path param validation ---------------------------------------------
  const submissionId = event.pathParameters?.submissionId;
  if (!submissionId || !/^[A-Za-z0-9_-]{8,40}$/.test(submissionId)) {
    return json(400, {
      error: "bad_request",
      message: "submissionId must be 8-40 chars of [A-Za-z0-9_-]",
    });
  }

  // --- 2. resolve requester from JWT ---------------------------------------
  const sub = getRequesterSub(event);
  if (!sub) {
    // Should never happen — the authorizer would have rejected first —
    // but a defensive 401 keeps the handler honest if JWT shape changes.
    return json(401, { error: "unauthorized", message: "missing sub claim" });
  }

  // --- 3. read the row -----------------------------------------------------
  const got = await ddb.send(
    new GetCommand({
      TableName: SUBMISSIONS_TABLE,
      Key: { pk: `SUB#${submissionId}`, sk: "META" },
      ConsistentRead: false,
    }),
  );
  const row = got.Item as SubmissionRow | undefined;
  if (!row) {
    return json(404, {
      error: "not_found",
      message: "submission not found",
    });
  }

  // --- 4. ownership check (404, not 403, to avoid existence leak) -----------
  if (row.userId !== sub) {
    return json(404, {
      error: "not_found",
      message: "submission not found",
    });
  }

  // --- 5. shape and return -------------------------------------------------
  return json(200, rowToResponse(row));
}
