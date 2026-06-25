#!/usr/bin/env python3
"""Dispatcher for the leetcode-workers image.

The single entrypoint. Runs as PID 1 of the Fargate task. Loops on
SQS long-poll, processes messages, and exits cleanly on SIGTERM
(both Fargate and docker stop give ~30s grace).

Per design-research.md §4 (leetcode-workers section):
  - long-poll SQS (WaitTimeSeconds=20)
  - claim a message: parse {submissionId, problemId, userId, language, submittedAt}
  - read the submission row from DDB
  - read the problem row from DDB
  - conditional UpdateItem PENDING -> RUNNING (sets workerId, startedAt)
  - write user code + test cases to a temp config file
  - exec the right runner shim with subprocess.run(timeout=time_limit)
  - parse the runner's JSON output
  - conditional UpdateItem RUNNING -> terminal status
    (sets acceptedAt + resultSummary on ACCEPTED,
     sets resultSummary + s3LogKey on failure)
  - delete the SQS message

Environment variables (set by the task definition):
  - WORK_QUEUE_URL              (the SQS work queue)
  - SUBMISSIONS_TABLE_NAME
  - PROBLEMS_TABLE_NAME
  - EVENT_BUS_NAME              (optional — emits SubmissionAccepted/Failed)
  - S3_LOGS_BUCKET              (optional — for failure trace uploads)
  - AWS_REGION                  (set by ECS automatically)

IAM (granted via the task role):
  - sqs:ReceiveMessage, DeleteMessage, ChangeMessageVisibility on the queue
  - dynamodb:GetItem on submissions and problems tables
  - dynamodb:UpdateItem on submissions table
  - events:PutEvents on the bus (if EVENT_BUS_NAME set)
  - s3:PutObject on the logs bucket (if S3_LOGS_BUCKET set)
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import traceback
import uuid
from datetime import datetime, timezone
from typing import Any

import boto3


# --- env ---------------------------------------------------------------------

WORK_QUEUE_URL = os.environ["WORK_QUEUE_URL"]
SUBMISSIONS_TABLE = os.environ["SUBMISSIONS_TABLE_NAME"]
PROBLEMS_TABLE = os.environ["PROBLEMS_TABLE_NAME"]
EVENT_BUS_NAME = os.environ.get("EVENT_BUS_NAME")
S3_LOGS_BUCKET = os.environ.get("S3_LOGS_BUCKET")
AWS_REGION = os.environ["AWS_REGION"]
WORKER_ID = os.environ.get("WORKER_ID", f"worker-{uuid.uuid4().hex[:8]}")


# --- clients -----------------------------------------------------------------

sqs = boto3.client("sqs", region_name=AWS_REGION)
ddb = boto3.client("dynamodb", region_name=AWS_REGION)
events_client = boto3.client("events", region_name=AWS_REGION) if EVENT_BUS_NAME else None
s3_client = boto3.client("s3", region_name=AWS_REGION) if S3_LOGS_BUCKET else None


# --- signal handling ---------------------------------------------------------

_running = True


def _stop(*_a: Any) -> None:
    global _running
    _running = False


signal.signal(signal.SIGTERM, _stop)
signal.signal(signal.SIGINT, _stop)


# --- DDB helpers -------------------------------------------------------------

def _get_submission(submission_id: str) -> dict[str, Any] | None:
    resp = ddb.get_item(
        TableName=SUBMISSIONS_TABLE,
        Key={"pk": {"S": f"SUB#{submission_id}"}, "sk": {"S": "META"}},
    )
    return resp.get("Item")


def _get_problem(problem_id: str) -> dict[str, Any] | None:
    resp = ddb.get_item(
        TableName=PROBLEMS_TABLE,
        Key={"pk": {"S": f"PROBLEM#{problem_id}"}, "sk": {"S": "META"}},
    )
    return resp.get("Item")


def _unmarshall(item: dict[str, Any]) -> dict[str, Any]:
    """DDB low-level item -> python dict. Handles S, N, BOOL, NULL, M, L."""
    out: dict[str, Any] = {}
    for k, v in item.items():
        if "S" in v:
            out[k] = v["S"]
        elif "N" in v:
            num = v["N"]
            # Try int first, fall back to float
            try:
                out[k] = int(num)
            except ValueError:
                out[k] = float(num)
        elif "BOOL" in v:
            out[k] = v["BOOL"]
        elif "NULL" in v:
            out[k] = None
        elif "M" in v:
            out[k] = _unmarshall(v["M"])
        elif "L" in v:
            out[k] = [_unmarshall({"x": x})["x"] if isinstance(x, dict) and "M" in x else x for x in v["L"]]
        else:
            out[k] = v
    return out


def _claim_pending(submission_id: str) -> bool:
    """PENDING -> RUNNING. Returns True on successful claim, False on race."""
    now = datetime.now(timezone.utc).isoformat()
    try:
        ddb.update_item(
            TableName=SUBMISSIONS_TABLE,
            Key={"pk": {"S": f"SUB#{submission_id}"}, "sk": {"S": "META"}},
            UpdateExpression=(
                "SET #s = :running, startedAt = :now, "
                "workerId = :wid, gsi2pk = :gsi2pk, gsi2sk = :gsi2sk, "
                "#a = if_not_exists(#a, :one)"
            ),
            ConditionExpression="#s = :pending",
            ExpressionAttributeNames={
                "#s": "status",
                "#a": "attempt",
            },
            ExpressionAttributeValues={
                ":running": {"S": "RUNNING"},
                ":pending": {"S": "PENDING"},
                ":now": {"S": now},
                ":wid": {"S": WORKER_ID},
                ":gsi2pk": {"S": "STATUS#RUNNING"},
                ":gsi2sk": {"S": now},
                ":one": {"N": "1"},
            },
        )
        return True
    except ddb.exceptions.ConditionalCheckFailedException:
        return False


def _set_terminal(
    submission_id: str,
    *,
    status: str,
    result_summary: dict[str, Any] | None,
    error_message: str | None,
    s3_log_key: str | None,
) -> None:
    """RUNNING -> terminal. Always wins (idempotent: REPLACE on status)."""
    now = datetime.now(timezone.utc).isoformat()
    # DDB UpdateExpression: SET/REMOVE clauses are SPACE-separated.
    # Within SET, comma-separate attribute paths. Within REMOVE, comma-separate.
    set_clauses: list[str] = ["#s = :status", "acceptedAt = :now"]
    remove_clauses: list[str] = ["gsi2pk", "gsi2sk"]
    names: dict[str, str] = {"#s": "status"}
    values: dict[str, Any] = {
        ":status": {"S": status},
        ":now": {"S": now},
    }
    if result_summary is not None:
        set_clauses.append("resultSummary = :rs")
        values[":rs"] = {"M": _marshall(result_summary)}
    if error_message is not None:
        set_clauses.append("errorMessage = :err")
        values[":err"] = {"S": error_message}
    if s3_log_key is not None:
        set_clauses.append("s3LogKey = :log")
        values[":log"] = {"S": s3_log_key}
    expr = "SET " + ", ".join(set_clauses) + " REMOVE " + ", ".join(remove_clauses)
    ddb.update_item(
        TableName=SUBMISSIONS_TABLE,
        Key={"pk": {"S": f"SUB#{submission_id}"}, "sk": {"S": "META"}},
        UpdateExpression=expr,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def _marshall(v: Any) -> dict[str, Any]:
    """python -> DDB AttributeValue (subset: S, N, M, L, BOOL)."""
    if isinstance(v, str):
        return {"S": v}
    if isinstance(v, bool):
        return {"BOOL": v}
    if isinstance(v, int):
        return {"N": str(v)}
    if isinstance(v, float):
        return {"N": repr(v)}
    if isinstance(v, dict):
        return {"M": {k: _marshall(x) for k, x in v.items()}}
    if isinstance(v, list):
        return {"L": [_marshall(x) for x in v]}
    if v is None:
        return {"NULL": True}
    raise TypeError(f"unsupported value type: {type(v).__name__}")


# --- runner invocation -------------------------------------------------------

def _run_user_code(
    language: str,
    code: str,
    entrypoint: str,
    test_cases: list[dict[str, str]],
    time_limit_ms: int,
    mem_limit_mb: int,
) -> dict[str, Any]:
    """Invoke the runner shim, parse the JSON output, enforce timeout."""
    config = {
        "code": code,
        "entrypoint": entrypoint,
        "testCases": test_cases,
        "timeLimitMs": time_limit_ms,
        "memoryLimitMb": mem_limit_mb,
    }
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", delete=False, dir="/tmp"
    ) as f:
        json.dump(config, f)
        config_path = f.name
    try:
        if language == "python":
            cmd = ["python3", "/opt/runners/python_runner.py", config_path]
        elif language == "javascript":
            cmd = ["node", "/opt/runners/node_runner.js", config_path]
        else:
            return {"compileError": f"unsupported language: {language}"}

        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=(time_limit_ms / 1000.0) + 1.0,  # +1s slack for shim startup
                check=False,
            )
        except subprocess.TimeoutExpired:
            return {"runtimeError": f"TimeLimitExceeded ({time_limit_ms}ms)"}
        if proc.returncode != 0 and not proc.stdout.strip():
            return {"runtimeError": f"runner exit {proc.returncode}: {proc.stderr[:500]}"}
        try:
            return json.loads(proc.stdout.strip())
        except json.JSONDecodeError as e:
            return {"runtimeError": f"runner produced non-JSON: {e}: {proc.stdout[:500]}"}
    finally:
        try:
            os.unlink(config_path)
        except OSError:
            pass


# --- SQS helpers -------------------------------------------------------------

def _delete_message(receipt_handle: str) -> None:
    try:
        sqs.delete_message(QueueUrl=WORK_QUEUE_URL, ReceiptHandle=receipt_handle)
    except Exception as e:  # noqa: BLE001
        # Non-fatal — visibility timeout will eventually expire
        print(f"[warn] delete_message failed: {e}", file=sys.stderr)


def _emit_event(detail_type: str, detail: dict[str, Any]) -> None:
    if events_client is None or not EVENT_BUS_NAME:
        return
    try:
        events_client.put_events(
            Entries=[{
                "Source": "leetcode.workers",
                "DetailType": detail_type,
                "Detail": json.dumps(detail),
                "EventBusName": EVENT_BUS_NAME,
            }]
        )
    except Exception as e:  # noqa: BLE001
        print(f"[warn] put_events failed: {e}", file=sys.stderr)


def _upload_log(submission_id: str, text: str) -> str | None:
    if s3_client is None or not S3_LOGS_BUCKET:
        return None
    try:
        key = f"submissions/{submission_id}/{uuid.uuid4().hex}.log"
        s3_client.put_object(
            Bucket=S3_LOGS_BUCKET,
            Key=key,
            Body=text.encode("utf-8", errors="replace")[:64 * 1024],
            ContentType="text/plain",
        )
        return key
    except Exception as e:  # noqa: BLE001
        print(f"[warn] s3 put failed: {e}", file=sys.stderr)
        return None


# --- main loop ---------------------------------------------------------------

def _process_one(message: dict[str, Any]) -> None:
    body = message.get("Body", "")
    receipt = message["ReceiptHandle"]
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        # Bad message — log and drop. A poison-message DLQ catches
        # this in the v1 setup, but we also want a hard fallback
        # so a single bad message doesn't loop forever.
        print(f"[error] non-JSON SQS body: {body[:200]}", file=sys.stderr)
        _delete_message(receipt)
        return

    submission_id = payload.get("submissionId")
    problem_id = payload.get("problemId")
    user_id = payload.get("userId")
    language = payload.get("language")
    if not all([submission_id, problem_id, language]):
        print(f"[error] bad message shape: {payload}", file=sys.stderr)
        _delete_message(receipt)
        return

    print(f"[info] claim {submission_id} problem={problem_id} lang={language}", file=sys.stderr)

    # Claim the row. If another worker beat us, skip.
    if not _claim_pending(submission_id):
        print(f"[info] {submission_id} not PENDING — skipping", file=sys.stderr)
        _delete_message(receipt)
        return

    # Read submission + problem
    sub = _get_submission(submission_id)
    prob = _get_problem(problem_id)
    if sub is None or prob is None:
        msg = "submission row missing" if sub is None else "problem row missing"
        _set_terminal(
            submission_id, status="RUNTIME_ERROR", result_summary=None,
            error_message=msg, s3_log_key=None,
        )
        _emit_event("SubmissionFailed", {
            "submissionId": submission_id, "userId": user_id,
            "problemId": problem_id, "language": language,
            "failureType": "missing_data", "message": msg,
        })
        _delete_message(receipt)
        return

    sub_dict = _unmarshall(sub)
    prob_dict = _unmarshall(prob)

    # Extract the per-language bits we need
    code = sub_dict["code"]
    starter_code = prob_dict.get("starterCode", {})
    entrypoint = starter_code.get(f"{language}Entrypoint") or starter_code.get(language)
    test_cases = prob_dict.get("testCases", [])
    time_limit_ms = int(prob_dict.get("timeLimitMs", 2000))
    mem_limit_kb = int(prob_dict.get("memoryLimitKb", 262144))
    mem_limit_mb = max(1, mem_limit_kb // 1024)

    if not entrypoint or not isinstance(test_cases, list) or not test_cases:
        _set_terminal(
            submission_id, status="COMPILE_ERROR", result_summary=None,
            error_message=(
                f"problem {problem_id} has no testCases or no entrypoint for "
                f"{language} (entrypoint={entrypoint!r}, tests={len(test_cases)})"
            ),
            s3_log_key=None,
        )
        _emit_event("SubmissionFailed", {
            "submissionId": submission_id, "userId": user_id,
            "problemId": problem_id, "language": language,
            "failureType": "problem_setup", "message": "no tests or no entrypoint",
        })
        _delete_message(receipt)
        return

    # Run the code.
    result = _run_user_code(
        language=language,
        code=code,
        entrypoint=entrypoint,
        test_cases=test_cases,
        time_limit_ms=time_limit_ms,
        mem_limit_mb=mem_limit_mb,
    )

    # Map runner output -> terminal status.
    if "compileError" in result:
        terminal = "COMPILE_ERROR"
        log_key = _upload_log(submission_id, result["compileError"])
        _set_terminal(submission_id, status=terminal, result_summary=None,
                      error_message=result["compileError"], s3_log_key=log_key)
        _emit_event("SubmissionFailed", {
            "submissionId": submission_id, "userId": user_id,
            "problemId": problem_id, "language": language,
            "failureType": "compile", "message": result["compileError"],
        })
    elif "runtimeError" in result:
        # Detect TIMEOUT substring for status mapping.
        if "TimeLimitExceeded" in result["runtimeError"]:
            terminal = "TIMEOUT"
        else:
            terminal = "RUNTIME_ERROR"
        log_key = _upload_log(submission_id, result["runtimeError"])
        _set_terminal(submission_id, status=terminal, result_summary=None,
                      error_message=result["runtimeError"], s3_log_key=log_key)
        _emit_event("SubmissionFailed", {
            "submissionId": submission_id, "userId": user_id,
            "problemId": problem_id, "language": language,
            "failureType": "runtime", "message": result["runtimeError"],
        })
    else:
        # Normal case: we have a result summary.
        passed = int(result.get("passedCount", 0))
        total = int(result.get("totalCount", 0))
        runtime_ms = int(result.get("runtimeMs", 0))
        memory_kb = int(result.get("memoryKb", 0))
        failed_idx = result.get("failedCaseIndex")
        summary = {
            "passedCount": passed,
            "totalCount": total,
            "runtimeMs": runtime_ms,
            "memoryKb": memory_kb,
            "failedCaseIndex": failed_idx,
        }
        if passed == total and total > 0:
            terminal = "ACCEPTED"
            _set_terminal(
                submission_id, status=terminal, result_summary=summary,
                error_message=None, s3_log_key=None,
            )
            _emit_event("SubmissionAccepted", {
                "submissionId": submission_id, "userId": user_id,
                "problemId": problem_id, "language": language,
                "runtimeMs": runtime_ms, "memoryKb": memory_kb,
                "acceptedAt": datetime.now(timezone.utc).isoformat(),
            })
        else:
            terminal = "WRONG_ANSWER"
            log_key = _upload_log(
                submission_id,
                json.dumps({
                    "summary": summary,
                    "results": result.get("results", []),
                }, indent=2),
            )
            _set_terminal(
                submission_id, status=terminal, result_summary=summary,
                error_message=(
                    f"{passed}/{total} tests passed; first failure at "
                    f"case {failed_idx}"
                ),
                s3_log_key=log_key,
            )
            _emit_event("SubmissionFailed", {
                "submissionId": submission_id, "userId": user_id,
                "problemId": problem_id, "language": language,
                "failureType": "wrong_answer", "message": f"{passed}/{total} passed",
            })

    print(
        f"[info] {submission_id} -> {terminal} "
        f"(passed={passed if 'passed' in dir() else '?'}/{total if 'total' in dir() else '?'})",
        file=sys.stderr,
    )
    _delete_message(receipt)


def main() -> int:
    print(f"[info] dispatcher starting; workerId={WORKER_ID}", file=sys.stderr)
    print(f"[info]   queue={WORK_QUEUE_URL}", file=sys.stderr)
    print(f"[info]   submissions={SUBMISSIONS_TABLE}", file=sys.stderr)
    print(f"[info]   problems={PROBLEMS_TABLE}", file=sys.stderr)
    while _running:
        try:
            resp = sqs.receive_message(
                QueueUrl=WORK_QUEUE_URL,
                MaxNumberOfMessages=1,
                WaitTimeSeconds=20,
                VisibilityTimeout=180,
                MessageAttributeNames=["All"],
            )
        except Exception as e:  # noqa: BLE001
            print(f"[error] receive_message: {e}", file=sys.stderr)
            time.sleep(5)
            continue
        for msg in resp.get("Messages", []):
            try:
                _process_one(msg)
            except Exception as e:  # noqa: BLE001
                # We want the worker to keep running even if one
                # message has a bug. Log and let SQS redrive
                # (visibility timeout will expire).
                print(f"[error] processing message: {e}", file=sys.stderr)
                print(traceback.format_exc(), file=sys.stderr)
    print("[info] dispatcher stopping (SIGTERM)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
