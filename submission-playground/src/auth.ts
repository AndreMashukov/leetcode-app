import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
} from "amazon-cognito-identity-js";
import type { AppConfig } from "./types";

export async function loginWithPassword(
  config: AppConfig,
  email: string,
  password: string,
): Promise<string> {
  const pool = new CognitoUserPool({
    UserPoolId: config.userPoolId,
    ClientId: config.clientId,
    // Keep SDK session keys in localStorage — not document cookies.
    // Cookies on localhost are sent with every Vite asset request and
    // can trigger HTTP 431 once they accumulate.
    Storage: window.localStorage,
  });

  const user = new CognitoUser({
    Username: email.trim(),
    Pool: pool,
  });

  const authDetails = new AuthenticationDetails({
    Username: email.trim(),
    Password: password,
  });

  return new Promise((resolve, reject) => {
    user.authenticateUser(authDetails, {
      onSuccess: (session) => {
        const idToken = session.getIdToken().getJwtToken();
        resolve(idToken);
      },
      onFailure: (err) => {
        reject(err);
      },
    });
  });
}

/** Decode JWT payload segment (base64url → JSON). */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const segment = token.split(".")[1];
    if (!segment) return null;
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "=",
    );
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function tokenExpiry(token: string): Date | null {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") return null;
  return new Date(payload.exp * 1000);
}

export function tokenEmail(token: string): string | null {
  const payload = decodeJwtPayload(token);
  return typeof payload?.email === "string" ? payload.email : null;
}

export function isTokenExpired(token: string): boolean {
  const exp = tokenExpiry(token);
  if (!exp) return true;
  return exp.getTime() <= Date.now();
}

/** Cognito ID tokens are three base64url segments separated by dots. */
export function looksLikeIdToken(value: string): boolean {
  const t = value.trim();
  const parts = t.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0) && t.startsWith("eyJ");
}
