# leetcode-problems-bff

Authoring + read API for the LeetCode-style coding platform.

## Routes

| Method | Path             | Auth          | Description                       |
| ------ | ---------------- | ------------- | --------------------------------- |
| POST   | `/problems`      | Cognito JWT   | Create a new problem              |
| GET    | `/me/problems`   | Cognito JWT   | List problems authored by caller  |
| GET    | `/problems`      | Cognito JWT   | List all problems (optional tag)  |
| GET    | `/problems/{slug}` | public      | Full problem detail by slug       |
| GET    | `/health`        | public        | Health check                      |

A trigger lambda consumes the DDB stream and emits
`ProblemCreated` / `ProblemDeleted` to the bus (sole producer).

## Deploy

```bash
# Cross-stack: requires leetcode-event-hub-dev + leetcode-auth-dev first.
cd /opt/data/serverless/leetcode-app
npx nx run leetcode-problems-bff:deploy --stage dev
```

## Stack outputs

- `ProblemsTableName`, `ProblemsTableArn`, `ProblemsTableStreamArn`
- `ApiEndpoint`
