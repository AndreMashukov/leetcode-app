/**
 * Problem entity (Single-Table Design).
 *
 * Stored in ProblemsTable. The DDB row shape:
 *   pk        = "PROBLEM#<problemId>"
 *   sk        = "META"
 *   gsi1      = authorSub (HASH) + gsisk (RANGE)   - GET /me/problems
 *   gsi2      = tagSlug (HASH) + tagGsisk (RANGE)  - GET /problems?tag=...
 *
 *   pk          = "PROBLEM#<problemId>"          - primary key
 *   sk          = "META"                          - sort key (always META)
 *   problemId   = <8-char id, see lib/problemId>  - public, in row
 *   slug        = <slug from client>              - human-readable URL part
 *   authorSub   = <cognito sub>                   - GSI1 HASH key
 *   gsisk       = "<createdAt>#<problemId>"      - GSI1 RANGE
 *   tagSlug     = "TAG#<tag>"                     - GSI2 HASH (sparse)
 *   tagGsisk    = "slug#<problemId>"              - GSI2 RANGE
 *
 * GSI1 enables GET /me/problems: query GSI1 with KeyConditionExpression
 * `authorSub = :sub` to list problems authored by the caller, sorted
 * newest-first by createdAt.
 *
 * GSI2 is sparse — only rows with tags get a value. Each problem has one
 * (tagSlug, tagGsisk) entry per tag in its `tags` array. For v1 we
 * support single-tag filtering; multi-tag is v1.1.
 *
 * The bus event shape (`detail` field of Problem.* events) is the
 * `ProblemEvent` type below.
 *
 * Design doc: ../design-research.md §4.
 */

export type Discriminator = "META";

/** Difficulty levels accepted at MVP. Strict union to reject typos. */
export type Difficulty = "easy" | "medium" | "hard";

/** A single test case attached to a problem. */
export interface ProblemExample {
  input: string;
  output: string;
  explanation?: string;
}

/** A worker test case (stdin/stdout). Stored on the problem row. */
export interface ProblemTestCase {
  input: string;
  expected: string;
}

/** Per-language starter snippets + entrypoint names for the worker. */
export interface StarterCode {
  python?: string;
  pythonEntrypoint?: string;
  javascript?: string;
  javascriptEntrypoint?: string;
  [key: string]: string | undefined;
}

/** Persistence row in ProblemsTable.
 *
 * No `expires_at` — problems are not expirable at MVP. v1.1 may add a
 * soft-delete (sets status=archived); the GSI1 query in
 * listMyProblems filters that out.
 *
 * DDB row shape:
 *   pk          = "PROBLEM#<problemId>"            (HASH)
 *   sk          = "META"                           (RANGE)
 *   authorSub   = <cognito sub>                    (GSI1 HASH)
 *   gsisk       = "<createdAt>#<problemId>"        (GSI1 RANGE)
 *   tagSlug     = "TAG#<tag>"                      (GSI2 HASH, sparse — only when tags set)
 *   tagGsisk    = "slug#<problemId>"               (GSI2 RANGE)
 *
 * NOTE: the GSI2 attributes are `tagSlug` and `tagGsisk` (not the
 * standard `gsi*pk` / `gsi*sk` naming pastebin uses) because each row
 * has MULTIPLE entries in gsi2 — one per tag. The names are local to
 * problems-bff; nothing outside the table cares.
 */
export interface ProblemRow {
  pk: string;
  sk: Discriminator;
  problemId: string;
  slug: string;
  authorSub: string;
  title: string;
  difficulty: Difficulty;
  tags: string[];
  description: string;
  examples: ProblemExample[];
  constraints: string[];
  createdAt: string;
  gsisk: string;
  // GSI2 attributes — sparse. The (tagSlug, tagGsisk) pair is repeated
  // once per tag in `tags`, so a problem with tags=["array","dp"] has
  // two copies of (tagSlug, tagGsisk) — one for each.
  tagSlug?: string;
  tagGsisk?: string;
  // GSI3 — slug lookup for cross-stack callers (submissions-bff).
  // Every row has exactly one slug, so this is a 1:1 alias.
  slugKey: `SLUG#${string}`;
  /** Worker fields — optional at create; required for submissions to run. */
  testCases?: ProblemTestCase[];
  starterCode?: StarterCode;
  timeLimitMs?: number;
  memoryLimitKb?: number;
}

/** Public-facing summary (used in list endpoints — no full body). */
export interface ProblemSummary {
  problemId: string;
  slug: string;
  title: string;
  difficulty: Difficulty;
  tags: string[];
  authorSub: string;
  createdAt: string;
}

/** Full Problem detail (returned by GET /problems/{slug}). */
export interface ProblemDetail extends ProblemSummary {
  description: string;
  examples: ProblemExample[];
  constraints: string[];
}

/** Problem detail payload carried on EventBridge as `detail` of `Problem.*`. */
export interface ProblemEvent {
  problemId: string;
  slug: string;
  authorSub: string;
  title: string;
  difficulty: Difficulty;
  tags: string[];
  createdAt: string;
}

/** Problem change kind emitted as `detail-type`. */
export type ProblemEventType = "ProblemCreated" | "ProblemDeleted";
