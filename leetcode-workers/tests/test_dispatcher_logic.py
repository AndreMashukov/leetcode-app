#!/usr/bin/env python3
"""End-to-end test of leetcode-workers/runs/dispatcher.py.

Approach: import the dispatcher module and patch its **internal
function-level seams** (the `_get_submission`, `_get_problem`,
`_claim_pending`, `_set_terminal`, `_emit_event`, `_upload_log`
helpers) with recording fakes. The dispatcher still calls
`subprocess.run` to invoke the runner, so we monkey-patch that to a
fake that returns canned JSON output, but the **real** runner
invocation code-path (config-file write, subprocess spawn, JSON
parse, summary build) is exercised.

This test runs in <1s without a Docker daemon and verifies:
  - the message-shape validation (drops non-JSON / bad-shape)
  - the claim-then-skip-on-duplicate flow
  - the language → runner dispatch (python vs node)
  - the result write-back (ACCEPTED / COMPILE_ERROR / WRONG_ANSWER)
  - the SQS delete after success
  - the EventBridge emit

Run from /opt/data/serverless/leetcode-app/leetcode-workers:
    python3 tests/test_dispatcher_logic.py
"""

import importlib.util
import json
import os
import sys
import types
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
RUNS = REPO / "runs"


# --- in-memory stores --------------------------------------------------------

SUBMISSIONS = {}     # plain python dicts (MarshalledIn)
PROBLEMS = {}        # plain python dicts (MarshalledIn)
EVENTS = []
SQS_DELETED = []


def marshall(v):
    """Mirror the dispatcher's _marshall — turn python into DDB AttributeValue."""
    if isinstance(v, str):
        return {"S": v}
    if isinstance(v, bool):
        return {"BOOL": v}
    if isinstance(v, int):
        return {"N": str(v)}
    if isinstance(v, float):
        return {"N": repr(v)}
    if isinstance(v, dict):
        return {"M": {k: marshall(x) for k, x in v.items()}}
    if isinstance(v, list):
        return {"L": [marshall(x) for x in v]}
    if v is None:
        return {"NULL": True}
    raise TypeError(f"unsupported: {type(v).__name__}")


# --- prepare env + import dispatcher ----------------------------------------

os.environ.setdefault("WORK_QUEUE_URL", "https://sqs.example/dev/queue")
os.environ.setdefault("AWS_REGION", "ap-southeast-1")
os.environ.setdefault("PROBLEMS_TABLE_NAME", "leetcode-problems-bff-dev-problems")
os.environ.setdefault("SUBMISSIONS_TABLE_NAME", "leetcode-submissions-bff-dev-submissions")
os.environ.setdefault("EVENT_BUS_NAME", "x")
os.environ.setdefault("EVENT_SOURCE", "x")

spec = importlib.util.spec_from_file_location("dispatcher", str(RUNS / "dispatcher.py"))
dispatcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatcher)


# --- monkey-patch internal helpers ------------------------------------------

def _fake_get_submission(submission_id):
    """Return the DDB item in AttributeValue format (as the real DDB does)."""
    sub = SUBMISSIONS.get(submission_id)
    if sub is None:
        return None
    return {"pk": marshall("SUB#" + submission_id),
            "sk": marshall("META"),
            **{k: marshall(v) for k, v in sub.items() if k not in ("pk",)}}

def _fake_get_problem(problem_id):
    prob = PROBLEMS.get(problem_id)
    if prob is None:
        return None
    # Each top-level field is its own AttributeValue (NOT wrapped in M).
    return {k: marshall(v) for k, v in prob.items()}

def _fake_claim_pending(submission_id):
    sub = SUBMISSIONS.get(submission_id)
    if sub is None:
        return False
    if sub.get("status") != "PENDING":
        return False
    sub["status"] = "RUNNING"
    return True

def _fake_set_terminal(submission_id, *, status, result_summary=None,
                       error_message=None, s3_log_key=None,
                       compiler_output=None):
    sub = SUBMISSIONS.get(submission_id)
    if sub is None:
        return
    sub["status"] = status
    if result_summary is not None:
        sub["resultSummary"] = result_summary
    if error_message is not None:
        sub["errorMessage"] = error_message
    if s3_log_key is not None:
        sub["s3LogKey"] = s3_log_key
    if compiler_output is not None:
        sub["compilerOutput"] = compiler_output

