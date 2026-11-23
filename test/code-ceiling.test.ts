// The code ceiling (code-ceiling.json): Pako's code may not grow past its size on the day of the feature freeze, so new code replaces old.
// Tests and docs do not count. When the code shrinks well below the ceiling, the ceiling comes down with it (a ratchet), so room made by
// deleting is not quietly spent later.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const CODE = /\.(ts|js|cjs|mjs|swift|sh|ps1)$/;
const PLACES = ["src/", "assistant/", "desktop/", "bin/", "voice-worker/src/"];
/** How far below the ceiling the code may sit before the ceiling must come down to it. */
const SLACK = 1000;
/** Private-only (bin/mirror.ts never exports it): left out, so the private and the public repository count the same. */
const PRIVATE_ONLY = new Set(["bin/mirror.ts"]);

/** Non-blank lines of every tracked code file that counts, by file. */
function codeLines(): Map<string, number> {
  const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n")
    .filter((f) => CODE.test(f) && !PRIVATE_ONLY.has(f) && (PLACES.some((p) => f.startsWith(p)) || !f.includes("/")));
  return new Map(files.map((f) => [f, readFileSync(new URL(f, root), "utf8").split("\n").filter((l) => l.trim()).length]));
}

test("code ceiling: Pako's code is no bigger than code-ceiling.json allows (new code replaces old), and the ceiling follows the code down", () => {
  const ceiling = (JSON.parse(readFileSync(new URL("code-ceiling.json", root), "utf8")) as { lines: number }).lines;
  const byFile = codeLines();
  const total = [...byFile.values()].reduce((a, b) => a + b, 0);
  const biggest = [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([f, n]) => `${f} ${n}`).join(", ");
  assert.ok(total <= ceiling, `the code is ${total} lines, ${total - ceiling} over the ceiling of ${ceiling}: delete as much as you add `
    + `(the biggest files: ${biggest}). Raising the ceiling needs the owner's yes.`);
  assert.ok(total >= ceiling - SLACK, `the code is ${total} lines, ${ceiling - total} under the ceiling: set "lines" in code-ceiling.json to ${total}`);
});
