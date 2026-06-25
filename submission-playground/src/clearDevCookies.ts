/**
 * Vite's dev server rejects requests when Cookie headers exceed Node's
 * default limit (~16 KiB). Stale Cognito / auth cookies on localhost are
 * a common cause — they are not used by this app (we keep the JWT in
 * localStorage only).
 */
export function clearStaleDevCookies(): void {
  if (typeof document === "undefined" || !document.cookie) return;

  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]?.trim();
    if (!name) continue;

    const isCognito = name.startsWith("CognitoIdentityServiceProvider");
    const isAuthish =
      name.includes("token") ||
      name.includes("Token") ||
      name.includes("session") ||
      name.includes("Session");

    if (isCognito || isAuthish) {
      document.cookie = `${name}=; Max-Age=0; path=/`;
      document.cookie = `${name}=; Max-Age=0; path=/; domain=localhost`;
    }
  }
}
