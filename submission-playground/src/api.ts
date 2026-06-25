import type {
  AppConfig,
  Language,
  ProblemDetail,
  SubmitResponse,
  SubmissionStatusResponse,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const msg =
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof (parsed as { message: unknown }).message === "string"
        ? (parsed as { message: string }).message
        : `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, parsed);
  }

  return parsed as T;
}

export function fetchProblem(
  config: AppConfig,
  slug: string,
): Promise<ProblemDetail> {
  return request<ProblemDetail>(
    config.problemsApi,
    `/problems/${encodeURIComponent(slug)}`,
  );
}

export interface CreateProblemResponse {
  problemId: string;
  slug: string;
  title: string;
}

export function createProblem(
  config: AppConfig,
  token: string,
  body: Record<string, unknown>,
): Promise<CreateProblemResponse> {
  return request<CreateProblemResponse>(config.problemsApi, "/problems", {
    method: "POST",
    token,
    body,
  });
}

export function submitSolution(
  config: AppConfig,
  token: string,
  slug: string,
  language: Language,
  code: string,
): Promise<SubmitResponse> {
  return request<SubmitResponse>(
    config.submissionsApi,
    `/problems/${encodeURIComponent(slug)}/submission`,
    {
      method: "POST",
      token,
      body: { language, code },
    },
  );
}

export function fetchSubmissionStatus(
  config: AppConfig,
  token: string,
  submissionId: string,
): Promise<SubmissionStatusResponse> {
  return request<SubmissionStatusResponse>(
    config.statusApi,
    `/submissions/${encodeURIComponent(submissionId)}/status`,
    { token },
  );
}

export async function pollSubmissionStatus(
  config: AppConfig,
  token: string,
  submissionId: string,
  onUpdate: (status: SubmissionStatusResponse) => void,
  signal?: AbortSignal,
): Promise<SubmissionStatusResponse> {
  const delay = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      const id = window.setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          window.clearTimeout(id);
          reject(new DOMException("Polling aborted", "AbortError"));
        },
        { once: true },
      );
    });

  while (true) {
    if (signal?.aborted) {
      throw new DOMException("Polling aborted", "AbortError");
    }

    const status = await fetchSubmissionStatus(config, token, submissionId);
    onUpdate(status);

    if (
      status.status === "ACCEPTED" ||
      status.status === "WRONG_ANSWER" ||
      status.status === "TIMEOUT" ||
      status.status === "RUNTIME_ERROR" ||
      status.status === "COMPILE_ERROR"
    ) {
      return status;
    }

    await delay(1000);
  }
}
