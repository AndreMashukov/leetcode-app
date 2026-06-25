# leetcode-status-bff

Submission status polling API for the LeetCode service.

Read-only on the `leetcode-submissions-bff-dev-submissions` table.
No SQS, no bus subscription — workers write the submission row
directly; this stack polls DDB.

## Routes (all JWT-required)

| Method | Path | Handler | Notes |
|--------|------|---------|-------|
| GET | `/health` | `health` | JWT-protected liveness probe |
| GET | `/submissions/{submissionId}/status` | `getStatus` | Verifies row.userId == jwt.sub before returning |

## Cross-stack wiring

| Input | Source | Use |
|-------|--------|-----|
| `SubmissionsTableName` | `leetcode-submissions-bff-${stage}` | `SUBMISSIONS_TABLE` env var |
| `SubmissionsTableArn`  | `leetcode-submissions-bff-${stage}` | IAM resource scope |
| `UserPoolId`, `UserPoolClientId` | `leetcode-auth-${stage}` | JWT authorizer |

## Deploy

After `leetcode-auth` and `leetcode-submissions-bff` are up:

```bash
yarn deploy:status-bff
# or, from this directory:
../node_modules/.bin/serverless deploy --stage dev --region ap-southeast-1
```

## Security

- 401 if the JWT `sub` claim is missing.
- 404 (not 403) if the row exists but belongs to a different user —
  prevents probing for the existence of other users' submissions
  by guessing ULIDs.
- 400 if `submissionId` doesn't match `/^[A-Za-z0-9_-]{8,40}$/`.
- IAM scope is `dynamodb:GetItem` on the single submissions table ARN
  only. No `Query`, no `Scan`, no `UpdateItem`.
