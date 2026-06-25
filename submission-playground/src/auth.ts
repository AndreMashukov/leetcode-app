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

export function tokenExpiry(token: string): Date | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1] ?? ""));
    if (typeof payload.exp !== "number") return null;
    return new Date(payload.exp * 1000);
  } catch {
    return null;
  }
}

export function tokenEmail(token: string): string | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1] ?? ""));
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
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
