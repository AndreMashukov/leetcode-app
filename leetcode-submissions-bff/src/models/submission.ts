/**
 * Submission domain types.
 *
 * The DDB row shape, the wire response shape, and the SQS work
 * message shape are kept separate on purpose:
 *
 *   - SubmissionRow        → what's in DDB (camelCase, internal).
 *   - SubmissionSummary    → what listMySubmissions returns
 *                            (omits `code` — large, sensitive).
 *   - SubmissionAccepted   → 202 response to POST /problems/{slug}/submission.
 *   - SubmissionWorkMessage → SQS body handed to workers.
 *
 * Keeping them disjoint prevents accidentally returning the
 * raw user-submitted code from the list endpoint, or putting
 * a 1MB `code` blob on SQS when only the worker needs it (the
 * worker reads it back from DDB).
 */

import type { Difficulty } from "./problem.js";

/** Languages we support at v1 (interpreted only — no compile step). */
export type Language = "python" | "javascript";

/** Submission lifecycle. Mirrors the design §3 enum. */
export type SubmissionStatus =
  | "PENDING"
  | "RUNNING"
  | "ACCEPTED"
  | "WRONG_ANSWER"
  | "TIMEOUT"
  | "RUNTIME_ERROR"
  | "COMPILE_ERROR";

/** Per-test verdict, returned to status-bff and the UI. */
export interface TestResult {
  index: number;
  passed: boolean;
  actual?: string;
  expected?: string;
  message?: string;
}

/** Filled by the worker. summary is the only field the client
 *  reads in a "give me the verdict" call. */
export interface ResultSummary {
  passedCount: number;
  totalCount: number;
  runtimeMs: number;
  memoryKb: number;
  failedCaseIndex?: number;
}

/** DDB row. GSI keys are denormalized into the row so a single
 *  Query (no Filter) answers list-by-user. */
export interface SubmissionRow {
  pk: `SUB#${string}`;
  sk: "META";
  submissionId: string;
  userId: string;
  problemId: string;
  /** Slug is denormalized for cheap list displays. The
   *  slug→problemId mapping is owned by problems-bff; we
   *  re-resolve at submission time and snapshot here. */
  problemSlug: string;
  /** Snapshot of the difficulty at submit time so the user's
   *  history reflects what they saw, not what problems-bff
   *  later edits. */
  problemDifficulty: Difficulty;
  language: Language;
  code: string;
  status: SubmissionStatus;
  /** Worker-set. Null until the row is picked up. */
  startedAt?: string;
  /** Worker-set. */
  acceptedAt?: string;
  /** Result populated by the worker on terminal status. */
  resultSummary?: ResultSummary;
  /** S3 key to the build/run log, populated only on failure. */
  s3LogKey?: string;
  /** Worker that claimed the row. Filled when status moves to
   *  RUNNING; used in the conditional UpdateItem at completion. */
  workerId?: string;
  /** Attempt counter. Workers bump this with if_not_exists semantics. */
  attempt?: number;
  submittedAt: string;
  /** Always "META" at v1 — the sort key slot is reserved for
   *  future per-attempt rows if we ever split attempts into
   *  multiple items. */
  gsi1pk: `USER#${string}`;
  gsi1sk: string;
  /** Sparse — only present when status === "RUNNING". */
  gsi2pk?: "STATUS#RUNNING";
  gsi2sk?: string;
}

/** What listMySubmissions returns per item. NEVER includes `code`. */
export interface SubmissionSummary {
  submissionId: string;
  problemId: string;
  problemSlug: string;
  problemDifficulty: Difficulty;
  language: Language;
  status: SubmissionStatus;
  submittedAt: string;
  startedAt?: string;
  acceptedAt?: string;
  resultSummary?: ResultSummary;
}

/** 202 response from POST /problems/{slug}/submission. */
export interface SubmissionAccepted {
  submissionId: string;
  statusUrl: string;
  status: "PENDING";
}

/** SQS body handed to workers. Minimal — workers read the row
 *  from DDB. We deliberately do NOT send `code` on SQS: it's
 *  in the row, SQS is for routing. */
export interface SubmissionWorkMessage {
  submissionId: string;
  problemId: string;
  userId: string;
  language: Language;
  submittedAt: string;
}
