import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from "react";
import {
  ApiError,
  createProblem,
  fetchProblem,
  pollSubmissionStatus,
  submitSolution,
} from "./api";
import {
  isTokenExpired,
  loginWithPassword,
  looksLikeIdToken,
  tokenEmail,
  tokenExpiry,
} from "./auth";
import {
  DEFAULT_CONFIG,
  loadConfig,
  loadToken,
  saveConfig,
  saveToken,
} from "./config";
import { TWO_SUM_SEED, defaultCode } from "./seeds/two-sum";
import type {
  AppConfig,
  Language,
  ProblemDetail,
  SubmissionStatusResponse,
} from "./types";

function formatExpiry(token: string): string {
  const exp = tokenExpiry(token);
  if (!exp) return "invalid token";
  if (isTokenExpired(token)) return "expired";
  return exp.toLocaleString();
}

export default function App() {
  const [config, setConfig] = useState<AppConfig>(() => loadConfig());
  const [showConfig, setShowConfig] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState(() => loadToken());
  const [tokenInput, setTokenInput] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  const [slug, setSlug] = useState("two-sum");
  const [language, setLanguage] = useState<Language>("python");
  const [code, setCode] = useState(() => defaultCode("python"));
  const [problem, setProblem] = useState<ProblemDetail | null>(null);
  const [problemError, setProblemError] = useState<string | null>(null);
  const [problemBusy, setProblemBusy] = useState(false);
  const [seedBusy, setSeedBusy] = useState(false);
  const [problemNotFound, setProblemNotFound] = useState(false);

  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [status, setStatus] = useState<SubmissionStatusResponse | null>(null);
  const pollAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => pollAbort.current?.abort();
  }, []);

  const applyConfig = () => {
    saveConfig(config);
    setShowConfig(false);
  };

  const resetConfig = () => {
    setConfig({ ...DEFAULT_CONFIG });
    saveConfig(DEFAULT_CONFIG);
  };

  const handleLogin = async () => {
    setAuthError(null);
    setAuthBusy(true);
    try {
      const idToken = await loginWithPassword(config, email, password);
      setToken(idToken);
      saveToken(idToken);
      setPassword("");
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  };

  const handlePasteToken = (raw?: string) => {
    const trimmed = (raw ?? tokenInput).trim();
    if (!trimmed) return;
    if (!looksLikeIdToken(trimmed)) {
      setAuthError(
        "That does not look like a full ID token (need all 3 eyJ… segments). See .cursor/skills/leetcode-dev-jwt/SKILL.md",
      );
      return;
    }
    setToken(trimmed);
    saveToken(trimmed);
    setTokenInput("");
    setAuthError(null);
  };

  const handleTokenPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = e.clipboardData.getData("text").trim();
    if (looksLikeIdToken(pasted)) {
      e.preventDefault();
      handlePasteToken(pasted);
    }
  };

  const handleLogout = () => {
    setToken("");
    saveToken("");
  };

  const loadProblem = useCallback(async () => {
    setProblemError(null);
    setProblemNotFound(false);
    setProblemBusy(true);
    setProblem(null);
    try {
      const detail = await fetchProblem(config, slug.trim());
      setProblem(detail);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setProblemNotFound(true);
      }
      setProblemError(
        err instanceof ApiError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setProblemBusy(false);
    }
  }, [config, slug]);

  useEffect(() => {
    void loadProblem();
  }, [loadProblem]);

  const handleLanguageChange = (next: Language) => {
    setLanguage(next);
    setCode(defaultCode(next));
  };

  const handleSeedTwoSum = async () => {
    if (!token || isTokenExpired(token)) {
      setProblemError("Sign in first — seeding requires a JWT.");
      return;
    }

    setSeedBusy(true);
    setProblemError(null);
    try {
      await createProblem(config, token, TWO_SUM_SEED);
      await loadProblem();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await loadProblem();
        return;
      }
      setProblemError(
        err instanceof ApiError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setSeedBusy(false);
    }
  };

  const handleSubmit = async () => {
    if (!token || isTokenExpired(token)) {
      setSubmitError("Sign in or paste a valid JWT first.");
      return;
    }

    pollAbort.current?.abort();
    pollAbort.current = new AbortController();

    setSubmitError(null);
    setStatus(null);
    setSubmitBusy(true);

    try {
      const accepted = await submitSolution(
        config,
        token,
        slug.trim(),
        language,
        code,
      );

      setStatus({
        submissionId: accepted.submissionId,
        status: accepted.status,
        submittedAt: new Date().toISOString(),
      });

      await pollSubmissionStatus(
        config,
        token,
        accepted.submissionId,
        setStatus,
        pollAbort.current.signal,
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setSubmitError(
        err instanceof ApiError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setSubmitBusy(false);
    }
  };

  const tokenOk = Boolean(token) && !isTokenExpired(token);

  return (
    <div className="app">
      <h1>Submission playground</h1>
      <p className="subtitle">
        Local React UI for the deployed leetcode BFFs — load a problem,
        submit code, poll status until verdict.
      </p>

      <section className="panel">
        <h2>Authentication</h2>
        <div className="row">
          <div>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
            />
          </div>
          <div>
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div className="shrink">
            <label>&nbsp;</label>
            <button type="button" onClick={() => void handleLogin()} disabled={authBusy}>
              {authBusy ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <div>
            <label htmlFor="tokenPaste">Or paste ID token (auto-applies on paste)</label>
            <textarea
              id="tokenPaste"
              className="token-paste"
              rows={3}
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              onPaste={handleTokenPaste}
              placeholder="Paste full eyJ… token from yarn mint:jwt"
            />
          </div>
          <div className="shrink">
            <label>&nbsp;</label>
            <button type="button" className="secondary" onClick={() => handlePasteToken()}>
              Use token
            </button>
          </div>
        </div>

        <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span className={`pill ${tokenOk ? "ok" : token ? "error" : "warn"}`}>
            {tokenOk
              ? `Signed in as ${tokenEmail(token) ?? "user"} · expires ${formatExpiry(token)}`
              : token
                ? "Token expired — sign in again"
                : "Not signed in"}
          </span>
          {token ? (
            <button type="button" className="secondary" onClick={handleLogout}>
              Clear token
            </button>
          ) : null}
        </div>

        {authError ? <p className="error-text">{authError}</p> : null}
        <p className="hint">
          Obtain a JWT via the <code>leetcode-dev-jwt</code> skill (
          <code>.cursor/skills/leetcode-dev-jwt/SKILL.md</code>). Paste auto-applies;
          or sign in with your Cognito email and password.
        </p>
      </section>

      <section className="panel">
        <details open={showConfig} onToggle={(e) => setShowConfig(e.currentTarget.open)}>
          <summary>API &amp; Cognito settings</summary>
          <div className="grid-2" style={{ marginTop: 12 }}>
            <div>
              <label htmlFor="problemsApi">Problems API</label>
              <input
                id="problemsApi"
                value={config.problemsApi}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, problemsApi: e.target.value }))
                }
              />
            </div>
            <div>
              <label htmlFor="submissionsApi">Submissions API</label>
              <input
                id="submissionsApi"
                value={config.submissionsApi}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, submissionsApi: e.target.value }))
                }
              />
            </div>
            <div>
              <label htmlFor="statusApi">Status API</label>
              <input
                id="statusApi"
                value={config.statusApi}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, statusApi: e.target.value }))
                }
              />
            </div>
            <div>
              <label htmlFor="userPoolId">User pool ID</label>
              <input
                id="userPoolId"
                value={config.userPoolId}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, userPoolId: e.target.value }))
                }
              />
            </div>
            <div>
              <label htmlFor="clientId">Client ID</label>
              <input
                id="clientId"
                value={config.clientId}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, clientId: e.target.value }))
                }
              />
            </div>
            <div>
              <label htmlFor="cognitoRegion">Cognito region</label>
              <input
                id="cognitoRegion"
                value={config.cognitoRegion}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, cognitoRegion: e.target.value }))
                }
              />
            </div>
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <button type="button" onClick={applyConfig}>
              Save settings
            </button>
            <button type="button" className="secondary" onClick={resetConfig}>
              Reset defaults
            </button>
          </div>
        </details>
      </section>

      <div className="grid-2">
        <section className="panel">
          <h2>Problem</h2>
          <div className="row">
            <div>
              <label htmlFor="slug">Slug</label>
              <input
                id="slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
              />
            </div>
            <div className="shrink">
              <label>&nbsp;</label>
              <button
                type="button"
                className="secondary"
                onClick={() => void loadProblem()}
                disabled={problemBusy}
              >
                {problemBusy ? "Loading…" : "Reload"}
              </button>
            </div>
            {slug.trim() === "two-sum" ? (
              <div className="shrink">
                <label>&nbsp;</label>
                <button
                  type="button"
                  onClick={() => void handleSeedTwoSum()}
                  disabled={seedBusy || !tokenOk}
                >
                  {seedBusy ? "Seeding…" : "Seed two-sum"}
                </button>
              </div>
            ) : null}
          </div>

          {problemNotFound ? (
            <p className="hint">
              Sign in and click Seed two-sum (or POST /problems from the smoke
              harness). Redeploy problems-bff if seeding ignores testCases.
            </p>
          ) : null}

          {problemError ? <p className="error-text">{problemError}</p> : null}

          {problem ? (
            <>
              <h3 className="problem-title">{problem.title}</h3>
              <div className="problem-meta">
                <span className="tag">{problem.difficulty}</span>
                <span className="tag">{problem.slug}</span>
                <span className="tag">{problem.problemId}</span>
                {(problem.tags ?? []).map((t) => (
                  <span key={t} className="tag">
                    {t}
                  </span>
                ))}
              </div>
              <div className="problem-body">
                {problem.statement ?? problem.description ?? "(no statement)"}
              </div>
            </>
          ) : problemBusy ? (
            <p className="hint">Loading problem…</p>
          ) : null}
        </section>

        <section className="panel">
          <h2>Submit</h2>
          <div className="row">
            <div className="shrink" style={{ minWidth: 160 }}>
              <label htmlFor="language">Language</label>
              <select
                id="language"
                value={language}
                onChange={(e) => handleLanguageChange(e.target.value as Language)}
              >
                <option value="python">python</option>
                <option value="javascript">javascript</option>
              </select>
            </div>
            <div className="shrink">
              <label>&nbsp;</label>
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={submitBusy || !problem}
              >
                {submitBusy ? "Running…" : "Run submission"}
              </button>
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <label htmlFor="code">Code</label>
            <textarea
              id="code"
              className="code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              spellCheck={false}
            />
          </div>

          {submitError ? <p className="error-text">{submitError}</p> : null}

          {status ? (
            <div style={{ marginTop: 16 }}>
              <h2>Status</h2>
              <p>
                <strong className={`status-${status.status}`}>{status.status}</strong>
                {" · "}
                <span className="hint">{status.submissionId}</span>
              </p>
              {status.resultSummary ? (
                <p className="hint">
                  {status.resultSummary.passedCount}/{status.resultSummary.totalCount}{" "}
                  passed · {status.resultSummary.runtimeMs} ms ·{" "}
                  {status.resultSummary.memoryKb} KB
                </p>
              ) : null}
              {status.resultSummary?.failedCase ? (
                <p className="error-text">
                  Case {status.resultSummary.failedCase.index}:{" "}
                  {status.resultSummary.failedCase.message ??
                    `expected ${status.resultSummary.failedCase.expected}, got ${status.resultSummary.failedCase.actual}`}
                </p>
              ) : null}
              <pre className="status-box">{JSON.stringify(status, null, 2)}</pre>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