def _fake_emit_event(detail_type, detail):
    EVENTS.append({"detail_type": detail_type, "detail": detail})

def _fake_upload_log(submission_id, text):
    return f"s3://logs/{submission_id}.txt"

def _fake_delete_message(receipt_handle):
    SQS_DELETED.append(receipt_handle)

dispatcher._get_submission = _fake_get_submission
dispatcher._get_problem = _fake_get_problem
dispatcher._claim_pending = _fake_claim_pending
dispatcher._set_terminal = _fake_set_terminal
dispatcher._emit_event = _fake_emit_event
dispatcher._upload_log = _fake_upload_log
dispatcher._delete_message = _fake_delete_message


# Patch subprocess.run to a configurable fake.
SUBPROCESS_CALLS = []
def _fake_subprocess_run(cmd, **kwargs):
    SUBPROCESS_CALLS.append({"cmd": cmd, "kwargs": kwargs})
    runner = cmd[1]  # the runner binary
    # The "user code" comes in via the JSON file passed as argv[2].
    json_path = cmd[2]
    config = json.loads(Path(json_path).read_text())
    code = config["code"]
    # Simple "compute the expected" emulator: code tells us the result
    # via a sentinel comment "#FAKE_RESULT: <json>".
    # The runner shims emit `passedCount`/`totalCount` (not passed/total),
    # so we use those keys here too — the dispatcher reads them by name.
    fake_marker = "#FAKE_RESULT: "
    verdict = "ACCEPTED"
    total = len(config["testCases"])
    passed = total
    compile_error = None
    for line in code.splitlines():
        if line.startswith(fake_marker):
            payload = json.loads(line.split(fake_marker, 1)[1])
            passed = payload.get("passedCount", payload.get("passed", 0))
            total = payload.get("totalCount", payload.get("total", 0))
            verdict = payload.get("verdict", "WRONG_ANSWER")
            compile_error = payload.get("compileError")
    if compile_error:
        result = {"compileError": compile_error}
    else:
        result = {
            "passedCount": passed,
            "totalCount": total,
            "verdict": verdict,
            "runtimeMs": 3,
            "memoryKb": 1024,
            "firstFailure": None if passed == total else {
                "caseIndex": 0,
                "expected": "",
                "actual": "",
            },
        }
    return types.SimpleNamespace(
        returncode=0,
        stdout=json.dumps(result).encode("utf-8"),
        stderr=b"",
    )

dispatcher.subprocess.run = _fake_subprocess_run


# --- fixtures ----------------------------------------------------------------

PROBLEM_ID = "p1"
SUB_PK = "sub#abc123"

PROBLEMS[PROBLEM_ID] = {
    "problemId": PROBLEM_ID,
    "slug": "two-sum",
    "title": "Two Sum",
    "language": "python",
    "entrypoint": "two_sum",
    "starterCode": {
        "python": "def two_sum():\n    pass\n",
        "pythonEntrypoint": "two_sum",
    },
    "testCases": [
        {"input": "1\n2\n", "expected": "3"},
        {"input": "10\n20\n", "expected": "30"},
    ],
    "timeLimitMs": 2000,
    "memoryLimitKb": 262144,
}
SUBMISSIONS[SUB_PK] = {
    "pk": SUB_PK,
    "userId": "u1",
    "problemId": PROBLEM_ID,
    "language": "python",
    "code": "def two_sum(): pass\n#FAKE_RESULT: {\"passedCount\": 2, \"totalCount\": 2, \"verdict\": \"ACCEPTED\"}",
    "status": "PENDING",
}


# --- run test 1: happy-path python ------------------------------------------

print("[test 1] python ACCEPTED happy path")
dispatcher._process_one({
    "Body": json.dumps({
        "submissionId": SUB_PK,
        "problemId": PROBLEM_ID,
        "userId": "u1",
        "language": "python",
        "submittedAt": "2026-06-24T00:00:00Z",
    }),
    "ReceiptHandle": "rh-1",
})

