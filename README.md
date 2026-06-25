# leetcode-app

AWS serverless coding platform (LeetCode-style). Fargate MVP sandbox for trusted/internal users. Six CloudFormation stacks on one EventBridge bus.

Siblings to [`../pastebin-app/`](../pastebin-app/) and [`../url-shortener-app/`](../url-shortener-app/). See [`design-research.md`](./design-research.md) for the architecture and [`system_design__architecting_a_scalable_coding_platform_like_leetcode.md`](./system_design__architecting_a_scalable_coding_platform_like_leetcode.md) for the source textbook brief.

## v1 scope

- JavaScript (Node 20) and Python (3.12) only — one combined ECR image, dispatched by `language` field.
- JWT-required catalog (`GET /problems`, `GET /problems/{slug}`) — no anonymous reads.
- Test cases stored inline in DDB (no separate S3 bucket).
- Async submission: `POST /submissions` → SQS → Fargate runner → status row → `GET /submissions/{id}`.
- No contests, no leaderboard, no two-phase processing in v1.
- Fargate v1 is **not** a full untrusted-code sandbox; production = ECS-on-EC2 with gVisor.

See `design-research.md` §3 and §10.1 for the full scope rationale and the production path.
