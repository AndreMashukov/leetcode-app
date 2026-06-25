# LeetCode Coding Platform — Architectural Research

> Companion to `system_design__architecting_a_scalable_coding_platform_like_leetcode.md`
> (the generic textbook design school brief).
>
> **Scope:** This research proposes a concrete AWS architecture for a
> LeetCode-style coding platform, names the specific templates in
> `templates/` to fork (or notes when a new resource is required),
> lists the per-stack resources that will be created, and surfaces the
> design decisions the system-design doc left implicit (Fargate vs
> Lambda for code execution, inline test cases in DDB vs S3,
> problem-browsing as JWT-authed not public, JWT-poll pattern for async
> submission status, the worker SQS contract, and the absence of
> contest/leaderboard subsystems in v1). See §10 for the resolved
> architecture concerns and §11 for open questions deferred to the
> user.
>
> **v1 scope (post-user-review, 2026-06-24):** no contests, no
> leaderboard, no two-phase processing. Single region
> `ap-southeast-1`. Languages: **Python 3 and JavaScript (Node 20)**.
> Auth: **Cognito JWT, required on every endpoint**. Worker pool:
> **Fargate min=10, max=50**, one combined Python+Node runner image.
> v1 is a **Fargate MVP sandbox** for internal/trusted users; true
> per-submission container isolation (custom seccomp / gVisor /
> Docker-in-Docker style controls) moves to an ECS-on-EC2 worker fleet
> if the platform accepts arbitrary untrusted public code.
>
> **Sibling reference:** `../pastebin-app/design-research.md` and
> `../url-shortener-app/design-research.md` — both are CQRS Lambda
> apps in the same monorepo. This doc mirrors their format, then
> departs where LeetCode's requirements demand it (Fargate workers,
> inline test cases in DDB, JWT-required catalog).

---

## 0. Where this fits in the existing repo

The repo has the right building blocks for **everything except the code
execution fleet**. The CQRS BFFs, the EventBridge bus, the Cognito
auth, and the SQS-driven async pattern all match what LeetCode needs
at the read/ingest edge. The missing piece is a **containerized,
long-running, sandboxed worker pool** — Fargate with custom Docker
images. That is the only meaningful new primitive this design adds.

| Building block                                 | Comes from                                            | Notes |
| ---------------------------------------------- | ----------------------------------------------------- | ----- |
| Service skeleton (Lambda + HTTP API + IAM)     | `templates/template-bff-service/`                     | Direct fit for problems-bff, submissions-bff, status-bff |
| EventBridge bus (per subsystem)                | `templates/template-event-hub/`                       | One bus for leetcode-app; carries submission lifecycle events |
| Single-Table Design DDB table + stream         | `templates/template-bff-service/serverless/dynamodb.yml` | Problems table; submissions table; both single-table |
| Listener + trigger leg (CDC + materialize)     | `templates/template-bff-service/src/{listener,trigger}/` | Not needed at MVP — workers write DDB directly; CDC is overkill when there's no read-model fanout |
| Cognito User Pool + JWT authorizer             | `templates/template-bff-service/serverless/cognito.yml` (see `product-catalog-bff` for the production version) | All three BFFs share one UserPool via a new `leetcode-auth` stack |
| Idempotency, order tolerance, single-table     | _Software Architecture Patterns for Serverless_, Ch. 4–5 | Submission dedupe via `submissionId` as PK; worker updates use conditional `PENDING → RUNNING → terminal` transitions |
| Anti-corruption layer at the status edge       | _Book_, Ch. 7 (ESG pattern)                            | status-bff shapes internal DDB row into the wire format the client polls |
| Async ingest → SQS → worker pool               | SQS standard queue + Fargate Service                   | **NEW PRIMITIVE** — no template, but trivial CloudFormation |
| Fargate task definition with cgroups + private networking | Direct CFN `AWS::ECS::TaskDefinition` + `AWS::ECS::Service` | **NEW PRIMITIVE** — v1 Fargate sandbox; see §3 / §5 for limits |
| Worker Docker image (Python + Node runners)    | Custom Dockerfile in `leetcode-workers/`               | **NEW PRIMITIVE** — single combined runner image; see §5.2 |
| Working examples to compare against            | `../pastebin-app/`, `../url-shortener-app/`, `../product-catalog-bff/` | Same CQRS conventions; same Cognito wiring; same deploy order |

> The system-design doc sketches **four** monolith-style services
> (Problems Service, Evaluation Service, Execution Workers,
> Leaderboard Service). The book and this repo's existing apps both
> push toward **BFF-per-concern + DDB-as-cache**. We keep that posture
> for problems / submissions / status (all three BFFs are Lambda
> HTTP API + DDB), and **break from it only for the execution
> worker fleet** — that fleet uses Fargate in v1 because the work is
> long-running and benefits from a warm container pool. This is **not**
> the same as Docker-in-Docker / custom seccomp isolation; see §3 and
> §5 for the v1 threat-model boundary.

---

## 1. The right primitive: BFFs at the edge, a worker pool in the middle

The system-design doc puts problems browsing, submission acceptance,
execution, and the leaderboard in one logical diagram. In this repo's
patterns, the right move is to split those into **independently
deployable stacks with single responsibilities**, then introduce a
**container-based worker pool** for the bit that is genuinely
different — running untrusted user code.

### Proposed service decomposition

| Stack                    | Role                                                | Compute    | Trigger              | DDB writes | Public? |
| ------------------------ | --------------------------------------------------- | ---------- | -------------------- | ---------- | ------- |
| `leetcode-event-hub`     | EventBridge bus + archive                           | n/a        | n/a                  | n/a        | n/a     |
| `leetcode-auth`          | Cognito User Pool + App Client + Hosted UI          | n/a        | n/a                  | n/a        | n/a     |
| `leetcode-problems-bff`  | `GET /problems`, `GET /problems/:id`                | Lambda     | HTTP API (JWT)       | write      | **no — JWT required** |
| `leetcode-submissions-bff` | `POST /problems/:id/submission` (async ingest)     | Lambda     | HTTP API (JWT)       | write (submission row) | no — JWT required |
| `leetcode-status-bff`    | `GET /submissions/:submission_id/status` (polling)   | Lambda     | HTTP API (JWT)       | read       | no — JWT required |
| `leetcode-workers`       | Code execution fleet                                | **Fargate** | SQS long-poll        | write (submission row update) | internal only |

**Six stacks, three of which are pure Lambda BFFs**
(`problems-bff`, `submissions-bff`, `status-bff`); two are
non-compute infrastructure stacks (`leetcode-event-hub` for the bus,
`leetcode-auth` for Cognito); and one is the Fargate worker pool
(`leetcode-workers`). The Fargate service is the only one that
breaks the repo's "everything is Lambda" convention. That is
intentional and explained in §3.

**Why JWT on every endpoint (no anonymous browsing):** the user
confirmed in the design review (2026-06-24, answer to question 7)
that **all endpoints require Cognito JWT auth**. This matches
`url-shortener-app/` (Cognito on the write path) and `pastebin-app/`
(Cognito on `POST /pastes`). For the leetcode platform, it means
problems-bff / submissions-bff / status-bff all share the same
JWT authorizer attached to the same Cognito UserPool.

**Why a separate `leetcode-auth` stack:** the UserPool must be
referenced by **three** BFF stacks (problems, submissions, status)
and the EventBridge rule that backs the SQS-to-workers handoff is
cleaner when one stack owns it. Following the pastebin convention
(author-bff owns Cognito, exports `UserPoolId` + `UserPoolClientId`),
the cleanest analog here is a tiny dedicated `leetcode-auth` stack
that exports those same outputs. The alternative — making
`problems-bff` the auth owner — couples problem reads to user
provisioning, which is the wrong direction.

