---
name: leetcode-dev-jwt
description: >-
  Obtain a Cognito ID token for the leetcode-app dev stage (submission
  playground, smoke tests, seed scripts). Use when the user needs to sign in,
  mint a JWT, authenticate against leetcode BFFs, or asks about Cognito
  credentials for local dev.
---

# LeetCode dev JWT

Mint a **Cognito ID token** for `dev` in `ap-southeast-1`. Never commit
passwords or tokens. Use env vars or a local `.env` (gitignored).

## Prerequisites

1. `leetcode-auth-dev` deployed (shared UserPool).
2. AWS credentials with Cognito admin API access — load from repo `.env`:
   ```bash
   set -a && source .env && set +a
   ```
3. A **dev user email** and **password** you control (pool has admin-create only; no self sign-up).

Optional overrides (defaults match `submission-playground` config):

| Variable | Source |
|----------|--------|
| `COGNITO_USER_POOL_ID` | `${cf:leetcode-auth-dev.UserPoolId}` |
| `COGNITO_CLIENT_ID` | `${cf:leetcode-auth-dev.UserPoolClientId}` |
| `AWS_REGION` | `ap-southeast-1` |

## 1. Create or reset a dev user (once)

Pick an email (Cognito username) and a password meeting pool policy (8+ chars, upper, lower, number).

```bash
export COGNITO_USERNAME='you@example.com'
export COGNITO_PASSWORD='…'   # never commit
yarn set:dev-user
```

Uses `AdminCreateUser` + `AdminSetUserPassword` via `@aws-sdk/client-cognito-identity-provider` — **no AWS CLI required**.

## 2. Mint an ID token

```bash
export COGNITO_USERNAME='you@example.com'
export COGNITO_PASSWORD='…'
yarn mint:jwt
```

Stdout is the **IdToken** (paste into submission playground → token field, or export for scripts). Stderr notes expiry (~1 hour).

## 3. Use the token

**Submission playground** (`yarn dev:playground`):

- Paste token (auto-applies on paste), or
- Email + password → **Sign in** (Cognito SRP in browser).

**Seed two-sum** (optional):

```bash
export COGNITO_USERNAME='…'
export COGNITO_PASSWORD='…'
yarn seed:two-sum
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Incorrect username or password` | Re-run `yarn set:dev-user` with known `COGNITO_PASSWORD`. |
| `Set COGNITO_USERNAME` / `Set COGNITO_PASSWORD` | Export both before yarn scripts. |
| Token expired | Mint again with `yarn mint:jwt`. |
| `aws: command not found` / broken CLI | Use `yarn mint:jwt` and `yarn set:dev-user` only. |

## Security

- Do not hardcode emails, passwords, or JWTs in source, README, or skills.
- Do not paste tokens into chat logs or commits.
- `ADMIN_USER_PASSWORD_AUTH` is dev-only on the UserPoolClient; remove for production.
