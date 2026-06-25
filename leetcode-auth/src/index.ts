// Placeholder entrypoint for leetcode-auth.
//
// This stack is pure infrastructure (one Cognito UserPool + one
// UserPoolClient). It has no Lambda functions and no business logic.
// This file exists so the project's TypeScript build has at least
// one `.ts` input to validate, satisfying `tsc --noEmit`.
//
// Future: when we add custom auth challenges or post-confirmation
// Lambda triggers, this file can re-export the trigger handlers
// and the trigger event shapes.

export const AUTH_STACK_NAME = "leetcode-auth";
export const AUTH_STACK_DESCRIPTION =
  "Cognito UserPool + UserPoolClient shared by every BFF in the leetcode system";
