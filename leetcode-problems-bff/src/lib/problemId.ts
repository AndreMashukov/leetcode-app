/**
 * Problem ID generation.
 *
 * Format: 8 chars total — 6 random Base62 + 2-char checksum.
 * Example: "aB3xY7" + "9K" -> "aB3xY79K"
 *
 * Why this shape (mirrors pastebin-author-bff's pasteId generator):
 *   - 6 random Base62 chars give 62^6 = ~56.8 B ids. At 10 K problems/day
 *     that's ~15 000 years of headroom before birthday-paradox
 *     collision is meaningful (~1e-6). We accept the tiny collision
 *     risk rather than carry a separate KGS service.
 *   - 2-char Base62 checksum catches typos. 62^2 = 3844 possible
 *     checksums; with random ids the chance of a single-char typo
 *     producing a valid checksum is ~0.026%. We accept that.
 *   - Total 8 chars, lowercase + digits, easy to type, URL-safe.
 *
 * `checksum2` is the SAME algorithm as
 * pastebin-author-bff/src/lib/pasteId.ts:checksum2 — if we ever change
 * one, we change both. We could move this to a shared package later.
 *
 * Slug uniqueness is enforced separately: when createProblem receives
 * a duplicate slug, the table's conditional Put fails and we surface
 * 409. (Slug is part of the row but NOT the primary key — we look up
 * the existing row by GSI2 tag-slug slice or a separate Query if we
 * add a `slug` GSI in v1.1. For v1 we just rely on a one-time
 * conditional Put on `attribute_not_exists(pk)` — see handlers.ts.)
 */

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Generate `bytes` random Base62 characters from `crypto.randomBytes`.
 * Each input byte (0-255) is mapped to a Base62 character by
 * `b % 62` -- 256 mod 62 = 8, so the first 8 chars of BASE62 are
 * slightly biased (5/256 vs 4/256 chance). For problem IDs this bias
 * is invisible; if it ever matters, switch to rejection sampling.
 */
export function randomBase62(bytes: number): string {
  // Lazy import: `crypto` is a Node global so we could `import { randomBytes }
  // from 'crypto'` at the top, but we want this module to stay
  // importable from `aws-lambda-stream` test harnesses that don't
  // require a full Node module loader. Calling it lazily works in
  // both contexts (Node Lambda + test).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
  const buf = randomBytes(bytes);
  let out = "";
  for (let i = 0; i < bytes; i++) {
    out += BASE62[buf[i]! % BASE62.length];
  }
  return out;
}

/**
 * 2-character Base62 checksum of an input string. Same algorithm as
 * pastebin-author-bff/src/lib/pasteId.ts:checksum2 — 31-bit sum mod
 * 3844 (62^2), encoded as two Base62 chars.
 */
export function checksum2(s: string): string {
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    sum = (sum * 31 + s.charCodeAt(i)) & 0x7fffffff;
  }
  // mod 62^2 (= 3844) to keep the sum to 2 base62 chars.
  // 3844 < 62^2, so both lookups are in-range, but
  // `noUncheckedIndexedAccess` still types them as `string | undefined`.
  // We compute the two char indices into local consts and use
  // non-null assertions here because the modulo bounds them
  // inside BASE62.length, which is 62.
  const mod = sum % (BASE62.length * BASE62.length);
  const hi = Math.floor(mod / BASE62.length);
  const lo = mod % BASE62.length;
  return BASE62[hi]! + BASE62[lo]!;
}

/**
 * Generate a fresh problem ID: 6 random Base62 chars + 2-char checksum.
 * The function is a fresh-call site (not idempotent on a given input);
 * the caller decides whether to re-derive the ID for retries (we do NOT
 * for problem creation — see src/rest/handlers.ts for the retry policy).
 */
export function generateProblemId(): string {
  const random = randomBase62(6);
  return random + checksum2(random);
}

/**
 * Validate that an arbitrary string looks like a problem ID. Used by
 * handlers to defend against 400-on-malformed-input rather than
 * silently forwarding garbage to DDB.
 */
export function isProblemId(s: string): boolean {
  return /^[0-9A-Za-z]{8}$/.test(s);
}