**Why a `status-bff` separate from `submissions-bff`:** the design
doc's polling pattern needs an endpoint the client can hit every
1–2 seconds for as long as a submission is in flight. Putting that on
the same Lambda as the ingest creates two scaling profiles: ingest is
spiky at submit-time, status is a steady drip for the entire polling
window. Separate BFFs scale independently. Both read from the same
DDB row, but they have different IAM profiles (submissions-bff writes
SQS; status-bff only reads DDB).

**Why we do NOT need a CDC listener at MVP:** the worker writes the
final submission result directly back to DDB. The status-bff reads
DDB on each poll. There is no downstream read-model fanout yet — no
leaderboard (no contests), no analytics. If v2 adds analytics, an
event-hub + listener leg is the textbook add (mirrors
`url-shortener-analytics-bff`). For v1, **direct writes from
workers** are simpler and adequate.

**What we explicitly do NOT build in v1** (and why):

| Skipped                  | Reason                                                                | Revisit if... |
| ------------------------ | --------------------------------------------------------------------- | ------------- |
| `leetcode-contest-bff`   | User dropped contests from v1 scope (review 2026-06-24, Q1)            | A future v2 introduces timed contests |
| `leetcode-leaderboard-bff` | Same reason — no contest, no ZSET, no leaderboard                      | A future v2 introduces timed contests |
| Two-phase processing      | Same reason — phase 2 (90% test cases post-contest) is a contest-only concern | A future v2 introduces timed contests |
| Pre-warm scheduler        | Same reason — pre-warm is to absorb contest-start spikes               | A future v2 introduces timed contests |
| Read-replica database     | DDB lean views + on-demand tables cover the read load at MVP scale     | Daily active users cross ~10K or read p95 crosses 50ms |
| CDN                       | Same as pastebin — defer until traffic profile justifies it            | Hot problems (>1000 RPS) or global latency demand |
| Custom compile step       | We support only interpreted languages (Python, JS); no compile, no warm container cache | v2 adds a compiled language (Java, Go, C++, Rust) |

---

## 2. Event topology

