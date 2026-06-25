import type { AppConfig } from "./types";

const STORAGE_KEY = "leetcode-playground-config";

/** Dev-stage defaults — same endpoints as smoke-tests/*. */
export const DEFAULT_CONFIG: AppConfig = {
  problemsApi:
    "https://73yfry46sl.execute-api.ap-southeast-1.amazonaws.com",
  submissionsApi:
    "https://yffu5ff2t3.execute-api.ap-southeast-1.amazonaws.com",
  statusApi:
    "https://mulz4grtp5.execute-api.ap-southeast-1.amazonaws.com",
  cognitoRegion: "ap-southeast-1",
  userPoolId: "ap-southeast-1_BIhFoAA8R",
  clientId: "2bpmi5mtaa2eqdria5g1ih5ip9",
};

export function loadConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) } as AppConfig;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: AppConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

const TOKEN_KEY = "leetcode-playground-id-token";

export function loadToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function saveToken(token: string): void {
  if (token.trim()) {
    localStorage.setItem(TOKEN_KEY, token.trim());
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}
