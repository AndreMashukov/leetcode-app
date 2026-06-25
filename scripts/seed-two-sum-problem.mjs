#!/usr/bin/env node
/**
 * Seed the dev two-sum problem via problems-bff POST /problems.
 *
 * See .cursor/skills/leetcode-dev-jwt/SKILL.md for auth env vars.
 */

import {
  AdminInitiateAuthCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

const PROBLEMS_API =
  process.env.PROBLEMS_API ??
  "https://73yfry46sl.execute-api.ap-southeast-1.amazonaws.com";
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? "ap-southeast-1_BIhFoAA8R";
const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? "2bpmi5mtaa2eqdria5g1ih5ip9";
const REGION = process.env.AWS_REGION ?? "ap-southeast-1";
const username = process.env.COGNITO_USERNAME;
const password = process.env.COGNITO_PASSWORD;

const TWO_SUM_SEED = {
  title: "Two Sum",
  slug: "two-sum",
  description:
    "Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.",
  difficulty: "easy",
  tags: ["arrays", "hash-table"],
  examples: [
    {
      input: "nums = [2,7,11,15], target = 9",
      output: "[0,1]",
      explanation: "Because nums[0] + nums[1] == 9, we return [0, 1].",
    },
  ],
  constraints: ["2 <= nums.length <= 10^4"],
  timeLimitMs: 2000,
  memoryLimitKb: 262144,
  starterCode: {
    python: "def two_sum():\n    pass\n",
    pythonEntrypoint: "two_sum",
    javascript: "function twoSum() {}\n",
    javascriptEntrypoint: "twoSum",
  },
  testCases: [
    { input: "[2,7,11,15]\n9\n", expected: "[0,1]\n" },
    { input: "[3,2,4]\n6\n", expected: "[1,2]\n" },
  ],
};

if (!username || !password) {
  console.error(
    "Set COGNITO_USERNAME and COGNITO_PASSWORD.\n" +
      "See .cursor/skills/leetcode-dev-jwt/SKILL.md",
  );
  process.exit(1);
}

const cognito = new CognitoIdentityProviderClient({ region: REGION });

const auth = await cognito.send(
  new AdminInitiateAuthCommand({
    UserPoolId: USER_POOL_ID,
    ClientId: CLIENT_ID,
    AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
    AuthParameters: { USERNAME: username, PASSWORD: password },
  }),
);
const token = auth.AuthenticationResult?.IdToken;
if (!token) {
  console.error("Failed to mint ID token");
  process.exit(1);
}

const getRes = await fetch(`${PROBLEMS_API}/problems/two-sum`);
if (getRes.ok) {
  const existing = await getRes.json();
  process.stderr.write(`two-sum already exists (problemId=${existing.problemId})\n`);
  process.exit(0);
}

const postRes = await fetch(`${PROBLEMS_API}/problems`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(TWO_SUM_SEED),
});

const body = await postRes.text();
if (postRes.status === 409) {
  process.stderr.write("Slug conflict (409) — problem may already exist. Try Reload in the UI.\n");
  process.exit(0);
}

if (!postRes.ok) {
  console.error(`POST /problems failed (${postRes.status}): ${body}`);
  process.exit(1);
}

process.stderr.write(`Seeded two-sum: ${body}\n`);

const verify = await fetch(`${PROBLEMS_API}/problems/two-sum`);
process.stderr.write(`GET /problems/two-sum → ${verify.status}\n`);
