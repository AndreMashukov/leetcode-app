#!/usr/bin/env node
/**
 * Mint a Cognito ID token for local dev (no AWS CLI required).
 *
 * See .cursor/skills/leetcode-dev-jwt/SKILL.md
 */

import {
  AdminInitiateAuthCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? "ap-southeast-1_BIhFoAA8R";
const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? "2bpmi5mtaa2eqdria5g1ih5ip9";
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

const client = new CognitoIdentityProviderClient({ region: REGION });

try {
  const out = await client.send(
    new AdminInitiateAuthCommand({
      UserPoolId: USER_POOL_ID,
      ClientId: CLIENT_ID,
      AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password,
      },
    }),
  );

  const token = out.AuthenticationResult?.IdToken;
  if (!token) {
    console.error("No IdToken in response:", JSON.stringify(out, null, 2));
    process.exit(1);
  }

  process.stdout.write(token);
  process.stderr.write(`\n# expires in ~1h\n`);
} catch (err) {
  console.error(err.message ?? err);
  process.exit(1);
}
