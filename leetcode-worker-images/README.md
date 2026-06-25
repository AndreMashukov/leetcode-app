# leetcode-worker-images

ECR repository for the leetcode combined Python 3.12 + Node 20 worker image.

- **Stack name:** `leetcode-worker-images-dev`
- **Repo name:** `leetcode-worker-images-dev-worker-images`
- **Resources:** 1 `AWS::ECR::Repository` (imageTagMutability=IMMUTABLE, scanOnPush=true)
- **Business logic:** none — pure infrastructure

## Why a separate stack

`leetcode-workers` (the Fargate service) is redeployed whenever runner code changes (subprocess invocation, sandbox setrlimit, timeout handling). The image is **not** redeployed on every code change — it's built by `scripts/build-runners.sh` and pushed with a git-SHA tag. Keeping the ECR repo in its own stack lets us evolve the runner code without churning the registry, and vice versa.

## Image contents (built by `scripts/build-runners.sh`)

- **Python 3.12** + stdlib (for `python` runner invocations)
- **Node 20** + npm (for `node` runner invocations)
- A small `runner.py` and `runner.js` invocation harness that reads stdin (problem code + test cases + language), writes the file to `/tmp/code.<ext>`, and execs the interpreter with `timeout=`, `setrlimit(RLIMIT_AS)`, and `RLIMIT_NPROC=1`.

The Fargate task in `leetcode-workers` selects `python` vs `node` via the `language` field on the SQS message; the image itself contains both runtimes.

## Outputs (consumed by leetcode-workers)

| Output key | What it is | Example value |
|---|---|---|
| `EcrRepoName` | The repo name (used by `docker build` / `docker push` in `scripts/build-runners.sh`) | `leetcode-worker-images-dev-worker-images` |
| `EcrRepoUri` | The full ECR URI used by the Fargate task definition's `image` field | `579273601730.dkr.ecr.ap-southeast-1.amazonaws.com/leetcode-worker-images-dev-worker-images` |
| `EcrRepoArn` | The repo ARN (used for IAM scoping) | `arn:aws:ecr:ap-southeast-1:579273601730:repository/leetcode-worker-images-dev-worker-images` |

## Build + push (after this stack is deployed)

```bash
# scripts/build-runners.sh is added in a follow-up commit (post v1.0.1).
# It will:
#   1. aws ecr get-login-password ... | docker login ...
#   2. docker build -t <repoUri>:<git-sha> leetcode-workers/docker/
#   3. docker push <repoUri>:<git-sha>
```

The Fargate task definition (in `leetcode-workers`) reads the image URI from `${cf:leetcode-worker-images-${opt:stage}.EcrRepoUri}` and is pinned to the git-SHA tag.

## Deploy

```bash
yarn deploy:worker-images
# or: NX_SKIP_NATIVE_FILE_CACHE=true npx nx run leetcode-worker-images:deploy
```

This is the **third** stack to deploy in the leetcode-app build order (after `leetcode-event-hub` and `leetcode-auth`).
