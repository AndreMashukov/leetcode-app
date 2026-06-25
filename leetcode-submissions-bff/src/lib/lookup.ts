/**
 * Shared helpers for cross-stack lookups + auth-shape parsing.
 *
 * Lives outside handlers.ts so future stacks (status-bff etc.)
 * can copy this file verbatim without pulling the submission
 * handler logic along with it.
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyEventV2WithRequestContext,
  APIGatewayEventRequestContextV2,
} from "aws-lambda";

/** Shape of the JWT claim we rely on. Authorizer augments the
 *  requestContext with the verified claims (see serverless.yml's
 *  `cognitoJwtAuthorizer`). Mirrors the problems-bff helper. */
export interface JwtClaims {
  sub: string;
  /** Optional. Cognito groups claim, when configured. */
  "cognito:groups"?: string[];
  /** Anything else the IdP emits. Kept loose for forward-compat. */
  [k: string]: unknown;
}

/** Augmented request-context type for Cognito JWT authorizer.
 *  Mirrors problems-bff/src/rest/handlers.ts — same shape across
 *  all BFFs that use the JWT authorizer. */
type CognitoClaims = Record<string, string | undefined>;
type JwtAuthorizer = { jwt: { claims: CognitoClaims } };
export type AuthorizedRequest = APIGatewayProxyEventV2WithRequestContext<
  APIGatewayEventRequestContextV2 & { authorizer?: JwtAuthorizer }
>;

/** Read the verified claims from the request context.
 *  Throws if missing (handlers should treat that as 401 — should
 *  not happen behind a JWT authorizer, but the path can't be
 *  taken without an explicit guard). */
export function requireClaims(
  event: APIGatewayProxyEventV2,
): JwtClaims {
  const authorizer = (
    event.requestContext as APIGatewayEventRequestContextV2 & {
      authorizer?: JwtAuthorizer;
    }
  ).authorizer;
  const claims = authorizer?.jwt?.claims;
  if (!claims?.sub) {
    throw new Error("auth: missing claims on requestContext");
  }
  return claims as JwtClaims;
}

/** Pull `{slug}` out of path params. Throws on missing — same
 *  contract as problems-bff. */
export function requireSlug(event: APIGatewayProxyEventV2): string {
  const slug = event.pathParameters?.slug;
  if (!slug) throw new Error("handler: missing path param 'slug'");
  return slug;
}

/** Parse JSON body. Empty bodies map to {}; missing/invalid
 *  JSON is propagated as a thrown Error so the handler can
 *  surface 400. */
export function parseJsonBody<T extends Record<string, unknown>>(
  event: APIGatewayProxyEventV2,
): T {
  const raw = event.body;
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("handler: invalid JSON body");
  }
}
