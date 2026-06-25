#!/usr/bin/env bash
#
# build-runners.sh — build the combined Python+Node runner image and
# push it to the ECR repo owned by leetcode-worker-images.
#
# Usage:
#   scripts/build-runners.sh                    # builds :dev-latest
#   scripts/build-runners.sh v1.0.3             # builds :v1.0.3 + :dev-latest
#   STAGE=prod scripts/build-runners.sh         # builds :prod-latest
#
# The image is rebuilt on every code change. There is no separate
# "build artifact" step; the Dockerfile copies the runner scripts
# straight in. The image is ~400 MB (python3.11-slim + node20-slim +
# boto3).
#
# Requirements:
#   - docker
#   - AWS CLI v2 (for the ECR login)
#   - AWS env vars / profile set (this script re-uses whatever
#     `aws ecr get-login-password` would see)
#
# What this script does NOT do:
#   - It does not deploy the leetcode-workers Fargate stack. Run
#     `serverless deploy` in leetcode-workers/ after this script
#     succeeds, OR have the task definition pin to :dev-latest and
#     force a new deployment.
#   - It does not clean up old images. ECR lifecycle rules handle
#     that (set in the worker-images stack's CFN).

set -euo pipefail

STAGE="${STAGE:-dev}"
TAG="${1:-${STAGE}-latest}"
REGION="${AWS_REGION:-ap-southeast-1}"
REPO_NAME="leetcode-worker-images-${STAGE}-worker-images"
ECR_URI="${ACCOUNT_ID:-579273601730}.dkr.ecr.${REGION}.amazonaws.com"
FULL_IMAGE="${ECR_URI}/${REPO_NAME}:${TAG}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKERFILE_DIR="${SCRIPT_DIR}/../leetcode-workers/runs"

echo "[build-runners] stage=${STAGE} tag=${TAG}"
echo "[build-runners] image: ${FULL_IMAGE}"
echo "[build-runners] dockerfile: ${DOCKERFILE_DIR}/Dockerfile"

# 1) ECR login. The "new" `aws ecr get-login-password` + `docker login`
#    pattern that works for Docker 17.06+ (we are on 26.1.x).
#    If `aws` is not on PATH (this sandbox uses Python boto3), fall
#    back to a boto3 call. Either way we pipe a single password line
#    to `docker login --password-stdin`.
echo "[build-runners] ecr login..."
if command -v aws >/dev/null 2>&1; then
  aws ecr get-login-password --region "${REGION}" \
    | docker login --username AWS --password-stdin "${ECR_URI}"
else
  # Write the python helper to a temp file so the bash parser doesn't
  # eat the `[` `]` access patterns.
  ECR_HELPER="$(mktemp /tmp/ecr-login.XXXXXX.py)"
  cat > "$ECR_HELPER" <<'PYEOF'
import boto3, base64, sys
r = boto3.client('ecr', region_name=sys.argv[1]).get_authorization_token()
# ECR returns a base64-encoded "AWS:<password>" string in
# `authorizationToken`. Decode it and strip the "AWS:" prefix.
tok = r['authorizationData'][0]['authorizationToken']
decoded = base64.b64decode(tok).decode('utf-8')
if ':' in decoded:
    decoded = decoded.split(':', 1)[1]
sys.stdout.write(decoded)
PYEOF
  /tmp/venv/bin/python "$ECR_HELPER" "${REGION}" \
    | docker login --username AWS --password-stdin "${ECR_URI}"
  rm -f "$ECR_HELPER"
fi

# 2) Build. --platform=linux/amd64 so it matches Fargate x86_64 by
#    default (Fargate arm64 is opt-in). --provenance=false because
#    we don't need SLSA provenance for an internal worker image.
echo "[build-runners] docker build..."
docker build \
  --tag "${FULL_IMAGE}" \
  --file "${DOCKERFILE_DIR}/Dockerfile" \
  "${DOCKERFILE_DIR}"

# 3) Push.
echo "[build-runners] docker push..."
docker push "${FULL_IMAGE}"

# 4) When the explicit tag is not the stage-latest, also re-tag the
#    stage-latest so the Fargate task definition (which pins to
#    `<stage>-latest` by convention) picks up the new code.
STAGE_LATEST="${ECR_URI}/${REPO_NAME}:${STAGE}-latest"
if [[ "${TAG}" != "${STAGE}-latest" ]]; then
  echo "[build-runners] also tagging ${STAGE_LATEST}"
  docker tag "${FULL_IMAGE}" "${STAGE_LATEST}"
  docker push "${STAGE_LATEST}"
fi

echo "[build-runners] done. image pushed: ${FULL_IMAGE}"
