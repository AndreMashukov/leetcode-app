/**
 * Submission row + wire shapes for status-bff.
 *
 * IMPORTANT: this is a SUBSET of submissions-bff/src/models/submission.ts.
 * We only need what we return to the client + the ownership field
 * (userId). If submissions-bff adds new attributes, status-bff does
 * NOT need to be redeployed — the read is by attribute name and
 * anything unknown is silently dropped by DDB Document Client.
 *
 * Keeping the types in sync is still a good idea — TS will catch
 * any accidental reference to a field that submissions-bff
 * stopped emitting. The split file pattern matches problems-bff's
 * "each BFF owns its row shape" convention.
 */

export type SubmissionStatus =
  | "PENDING"
  | "RUNNING"
  | "ACCEPTED"
  | "WRONG_ANSWER"
  | "TIMEOUT"
  | "RUNTIME_ERROR"
  | "COMPILE_ERROR";

/** Per-test verdict, returned as part of the terminal result. */
export interface TestResult {
  index: number;
  passed: boolean;
  actual?: string;
  expected?: string;
  message?: string;
}

/** Filled by the worker. summary is what the client reads on
 *  "give me the verdict". Null while status is PENDING / RUNNING. */
export interface ResultSummary {
  passedCount: number;
  totalCount: number;
  runtimeMs: number;
  memoryKb: number;
  failedCaseIndex?: number;
  failedCase?: TestResult;
}

/** Subset of the DDB row we read. */
export interface SubmissionRow {
  pk: `SUB#${string}`;
  sk: "META";
  submissionId: string;
  /** Cognito sub of the owner — used for the ownership check. */
  userId: string;
  status: SubmissionStatus;
  submittedAt: string;
  /** Worker-set. */
  startedAt?: string;
  /** Worker-set, on terminal-OK status. */
  acceptedAt?: string;
  /** Worker-set, on terminal-* status. */
  resultSummary?: ResultSummary;
  /** S3 key for build/run log, populated only on failure. */
  s3LogKey?: string;
}

/** Wire response shape. Mirrors design §547's contract:
 *  `{ status, resultSummary, acceptedAt }` — plus a couple of
 *  convenience fields (submissionId, submittedAt) that the client
 *  needs to render its status page without an extra round trip. */
export interface SubmissionStatusResponse {
  submissionId: string;
  status: SubmissionStatus;
  submittedAt: string;
  startedAt?: string;
  acceptedAt?: string;
  resultSummary?: ResultSummary;
  /** Only set on terminal-failure statuses (WRONG_ANSWER, RUNTIME_ERROR,
   *  COMPILE_ERROR, TIMEOUT). Lets the client link to a "view log"
   *  page that fetches the S3 object via a signed URL. */
  logUrl?: string;
}
