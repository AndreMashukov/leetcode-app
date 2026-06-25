#!/usr/bin/env node
/**
 * Create or reset a dev Cognito user (no AWS CLI required).
 *
 * See .cursor/skills/leetcode-dev-jwt/SKILL.md
 */

import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? "ap-southeast-1_BIhFoAA8R";
const REGION = process.env.AWS_REGION ?? "ap-southeast-1";
const username = process.argv[2] ?? process.env.COGNITO_USERNAME;
const password = process.env.COGNITO_PASSWORD;

if (!username) {
  console.error(
    "Set COGNITO_USERNAME (Cognito email/username).\n" +
      "See .cursor/skills/leetcode-dev-jwt/SKILL.md",
  );
  process.exit(1);
}

if (!password) {
  console.error(
    "Set COGNITO_PASSWORD.\n" +
      "See .cursor/skills/leetcode-dev-jwt/SKILL.md",
  );
  process.exit(1);
}

if (password.length < 8) {
  console.error("Password must be at least 8 characters (Cognito pool policy).");
  process.exit(1);
}

const client = new CognitoIdentityProviderClient({ region: REGION });

async function userExists() {
  try {
    await client.send(
      new AdminGetUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
      }),
    );
    return true;
  } catch (err) {
    if (err?.name === "UserNotFoundException") return false;
    throw err;
  }
}

try {
  if (!(await userExists())) {
    await client.send(
      new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
        MessageAction: "SUPPRESS",
        UserAttributes: [
          { Name: "email", Value: username },
          { Name: "email_verified", Value: "true" },
        ],
      }),
    );
    process.stderr.write("Created Cognito user.\n");
  } else {
    process.stderr.write("User exists — password reset.\n");
  }

  await client.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      Password: password,
      Permanent: true,
    }),
  );

  process.stderr.write(
    "Done. Mint a token with yarn mint:jwt — see .cursor/skills/leetcode-dev-jwt/SKILL.md\n",
  );
} catch (err) {
  console.error(err.message ?? err);
  process.exit(1);
}