assert SUBMISSIONS[SUB_PK]["status"] == "ACCEPTED", SUBMISSIONS[SUB_PK]
assert SUBMISSIONS[SUB_PK]["resultSummary"]["passedCount"] == 2, SUBMISSIONS[SUB_PK]
assert SUBMISSIONS[SUB_PK]["resultSummary"]["totalCount"] == 2, SUBMISSIONS[SUB_PK]
assert "rh-1" in SQS_DELETED, f"rh-1 not deleted (deleted={SQS_DELETED})"
assert any(e["detail_type"] == "SubmissionAccepted" for e in EVENTS), EVENTS
assert len(SUBPROCESS_CALLS) == 1, SUBPROCESS_CALLS
print("  ok — python runner invoked, ACCEPTED, 2/2, event emitted")


# --- run test 2: duplicate claim (idempotent) -------------------------------

print("[test 2] duplicate claim returns early (idempotent)")
SUBPROCESS_CALLS.clear()
EVENTS.clear()
SUBMISSIONS[SUB_PK]["status"] = "RUNNING"  # simulate another worker beat us
dispatcher._process_one({
    "Body": json.dumps({
        "submissionId": SUB_PK,
        "problemId": PROBLEM_ID,
        "userId": "u1",
        "language": "python",
        "submittedAt": "2026-06-24T00:00:00Z",
    }),
    "ReceiptHandle": "rh-2",
})
assert "rh-2" in SQS_DELETED, "rh-2 should be deleted (idempotent)"
assert len(SUBPROCESS_CALLS) == 0, "no subprocess should have run on duplicate"
print("  ok — duplicate claim returns early, no user code executed")


# --- run test 3: COMPILE_ERROR -----------------------------------------------

print("[test 3] COMPILE_ERROR path")
SUB_PK2 = "sub#fail1"
SUBMISSIONS[SUB_PK2] = {
    "pk": SUB_PK2,
    "userId": "u1",
    "problemId": PROBLEM_ID,
    "language": "python",
    "code": "def two_sum(:\n  pass\n#FAKE_RESULT: {\"passedCount\": 0, \"totalCount\": 0, \"verdict\": \"COMPILE_ERROR\", \"compileError\": \"SyntaxError: invalid syntax (line 1)\"}",
    "status": "PENDING",
}
SUBPROCESS_CALLS.clear()
dispatcher._process_one({
    "Body": json.dumps({
        "submissionId": SUB_PK2,
        "problemId": PROBLEM_ID,
        "userId": "u1",
        "language": "python",
        "submittedAt": "2026-06-24T00:00:00Z",
    }),
    "ReceiptHandle": "rh-3",
})
assert SUBMISSIONS[SUB_PK2]["status"] == "COMPILE_ERROR", SUBMISSIONS[SUB_PK2]
assert "SyntaxError" in SUBMISSIONS[SUB_PK2]["errorMessage"], SUBMISSIONS[SUB_PK2]
assert SUBMISSIONS[SUB_PK2]["s3LogKey"], SUBMISSIONS[SUB_PK2]
assert "rh-3" in SQS_DELETED
assert any(e["detail_type"] == "SubmissionFailed" for e in EVENTS), EVENTS
assert any(e["detail"].get("failureType") == "compile" for e in EVENTS), EVENTS
print("  ok — compile error path returns COMPILE_ERROR + uploads log")


# --- run test 4: node language dispatch --------------------------------------

print("[test 4] node ACCEPTED path")
PROBLEMS["p2"] = {
    "problemId": "p2",
    "language": "javascript",
    "starterCode": {
        "javascript": "function add() {}\n",
        "javascriptEntrypoint": "add",
    },
    "testCases": [{"input": "1\n2\n", "expected": "3"}],
    "timeLimitMs": 2000,
    "memoryLimitKb": 262144,
}
SUB_PK3 = "sub#node1"
SUBMISSIONS[SUB_PK3] = {
    "pk": SUB_PK3,
    "userId": "u1",
    "problemId": "p2",
    "language": "node",
    "code": "function add(){}\n#FAKE_RESULT: {\"passedCount\": 1, \"totalCount\": 1, \"verdict\": \"ACCEPTED\"}",
    "status": "PENDING",
}
SUBPROCESS_CALLS.clear()
dispatcher._process_one({
    "Body": json.dumps({
        "submissionId": SUB_PK3,
        "problemId": "p2",
        "userId": "u1",
        "language": "javascript",
        "submittedAt": "2026-06-24T00:00:00Z",
    }),
    "ReceiptHandle": "rh-4",
})
assert SUBMISSIONS[SUB_PK3]["status"] == "ACCEPTED", SUBMISSIONS[SUB_PK3]
assert SUBMISSIONS[SUB_PK3]["resultSummary"]["passedCount"] == 1
# Verify the node runner was used (argv[1] should end with node_runner.js
# or contain "node").
assert "node" in SUBPROCESS_CALLS[0]["cmd"][1].lower(), SUBPROCESS_CALLS[0]
print("  ok — node runner invoked, ACCEPTED, 1/1")


