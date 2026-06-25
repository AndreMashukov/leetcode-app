# AGENTS.md — LeetCode App

Instructions for AI agents working in this repository.

## Project overview

AWS serverless coding platform (LeetCode-style) built with **Serverless Framework v4** and **Nx**. Event-sourced / CQRS architecture. Fargate MVP sandbox for trusted/internal users. Six CloudFormation stacks share one EventBridge bus in **`ap-southeast-1`**.

Sibling apps at `../pastebin-app/` and `../url-shortener-app/` are the reference for conventions, build order, and bus wiring. This repo mirrors them.

| Stack | Directory | MCP service name (dev) | Status |
|-------|-----------|------------------------|--------|
| Event hub | `leetcode-event-hub/` | `leetcode-event-hub-dev` | scaffolded |
| Auth (Cognito) | `leetcode-auth/` | `leetcode-auth-dev` | scaffolded |
| Worker images (ECR) | `leetcode-worker-images/` | `leetcode-worker-images-dev` | scaffolded |
| Problems BFF | `leetcode-problems-bff/` | `leetcode-problems-bff-dev` | pending |
| Submissions BFF | `leetcode-submissions-bff/` | `leetcode-submissions-bff-dev` | pending |
| Status BFF | `leetcode-status-bff/` | `leetcode-status-bff-dev` | pending |
| Workers (Fargate) | `leetcode-workers/` | `leetcode-workers-dev` | pending |

**Deploy order:**
1. `leetcode-event-hub` — bus + archive
2. `leetcode-auth` — Cognito UserPool (no cross-stack inputs)
3. `leetcode-worker-images` — combined Python+Node ECR repo (no cross-stack inputs)
4. `leetcode-problems-bff` — consumes auth + bus
5. `leetcode-submissions-bff` — consumes auth + bus + workers queue
6. `leetcode-status-bff` — consumes auth + bus
7. `scripts/build-runners.sh` — builds and pushes runner image to ECR
8. `leetcode-workers` — Fargate service, consumes submissions queue

**Default stage:** `dev` · **Region:** `ap-southeast-1` · **AWS account:** 579273601730

## Architecture

See `design-research.md` (the build plan) and `system_design__architecting_a_scalable_coding_platform_like_leetcode.md` (the textbook brief this repo is implementing).

Key design rules (from `design-research.md` §10):

- **DDB stream is the SOLE event producer.** Submissions-bff never calls `PutEvents` directly; a DDB stream trigger on the submissions table re-emits as `SubmissionCreated` on the bus.
- **One combined Python+Node ECR image** in `leetcode-worker-images`. The `leetcode-workers` Fargate service consumes it. v2 splits per-language if compiled languages are added.
- **JWT required on every BFF endpoint** (problems-bff, submissions-bff, status-bff). One shared Cognito UserPool across all BFFs.
- **No Redis, no separate test-case S3 bucket at v1.** Test cases are inlined in the Problems DDB row (≤64 KiB code cap).
- **Workers are Fargate, not Lambda** — required for the long-running runner shape, warm pool (`desiredCount: 10`), and `python` / `node` invocation that Lambda cannot do cleanly.
- **No contests in v1** — drops leaderboard, two-phase processing, and pre-warm scheduling.
- **All cross-stack wiring via `${cf:...}` CFN outputs.** No SSM at MVP.

## Commands

```bash
yarn install
yarn typecheck
yarn package:event-hub && yarn deploy:event-hub   # bus first
yarn deploy:auth
yarn deploy:worker-images
yarn deploy:problems-bff
yarn deploy:submissions-bff
yarn deploy:status-bff
yarn deploy:workers    # only after scripts/build-runners.sh has pushed the image
```

Prefer Nx/yarn scripts over invoking `serverless` directly when a target exists.

## Code conventions

- **Node 20+**, TypeScript, yarn workspaces (or `npm install` if yarn isn't available — see `../url-shortener-app/`).
- Match the patterns in `../pastebin-app/` (sister repo) — same conventions, same template set, same bus-archive shape.
- Minimal diffs — only change what the task requires.
- Never commit `.env` or secrets.
- Only create git commits when the user explicitly asks.

## Related docs

- `design-research.md` — architecture deep dive + resolved design decisions
- `system_design__architecting_a_scalable_coding_platform_like_leetcode.md` — generic textbook brief this repo maps onto
- `CHANGES_2026-06-24.md` — design-research change log + verification report
- `../pastebin-app/design-research.md` — sibling repo's architecture doc (format reference)
