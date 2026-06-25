#!/usr/bin/env node
/**
 * Node.js runner shim for the leetcode-workers image.
 *
 * Symmetric to python_runner.py: reads a JSON config from argv[1],
 * loads the user's code with `require()`, calls the entrypoint
 * function with input read from a fake stdin, captures stdout,
 * compares per test case, emits a JSON result on stdout.
 *
 * Sandbox (v1):
 *   - Memory: setrlimit(RLIMIT_AS) inherited from the python
 *     dispatcher (the shim is exec'd from python, so the rlimits
 *     carry over).
 *   - Time: enforced by the dispatcher's subprocess.run timeout.
 *   - No seccomp, no --no-sandbox (Node 20 has --frozen-intrinsics
 *     and --disallow-code-generation-from-strings but v1 doesn't
 *     use them — the user code is loaded as a file, not eval'd).
 *
 * Output contract: identical to python_runner.py so the dispatcher
 * can use the same parsing code.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");

// --- helpers ----------------------------------------------------------------

function loadUserModule(codePath) {
  // Use require() with a fresh cache entry. We can't simply delete
  // require.cache because the user code may have side effects
  // (imports, top-level state) that we want to surface as
  // COMPILE_ERROR rather than silent RUNTIME_ERROR.
  delete require.cache[require.resolve(codePath)];
  return require(codePath);
}

function resolveEntrypoint(mod, dotted) {
  let obj = mod;
  for (const part of dotted.split(".")) {
    if (obj == null || !(part in obj)) {
      throw new Error(
        `user code does not define \`${dotted}\` (missing \`${part}\` on ${
          obj == null ? "null" : typeof obj
        })`
      );
    }
    obj = obj[part];
  }
  if (typeof obj !== "function") {
    throw new TypeError(`\`${dotted}\` is not a function`);
  }
  return obj;
}

function normalizeOutput(s) {
  // Trim trailing whitespace per line. Matches python_runner.
  return s
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n");
}

function runOneTest(fn, stdinPayload) {
  // We feed the user code's stdin by spawning the user's CALLBACK
  // in a sub-context where process.stdin has been redirected to a
  // pre-loaded buffer. We can't use child_process.spawn for the
  // user code (it's a function, not a process), so we monkey-patch
  // process.stdin directly.
  //
  // Simpler approach (v1): the user's code reads from
  // `fs.readFileSync(process.env.STDIN_FILE)`. We set STDIN_FILE
  // to a per-test temp file before each call, then unset.
  // The runner's main() writes the *config* to a file; the
  // dispatcher writes the *test input* to STDIN_FILE and the user
  // code reads from it. This is what the user code already does
  // for the LeetCode "read input from stdin" convention.
  const fsModule = require("fs");
  const os = require("os");
  const path = require("path");
  const stdinFile = path.join(os.tmpdir(), `node-stdin-${process.pid}-${Date.now()}.txt`);
  fsModule.writeFileSync(stdinFile, stdinPayload, "utf-8");

  const outChunks = [];
  const errChunks = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = function (chunk, ...rest) {
    outChunks.push(String(chunk));
    return true;
  };
  process.stderr.write = function (chunk, ...rest) {
    errChunks.push(String(chunk));
    return true;
  };

  const started = performance.now();
  let err = null;
  // Set the env var the user code reads.
  const prevStdin = process.env.STDIN_FILE;
  process.env.STDIN_FILE = stdinFile;
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      throw new Error("async solutions are not supported at v1");
    }
  } catch (e) {
    err = `${e && e.name ? e.name : "Error"}: ${e && e.message ? e.message : e}`;
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    if (prevStdin === undefined) {
      delete process.env.STDIN_FILE;
    } else {
      process.env.STDIN_FILE = prevStdin;
    }
    try {
      fsModule.unlinkSync(stdinFile);
    } catch (_e) {
      // ignore
    }
  }
  const elapsedMs = Math.round(performance.now() - started);
  return {
    ok: err === null,
    stdout: outChunks.join(""),
    stderr: errChunks.join(""),
    error: err,
    elapsedMs,
  };
}

function runTestCases(fn, testCases) {
  const results = [];
  let passedCount = 0;
  const totalCount = testCases.length;
  let failedCaseIndex = null;
  let maxRuntimeMs = 0;
  for (let idx = 0; idx < testCases.length; idx++) {
    const tc = testCases[idx];
    const v = runOneTest(fn, tc.input);
    const actual = normalizeOutput(v.stdout);
    const expected = normalizeOutput(tc.expected || "");
    const passed = v.ok && actual === expected;
    if (!passed && failedCaseIndex === null) failedCaseIndex = idx;
    if (passed) passedCount++;
    if (v.elapsedMs > maxRuntimeMs) maxRuntimeMs = v.elapsedMs;
    results.push({
      index: idx,
      passed,
      actual: passed ? undefined : actual,
      expected: passed ? undefined : expected,
      message: v.error || (v.stderr.trim() || undefined),
    });
  }
  return {
    passedCount,
    totalCount,
    runtimeMs: maxRuntimeMs,
    memoryKb: 0,
    failedCaseIndex,
    results,
  };
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
  process.stdout.write("\n");
  return 0;
}

// --- entrypoint -------------------------------------------------------------

function main() {
  if (process.argv.length < 3) {
    process.stdout.write(
      JSON.stringify({ error: "usage: node_runner.js <config.json>" })
    );
    return 2;
  }
  const configPath = process.argv[2];
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (e) {
    process.stdout.write(JSON.stringify({ compileError: `bad config: ${e}` }));
    return 1;
  }
  const code = config.code;
  const entrypoint = config.entrypoint;
  const testCases = config.testCases;
  // time/memory limits are inherited from the dispatcher's rlimits
  // and outer timeout — Node has no portable way to set its own.

  const tmpDir = "/tmp";
  const codePath = path.join(
    tmpDir,
    `user-solution-${Date.now()}-${process.pid}.js`
  );
  try {
    fs.writeFileSync(codePath, code, "utf-8");
    let mod;
    try {
      mod = loadUserModule(codePath);
    } catch (e) {
      return emit({ compileError: `${e.name}: ${e.message}` });
    }
    let fn;
    try {
      fn = resolveEntrypoint(mod, entrypoint);
    } catch (e) {
      return emit({ compileError: e.message });
    }
    const summary = runTestCases(fn, testCases);
    return emit(summary);
  } catch (e) {
    return emit({ runtimeError: `${e.name}: ${e.message}` });
  } finally {
    try {
      fs.unlinkSync(codePath);
    } catch (_e) {
      // ignore
    }
  }
}

process.exit(main());
