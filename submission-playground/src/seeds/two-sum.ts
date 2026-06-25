import type { Language } from "./types";

/** POST /problems body for the dev two-sum fixture. */
export const TWO_SUM_SEED = {
  title: "Two Sum",
  slug: "two-sum",
  description:
    "Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.",
  difficulty: "easy" as const,
  tags: ["arrays", "hash-table"],
  examples: [
    {
      input: "nums = [2,7,11,15], target = 9",
      output: "[0,1]",
      explanation: "Because nums[0] + nums[1] == 9, we return [0, 1].",
    },
  ],
  constraints: ["2 <= nums.length <= 10^4"],
  timeLimitMs: 2000,
  memoryLimitKb: 262144,
  starterCode: {
    python: "def two_sum():\n    pass\n",
    pythonEntrypoint: "two_sum",
    javascript: "function twoSum() {}\n",
    javascriptEntrypoint: "twoSum",
  },
  testCases: [
    { input: "[2,7,11,15]\n9\n", expected: "[0,1]\n" },
    { input: "[3,2,4]\n6\n", expected: "[1,2]\n" },
  ],
};

/** Runner reads stdin and prints stdout; entrypoint is called with no args. */
export const DEFAULT_PYTHON = `def two_sum():
    import sys
    import json

    lines = sys.stdin.read().strip().split("\\n")
    nums = json.loads(lines[0])
    target = int(lines[1])
    seen = {}
    for i, n in enumerate(nums):
        if target - n in seen:
            print(json.dumps([seen[target - n], i], separators=(",", ":")))
            return
        seen[n] = i
`;

export const DEFAULT_JAVASCRIPT = `function twoSum() {
  const fs = require("fs");
  const lines = fs.readFileSync(0, "utf8").trim().split("\\n");
  const nums = JSON.parse(lines[0]);
  const target = parseInt(lines[1], 10);
  const seen = new Map();
  for (let i = 0; i < nums.length; i++) {
    const need = target - nums[i];
    if (seen.has(need)) {
      console.log(JSON.stringify([seen.get(need), i]));
      return;
    }
    seen.set(nums[i], i);
  }
}
`;

export function defaultCode(language: Language): string {
  return language === "python" ? DEFAULT_PYTHON : DEFAULT_JAVASCRIPT;
}
