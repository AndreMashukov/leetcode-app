export type Language = "python" | "javascript";

export type SubmissionStatus =
  | "PENDING"
  | "RUNNING"
  | "ACCEPTED"
  | "WRONG_ANSWER"
  | "TIMEOUT"
  | "RUNTIME_ERROR"
  | "COMPILE_ERROR";

export interface AppConfig {
  problemsApi: string;
  submissionsApi: string;
  statusApi: string;
  cognitoRegion: string;
  userPoolId: string;
  clientId: string;
}

export interface ProblemDetail {
  problemId: string;
  slug: string;
  title: string;
  difficulty: string;
  description?: string;
  statement?: string;
  tags?: string[];
}

export interface TestResult {
  index: number;
  passed: boolean;
  actual?: string;
  expected?: string;
  message?: string;
}

export interface ResultSummary {
  passedCount: number;
  totalCount: number;
  runtimeMs: number;
  memoryKb: number;
  failedCaseIndex?: number;
  failedCase?: TestResult;
}

export interface SubmissionStatusResponse {
  submissionId: string;
  status: SubmissionStatus;
  submittedAt: string;
  startedAt?: string;
  acceptedAt?: string;
  resultSummary?: ResultSummary;
  logUrl?: string;
}

export interface SubmitResponse {
  ok: boolean;
  submissionId: string;
  statusUrl: string;
  status: SubmissionStatus;
}

export const TERMINAL_STATUSES: SubmissionStatus[] = [
  "ACCEPTED",
  "WRONG_ANSWER",
  "TIMEOUT",
  "RUNTIME_ERROR",
  "COMPILE_ERROR",
];

export function isTerminal(status: SubmissionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