The leetcode-app uses one EventBridge bus for everything related to
the submission lifecycle. Problems-bff does not publish events
(problem catalog CRUD is auth'd writes, no fanout needed at MVP).
Workers publish a single event type on submission completion.
status-bff does not subscribe — it polls DDB directly. This is
deliberately minimal.

### Domain events

| Event                | Source                  | Detail                                                  | Consumed by (v1) |
| -------------------- | ----------------------- | ------------------------------------------------------- | ---------------- |
| `SubmissionAccepted` | `leetcode.workers`     | `{ submissionId, userId, problemId, language, runtimeMs, memoryKb, acceptedAt }` | none at v1 (downstream consumers future) |
| `SubmissionFailed`   | `leetcode.workers`     | `{ submissionId, userId, problemId, language, failureType, message }` | none at v1 (could feed a future analytics-bff) |

Two events, two sources, zero subscribers at v1. The events exist
**for future extensibility**, not because anything today consumes
them. This is intentional: the alternative — bus-only when there's
no listener — would mean dropping the bus and adding it later when
v2 ships a leaderboard or analytics. Easier to declare the bus and
have it ready.

### Event shape (aligned with `aws-lambda-stream`)

`aws-lambda-stream` is the runtime pattern the sibling apps use for
their `trigger` / `listener` legs. We do not need those legs at v1,
but the **event envelope** is the same so a future consumer can
plug in without changing the producer:

```json
{
  "source": "leetcode.workers",
  "detail-type": "SubmissionAccepted",
  "detail": {
    "metadata": {
      "id": "<uuid v4>",
      "version": "v1",
      "createdAt": "2026-06-24T05:51:00.000Z"
    },
    "data": {
      "submissionId": "8c4d2a1f6b9e...",
      "userId": "user-uuid-from-cognito",
      "problemId": "two-sum",
      "language": "python",
      "runtimeMs": 47,
      "memoryKb": 8192,
      "acceptedAt": "2026-06-24T05:51:01.234Z"
    }
  }
}
```

The `metadata.id` is the **event id** (not the submission id) — it
uniquely identifies the event for idempotency on the consumer side.
The `metadata.createdAt` is server-side, not client-claimable. The
`data` block is the domain payload.

**Why no `anything-but` filter:** the workers do not subscribe to
their own bus. There is no anti-feedback guard because there is no
loop. Future consumers (analytics, leaderboard) will need the
guard; that goes in their `Events:` block, not the worker's.

**EventBus naming:** `leetcode-event-hub-<stage>-bus` (same pattern
as `pastebin-event-hub-<stage>-bus`). Single bus for the whole
leetcode-app. If a v2 introduces a separate bounded context (e.g.,
`leetcode-contest`), it gets its own bus and stack.

---

## 3. Why Fargate for the workers, Lambda for everything else

The system-design doc is explicit about why **not** Lambda for code
execution:

> "Serverless functions (like AWS Lambda) seem appealing for automatic
> scaling, but they suffer from cold starts (delays of 500ms to 2
> seconds when spinning up new instances). During a contest spike,
> thousands of users would hit this latency penalty simultaneously.
> Instead, Containerization (Docker) is the optimal choice."

The reasoning is correct, but the doc's framing is contest-centric.
The same argument applies even **without** contests: every first
submission in a cold Lambda container pays 500ms–2s before the user
code even starts running. On a polling UX where the user is waiting
for `submission_id` to flip from `PENDING` to `RUNNING`, that
latency is felt immediately.

### Why not Lambda for the worker pool

| Concern                            | Lambda limit                                              | Fargate fit                                                |
| ---------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| Per-submission runtime             | 15 min max                                                | No limit (practical cap by task timeout, default 30 min)   |
| Memory ceiling                     | 10 GB                                                     | Up to 120 GB                                               |
| Ephemeral storage                  | 10 GB `/tmp`                                              | Up to 200 GB volume mount                                  |
| Cold start                         | 500ms–2s on first invoke in a region                      | Warm pool via `desiredCount: 10` (the user's target)       |
| Runtime sandbox                    | Lambda runtime sandbox; no warm worker process | Fargate task boundary + resource limits in v1; ECS-on-EC2 required for custom seccomp / per-submission containers |
| Language compile                   | No persistent build cache between invocations            | Container image bakes the language runtime + any pip/npm cache |
| Cost at steady state               | $0.0000166667 per GB-second (Lambda)                               | $0.04048/vCPU-hour on-demand; ~$0.01012/vCPU-hour on Fargate Spot                     |

The last row is the only place Lambda wins — and only at very low
utilization. With min=10 / max=50 warm Fargate tasks (the user's
target), the combined runner container comes out roughly **~$180/month
on-demand** for the 10-task floor (or **~$55/month on Spot**, before
VPC endpoint hourly charges). That is more than Lambda at low utilization, but
Lambda **cannot satisfy the warm-pool / long-running worker shape**.
Fargate v1 also does **not** satisfy the full custom-seccomp /
Docker-in-Docker sandbox promised by the generic design doc; it is the
smallest AWS-managed container step that fits an internal MVP. If the
platform must safely execute arbitrary public code, move the worker
fleet to ECS-on-EC2 (see §10.1).

> **Future v2 note:** if the contest feature is reintroduced, the
> pre-warm scheduler raises `desiredCount` from 10 to a contest-sized
> number (50, 100, 200) at T-5 min via Fargate Service auto-scaling
> on a scheduled action. The min=10 baseline absorbs normal spikes
> without the pre-warm hop. Today, with no contests, 10 is the
> floor and we let auto-scaling climb to 50 if SQS backlog grows.

### Fargate sizing for v1

Per the user's answer to question 4, **pre-warm target = 10**. Fargate
Service config:

```yaml
DesiredCount: 10          # always-warm baseline
DeploymentConfiguration:
  MinimumHealthyPercent: 100
  MaximumPercent: 200     # roll forward cleanly without dropping capacity
AutoScaling:
  MinCapacity: 10
  MaxCapacity: 50
  StepScaling:
    ScaleOut:
      Metric: ApproximateNumberOfMessagesVisible / RunningTaskCount
      Threshold: 50       # backlog per running task
    ScaleIn:
      Metric: ApproximateNumberOfMessagesVisible
      Threshold: 0
      EvaluationPeriods: 10
```

**Backlog scale-out target:** 50 visible messages per running task.
The v1 runner loop processes one SQS message at a time (`max=1`), so
this is **not** per-task concurrency. A task with 0.5 vCPU and 1 GB RAM
can comfortably process short interpreted-language submissions in
series; the 50-message target is just the point where CloudWatch
step-scaling starts adding tasks. ECS target tracking does not expose
`SQSQueueVisibleMessageCount` as a predefined metric; implement this
with CloudWatch metric math + step scaling (see §10.5).

**Per-task resource limits (matches design doc §"Sandboxing"):**

```yaml
ContainerProperties:
  Cpu: 512          # 0.5 vCPU
  Memory: 1024      # 1 GB (host limit; runner inside caps at 512 MB)
  Environment:
    - Name: EXEC_TIMEOUT_MS
      Value: "5000"
    - Name: MEM_LIMIT_MB
      Value: "512"
    - Name: NETWORK_MODE
      Value: "aws-endpoints-only"  # task egress limited by SG + VPC endpoints
```

The v1 sandbox is the Fargate task boundary plus inner process limits:
memory `setrlimit`, wall-clock timeout enforcement, non-root user,
read-only root filesystem where Fargate supports it, and private
networking restricted to AWS VPC endpoints. There is no inner CPU
`setrlimit` in the v1 sketch; CPU is bounded by the Fargate task's
0.5 vCPU allocation and the parent timeout. Fargate does **not**
support privileged Docker-in-Docker, custom container runtimes such as
`runsc`, or arbitrary task-level seccomp profiles. Those controls
require an ECS-on-EC2 worker fleet (see §10.1).

### What we drop from the system-design doc

The doc describes a leaderboard service backed by Redis ZSET. We are
not building that — see §10.6.

The doc describes a "read-replica database" for the Problems
Service. In this repo's patterns the read model is a **DDB lean
view**, optionally fronted by DAX. At MVP scale (a few hundred
problems, a few thousand reads/sec) DDB on-demand is sufficient; no
replica, no DAX. Add DAX if read p95 crosses 10ms.

---

## 4. The full architecture

```
                                 ┌─────────────────────┐
                                 │  Cognito UserPool   │
                                 │  (leetcode-auth)    │
                                 └──────────┬──────────┘
                                            │ JWT
                                            ▼
┌──────────────┐         ┌──────────────────────────────┐         ┌──────────────────────┐
│   Browser    │  JWT    │  problems-bff                │   DDB   │  problems-table      │
│   (client)   │ ──────► │  GET /problems               │ ──────► │  pk = PROB#<slug>    │
│              │         │  GET /problems/:id           │         │  inline testCases    │
│              │         │  POST /problems (admin)      │         └──────────────────────┘
│              │         └──────────────┬───────────────┘
│              │                        │
│              │  JWT                   │ POST /problems/:id/submission
│              │ ─────────────────────────────────────────────────────┐
│              │                        ▼                              │
│              │         ┌──────────────────────────────┐             │
│              │  JWT    │  submissions-bff             │             │
│              │ ◄────── │  validates, drops to SQS,    │             ▼
│              │         │  writes submission row,      │    ┌──────────────────────┐
│              │         │  returns submission_id       │    │  submissions-queue   │
│              │         └──────────────────────────────┘    │  SQS standard        │
│              │                        │                      │  + DLQ                │
│              │  JWT                   │ writes               └──────────┬───────────┘
│              │ ◄────────────────────────────────────────────┐             │
│              │                        ▼                      │             │
│              │         ┌──────────────────────────────┐      │             │
│              │         │  submissions-table           │ ◄────┘             │
│              │         │  pk = SUB#<submissionId>     │                    │
│              │         │  GSI1: userId (HASH)         │                    │
│              │         └──────────────────────────────┘                    │
│              │                        ▲                                     │
│              │  JWT                   │ updates                             │
│              │ ◄────────────────────────────────────────────────┐            │
│              │                        │                        │            │
│              │                        │   ┌────────────────────┴─────┐      │
│              │                        │   │  leetcode-workers        │      │
│              │                        │   │  Fargate service         │      │
│              │                        │   │  - python-runner:latest  │ ◄────┘
│              │                        │   │  - node-runner:latest    │
│              │                        │   │  Fargate MVP sandbox       │
│              │                        │   │  10 tasks always warm   │
│              │                        │   └─────────────┬────────────┘
│              │         ┌──────────────────────────────┐  │
│              │         │  status-bff                  │  │ emits SubmissionAccepted/Failed
│              │         │  GET /submissions/:id/status │  │  on EventBridge bus (future)
│              │         │  reads submissions-table     │  │
│              │         └──────────────────────────────┘  │
│              │                                            │
└──────────────┘                                            ▼
                                                  ┌────────────────────┐
                                                  │  leetcode-event-hub │
                                                  │  EventBridge bus    │
                                                  │  + archive          │
                                                  └────────────────────┘
```

### Why this shape

- **All three user-facing BFFs are Lambda + HTTP API** with the same
  Cognito JWT authorizer. This is the repo's pattern (pastebin,
  url-shortener). No new Lambda scaffolding needed.
- **The worker pool is the only Fargate service.** It is a single
  CFN stack that declares the task definition, the service, the
  autoscaling config, the SQS policy, the IAM role, the ECR repo
  (two: `python-runner`, `node-runner`), and a CloudWatch log group.
- **One bus, no listeners at v1.** When v2 ships analytics or a
  leaderboard, the consumer stack adds a rule + SQS + listener leg,
  exactly the pattern in `url-shortener-analytics-bff`.
- **DDB tables are owned by the BFF that uses them.** problems-table
  is owned by problems-bff; submissions-table is owned by
  submissions-bff. Workers import the table ARN for IAM and the
  table name for the SDK. Cross-stack wiring via `${cf:...}` outputs,
  same convention as pastebin.
- **The auth stack owns Cognito.** problems-bff, submissions-bff,
  status-bff all import `UserPoolId` + `UserPoolClientId` outputs
  from `leetcode-auth`. New users on the platform are
  admin-provisioned in dev (matches the pastebin e2e pattern) and
  self-signup via Hosted UI in prod.

### Per-stack resources (what `sls deploy` creates)

#### `leetcode-event-hub` (forked from `template-event-hub`)
- `AWS::Events::EventBus` named `leetcode-event-hub-<stage>-bus`
- `AWS::Events::Archive` (everything-but-fault) → S3
- Outputs: `busName`, `busArn`

#### `leetcode-auth` (new — small CFN stack)
- `AWS::Cognito::UserPool` named `leetcode-auth-<stage>-users`
  - Self-signup disabled in dev, enabled in prod
  - Password policy: 12+ chars, mixed case, digit, symbol
  - MFA optional in dev, TOTP in prod
  - Email verification required
- `AWS::Cognito::UserPoolClient` named `leetcode-auth-<stage>-client`
  - Auth flows: `ALLOW_USER_SRP_AUTH`, `ALLOW_REFRESH_TOKEN_AUTH`
  - No client secret (machine-to-machine uses Cognito JWT directly)
- `AWS::Cognito::UserPoolDomain` (`<stage>-leetcode-auth`) for Hosted UI
- Outputs (CFN exports):
  - `UserPoolId`
  - `UserPoolArn`
  - `UserPoolClientId`
- Why separate: shared across problems-bff, submissions-bff,
  status-bff; deploy cadence independent of any BFF; users
  provisioned once and live across all stacks.

#### `leetcode-problems-bff` (forked from `template-bff-service`)
- `AWS::DynamoDB::Table` `leetcode-problems-bff-<stage>-problems`
  - `pk` (S, HASH) = `PROB#<slug>` — slug is the problem identifier
    (e.g., `two-sum`)
  - `sk` (S, RANGE) = `META`
  - GSI1: not needed at MVP (problems are read by `pk` only)
  - **No stream** — no event-publishing, no listener
  - Schema per row:
    ```
    pk                    PROB#two-sum
    sk                    META
    slug                  two-sum
    title                 Two Sum
    description           <markdown>
    difficulty            easy | medium | hard
    tags                  ["array", "hash-table"]
    starterCode.python    "def two_sum(nums, target):\n    ..."
    starterCode.javascript "function twoSum(nums, target) {\n    ..."
    testCases             [
                           { input: "[2,7,11,15]\n9\n", expected: "[0,1]\n" },
                           ...
                         ]
    timeLimitMs           2000
    memoryLimitKb         262144
    createdAt             2026-06-24T05:51:00.000Z
    updatedAt             2026-06-24T05:51:00.000Z
    createdBy             <cognito sub of admin>
    ```
- Lambdas (3, shared IAM role):
  - `listProblems` — `GET /problems` (JWT); Query by `pk begins_with PROB#`
  - `getProblem` — `GET /problems/{slug}` (JWT); GetItem by `pk`
  - `upsertProblem` — `POST /problems` (JWT, requires `admin` group);
    PutItem with `ConditionExpression: attribute_not_exists(pk)` for
    create, UpdateItem for modify
- HTTP API with JWT authorizer attached to the leetcode-auth
  UserPool. No anonymous routes — every endpoint validates the token.
- IAM: `dynamodb:Query` + `GetItem` + `PutItem` + `UpdateItem` on the
  problems table.
- Outputs: `ProblemsTableName`, `ProblemsTableArn`.

#### `leetcode-submissions-bff` (forked from `template-bff-service`)
- `AWS::DynamoDB::Table` `leetcode-submissions-bff-<stage>-submissions`
  - `pk` (S, HASH) = `SUB#<submissionId>`
  - `sk` (S, RANGE) = `META`
  - GSI1: `userId` (HASH) + `submittedAt` (RANGE) — for `GET /me/submissions`
  - GSI2: `status` (HASH) + `submittedAt` (RANGE) — sparse, only
    rows in `RUNNING` state; for worker claim coordination
  - **No stream** — workers update rows directly
  - Schema per row:
    ```
    pk                    SUB#8c4d2a1f6b9e...
    sk                    META
    submissionId          8c4d2a1f6b9e...
    userId                <cognito sub>
    problemId             two-sum
    language              python | javascript
    code                  <user-submitted source>
    status                PENDING | RUNNING | ACCEPTED | WRONG_ANSWER | TIMEOUT | RUNTIME_ERROR | COMPILE_ERROR
    resultSummary         { passedCount, totalCount, runtimeMs, memoryKb, failedCaseIndex }
    submittedAt           2026-06-24T05:51:00.000Z
    acceptedAt            null (filled by worker)
    s3LogKey              submissions/<submissionId>.log (only on failure)
    ```
- `AWS::SQS::Queue` `leetcode-submissions-bff-<stage>-work-queue`
  - VisibilityTimeout: 180 seconds (3x the worker exec timeout +
    DDB/S3/EventBridge overhead); workers can extend visibility if a
    future language has longer wall time
  - MessageRetentionPeriod: 4 days
  - Redrive: `maxReceiveCount=3` to DLQ
- `AWS::SQS::Queue` `<...>-work-queue-dlq` for poison messages
- Lambdas (3, shared IAM role):
  - `submitSolution` — `POST /problems/{slug}/submission` (JWT);
    validates body (`language`, `code`); **size cap: 64 KiB code**
    (intentionally lower than pastebin because solutions are small);
    checks the
    problem exists (GetItem on problems-table); creates the
    submission row (`status=PENDING`, `submittedAt=now`); enqueues
    SQS message `{ submissionId, problemId, language }`; returns
    `{ submissionId, statusUrl }` to the client.
  - `listMySubmissions` — `GET /me/submissions` (JWT); Query on GSI1.
  - `health` — `GET /health` (JWT; documented as "any valid token").
- HTTP API with JWT authorizer on the leetcode-auth UserPool.
- IAM:
  - `dynamodb:GetItem` on problems-table (existence check before enqueue)
  - `dynamodb:PutItem` on submissions-table
  - `dynamodb:Query` on submissions-table GSI1
  - `sqs:SendMessage` on the work-queue
- Outputs: `SubmissionsTableName`, `SubmissionsTableArn`, `WorkQueueUrl`,
  `WorkQueueArn`, `DlqUrl`.

#### `leetcode-worker-images` (NEW — ECR bootstrap)
- `AWS::ECR::Repository` `leetcode-workers-<stage>-runner`
- Outputs: `RunnerImageUri`
- Why separate: the ECS service cannot start until an image exists.
  Create the repository first, push the image, then deploy
  `leetcode-workers`.

#### `leetcode-status-bff` (forked from `template-bff-service`)
- No DDB table — read-only on the submissions-table imported from
  submissions-bff.
- Lambdas (2, shared IAM role):
  - `getStatus` — `GET /submissions/{submissionId}/status` (JWT);
    GetItem on submissions-table; checks the `userId` on the row
    matches the requesting JWT's `sub` claim (so users cannot poll
    each other's submissions); returns `{ status, resultSummary, acceptedAt }`.
  - `health` — `GET /health` (JWT).
- HTTP API with JWT authorizer on the leetcode-auth UserPool.
- IAM: `dynamodb:GetItem` on submissions-table only.
- **No outputs.** This stack consumes; it does not export.

#### `leetcode-workers` (NEW — Fargate + SQS consumer)
- **No HTTP API, no Cognito, no DDB stream.**
- Imports `RunnerImageUri` from `leetcode-worker-images` — this stack
  does **not** create ECR repositories.
- `AWS::ECS::Cluster` `leetcode-workers-<stage>` (Fargate, FARGATE
  capacity providers)
- `AWS::ECS::TaskDefinition` `leetcode-workers-<stage>-runner`:
  - Requires compatibilities: `["FARGATE"]`
  - Network mode: `awsvpc`
  - CPU: `512`, Memory: `1024`
  - Execution role: ECR pull + CloudWatch logs write
  - Task role: SQS ReceiveMessage/DeleteMessage on work-queue,
    DDB GetItem/UpdateItem on submissions-table, DDB GetItem on
    problems-table, S3 PutObject on the logs bucket (only for
    failures), and `events:PutEvents` on the bus if v1 keeps
    `SubmissionAccepted` / `SubmissionFailed` publication
  - Container definitions: a **single** container that runs both
    runners, dispatched by `language` field. (See §5.2 for why
    one image instead of two services.)
- `AWS::ECS::Service` `leetcode-workers-<stage>`:
  - Launch type: FARGATE
  - DesiredCount: 10 (per user answer to question 4)
  - DeploymentConfiguration: MinHealthyPercent=100, MaximumPercent=200
  - NetworkConfiguration: awsvpc with private subnets, no NAT.
    Required VPC endpoints: SQS, DynamoDB, S3, ECR API, ECR DKR,
    CloudWatch Logs, and EventBridge (if worker events stay enabled).
  - SecurityGroup: no internet egress; allow egress only to the VPC
    endpoint security groups / prefix lists above. This restricts the
    **worker task**; it is not a per-submission `--network=none`.
- `AWS::ApplicationAutoScaling::ScalableTarget` + ScalingPolicy on
  `ECSService`, MinCapacity=10, MaxCapacity=50. Use CloudWatch
  metric-math/step-scaling on SQS backlog per running task, not a
  nonexistent ECS predefined `SQSQueueVisibleMessageCount` metric.
- `AWS::SQS::Queue::Policy` allowing the task role to consume.
- `AWS::S3::Bucket` `leetcode-workers-<stage>-logs` (private, SSE-S3,
  lifecycle rule: IA at 30d, expire at 365d) — workers write
  failure traces here so users can see runtime errors.
- `AWS::CloudWatch::LogGroup` `leetcode-workers-<stage>-runner`
  with retention=14 days.
- Outputs: `ClusterName`, `ServiceName`, `TaskDefinitionArn`,
  `LogsBucketName`.

> **Why a single task with both runners, not two services:** Python
> and Node user code never co-execute in one submission — the row's
> `language` field picks exactly one runner. One task definition
> with a dispatcher that reads `language` and `exec`s into the right
> runner avoids two services, two task defs, per-language queues, and
> halves the warm-pool cost. The trade-off is a slightly larger
> container image (both runtimes baked in), which is acceptable at
> ~400 MB total. See §10.4 for the decision rationale.

### Stack deployment order

```
1. leetcode-event-hub                  (no dependencies)
2. leetcode-auth                       (no dependencies)
3. leetcode-problems-bff               (depends on busName + UserPoolId)
4. leetcode-submissions-bff            (depends on busName + UserPoolId + problems-table outputs)
5. leetcode-status-bff                 (depends on UserPoolId + submissions-table outputs)
6. leetcode-worker-images              (creates ECR repo)
7. build + push runner image           (uses RunnerImageUri output)
8. leetcode-workers                    (depends on queue/table/bus outputs + pushed image)
```

After step 8, `sls deploy` for any stack alone is safe; cross-stack
wiring via `${cf:...}` resolves on every deploy (no `sls deploy
--all` needed for routine updates).

---

## 5. Deep-dive 1 — Sandbox configuration for the execution container

The system-design doc is very specific about sandbox requirements:

> - CPU limits are strictly enforced (e.g., maximum 0.5 vCPU).
> - Memory is capped (e.g., 512 MB) to prevent out-of-memory crashes.
> - Network access is completely disabled.
> - The filesystem is mounted as read-only.
> - System calls are restricted using `seccomp` profiles.

The generic requirements are the production target. In **Fargate v1**,
we implement the parts Fargate actually exposes: task-level CPU/memory,
inner `setrlimit`, timeout enforcement, non-root execution, and
AWS-only private networking. Custom seccomp and true per-submission
`--network=none` move to the ECS-on-EC2 path in §5.4 / §10.1.

### 5.1 The runner subprocess contract

The runner is a small Python service that polls SQS, dequeues a
submission message, fetches the problem + submission rows from
DDB, and executes the user code. For each submission:

```
runner_loop():
    msg = sqs.receive_message(work_queue, max=1, wait=20s)
    if not msg: continue
    submission = ddb.get_item(submissions_table, pk=msg.submissionId)
    problem = ddb.get_item(problems_table, pk=submission.problemId)

    # claim once; redeliveries/noisy workers cannot double-run it
    worker_id = os.environ["ECS_TASK_ID"]
    ddb.update_item(
        submissions_table,
        status=RUNNING,
        startedAt=now,
        workerId=worker_id,
        attempt=if_not_exists(attempt, 0) + 1,
        ConditionExpression="status = :pending",
    )

    try:
        result = execute_user_code(
            language=submission.language,
            code=submission.code,
            test_cases=problem.testCases,
            time_limit_ms=problem.timeLimitMs,
            mem_limit_mb=512,           # hard inner cap
        )
        ddb.update_item(submissions_table,
                        status=ACCEPTED if result.all_passed else WRONG_ANSWER,
                        resultSummary=result.summary,
                        acceptedAt=now,
                        ConditionExpression="status = :running AND workerId = :workerId")
        emit_event(SubmissionAccepted or SubmissionFailed)
    except TimeoutError:
        ddb.update_item(submissions_table, status=TIMEOUT,
                        ConditionExpression="status = :running AND workerId = :workerId")
        emit_event(SubmissionFailed{ failureType: TIMEOUT })
    except CompileError as e:
        ddb.update_item(submissions_table, status=COMPILE_ERROR, errorMessage=str(e),
                        ConditionExpression="status = :running AND workerId = :workerId")
        emit_event(SubmissionFailed{ failureType: COMPILE_ERROR })
    except Exception as e:
        ddb.update_item(submissions_table, status=RUNTIME_ERROR, errorMessage=str(e),
                        ConditionExpression="status = :running AND workerId = :workerId")
        emit_event(SubmissionFailed{ failureType: RUNTIME_ERROR })

    sqs.delete_message(msg)
```

If the claim update fails because the row is no longer `PENDING`, the
worker deletes the SQS message and does no work. If a worker crashes
after claim, the 180-second visibility timeout redelivers the message;
the next worker can either leave it for a janitor workflow or reclaim
only rows whose `RUNNING startedAt` is older than the max runtime
(v1 keeps the simpler no-reclaim behavior and relies on the DLQ).

### 5.2 The `execute_user_code` call — the actual sandbox

The runner spawns the user code in a **chained subprocess** with the
exact constraints from the design doc:

```python
# runner image bakes Python 3 + Node 20; dispatches on language
def execute_user_code(language, code, test_cases, time_limit_ms, mem_limit_mb):
    # write code to a tmp dir
    with tempfile.TemporaryDirectory() as tmp:
        if language == "python":
            code_path = f"{tmp}/solution.py"
            runner_path = "/opt/runners/python_runner.py"
            cmd = ["python3", runner_path, code_path]
        elif language == "javascript":
            code_path = f"{tmp}/solution.js"
            runner_path = "/opt/runners/node_runner.js"
            cmd = ["node", runner_path, code_path]
        else:
            raise ValueError(f"unsupported language: {language}")

        with open(code_path, "w") as f:
            f.write(code)

        # THE SANDBOX: spawn the user code with strict isolation
        return subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=time_limit_ms / 1000,
            # --- illustrative helper: sets memory/core limits;
            #     wall-clock time is enforced by subprocess timeout above ---
            preexec_fn=set_memory_limits(mem_limit_mb),
            # --- file descriptors and stdio ---
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            # --- the runner subprocess will internally fork-exec the user code
            #     inside a child process with the following applied:
            env={
                "PYTHONDONTWRITEBYTECODE": "1",  # no .pyc files
                "NODE_OPTIONS": "--no-deprecation",
            },
            # user code is passed via stdin if size > argv limit
        )
```

The `python_runner.py` / `node_runner.js` scripts are **shim
executables** that:
1. Read the user's code from argv[1].
2. Import / `require` it.
3. Iterate the test cases, calling the user's solution for each.
4. Compare actual output to `expected` exact-match (whitespace
   trimmed from line ends, but not collapsed).
5. Write a structured JSON result to stdout for the parent
   runner to parse.

The **inner subprocess** (the user code) is launched by the shim
with these additional restrictions:

```python
# inside python_runner.py
def run_user_solution_in_sandbox(solution_module, test_cases):
    for idx, tc in enumerate(test_cases):
        proc = subprocess.Popen(
            ["python3", "-c", "import sys; sys.stdin = open('/dev/stdin'); "
                              "exec(open(sys.argv[1]).read())", "/sandbox/solution.py"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            # --- the design doc's required sandbox ---
            preexec_fn=lambda: apply_user_code_sandbox(),
        )
        ...
```

Where `apply_user_code_sandbox()` is:

```python
def apply_user_code_sandbox():
    import resource, os, signal

    # 1. CPU is bounded at the Fargate task (0.5 vCPU) and by the
    #    parent subprocess timeout. v1 does not set RLIMIT_CPU here.

    # 2. Memory: hard cap (RSS) at mem_limit_mb
    mem_bytes = mem_limit_mb * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (mem_bytes, mem_bytes))

    # 3. Disable core dumps
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

    # 4. Disable file creation (FUSE-friendly mode; the inner runner
    #    already mounted / read-only, but this is a belt-and-braces)
    # os.chmod("/sandbox", 0o555)

    # 5. Timeout is enforced by the parent subprocess timeout, which
    #    sends SIGKILL/SIGTERM to the child process tree.

    # 6. Drop supplementary groups (we are already uid/gid-limited by
    #    the Fargate task user; this is for paranoia in case of fork
    #    inheritance)
    # os.setgroups([])
```

### 5.3 What Fargate v1 can and cannot enforce

Fargate gives us a managed, warm container boundary, but it does **not**
give us the same controls as `docker run --security-opt seccomp=...`,
Docker-in-Docker, privileged containers, or selectable runtimes such as
`runsc` / gVisor. Therefore v1's enforceable controls are:

- Task-level CPU/memory limits (`0.5 vCPU`, `1 GB`) plus inner
  `setrlimit` for user-code memory only (time is enforced via the
  parent subprocess `timeout=`, not `RLIMIT_CPU`).
- Non-root container user, dropped Linux capabilities where ECS
  supports them, and read-only root filesystem where compatible with
  the runner.
- Private subnet with no NAT and egress only to required AWS VPC
  endpoints (SQS, DDB, S3, ECR, logs, EventBridge).
- Application-level guards in the Python/Node shims: timeout,
  max output bytes, no shell invocation, no user-controlled command
  args, no access to AWS credentials in the child environment.

This is sufficient for **internal/trusted users and accidental
resource-exhaustion bugs**. It is **not** a production-grade arbitrary
untrusted-code sandbox.

### 5.4 Production sandbox path: ECS-on-EC2

If v1 must accept public arbitrary code, replace `leetcode-workers`
with an ECS-on-EC2 worker fleet. That unlocks:

- per-submission child containers (`docker run --rm ...`)
- custom seccomp profiles
- `--network=none`
- `--read-only`, `--pids-limit`, `--memory`, `--cpus`
- gVisor / `runsc` or another hardened runtime
- host-level egress controls while the worker parent still reaches AWS
  APIs

That is a larger operational surface (EC2 capacity, AMIs, patching,
container runtime configuration), so it is deliberately not the MVP
path unless the threat model requires it.

---

## 6. Deep-dive 2 — Asynchronous result retrieval (the polling UX)

The system-design doc is specific about why polling, not WebSockets
or SSE:

> "WebSockets are bidirectional and stateful. We only need one-way
> updates, making the overhead of maintaining persistent WebSocket
> connections unnecessary. SSE also requires long-lived open HTTP
> connections, which drains server resources during massive traffic
> spikes."

Correct reasoning. The implementation on the client is verbatim the
doc's example 1, minus the `submitResponse.json()` destructuring
(which depends on framework choice):

```javascript
async function submitAndPoll(problemId, codePayload) {
    const submitResponse = await fetch(`/problems/${problemId}/submission`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${await getCognitoIdToken()}`,
        },
        body: JSON.stringify({ language: codePayload.language, code: codePayload.code }),
    });
    const { submissionId, statusUrl } = await submitResponse.json();

    const intervalId = setInterval(async () => {
        const statusResponse = await fetch(statusUrl, {
            headers: { 'Authorization': `Bearer ${await getCognitoIdToken()}` },
        });
        const result = await statusResponse.json();

        if (['ACCEPTED','WRONG_ANSWER','TIMEOUT','RUNTIME_ERROR','COMPILE_ERROR'].includes(result.status)) {
            clearInterval(intervalId);
            displayResult(result);
        }
    }, 1500);
}
```

### Why status-bff is its own stack (not part of submissions-bff)

Three reasons:
1. **Different scaling profile.** submissions-bff is spiky
   (clients submit at irregular times). status-bff is a steady
   drip for the lifetime of every in-flight submission.
2. **Different IAM.** submissions-bff needs SQS write + DDB write.
   status-bff only needs DDB read. Putting both in one stack means
   the read-only path has the write permissions, which is a
   permission over-grant.
3. **Different deployment cadence.** submissions-bff evolves as
   ingest rules change (validation, rate limits, syntax checking).
   status-bff is mostly stable (it just returns whatever is in the
   row). Separate stacks let us ship status-bff changes without
   risking ingest regressions.

### Why DDB read on every poll, not a cached read

DDB GetItem is sub-10ms for a hot row, well within the 1.5-second
polling interval budget. Caching (DAX, ElastiCache, CloudFront)
adds complexity without buying measurable latency improvement at
MVP scale. Add DAX if read p95 crosses 10ms in CloudWatch metrics.

---

## 7. Operational notes

### Per-stage configuration

| Stage  | Region       | Auth                                | Workers | Notes                                |
| ------ | ------------ | ----------------------------------- | ------- | ------------------------------------ |
| `dev`  | ap-southeast-1 | admin-provisioned users, single UserPool | min=10, max=50 | Smoke target. Same region as pastebin-app / url-shortener-app. |
| `prod` | ap-southeast-1 | self-signup via Hosted UI, MFA required | min=10, max=50 | WAF can wait; minimal CloudWatch alarms + DLQ alerting ship in v1 |

### Cost posture (rough order of magnitude, dev stage)

| Resource                        | Monthly cost (dev)        | Notes |
| ------------------------------- | ------------------------- | ----- |
| 10 Fargate tasks (0.5 vCPU, 1 GB) running idle | ~$180 on-demand / ~$55 Spot | Steady-state floor regardless of traffic; excludes VPC endpoint hourly charges. |
| Fargate tasks auto-scaling to 50 at peak        | + ~$720 on-demand / + ~$220 Spot if at max 24/7 | Realistic peak is hours-per-week, not full month. |
| 1 ECR repo (combined runner image)              | ~$1 (≤1 GB storage)        | Negligible. |
| 1 EventBridge bus + archive                     | ~$5 (archive S3 + events ingested) | Archive: every event stored 365d. |
| 1 Cognito UserPool (MFA off, < 50K MAUs)        | free                      | Free tier covers dev. |
| DDB on-demand (problems + submissions)          | ~$5–20 depending on volume | Problems read-heavy; submissions write-heavy at contest-time (not v1). |
| SQS standard queue                              | ~$1 per million messages   | Negligible. |
| S3 logs bucket (failure traces only)            | ~$2 (1–10 GB typical)      | Lifecycle rule: IA 30d, expire 365d. |

**Dev total: ~$200–230/month on-demand steady-state** (or materially
less on Spot), dominated by the always-warm Fargate pool plus VPC
endpoint hourly charges. **Contest-free v1 has no surge cost.**

If cost is the dominant constraint, drop `DesiredCount: 5` (half
the user's pre-warm target) and accept cold-start latency on the
first submission in a cold worker. The user explicitly chose 10, so
this is informational only.

### Known gaps to track

- **WAF is deferred.** Add `AWS::WAFv2::WebACL` rules (SQLi, XSS,
  rate per IP) in v1.1 before any broad public launch.
- **No test-case fixture seeding.** `POST /problems` requires an
  admin; there is no seed script. Add `scripts/seed-problems.ts`
  in v1.1 to seed the 10 LeetCode-easy problems used in smoke.
- **Minimal alarms ship in v1.** See §10.11: queue backlog, DLQ,
  ECS desired-vs-running mismatch, worker task stops, and API errors.
- **No multi-language dispatch.** v1 supports Python + JS only;
  the dispatch table is a hard-coded `if/elif`. Generalize when
  v2 adds Java/Go/C++.
- **No time/memory measurement fidelity.** v1 measures wall-clock
  and best-effort RSS via `/proc/<pid>/status`. For fair ranking
  in a future contest, move the worker fleet to ECS-on-EC2 and use
  real cgroup accounting.

---

## 8. Build order

Sequential. Every step depends on the previous.

```
1.  leetcode-event-hub                  (sls deploy — creates bus + archive)
2.  leetcode-auth                       (sls deploy — creates UserPool + client)
3.  leetcode-problems-bff               (sls deploy — creates problems table + 3 lambdas)
4.  seed admin user in Cognito + admin group
5.  seed 5 problems via POST /problems   (smoke: confirm GET /problems returns 5)
6.  leetcode-submissions-bff            (sls deploy — creates submissions table + work queue)
7.  leetcode-worker-images              (sls deploy — creates ECR repo only)
8.  build + push combined runner image to ECR
9.  leetcode-workers                    (sls deploy — Fargate service consumes the queue)
10. leetcode-status-bff                 (sls deploy — creates 2 lambdas, no DDB)
11. e2e: submit a Python solution, poll, observe ACCEPTED
12. e2e: submit a JS solution, poll, observe ACCEPTED
13. e2e: submit Python with a wrong answer, observe WRONG_ANSWER
14. e2e: submit Python with an infinite loop, observe TIMEOUT (5s)
15. e2e: submit Python with `import socket; socket.socket(...)`, observe RUNTIME_ERROR
    (v1 app-level guard; not proof of true kernel-level network isolation)
