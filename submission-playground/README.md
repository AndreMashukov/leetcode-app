# submission-playground

Local React UI for testing the submission flow against the deployed dev BFFs.

## Run

```bash
yarn install
yarn dev:playground
```

Opens at http://localhost:5173

## Authentication

Obtain a Cognito ID token using the **`leetcode-dev-jwt`** skill:

`.cursor/skills/leetcode-dev-jwt/SKILL.md`

Then paste the token in the playground (auto-applies on paste) or sign in with email + password.

## Flow

1. **Authenticate** (JWT required for seed/submit).
2. **Seed the problem** if `two-sum` returns 404 — click **Seed two-sum**.
3. **Load a problem** by slug (default: `two-sum`).
4. **Edit code**, pick `python` or `javascript`, click **Run submission**.
5. Poll status-bff until a terminal verdict.

## Defaults

Pre-filled with the same dev API endpoints as `smoke-tests/`:

| Service | URL |
|---------|-----|
| problems-bff | `https://73yfry46sl.execute-api.ap-southeast-1.amazonaws.com` |
| submissions-bff | `https://yffu5ff2t3.execute-api.ap-southeast-1.amazonaws.com` |
| status-bff | `https://mulz4grtp5.execute-api.ap-southeast-1.amazonaws.com` |

Settings and JWT are stored in `localStorage`. Expand **API & Cognito settings** to override endpoints.

## Troubleshooting

### HTTP 431 from Vite

Stale auth cookies on `localhost` can exceed header limits. Clear cookies for `http://localhost:5173` and reload. JWT is stored in **localStorage**, not cookies.

## Notes

- Calls the **live AWS stack** — workers must be running for submissions to complete.
- CORS is enabled on all three BFF HTTP APIs.
