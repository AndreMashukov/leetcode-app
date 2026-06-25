// Placeholder entrypoint for leetcode-worker-images.
//
// This stack is pure infrastructure (one ECR repository for the
// combined Python 3.12 + Node 20 worker image). It has no Lambda
// functions and no business logic. This file exists so the
// project's TypeScript build has at least one `.ts` input to
// validate, satisfying `tsc --noEmit`.
//
// The actual image is built by scripts/build-runners.sh and pushed
// to this repo (a separate concern from the CloudFormation stack).

export const WORKER_IMAGES_STACK_NAME = "leetcode-worker-images";
export const WORKER_IMAGES_STACK_DESCRIPTION =
  "ECR repository for the leetcode combined Python 3.12 + Node 20 worker image";
