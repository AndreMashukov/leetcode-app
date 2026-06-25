/**
 * REST handlers for leetcode-problems-bff.
 *
 * Five routes (HTTP API, version 2):
 *   POST /problems         createProblem         Cognito JWT required (author)
 *   GET  /me/problems      listMyProblems        Cognito JWT required (author)
 *   GET  /problems         listProblems          Cognito JWT required (any user)
 *   GET  /problems/{slug}  getProblemBySlug      public
 *   GET  /health           health                public
 *
 * Handler does NOT call PutEvents directly. The DDB stream + trigger
 * lambda is the SOLE producer of ProblemCreated / ProblemDeleted on the
 * bus (design §6). Mirrors pastebin-author-bff's pattern.
 *
 * Cognito JWT shape (from the auto-generated authorizer):
 *   requestContext.authorizer.jwt.claims.sub      <-- cognito sub
 *   requestContext.authorizer.jwt.claims.email    <-- email (verified)
 *
 * Authoring model:
 *   - Anyone authenticated can author a problem (no admin role in v1).
 *   - GET /me/problems returns the caller's authored problems via GSI1.
 *   - GET /problems returns ALL problems (paginated, optional tag filter)
 *     — open browsing like LeetCode's problem list.
 *   - GET /problems/{slug} is public; URL space is unguessable enough
 *     (8-char id, server-minted) that we don't rate-limit at v1.
 *
 * Slug uniqueness:
 *   Slugs are user-chosen and we don't have a separate `slug` GSI in
 *   v1. The PutItem uses `attribute_not_exists(pk)` (the unique
 *   problemId is server-generated) but does NOT enforce slug
 *   uniqueness. Two authors can race to claim the same slug; the
 *   second one will win because PutItem will succeed (the row keys
 *   differ). In v1 we accept this — admins can resolve manually.
 *   v1.1 adds a `slug` GSI with conditional Put.
 */

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2,
  APIGatewayProxyEventV2WithRequestContext,
} from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

import { generateProblemId, isProblemId } from "../lib/problemId";
import type {
  Difficulty,
  ProblemDetail,
  ProblemExample,
  ProblemRow,
  ProblemSummary,
} from "../models/problem";

const ddb = new DynamoDBClient({});
const ddbDoc = DynamoDBDocumentClient.from(ddb, {
  marshallOptions: { removeUndefinedValues: true },
});

// ─── types ───────────────────────────────────────────────────────
// Same shape as pastebin-author-bff/src/rest/handlers.ts.
// APIGatewayProxyHandlerV2's `requestContext` does not declare an
// `authorizer` field in @types/aws-lambda because that's authorizer-
// specific. We declare the augmented shape we expect from the HTTP API
// + Cognito JWT authorizer configured in serverless.yml.
type CognitoClaims = Record<string, string | undefined>;
type JwtAuthorizer = { jwt: { claims: CognitoClaims } };
type AuthorizedRequest = APIGatewayProxyEventV2WithRequestContext<
  APIGatewayProxyEventV2["requestContext"] & { authorizer?: JwtAuthorizer }
>;

const TABLE_NAME = process.env.TABLE_NAME;
if (!TABLE_NAME) throw new Error("Missing required env var: TABLE_NAME");

/** Max problem description size in bytes (design §3). */
const MAX_DESCRIPTION_BYTES = 64 * 1024;

/** Slug regex — kebab-case, 3–80 chars, alphanumeric + hyphens. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/;

/** Allowed difficulty values (mirrors models/problem.ts Difficulty). */
const ALLOWED_DIFFICULTY: ReadonlySet<string> = new Set(["easy", "medium", "hard"]);

/** Max tags per problem. Keeps GSI2 fanout bounded. */
const MAX_TAGS = 8;

/** Max tag length. */
const MAX_TAG_LEN = 32;

/** Max examples per problem. */
const MAX_EXAMPLES = 10;

/** Max constraints strings per problem. */
const MAX_CONSTRAINTS = 20;

/** Max examples/constraints string length. */
const MAX_EXAMPLE_FIELD_LEN = 4096;
const MAX_CONSTRAINT_LEN = 512;

