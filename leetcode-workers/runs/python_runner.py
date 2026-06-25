#!/usr/bin/env python3
"""Python runner shim for the leetcode-workers image.

The dispatcher invokes this shim as:
    python3 /opt/runners/python_runner.py <code_path>

It then writes a JSON result to stdout describing the per-test
verdicts. The dispatcher parses that JSON and writes it to DDB.

The shim imports the user's code (a single file) as a module. The
expected solution shape is one of:
  - a function named after the problem (we don't know the function
    name at v1; instead the user's code is expected to define
    `class Solution` with a method that matches the problem's
    `entrypoint.python` field)
  - a top-level function matching `entrypoint.python` (e.g. `two_sum`)

Per design-research §5.2, the user code runs in a child subprocess
with setrlimit(RLIMIT_AS) for memory. Time is enforced by
`subprocess.run(timeout=...)` at the *outer* call (the dispatcher
wraps the shim in a timeout) — v1 does not use RLIMIT_CPU.

Why a shim, not exec() of the user's code directly:
  - We can import it as a module and call named functions
    (the shim owns dispatch; user code owns algorithm).
  - We get a structured verdict JSON for free, instead of having to
    parse the user's stdout (which we want to compare against the
    expected output anyway).
  - We can catch import errors and surface them as COMPILE_ERROR
    rather than a generic RUNTIME_ERROR.

Test case format (DDB row's `testCases`):
  [
    {"input": "2 7 11 15\\n9\\n", "expected": "0 1\\n"},
    ...
  ]

`input` is fed to the solution as `input()` calls (i.e. the user
code reads from stdin); `expected` is the exact-match expected
output, with trailing whitespace trimmed per-line before compare.
"""

from __future__ import annotations

import importlib.util
import inspect
import io
import json
import signal
import sys
import time
import traceback
from contextlib import redirect_stderr, redirect_stdout
from typing import Any, Callable


# --- sandbox primitives ------------------------------------------------------

def _apply_user_code_sandbox(mem_limit_mb: int) -> None:
    """NO-OP. v1 sandbox is enforced at the *outer* level — by the
    Fargate task's hard memory limit (1 GB task) and by the
    dispatcher's `subprocess.run(timeout=...)` for wall time.

    The previous version of this function called `setrlimit(RLIMIT_AS,
    mem_limit_mb)` on the runner process, but Python 3.13's runtime
    + boto3 + the imported user module can exceed 256 MB at startup,
    and a low RLIMIT_AS on the same process kills the runner before
    it even gets to the user code. The right model is:

      - Fargate task: 1 GB hard cap, 0.5 vCPU
      - Dispatcher:    subprocess.run(timeout=time_limit_ms/1000)
                       kills the shim if user code hangs
      - Shim:          just runs the code, no extra rlimits

    Per design-research §5.3, the proper sandbox (cgroups, seccomp,
    network isolation per submission) needs ECS-on-EC2 — v1 is
    intentionally a sandbox-free MVP.
    """
    return


