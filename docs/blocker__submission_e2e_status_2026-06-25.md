BLOCKER: SUBMISSION END-TO-END NOT VERIFIED

Date: 2026-06-25
Status: IN-FLIGHT (one root-cause identified, one residual)
Related task: Task #10 (e2e submit -> worker -> ACCEPTED)


SUMMARY

The CloudWatch log stream failure that blocked the leetcode-workers Fargate
stack deployment on 2026-06-25 has been identified and fixed. The stack is
now live with a single healthy task polling SQS. A second blocker emerged
during the post-deploy e2e validation: the dispatcher transitions submissions
from PENDING to RUNNING but never reaches a terminal status. The runner
subprocess itself works correctly when invoked directly from a debug task.
The blocker is in the dispatcher's in-process flow, not in the runner, the
image, the IAM role, the log group, or the network.


BLOCKER 1 (RESOLVED): CLOUDWATCH LOG STREAM INIT FAILURE

Symptom
  - 12+ Fargate tasks failed to boot in a row.
  - Error surfaced via ecs describe_tasks STOPPED reason:
      ResourceInitializationError: failed to validate logger args:
      create stream has been retried 1 times: failed to create
      Cloudwatch log
  - Stack creation never reached CREATE_COMPLETE; eventually timed out.

Root cause
  The awslogs-group value passed to the task definition did not match the
  log group created by cluster.yml. The two YAML templates disagreed about
  the log group name.

  - runs/../serverless/cluster.yml
      AWS::Logs::LogGroup with LogGroupName: /aws/ecs/${self:service}-${opt:stage}
      (resolves to /aws/ecs/leetcode-workers-dev)

  - serverless/service.yml (BEFORE fix)
      logConfiguration.options.awslogs-group: ${self:service}-${opt:stage}
      (resolves to leetcode-workers-dev, WITHOUT the /aws/ecs/ prefix)

  The ECS awslogs driver looks up the log group by exact name. The
  /aws/ecs/-prefixed group existed but the driver asked for the unprefixed
  name. The lookup failed, the driver reported failed to validate logger
  args, and every task exited during the init phase.

  Note: the IAM-side hypothesis (missing logs:CreateLogGroup inline policy)
  was investigated and is a red herring for this specific error. The
  AWS-managed AmazonECSTaskExecutionRolePolicy already grants
  logs:CreateLogStream and logs:PutLogEvents, which is sufficient for
  awslogs-group lookup against an existing log group. CreateLogGroup is
  only needed if the agent itself is creating the group, which we are not.

Fix
  Patched serverless/service.yml to use the full path:

      awslogs-group: /aws/ecs/${self:service}-${opt:stage}

  This matches the log group created by cluster.yml exactly.

Redeploy
  - Deleted the failed stack (the workers service was still in
    CREATE_IN_PROGRESS, no manual cancel was needed; ecs stop_service +
    cloudformation delete-stack returned Stack-not-found within the
    polling window).
  - Deleted the orphan failure-logs S3 bucket (CFN retained it on stack
    rollback, so it had to be cleared before redeploy).
  - Ran serverless deploy --stage dev --region ap-southeast-1 --force.
  - Stack reached CREATE_COMPLETE in 123 seconds.
  - Single task reached RUNNING state with zero failed tasks.
  - Dispatcher started, connected to SQS work queue, began long-polling.

Verification
  - aws logs describe-log-streams against /aws/ecs/leetcode-workers-dev
    returned one stream with three startup events:
      [info] dispatcher starting; workerId=worker-735e65f9
      [info]   queue=https://sqs.ap-southeast-1.amazonaws.com/...
      [info]   submissions=leetcode-submissions-bff-dev-submissions
      [info]   problems=leetcode-problems-bff-dev-problems
  - The container is now writing to CloudWatch normally.


BLOCKER 2 (IN-FLIGHT): DISPATCHER DOES NOT REACH TERMINAL STATUS

Symptom
  - Sent a synthetic SQS message (bypassing the Cognito-gated BFF) to
    validate the worker pipeline directly.
  - Submission row transitions PENDING to RUNNING within seconds.
  - Submission row never reaches ACCEPTED, WRONG_ANSWER, RUNTIME_ERROR,
    TIMEOUT, or COMPILE_ERROR. It stays RUNNING indefinitely.
  - Worker log stream only ever shows the three startup lines.
    No [info] claim line. No [info] result line. Nothing.
  - Despite PYTHONUNBUFFERED=1 being set in the task definition env,
    the print(..., file=sys.stderr) lines are not appearing.