/** Default page size for list endpoints. */
const DEFAULT_PAGE_SIZE = 25;
/** Max page size — hard ceiling so we don't paginate half the table. */
const MAX_PAGE_SIZE = 100;

/** JWT body fields explicitly REJECTED at MVP (design §3).
 *
 *  - `problemId`, `id`, `key`: server-generated, not user-settable.
 *  - `createdAt`, `authorSub`: server-set from JWT sub and clock.
 *
 *  Slugs ARE user-chosen (and validated below). The server does not
 *  enforce uniqueness at v1; v1.1 swaps the unconditional Put for
 *  a slug-keyed GSI conditional check.
 */
const REJECTED_FIELDS = [
  "problemId",
  "id",
  "key",
  "createdAt",
  "authorSub",
] as const;

// ─── POST /problems ──────────────────────────────────────────────

export const createProblem: APIGatewayProxyHandlerV2 = async (event) => {
  const req = event as AuthorizedRequest;
  const sub = req.requestContext.authorizer?.jwt.claims.sub;
  if (!sub) {
    return json(401, { error: "unauthorized", message: "missing sub claim" });
  }

  const raw = event.body;
  if (!raw) {
    return json(400, { error: "bad_request", message: "missing body" });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "bad_request", message: "invalid JSON" });
  }

  for (const f of REJECTED_FIELDS) {
    if (f in body) {
      return json(400, {
        error: "bad_request",
        message: `field "${f}" is not supported`,
      });
    }
  }

  // Title.
  const title = body.title;
  if (typeof title !== "string" || title.length === 0 || title.length > 200) {
    return json(400, {
      error: "bad_request",
      message: 'field "title" must be a non-empty string ≤ 200 chars',
    });
  }

  // Slug.
  const slug = body.slug;
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    return json(400, {
      error: "bad_request",
      message:
        'field "slug" must be kebab-case, 3–80 chars, alphanumeric + hyphens',
    });
  }

  // Description.
  const description = body.description;
  if (typeof description !== "string" || description.length === 0) {
    return json(400, {
      error: "bad_request",
      message: 'field "description" must be a non-empty string',
    });
  }
  if (Buffer.byteLength(description, "utf8") > MAX_DESCRIPTION_BYTES) {
    return json(413, {
      error: "payload_too_large",
      message: `description exceeds ${MAX_DESCRIPTION_BYTES} bytes`,
    });
  }

  // Difficulty.
  const difficulty = body.difficulty;
  if (typeof difficulty !== "string" || !ALLOWED_DIFFICULTY.has(difficulty as Difficulty)) {
    return json(400, {
      error: "bad_request",
      message: 'field "difficulty" must be one of "easy" | "medium" | "hard"',
    });
  }

  // Tags.
  const tags = body.tags;
  if (!Array.isArray(tags) || tags.length === 0) {
    return json(400, {
      error: "bad_request",
      message: 'field "tags" must be a non-empty array of strings',
    });
  }
  if (tags.length > MAX_TAGS) {
    return json(400, {
      error: "bad_request",
      message: `field "tags" exceeds max of ${MAX_TAGS}`,
    });
  }
  for (const t of tags) {
    if (typeof t !== "string" || t.length === 0 || t.length > MAX_TAG_LEN) {
      return json(400, {
        error: "bad_request",
        message: `tag must be a non-empty string ≤ ${MAX_TAG_LEN} chars`,
      });
    }
  }

  // Examples.
  const examples = body.examples;
  if (!Array.isArray(examples)) {
    return json(400, {
      error: "bad_request",
      message: 'field "examples" must be an array',
    });
  }
  if (examples.length > MAX_EXAMPLES) {
    return json(400, {
      error: "bad_request",
      message: `field "examples" exceeds max of ${MAX_EXAMPLES}`,
    });
  }
  const parsedExamples: ProblemExample[] = [];
  for (const ex of examples) {
    if (
      typeof ex !== "object" ||
      ex === null ||
      typeof (ex as ProblemExample).input !== "string" ||
      typeof (ex as ProblemExample).output !== "string"
    ) {
      return json(400, {
        error: "bad_request",
        message: 'each example must have string "input" and "output"',
      });
    }
    const e = ex as ProblemExample;
    if (
      e.input.length > MAX_EXAMPLE_FIELD_LEN ||
      e.output.length > MAX_EXAMPLE_FIELD_LEN ||
      (e.explanation !== undefined && e.explanation.length > MAX_EXAMPLE_FIELD_LEN)
    ) {
      return json(400, {
        error: "bad_request",
        message: `example fields exceed max length ${MAX_EXAMPLE_FIELD_LEN}`,
      });
    }
    parsedExamples.push({
      input: e.input,
      output: e.output,
      ...(e.explanation !== undefined ? { explanation: e.explanation } : {}),
    });
  }

  // Constraints.
  const constraints = body.constraints;
  if (!Array.isArray(constraints)) {
    return json(400, {
      error: "bad_request",
      message: 'field "constraints" must be an array of strings',
    });
  }
  if (constraints.length > MAX_CONSTRAINTS) {
    return json(400, {
      error: "bad_request",
      message: `field "constraints" exceeds max of ${MAX_CONSTRAINTS}`,
    });
  }
  for (const c of constraints) {
    if (typeof c !== "string" || c.length === 0 || c.length > MAX_CONSTRAINT_LEN) {
      return json(400, {
        error: "bad_request",
        message: `constraint must be a non-empty string ≤ ${MAX_CONSTRAINT_LEN} chars`,
      });
    }
  }

  const problemId = generateProblemId();
  const createdAt = new Date().toISOString();
  const pk = `PROBLEM#${problemId}`;
  const tags_dedupe = Array.from(new Set(tags as string[]));
  const row: ProblemRow = {
    pk,
    sk: "META",
    problemId,
    slug,
    authorSub: sub,
    title,
    difficulty: difficulty as Difficulty,
    tags: tags_dedupe,
    description,
    examples: parsedExamples,
    constraints: constraints as string[],
    createdAt,
    gsisk: `${createdAt}#${problemId}`,
    // GSI3 — slug lookup for cross-stack callers (submissions-bff).
    // Every problem has exactly one slug, so this is a 1:1 alias on
    // the same row. KEYS_ONLY projection is enough — submissions-bff
    // reads problemId off the row's primary key (DDB copies it in).
    slugKey: `SLUG#${slug}`,
    // GSI2 attributes: each tag gets its own (tagSlug, tagGsisk). We
    // store ONE row per (problemId, tag) pair? No — DDB single-table
    // design stores ONE row per logical entity. The GSI2 index
    // duplicates that row into multiple GSI entries — one per tag.
    // DynamoDB does this automatically when the (tagSlug, tagGsisk)
    // attribute is non-null and matches the GSI schema. Since a
    // single row can only have ONE value for `tagSlug`, we need
    // either (a) one row per tag (denormalized), or (b) a separate
    // table for tag slices. We choose (a): one problem row plus N
    // tag-slice rows in the SAME table.
    //
    // For v1 we keep it simple: store the primary problem row only.
    // Tag filtering is implemented in v1.1 by a separate
    // `problem_tags` slice. The listProblems endpoint in v1 lists
    // all problems via a SCAN (cheap at MVP scale, <10 K problems).
    // v1.1 introduces the per-tag slice rows + GSI2 query.
  };

  await ddbDoc.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: row,
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );

  return json(201, {
    problemId,
    slug,
    title,
    difficulty,
    tags: tags_dedupe,
    authorSub: sub,
    createdAt,
  });
};