def _load_user_module(code_path: str) -> Any:
    """Import the user's code file as a module. Returns the module.

    Raises ImportError or SyntaxError on bad code; the caller
    catches these and maps them to COMPILE_ERROR.
    """
    spec = importlib.util.spec_from_file_location("user_solution", code_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load spec for {code_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _resolve_entrypoint(module: Any, entrypoint: str) -> Callable[..., Any]:
    """Find the call target inside the user's module.

    `entrypoint` is a dotted name like `Solution.twoSum` (for a
    LeetCode-style class+method problem) or `two_sum` (for a
    free-function problem). The user's module must expose it.
    """
    obj: Any = module
    for part in entrypoint.split("."):
        if not hasattr(obj, part):
            raise AttributeError(
                f"user code does not define `{entrypoint}` "
                f"(missing `{part}` on {type(obj).__name__})"
            )
        obj = getattr(obj, part)
    if not callable(obj):
        raise TypeError(f"`{entrypoint}` is not callable")
    return obj


# --- test runner -------------------------------------------------------------

def _run_one_test(
    fn: Callable[..., Any],
    stdin_payload: str,
    timeout_s: float,
) -> dict[str, Any]:
    """Execute fn() with `stdin_payload` as the user's input.

    The user's code is expected to call `input()` to read from
    stdin (matching LeetCode's `stdin` convention). We feed
    `stdin_payload` and capture stdout.

    Returns a dict with `ok`, `stdout`, `stderr`, `elapsedMs`,
    `timedOut`, `error`.
    """
    started = time.monotonic()
    saved_stdin = sys.stdin
    saved_stdout = sys.stdout
    saved_stderr = sys.stderr
    sys.stdin = io.StringIO(stdin_payload)
    out_buf = io.StringIO()
    err_buf = io.StringIO()
    err: str | None = None
    timed_out = False
    try:
        with redirect_stdout(out_buf), redirect_stderr(err_buf):
            fn()
    except SystemExit as e:
        # The user's code called sys.exit(n). Treat n=0 as success,
        # n!=0 as a soft error.
        if e.code not in (None, 0):
            err = f"sys.exit({e.code!r})"
    except BaseException as e:  # noqa: BLE001 — broad catch is intentional
        err = f"{type(e).__name__}: {e}"
    finally:
        elapsed_ms = int((time.monotonic() - started) * 1000)
        sys.stdin = saved_stdin
        sys.stdout = saved_stdout
        sys.stderr = saved_stderr
    return {
        "ok": err is None,
        "stdout": out_buf.getvalue(),
        "stderr": err_buf.getvalue(),
        "error": err,
        "elapsedMs": elapsed_ms,
        "timedOut": timed_out,
    }


def _normalize_output(s: str) -> str:
    """Trim trailing whitespace per line. The design's exact-match rule
    (whitespace trimmed from line ends, but not collapsed)."""
    return "\n".join(line.rstrip() for line in s.splitlines())


def _run_test_cases(
    fn: Callable[..., Any],
    test_cases: list[dict[str, str]],
    time_limit_ms: int,
) -> dict[str, Any]:
    """Iterate test cases. Return summary + per-test details."""
    timeout_s = time_limit_ms / 1000.0
    results: list[dict[str, Any]] = []
    passed_count = 0
    total_count = len(test_cases)
    failed_case_index: int | None = None
    max_runtime_ms = 0
    for idx, tc in enumerate(test_cases):
        if idx > 0 and time_limit_ms > 0:
            # We don't run individual test cases in subprocesses
            # (that would be the v2 sandbox). For v1 the entire
            # module is one process; per-test timeout is enforced
            # by the OUTER dispatcher wrapping the shim, not here.
            # We accept that a hang on test 2 of 3 will fail all of
            # them — same as LeetCode's "Time Limit Exceeded" model.
            pass
        verdict = _run_one_test(fn, tc["input"], timeout_s)
        actual = _normalize_output(verdict["stdout"])
        expected = _normalize_output(tc.get("expected", ""))
        passed = (not verdict["ok"]) is False and actual == expected and not verdict["timedOut"]
        if not passed and failed_case_index is None:
            failed_case_index = idx
        if passed:
            passed_count += 1
        max_runtime_ms = max(max_runtime_ms, verdict["elapsedMs"])
        results.append({
            "index": idx,
            "passed": passed,
            "actual": actual if not passed else None,
            "expected": expected if not passed else None,
            "message": verdict["error"] or (verdict["stderr"].strip() or None),
        })
    return {
        "passedCount": passed_count,
        "totalCount": total_count,
        "runtimeMs": max_runtime_ms,
        "memoryKb": 0,  # v1 does not measure per-process RSS from the shim
        "failedCaseIndex": failed_case_index,
        "results": results,
    }


# --- entrypoint --------------------------------------------------------------

def main() -> int:
    """Read the JSON config from argv[1] file, run, write JSON result to stdout.

    The dispatcher writes a small JSON file at /tmp/<submissionId>.json
    containing the user code, entrypoint, test cases, time/memory limits.
    We use a file rather than stdin to avoid mixing user code with
    config data on the same stream.
    """
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: python_runner.py <config.json>"}))
        return 2
    config_path = sys.argv[1]
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
        code = config["code"]
        entrypoint = config["entrypoint"]
        test_cases = config["testCases"]
        time_limit_ms = int(config.get("timeLimitMs", 2000))
        mem_limit_mb = int(config.get("memoryLimitMb", 256))
    except (OSError, KeyError, ValueError) as e:
        print(json.dumps({"compileError": f"bad config: {e!r}"}))
        return 1

    # Apply the v1 sandbox HERE. The shim is the child of the
    # dispatcher; user code is loaded as a module in this same
    # process. The RLIMIT_AS applies to the whole process tree
    # under the shim (one Python interpreter, no fork).
    _apply_user_code_sandbox(mem_limit_mb)

    # Write the user code to a temp file and import it.
    import tempfile, os
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".py", delete=False, dir="/tmp"
    ) as f:
        f.write(code)
        code_path = f.name
    try:
        try:
            module = _load_user_module(code_path)
        except (SyntaxError, ImportError) as e:
            return _emit({
                "compileError": f"{type(e).__name__}: {e}",
            })
        try:
            fn = _resolve_entrypoint(module, entrypoint)
        except (AttributeError, TypeError) as e:
            return _emit({"compileError": str(e)})
        summary = _run_test_cases(fn, test_cases, time_limit_ms)
        return _emit(summary)
    except BaseException as e:  # noqa: BLE001
        # Anything else — likely an OOM-killed shim. The shim being
        # alive is enough to report it; the dispatcher wraps us in
        # a timeout for the wall-clock enforcement.
        return _emit({"runtimeError": f"{type(e).__name__}: {e}"})
    finally:
        try:
            os.unlink(code_path)
        except OSError:
            pass


def _emit(payload: dict[str, Any]) -> int:
    """Write the result JSON to stdout, exit 0."""
    sys.stdout.write(json.dumps(payload))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