```

**Step 4–5 must precede step 6** because submissions-bff reads from
the problems-table for existence checks. Step 7 must precede step 8
because the ECR repo must exist before image push. Step 8 must precede
step 9 because the Fargate service fails to start without the container
image in ECR.

### Docker image build/push

The repo does not have a template for this. Add a small
`scripts/build-runners.sh` that runs from the project root:

```bash
#!/usr/bin/env bash
set -euo pipefail
AWS_REGION=ap-southeast-1
STAGE=${1:-dev}

RUNNER_REPO=$(aws cloudformation describe-stacks \
    --stack-name "leetcode-worker-images-$STAGE" \
    --query 'Stacks[0].Outputs[?OutputKey==`RunnerImageUri`].OutputValue' \
    --output text)

cd leetcode-workers/docker
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${RUNNER_REPO%/*}"
docker build --tag "$RUNNER_REPO" --file runner.Dockerfile .
docker push "$RUNNER_REPO"
```

Wire this into the `deploy:workers` nx target as two explicit phases:
`nx run leetcode-worker-images:deploy`, `scripts/build-runners.sh`,
then `nx run leetcode-workers:deploy`.

---

## 9. Summary

A LeetCode-style coding platform in this monorepo is **three
Lambda BFFs plus one Fargate worker pool, with two infrastructure
stacks (bus + Cognito)** — six independently versioned stacks on one
EventBridge bus. The BFFs are textbook Lambda + HTTP API + DDB + JWT;
the worker pool is the only novel piece, justified by the design
doc's sandbox and pre-warm requirements that Lambda cannot satisfy.

The design's three big departures from the system-design doc are:
**no contests in v1** (drops leaderboard, two-phase, pre-warm
scheduling), **JWT-required catalog** (no anonymous reads), and
**inline test cases in DDB** (no test-case S3 bucket). All three
are user decisions confirmed in the design review (2026-06-24).

The biggest architectural caveat is the worker threat model:
**Fargate v1 is not a full untrusted-code sandbox**. It gives us a warm
managed worker pool with resource limits and private AWS-only
networking. If the product accepts arbitrary public submissions, the
worker fleet should move to ECS-on-EC2 so we can run each submission in
a hardened child container with custom seccomp / gVisor / no network.

---

## 10. Resolved design concerns

Decisions from the architecture review (2026-06-24).

### 1. Worker runtime — Fargate MVP, ECS-on-EC2 for public untrusted code

The generic system-design doc says "use Docker with seccomp + cgroups
+ no-net". AWS Fargate does not expose Docker-in-Docker, arbitrary
custom seccomp profiles, privileged containers, or selectable runtimes
such as `runsc` / gVisor.

**Decision:** v1 keeps **Fargate** for a warm managed worker pool, but
explicitly scopes the threat model to internal/trusted users plus
accidental resource exhaustion. If the platform must execute arbitrary
public code, replace `leetcode-workers` with an **ECS-on-EC2** fleet
that runs each submission in a hardened child container
(`--network=none`, custom seccomp, `--read-only`, `--pids-limit`,
`--memory`, `--cpus`, gVisor/runsc if required).

### 2. Test cases — inline in DDB, not S3

The system-design doc is silent on test-case storage. The user's
answer to question 5: **inline in DDB**.

**Decision:** `testCases` is a list attribute on the problem row.
Each entry: `{ input: string, expected: string }`. DDB item size
cap is 400 KB; with ~50 test cases per problem averaging 1 KB each,
problems fit well within the limit. Avoids an extra cross-table
read for workers (which already `GetItem` the problem row).

**Trade-off accepted:** larger problem rows. If a v2 problem
needs > 100 test cases or binary inputs, revisit and move
testCases to S3 with `testCasesS3Key` referencing the bucket.

### 3. No contests, no leaderboard, no two-phase in v1

User's answer to questions 1 and 6. Drops:
- `leetcode-contest-bff` (not built)
- `leetcode-leaderboard-bff` (not built)
- Redis / ElastiCache (not needed; no ZSET, no ZADD)
- Two-phase processing (workers run 100% of test cases always)
- Pre-warm scheduler (auto-scaling on SQS backlog replaces it)

**Decision:** v1 is **practice mode only** — users browse
problems, submit code, get pass/fail feedback. No contests means
no leaderboards means no Redis. Auto-scaling on SQS queue depth
handles bursty traffic without a cron pre-warm hop.

**v2 revisit:** when contests are reintroduced, the `leetcode-event-hub`
bus and the `SubmissionAccepted` events already in place are
exactly what a future `leetcode-leaderboard-bff` would consume.
No re-architecture needed — add the stack, add a rule, add a
Redis ZSET.

### 4. Worker image — one task with both runners, not two services

User's answer to question 2: **Python + JS in v1**.

**Decision:** single Fargate task definition and **one combined ECR
image** with Python 3 + Node 20. A dispatcher spawns the right runner
based on `submission.language`. Avoids two services, two task defs,
and per-language queues. Trade-off: a single ~400 MB image instead of
two ~200 MB images, and slightly more complex dispatcher logic.

**v2 revisit:** if v2 adds Java/Go/C++/Rust, each compiled
language adds a separate image (the compile step requires a
real toolchain). Switch to two-image task with one runner per
container, dispatched at the queue level (use a second SQS
queue per language).

### 5. Worker pool sizing — min=10, max=50

User's answer to question 4: **pre-warm target = 10**.

**Decision:** `DesiredCount: 10`, `AutoScaling.MinCapacity: 10`,
`AutoScaling.MaxCapacity: 50`. Scale with CloudWatch metric math /
step scaling on `ApproximateNumberOfMessagesVisible / RunningTaskCount`
because ECS does not provide a predefined SQS backlog target-tracking
metric. At 10 tasks and a target of 50 visible messages per task,
that's 500 visible messages before aggressive scale-out.

**v2 revisit:** if contests are added, schedule a one-shot
Fargate action at T-5min that raises `MinCapacity` to the
contest-sized number (50, 100, 200) and a corresponding T+0
action that drops it back to 10. Or use a predictive scaling
policy with a contest-calendar input.

### 6. Leaderboard / Redis — explicitly dropped at v1

See §10.3. The system-design doc treats Redis ZSET as
load-bearing. With no contests, ZSET is unused. The cost of
running a Redis cluster at MVP scale (~$15–30/month dev) is
not justified by any current access pattern.

**Decision:** no Redis, no ElastiCache. If v2 adds contests,
add an ElastiCache replication group with one shard, multi-AZ,
in the `leetcode-leaderboard-bff` stack. ZADD with the
score-packing formula `(Points * 1000000) - TimeTaken` from
the design doc's example 4.

### 7. Auth — Cognito, implemented as one shared UserPool

User's answer to question 8: **Cognito**. The **one shared UserPool**
is this design's implementation choice so all BFFs use the same JWT
issuer and audience.

**Decision:** dedicated `leetcode-auth` stack owns the UserPool.
problems-bff, submissions-bff, status-bff all import
`UserPoolId` and `UserPoolClientId` via `${cf:...}`. New users
self-signup via Hosted UI in prod, admin-provisioned in dev
(matches pastebin's e2e pattern). One pool, one set of
authorizer configs, one IdP integration.

**Trade-off accepted:** coupling between BFFs through the shared
UserPool. Mitigated by the dedicated `leetcode-auth` stack:
UserPool changes (e.g., adding MFA, switching IdP) deploy
independently of any BFF.

### 8. Problems catalog — JWT-required, not anonymous

User's answer to question 7: **require JWT**.

**Decision:** `GET /problems` and `GET /problems/:id` both
validate the Cognito JWT. No anonymous reads. Simpler
authorization model (every request is authenticated; no
"public read but authed write" branching).

**Trade-off accepted:** no SEO benefit from anonymous crawling
of problem pages. If a v2 needs SEO, add CloudFront with a
lambda@edge that mints a service-account JWT for the crawler.

### 9. Submission code size — 64 KiB cap

The design doc doesn't mention a cap. Workers must read the
submission row from DDB; DDB item size cap is 400 KB but 64 KB
is a sane per-submission limit (most competitive programming
solutions are < 10 KB).

**Decision:** `submissions-bff` rejects submissions with
`code.length > 64 * 1024` bytes at the Lambda layer with a
413 response. Matches pastebin's `MAX_SIZE_BYTES = 256 KiB`
constraint style, but intentionally lower because competitive
programming solutions are usually much smaller than paste bodies.

**v2 revisit:** raise to 256 KiB if a real user hits the cap.

### 10. Cross-stack wiring — CFN outputs only (like pastebin / url-shortener)

Same convention as the sibling apps. Each consumer imports the
table ARNs, queue ARNs, UserPool outputs via `${cf:...}` in
its `serverless/config.yml`. **No SSM Parameter Store at MVP.**

Exports summary (CFN outputs):

| Output                       | Stack                | Imported by                    |
| ---------------------------- | -------------------- | ------------------------------ |
| `busName`, `busArn`          | leetcode-event-hub   | workers (PutEvents), future consumers |
| `UserPoolId`, `UserPoolArn`, `UserPoolClientId` | leetcode-auth | problems-bff, submissions-bff, status-bff |
| `ProblemsTableName`, `ProblemsTableArn`        | leetcode-problems-bff | submissions-bff (read for existence check) |
| `SubmissionsTableName`, `SubmissionsTableArn`  | leetcode-submissions-bff | status-bff (read), workers (write) |
| `WorkQueueUrl`, `WorkQueueArn`                 | leetcode-submissions-bff | workers (consume) |
| `RunnerImageUri`                               | leetcode-worker-images | build script, leetcode-workers |
| `ClusterName`, `ServiceName`                   | leetcode-workers | deploy scripts / ops |

### 11. Observability — minimal alarms in v1

The worker pool is asynchronous and always-on. Silent failure means
messages pile up, users poll forever, and the warm Fargate floor keeps
billing. This is high enough risk to include a minimal alarm set in v1.

**Decision:** ship these alarms with the v1 stacks:

- SQS DLQ `ApproximateNumberOfMessagesVisible > 0`
- SQS backlog per running task above target for 5 minutes
- ECS desired task count != running task count for 5 minutes
- ECS task stopped count > 0
- submissions-bff / status-bff Lambda `Errors > 0`
- worker `MemoryUtilization > 80%`

WAF and richer dashboards can wait until v1.1.

### 12. Worker networking — AWS-only VPC endpoints

Workers cannot have "deny all egress" and still poll SQS, read DDB,
write S3 logs, emit EventBridge events, pull ECR images, and write
CloudWatch logs. There is no NAT gateway in v1; instead, the Fargate
service runs in private subnets with VPC endpoints for:

- SQS
- DynamoDB
- S3
- ECR API
- ECR DKR
- CloudWatch Logs
- EventBridge (if worker event publication stays enabled)

Security groups allow egress only to those endpoint security groups /
prefix lists. This restricts the **worker task's** network surface; it
does not provide per-submission `--network=none` isolation.

### 13. Worker event publishing — keep bus, make it real

The bus has no v1 consumers, but workers still publish
`SubmissionAccepted` / `SubmissionFailed` so future analytics or
leaderboards can subscribe without changing worker code.

**Decision:** workers import `busName` / `busArn` from
`leetcode-event-hub`, receive `EVENT_BUS_NAME` in the task environment,
and the task role gets `events:PutEvents` on `busArn`. If we later
decide no event publication is needed in v1, remove both the worker
`emit_event(...)` calls and the bus import together — do not leave the
design halfway.

### 14. Worker idempotency — conditional status transitions

SQS standard queues are at-least-once. Workers must treat redelivery as
normal.

**Decision:** the worker claims work with:

```text
PENDING -> RUNNING
ConditionExpression: status = :pending
```

and completes work with:

```text
RUNNING -> terminal
ConditionExpression: status = :running AND workerId = :workerId
```

Rows include `workerId`, `startedAt`, `attempt`, and `completedAt`.
The queue visibility timeout is 180 seconds (3x the v1 execution
timeout + DDB/S3/EventBridge overhead). A future compiled-language
worker can add heartbeat-based `ChangeMessageVisibility`.

### 15. ECR deploy cycle — bootstrap image repo first

The ECS service cannot start without an image tag that exists in ECR.
Therefore the worker image repository is a separate
`leetcode-worker-images` stack:

1. Deploy ECR repo.
2. Build and push `runner.Dockerfile` to `RunnerImageUri`.
3. Deploy `leetcode-workers` service using the pushed image.

This avoids the first-deploy cycle where the workers stack both creates
the repo and immediately tries to launch tasks from an image that has
not been pushed yet.

---

## 11. Open questions deferred to the user

These came up during the design but were not blocking for v1.
Re-ask when v2 scope is defined.

1. **Contests / leaderboards.** When (if ever) do we add the
   contest feature back? It is the largest scope addition
   (contest-bff + leaderboard-bff + ElastiCache + pre-warm
   scheduler + two-phase processing). Affects the bus topology
   and the worker auto-scaling policy.
2. **Multi-region / global low-latency.** ap-southeast-1 only at
   v1. A v2 with users in EU/US would need either multi-region
   active-active or a regional sharding strategy. Pastes are
   already DDB-stream-replicated; contest submissions would need
   region-aware fairness.
3. **Java / Go / C++ / Rust.** Compiled languages require a real
   compile step in the worker, which means a heavier image,
   longer warm-up, and possibly per-language SQS queues. Affects
   worker auto-scaling policy and image build pipeline.
4. **Public problem catalog with anonymous read.** v1 requires
   JWT on every read. If SEO or unauthenticated trial matters,
   add a public read replica (DAX or CloudFront + lambda@edge).
5. **Problem authorship UX.** v1 has `POST /problems` requiring
   admin group membership. A real authoring UI (markdown editor,
   test-case builder) is post-MVP.
6. **Per-user rate limits.** v1 has no per-user rate limit;
   Cognito authorizer allows every authenticated user unlimited
   submits. A v2 should add a `USAGE#<userId>` counter and
   throttle at the authorizer layer.
7. **Cost-of-Floor.** The always-warm 10-task Fargate pool is
   roughly ~$180/month on-demand (less on Spot), plus VPC endpoint
   hourly charges, regardless of traffic. If dev cost is a
   constraint, scale down to 5 (accept first-submission cold
   start) or scale to 0 in non-business hours via a schedule.