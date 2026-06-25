# leetcode-workers

Fargate workers that consume submissions from the work queue and execute
user code in a sandboxed container.

## What's here

| Path | Purpose |
|---|---|
| `runs/dispatcher.py` | Main poll loop. Long-polls SQS, claims the submission (conditional UpdateItem), runs the right runner subprocess, sets terminal status, emits event, deletes the SQS message. |
| `runs/python_runner.py` | Subprocess invoked for `language=python`. Iterates `problem.testCases`, captures stdout, matches `expected`, returns JSON `{"passedCount", "totalCount", "verdict", "runtimeMs", "memoryKb", "firstFailure"}`. |
| `runs/node_runner.js` | Same as above for `language=javascript`. Reads stdin via the `STDIN_FILE` env var (line too long for `node -e`). |
| `runs/Dockerfile` | Combined image. python:3.12-slim + node:20 + AWS CLI (v2). Two ENTRYPOINT paths (python and node) routed by the dispatcher's argv. |
| `buildspec.yml` | CodeBuild buildspec for `scripts/cb-build-runners.sh` — does `docker build` + push in a CodeBuild-managed dind container. |
| `tests/test_dispatcher_logic.py` | Hermetic unit test for `_process_one` — patches subprocess.run + SQS + DDB + EventBridge. 8 scenarios, all passing. |
| `serverless/*.yml` | CFN resources: cluster, log group, IAM roles, S3 bucket, task definition, service, security group. |
| `serverless.yml` | Stack entrypoint. Service name `leetcode-workers`. No functions; pure-resources stack. |

## Deploy

```bash
# 1. Build + push image (uses CodeBuild because this sandbox lacks a Docker daemon):
scripts/cb-build-runners.sh

# 2. Deploy the Fargate service:
yarn deploy:workers
# or
cd leetcode-workers && serverless deploy
```

## How a message is processed

```
  submissions-bff ─PUT─► work-queue ─ReceiveMessage─► dispatcher._process_one
                                                            │
                                                            ▼
                                              conditional UpdateItem (PENDING→RUNNING)
                                                            │
                                                            ▼
                                              get problem row from DDB
                                                            │
                                                            ▼
                                ┌─────────────────────────┴────────────────────────┐
                                ▼                                                  ▼
                       python_runner.py                                  node_runner.js
                       (subprocess)                                      (subprocess)
                                │                                                  │
                                └─────────────────────────┬────────────────────────┘
                                                          ▼
                                              UpdateItem (RUNNING→ACCEPTED|WRONG|…)
                                                          │
                                                          ▼
                                                  emit SubmissionAccepted|Failed
                                                          │
                                                          ▼
                                                  DeleteMessage from SQS
```

## Design decisions

- **Combined image**, dispatched by `language` — see design-research §10.4. One ECR repo, one task definition, smaller blast radius.
- **1 vCPU / 2 GB task size** — Python's default heap is ~512MB at startup; 2GB gives headroom for the boto3 client, SQS long-poll buffer, and a single test-case subprocess up to ~512MB. Inner `setrlimit` is NO-OP at v1 (the design §5 fix moves the limit to a child process via `preexec_fn=resource.setrlimit`); Fargate task mem limit IS the outer sandbox.
- **Public subnets, public IP** — no NAT required, acceptable for v1 (internal/trusted users per AGENTS.md).
- **SQS long-poll in dispatcher loop** — `WaitTimeSeconds=20`, `MaxNumberOfMessages=1`. Fargate can't natively consume SQS as event source mappings (those are Lambda-only), so the long-poll loop is the simplest path for v1. For higher throughput we'd add CW-driven capacity-provider autoscaling.
- **Conditional UpdateItem for claim** — `PENDING → RUNNING` only if status is `PENDING`. Prevents double-processing on SQS redelivery (visibility-timeout expiry).
- **Failure logs to S3, not DDB** — keeps DDB rows small and lets status-bff return a signed URL for the traceback blob.
- **The dispatcher's inner sandbox `setrlimit` is NO-OP** — moving to child process via `preexec_fn=resource.setrlimit` is the v1.1 fix.

## Testing

```bash
python3 tests/test_dispatcher_logic.py
```

8 scenarios:
1. Python ACCEPTED happy path (runner invoked, ACCEPTED, 2/2, event emitted, SQS deleted)
2. Duplicate claim returns early (idempotent)
3. COMPILE_ERROR path (s3LogKey set, SubmissionFailed{failureType=compile} emitted)
4. JavaScript ACCEPTED path (node_runner.js invoked, 1/1)
5. WRONG_ANSWER path
6. Unsupported language drops message (no DDB mutation, SQS deleted)
7. Missing submission row → RUNTIME_ERROR + SubmissionFailed
8. Malformed JSON body drops SQS message

All pass without any AWS calls.
