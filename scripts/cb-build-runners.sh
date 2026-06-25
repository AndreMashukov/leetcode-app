#!/usr/bin/env bash
#
# cb-build-runners.sh — build the worker image using AWS CodeBuild
# (docker-in-docker) when the local machine has no Docker daemon.
# This is the path Hermes' sandbox uses; in a normal dev box you'd
# use build-runners.sh directly.
#
# Usage:
#   scripts/cb-build-runners.sh                    # builds :dev-latest
#   scripts/cb-build-runners.sh v1.0.3             # builds :v1.0.3
#
# The CodeBuild project is created once on first run (or via
# scripts/setup-cb-project.sh) and re-used. The source zip lives
# in s3://leetcode-worker-images-build-src/latest.zip.
#
# Requires:
#   - aws OR /tmp/venv/bin/python with boto3 (this sandbox)
#   - AWS env vars set (or profile)

set -euo pipefail

STAGE="${STAGE:-dev}"
# Default tag: a build-scoped suffix so ECR's immutability doesn't bite.
# Pass a tag explicitly to override (e.g. scripts/cb-build-runners.sh v1.0.3).
TAG="${1:-${STAGE}-$(/tmp/venv/bin/python -c 'import uuid;print(uuid.uuid4().hex[:10])')}"
REGION="${AWS_REGION:-ap-southeast-1}"
PROJECT_NAME="leetcode-worker-images-build"
SRC_BUCKET="leetcode-worker-images-build-src"
SRC_KEY="latest.zip"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKERS_DIR="${SCRIPT_DIR}/../leetcode-workers"

echo "[cb-build] stage=${STAGE} tag=${TAG}"
echo "[cb-build] project=${PROJECT_NAME} source=s3://${SRC_BUCKET}/${SRC_KEY}"

# 1) Zip the source. We zip from the leetcode-workers/ parent
#    so that `runs/Dockerfile` and `buildspec.yml` end up at the
#    correct paths (CodeBuild extracts the zip at the project
#    root and runs buildspec.yml from there).
echo "[cb-build] zipping source..."
TMP_ZIP="$(mktemp /tmp/cb-src.XXXXXX.zip)"
# Build the zip in Python so we don't depend on the `zip` binary
# (the sandbox doesn't have it and we can't apt-install).
# CodeBuild expects `buildspec.yml` at the *root* of the extracted
# zip — so we flatten the `leetcode-workers/` directory when
# adding files. The Dockerfile still ends up at `runs/Dockerfile`,
# which the buildspec references.
/tmp/venv/bin/python - <<PYEOF
import os, zipfile
src = "${WORKERS_DIR}"
out = "$TMP_ZIP"
with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
    for root, _dirs, files in os.walk(src):
        for f in files:
            full = os.path.join(root, f)
            arc = os.path.relpath(full, src)
            zf.write(full, arc)
PYEOF

# 2) Upload the zip to S3.
echo "[cb-build] uploading s3://${SRC_BUCKET}/${SRC_KEY}..."
if command -v aws >/dev/null 2>&1; then
  aws s3 cp "$TMP_ZIP" "s3://${SRC_BUCKET}/${SRC_KEY}" --region "${REGION}"
else
  /tmp/venv/bin/python - <<PYEOF
import boto3
boto3.client("s3", region_name="${REGION}").upload_file(
    "$TMP_ZIP", "${SRC_BUCKET}", "${SRC_KEY}"
)
PYEOF
fi
rm -f "$TMP_ZIP"

# 3) Start the build.
echo "[cb-build] starting build..."
if command -v aws >/dev/null 2>&1; then
  BUILD_ID=$(aws codebuild start-build \
    --project-name "${PROJECT_NAME}" \
    --region "${REGION}" \
    --environment-variables-override "name=TAG,value=${TAG},type=PLAINTEXT" \
    --query "build.id" --output text)
else
  /tmp/venv/bin/python - <<PYEOF
import boto3, json
r = boto3.client("codebuild", region_name="${REGION}").start_build(
    projectName="${PROJECT_NAME}",
    environmentVariablesOverride=[
        {"name": "TAG", "value": "${TAG}", "type": "PLAINTEXT"},
    ],
)
print(r["build"]["id"], end="")
PYEOF
  BUILD_ID=$(/tmp/venv/bin/python -c "import boto3,json; print(boto3.client('codebuild', region_name='${REGION}').start_build(projectName='${PROJECT_NAME}', environmentVariablesOverride=[{'name':'TAG','value':'${TAG}','type':'PLAINTEXT'}])['build']['id'])")
fi

echo "[cb-build] build id: ${BUILD_ID}"

# 4) Poll until done.
echo "[cb-build] waiting for build to complete..."
if command -v aws >/dev/null 2>&1; then
  for i in $(seq 1 60); do
    STATUS=$(aws codebuild batch-get-builds --ids "${BUILD_ID}" --region "${REGION}" --query "builds[0].buildStatus" --output text)
    case "$STATUS" in
      SUCCEEDED)
        echo "[cb-build] SUCCEEDED"
        exit 0 ;;
      FAILED|FAULT|STOPPED|TIMED_OUT)
        echo "[cb-build] FAILED with status: $STATUS"
        # Try to tail the log
        LOG_GROUP=$(aws codebuild batch-get-builds --ids "${BUILD_ID}" --region "${REGION}" --query "builds[0].logs.groupName" --output text)
        LOG_STREAM=$(aws codebuild batch-get-builds --ids "${BUILD_ID}" --region "${REGION}" --query "builds[0].logs.streamName" --output text)
        echo "[cb-build] logs: $LOG_GROUP / $LOG_STREAM"
        exit 1 ;;
      IN_PROGRESS|QUEUED)
        sleep 10 ;;
      *)
        echo "[cb-build] unknown status: $STATUS"
        sleep 10 ;;
    esac
  done
  echo "[cb-build] timed out waiting"
  exit 1
else
  /tmp/venv/bin/python - <<PYEOF
import boto3, time, sys
cb = boto3.client("codebuild", region_name="${REGION}")
build_id = "${BUILD_ID}"
deadline = time.time() + 600
while time.time() < deadline:
    r = cb.batch_get_builds(ids=[build_id])
    b = r["builds"][0]
    s = b["buildStatus"]
    if s == "SUCCEEDED":
        print("[cb-build] SUCCEEDED")
        sys.exit(0)
    if s in ("FAILED", "FAULT", "STOPPED", "TIMED_OUT"):
        print(f"[cb-build] FAILED with status: {s}")
        lg = b.get("logs", {}).get("groupName", "")
        ls = b.get("logs", {}).get("streamName", "")
        print(f"[cb-build] logs: {lg} / {ls}")
        # Tail the last few log lines.
        try:
            logs = boto3.client("logs", region_name="${REGION}")
            r2 = logs.get_log_events(
                logGroupName=lg, logStreamName=ls,
                startFromHead=False, limit=50,
            )
            for e in r2.get("events", []):
                print(e["message"])
        except Exception as ee:
            print(f"[cb-build] log tail failed: {ee}")
        sys.exit(1)
    time.sleep(10)
print("[cb-build] timed out waiting")
sys.exit(1)
PYEOF
fi
