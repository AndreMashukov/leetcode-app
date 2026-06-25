/**
 * Subset of leetcode-problems-bff's row shape that this stack needs
 * at submit time (the slug→problemId lookup + a difficulty snapshot
 * for the user's submission history).
 *
 * We keep this locally because the cross-stack TypeScript boundary
 * does not export types — only data. If the source-of-truth enum
 * in problems-bff ever changes, we want a compile error here, not
 * a silent read.
 */
export type Difficulty = "easy" | "medium" | "hard";

export interface ProblemLookupRow {
  problemId: string;
  slug: string;
  difficulty: Difficulty;
}
