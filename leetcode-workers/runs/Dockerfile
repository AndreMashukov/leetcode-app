# leetcode-workers/runs/Dockerfile
#
# Combined Python+Node runner image for the leetcode-workers Fargate
# service. The dispatcher at /opt/runners/dispatcher.py long-polls SQS
# for submissions, fetches the submission row from DynamoDB, picks the
# right runner shim, executes the user's code against the test cases,
# and writes the verdict back to DynamoDB.
#
# Why one image with two runtimes (per design-research.md §4, §10.4):
# submissions are single-language — Python users never co-execute with
# Node users — so a single dispatcher shim that re-execs into the
# right runner keeps the warm pool at one service, one task def.
# Image size: ~400 MB (python3.11-slim ~150 MB + node20-slim ~250 MB).
#
# The image is built and pushed by scripts/build-runners.sh. The ECS
# service in leetcode-workers references the `:dev-latest` (or
# stage-pinned) tag in the ECR repo owned by leetcode-worker-images.
#
# v1 sandbox (per design-research §5.2 / §5.3):
#   - CPU: Fargate task-level 0.5 vCPU + parent subprocess.run timeout
#   - Memory: Fargate task-level 1 GB (worker itself is small) +
#     inner setrlimit(RLIMIT_AS, mem_limit_mb) on the user-code child
#   - No seccomp, no --cap-drop, no network isolation per submission
#     (Fargate v1 cannot do that without ECS-on-EC2 — see design §5.3)
#   - User code runs as the same non-root UID as the dispatcher

FROM python:3.11-slim AS python-base
# We use the python:3.11-slim base because the user code is read by a
# Python shim. Node 20 is installed on top. apt-get clean at the end
# to keep the image small.

FROM node:20-slim AS node-base
# Pin to slim (Debian bookworm) — full node images bloat by ~600 MB.

# We want both runtimes in a single image. python:3.11-slim has apt
# + python3 + pip. node:20-slim has node + npm. We start from python
# (it has slightly more dev tooling by default) and add node on top.
FROM python:3.11-slim

# Install Node 20 from nodesource. apt-get update first so the
# python base has a current package index.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Install Python deps for the dispatcher (boto3 for DDB/SQS/EB).
# We pin loosely because the ECR image is rebuilt on every deploy.
RUN pip install --no-cache-dir \
    boto3==1.34.0 \
 && pip cache purge

# Set the working dir for the runner scripts. The dispatcher writes
# user code into a tmpdir per submission; the runner shims read from
# the path passed in argv[1].
WORKDIR /opt/runners

# Copy the dispatcher and runner shims in. The image is rebuilt on
# every code change — there's no separate "build artifact" step.
COPY dispatcher.py /opt/runners/dispatcher.py
COPY python_runner.py /opt/runners/python_runner.py
COPY node_runner.js /opt/runners/node_runner.js
RUN chmod +x /opt/runners/*.py /opt/runners/*.js

# The dispatcher is the long-running entrypoint. It loops on SQS
# long-poll, processes messages, and exits only on SIGTERM.
ENTRYPOINT ["python3", "/opt/runners/dispatcher.py"]
