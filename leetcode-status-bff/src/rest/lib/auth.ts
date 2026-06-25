/**
 * JWT authorizer-shape parsing.
 *
 * Same pattern that submissions-bff and problems-bff use, kept
 * here as a small local helper. Each BFF compiles to its own
 * Lambda bundle; sharing 6 lines of source across stacks would
 * require a NX lib which isn't worth the indirection at MVP.
 */

import type {
  APIGatewayEventRequestContextV2,
  APIGatewayProxyEventV2,
} from "aws-lambda";

interface JwtAuthorizer {
  jwt?: {
    claims?: Record<string, string | number | boolean>;
  };
}

/**
 * Extract the `sub` claim from the JWT authorizer payload, or
 * `undefined` if the claim is missing or the authorizer shape is
 * not what we expect.
 */
export function getRequesterSub(
  event: APIGatewayProxyEventV2,
): string | undefined {
  const authorizer = (
    event.requestContext as APIGatewayEventRequestContextV2 & {
      authorizer?: JwtAuthorizer;
    }
  ).authorizer;
  const sub = authorizer?.jwt?.claims?.sub;
  return typeof sub === "string" && sub.length > 0 ? sub : undefined;
}