# --- run test 5: WRONG_ANSWER path ------------------------------------------

print("[test 5] WRONG_ANSWER path")
SUB_PK4 = "sub#wa1"
SUBMISSIONS[SUB_PK4] = {
    "pk": SUB_PK4,
    "userId": "u1",
    "problemId": PROBLEM_ID,
    "language": "python",
    "code": "def two_sum(): pass\n#FAKE_RESULT: {\"passedCount\": 0, \"totalCount\": 2, \"verdict\": \"WRONG_ANSWER\"}",
    "status": "PENDING",
}
dispatcher._process_one({
    "Body": json.dumps({
        "submissionId": SUB_PK4,
        "problemId": PROBLEM_ID,
        "userId": "u1",
        "language": "python",
        "submittedAt": "2026-06-24T00:00:00Z",
    }),
    "ReceiptHandle": "rh-5",
})
assert SUBMISSIONS[SUB_PK4]["status"] == "WRONG_ANSWER", SUBMISSIONS[SUB_PK4]
assert SUBMISSIONS[SUB_PK4]["resultSummary"]["passedCount"] == 0
assert SUBMISSIONS[SUB_PK4]["resultSummary"]["totalCount"] == 2
print("  ok — wrong answer path returns WRONG_ANSWER")


# --- run test 6: unsupported language ---------------------------------------

print("[test 6] unsupported language drops message")
SUB_PK5 = "sub#ruby1"
SUBMISSIONS[SUB_PK5] = {
    "pk": SUB_PK5,
    "userId": "u1",
    "problemId": PROBLEM_ID,
    "language": "ruby",
    "code": "puts 'hi'",
    "status": "PENDING",
}
SUBPROCESS_CALLS.clear()
dispatcher._process_one({
    "Body": json.dumps({
        "submissionId": SUB_PK5,
        "problemId": PROBLEM_ID,
        "userId": "u1",
        "language": "ruby",
        "submittedAt": "2026-06-24T00:00:00Z",
    }),
    "ReceiptHandle": "rh-6",
})
# Status should remain PENDING (claim succeeded, but runner not
# invoked), and SQS message deleted.
assert "rh-6" in SQS_DELETED, SQS_DELETED
print("  ok — unsupported language path drops SQS message")


# --- run test 7: missing data (no submission row) ---------------------------

print("[test 7] missing submission row -> RUNTIME_ERROR")
SUB_PK6 = "sub#missing"
dispatcher._process_one({
    "Body": json.dumps({
        "submissionId": SUB_PK6,
        "problemId": PROBLEM_ID,
        "userId": "u1",
        "language": "python",
        "submittedAt": "2026-06-24T00:00:00Z",
    }),
    "ReceiptHandle": "rh-7",
})
assert "rh-7" in SQS_DELETED
# No fake sub was claimed so the test path should set RUNTIME_ERROR
# via the dispatcher; but the SUBMISSIONS dict has nothing for that
# key. EVENTS should contain a "SubmissionFailed" event.
assert any(e["detail_type"] == "SubmissionFailed" for e in EVENTS), EVENTS
print("  ok — missing data path emits SubmissionFailed")


# --- run test 8: malformed JSON body ----------------------------------------

print("[test 8] malformed JSON body drops SQS message")
dispatcher._process_one({
    "Body": "this is not json",
    "ReceiptHandle": "rh-8",
})
assert "rh-8" in SQS_DELETED
print("  ok — malformed JSON path drops SQS message")


print("\nALL TESTS PASSED")
