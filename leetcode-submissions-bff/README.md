# leetcode-submissions-bff

Submission ingest path for the LeetCode service.

## Routes (all JWT-required)

| Method | Path | Handler | Notes |
|--------|------|---------|-------|
| POST | `/problems/{slug}/submission` | `submitSolution` | 202 with `submissionId` + `statusUrl` |
| GET | `/me/submissions` | `listMySubmissions` | Query on GSI1, newest first, 50 max |
| GET | `/health` | `health` | Smoke for the auth path |

## Auth

JWT authorizer wired to `leetcode-auth-<stage>` UserPool. Client ID
is the audience. The verified claims land on `requestContext.authorizer.jwt.claims`
and we read `sub` for ownership.

## Data

- **Writes**: `SubmissionsTable` (single Put per submit; status=PENDING).
- **Reads**: `SubmissionsTable` gsi1 (list by user), `ProblemsTable`
  gsi1 (slug→problemId lookup before enqueue).
- **Emits**: SQS to `WorkQueue` with `{ submissionId, problemId, userId, language, submittedAt }`.

## Validation

- `language` ∈ { `python`, `javascript` }
- `code` non-empty string, ≤ 64 KiB UTF-8
- `code` is omitted from listMySubmissions response

## Deploy

```sh
nx run leetcode-submissions-bff:typecheck
nx run leetcode-submissions-bff:package
nx run leetcode-submissions-bff:deploy
```

## Outputs

| Name | Used by |
|---|---|
| `SubmissionsTableName`, `SubmissionsTableArn` | status-bff (read), workers (write) |
| `WorkQueueUrl`, `WorkQueueArn` | workers (consume) |
| `DlqUrl` | ops |

## What this stack does NOT do

- **No DDB stream.** Workers write back via direct UpdateItem with
  conditional expressions (status=PENDING→RUNNING→terminal). The
  bus is the wrong channel for fine-grained per-attempt writes.
- **No bus publish.** `SubmissionAccepted`/`SubmissionFailed` events
  are published by workers in `leetcode-workers`, not by this stack.
- **No public routes.** Everything is JWT-protected; even `/health`
  requires a valid token (use it to smoke the authorizer).