What was verified to NOT be the cause

  - The runner subprocess works correctly when invoked from a separate
    debug ECS task (overrode entryPoint to /bin/sh -c, ran the same
    python3 /opt/runners/python_runner.py /tmp/config.json with a known
    stdin-style main() function and two test cases). Returned:
      {"passedCount": 2, "totalCount": 2, "runtimeMs": 0,
       "memoryKb": 0, "failedCaseIndex": null, "results": [...]}
    within 50 milliseconds.
  - The Python and Node runner shim scripts exist at /opt/runners/ in
    the live image (ls -la /opt/runners/ from inside the debug task
    confirmed dispatcher.py, python_runner.py, node_runner.js).
  - The DDB claim succeeds (status went PENDING to RUNNING, attempt
    incremented to 1, workerId set). So _claim_pending returns True.
  - The IAM role has the right permissions for DDB reads/writes, SQS
    receive/delete, EventBridge put_events, and S3 put (verified via
    iam get_policy + get_policy_version against the execution role's
    attached policies).
  - The submission table schema matches what _claim_pending expects:
    pk=SUB#<id>, sk=META, status=PENDING at seed time.

What is most likely the cause (working theory)

  The dispatcher emits print(..., file=sys.stderr) without flush=True.
  Even though PYTHONUNBUFFERED=1 is set in the task definition env, the
  effective buffering behavior depends on how Docker's ENTRYPOINT chains
  to the Python interpreter. In this image the ENTRYPOINT is:

      ENTRYPOINT ["python3", "/opt/runners/dispatcher.py"]

  and the Python interpreter's stderr behavior in a non-tty subprocess
  of ECS init can differ from what PYTHONUNBUFFERED guarantees. The
  observed symptom (only the first three startup lines appear; subsequent
  lines buffered or dropped) is consistent with stderr buffering that
  is not flushed when the dispatcher is still running and processing.

  Net effect: we cannot tell from the log stream whether:
    (a) the dispatcher is stuck in _run_user_code with a hanging
        subprocess (unlikely, since the debug direct-call returned
        in <100ms),
    (b) the runner subprocess completed and returned JSON, but
        _set_terminal silently failed on its DDB update (would need
        to inspect a raised exception that is currently swallowed),
    (c) some other exception inside _process_one is being raised
        after _claim_pending and before _set_terminal, and the
        exception is being swallowed by a bare except clause.

  Without flush=True on the diagnostic prints, we are flying blind.


CONCRETE NEXT STEPS

Step 1: Add flush=True to every print(..., file=sys.stderr) call in
        runs/dispatcher.py. Locations identified:
            line 282 _delete_message warn
            line 298 _emit_event warn
            line 314 _upload_log warn
            line 329 bad-message-shape error
            line 338 missing-field error
            line 342 [info] claim
            line 346 [info] not PENDING skipping
            line 489 [info] dispatcher starting
            line 490-491 [info] queue/submissions/problems

Step 2: Wrap _process_one in a try/except that logs the traceback
        with flush=True. Currently if an unhandled exception fires
        between _claim_pending and _delete_message, it propagates to
        the main loop and the message stays in flight (visibility
        timeout will eventually retry, but we lose the diagnostic).

Step 3: Rebuild image via scripts/cb-build-runners.sh (will get a new
        dev-<uuid10> tag, since ECR image tags are immutable). Update
        serverless/config.yml workerImageTag field. Redeploy
        leetcode-workers (--function worker is enough, ~1s).

Step 4: Resend a synthetic SQS message and tail the log stream. The
        flushed prints will pinpoint whether the dispatcher is stuck
        inside _run_user_code, exiting early with an exception, or
        actually completing the result-mapping branch and then
        failing _set_terminal's DDB write.

Step 5: Independently verify the BFF actually sends testCases and
        starterCode in the SQS payload. Per design §10.4 the worker
        expects the SQS body to carry everything it needs. The
        submissions-bff handler currently only writes five scalar
        fields. If the BFF really ships only {submissionId, problemId,
        userId, language, submittedAt}, then the worker is forced to
        fetch testCases/starterCode from DDB, which means the problems
        table needs columns the seed flow does not populate. This is
        a separate bug from the dispatcher flow bug, but it would
        manifest as a compileError at runtime for any real user
        submission.


DATA LEFT IN THE ACCOUNT FOR THE NEXT DEBUG ROUND

  Problem row e2et2a0516 with starterCode and testCases seeded
  directly into leetcode-problems-bff-dev-problems.

  Three submission rows seeded into leetcode-submissions-bff-dev-submissions:
      970d4b3a3bd248099b4a867c213b1a8d  status RUNNING (from
          the first attempt before the BFF SQS shape was understood)
      f3a391feaee649d5b8c6071b02d0fb3f  status RUNNING (claim
          succeeded, never reached terminal status)
      42ffae882c774168b45f2d1f8d6e9e20  status RUNNING (latest
          debug attempt, same symptom)

  These can be left in place for the next debug round or cleaned up
  with ddb delete_item.


WHAT IS NOT BLOCKED

  - 4 of 6 BFF stacks are deployed (event-hub, problems-bff,
    submissions-bff, status-bff).
  - ECR image build/push pipeline works end-to-end.
  - CloudWatch log stream for the workers container is now receiving
    events normally.
  - The dispatcher image is healthy and connects to SQS on boot.
  - auth stack (Cognito) is the only missing BFF; not blocking the
    worker pipeline since synthetic SQS messages exercise the same
    path.

  The platform is otherwise healthy. Task #10 (e2e submit to worker
  to ACCEPTED) needs the buffering fix and one more debug cycle.