// ─── GET /me/problems ────────────────────────────────────────────

export const listMyProblems: APIGatewayProxyHandlerV2 = async (event) => {
  const req = event as AuthorizedRequest;
  const sub = req.requestContext.authorizer?.jwt.claims.sub;
  if (!sub) {
    return json(401, { error: "unauthorized", message: "missing sub claim" });
  }

  const limit = parseLimit(event.queryStringParameters?.limit);

  const result = await ddbDoc.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "gsi1",
      KeyConditionExpression: "authorSub = :sub",
      ExpressionAttributeValues: { ":sub": sub },
      ScanIndexForward: false, // newest-first by createdAt
      Limit: limit,
    }),
  );

  const items: ProblemSummary[] = (result.Items ?? []).map(toSummary);
  return json(200, { count: items.length, items });
};

// ─── GET /problems ───────────────────────────────────────────────
//
// v1 implementation: Scan with a client-side filter on `tags`. This
// is OK at MVP scale (<10 K problems) and matches the design doc's
// "v1 is simplicity" note. v1.1 will use GSI2 with per-tag rows.

export const listProblems: APIGatewayProxyHandlerV2 = async (event) => {
  // Auth required (any user) but we don't use the claims.
  const req = event as AuthorizedRequest;
  const sub = req.requestContext.authorizer?.jwt.claims.sub;
  if (!sub) {
    return json(401, { error: "unauthorized", message: "missing sub claim" });
  }

  const limit = parseLimit(event.queryStringParameters?.limit);
  const tag = event.queryStringParameters?.tag;
  const cursor = event.queryStringParameters?.cursor;

  let exclusiveStartKey: Record<string, unknown> | undefined;
  if (cursor) {
    try {
      exclusiveStartKey = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8"),
      );
    } catch {
      return json(400, { error: "bad_request", message: "invalid cursor" });
    }
  }

  const scanResult = await ddbDoc.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      Limit: limit,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      ...(tag
        ? {
            FilterExpression: "contains(tags, :tag)",
            ExpressionAttributeValues: { ":tag": tag },
          }
        : {}),
    }),
  );

  const items: ProblemSummary[] = (scanResult.Items ?? []).map(toSummary);
  const nextCursor = scanResult.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(scanResult.LastEvaluatedKey)).toString("base64url")
    : null;

  return json(200, {
    count: items.length,
    items,
    ...(nextCursor ? { nextCursor } : {}),
  });
};

// ─── GET /problems/{slug} ────────────────────────────────────────

export const getProblemBySlug: APIGatewayProxyHandlerV2 = async (event) => {
  // Path param from HTTP API v2 is at event.pathParameters.slug
  const slug = event.pathParameters?.slug;
  if (!slug) {
    return json(400, { error: "bad_request", message: "missing slug" });
  }

  // v1 does a Scan with FilterExpression on `slug`. At MVP scale
  // (<10 K problems) this is fast enough. v1.1 adds a `slug` GSI for
  // direct GetItem-style lookup.
  const result = await ddbDoc.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: "slug = :slug",
      ExpressionAttributeValues: { ":slug": slug },
      Limit: 1,
    }),
  );

  const row = result.Items?.[0] as ProblemRow | undefined;
  if (!row) {
    return json(404, { error: "not_found", message: "problem not found" });
  }

  // Defensive: if a slug passes the v1 Scan but the row somehow has a
  // malformed problemId, reject — protects against internal data drift.
  if (!isProblemId(row.problemId)) {
    return json(500, { error: "internal", message: "row has malformed id" });
  }

  const detail: ProblemDetail = {
    problemId: row.problemId,
    slug: row.slug,
    title: row.title,
    difficulty: row.difficulty,
    tags: row.tags,
    authorSub: row.authorSub,
    createdAt: row.createdAt,
    description: row.description,
    examples: row.examples,
    constraints: row.constraints,
  };
  return json(200, detail);
};

// ─── GET /health ─────────────────────────────────────────────────

export const health: APIGatewayProxyHandlerV2 = async () => {
  return json(200, { ok: true, service: "leetcode-problems-bff" });
};

// ─── helpers ─────────────────────────────────────────────────────

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function parseLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_PAGE_SIZE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(n), MAX_PAGE_SIZE);
}

function toSummary(row: Record<string, unknown>): ProblemSummary {
  // Defensive: cast through unknown to ProblemSummary. The DDB row
  // shape is validated server-side on Put; this is a runtime
  // cast for the read path. If a row is missing fields we surface
  // empty strings — better than 500.
  return {
    problemId: String(row.problemId ?? ""),
    slug: String(row.slug ?? ""),
    title: String(row.title ?? ""),
    difficulty: (row.difficulty as Difficulty) ?? "easy",
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    authorSub: String(row.authorSub ?? ""),
    createdAt: String(row.createdAt ?? ""),
  };
}
