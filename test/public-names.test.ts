// The public mirror (AnxovatomicaES/pako-personal-assistant) never carries a private name. The scrub renames them on export; this is the
// second line. The names are never written in either repository, not even hashed: they are read from a plain-text file outside the
// repository (one name or two-word name per line, `#` starts a comment), named by PAKO_PRIVATE_NAMES or found at ~/.pako-private-names.
// In the private repository, or with no such file (CI, a contributor's clone), the scan is skipped; whoever exports the mirror has the
// file and runs the gate in the public checkout.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const repo = join(import.meta.dirname, "..");
const listFile = process.env.PAKO_PRIVATE_NAMES || join(homedir(), ".pako-private-names");
const isPublic = /pako-personal-assistant/.test(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).repository?.url ?? "");
const skip = !isPublic ? "the private repository" : !existsSync(listFile) && "no private names file";

/** The names in a names file: lower case, one per line, blank lines and `#` comments left out. */
export function readNames(text: string): Set<string> {
  const names = text.split("\n").map((l) => l.replace(/#.*/, "").trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean);
  return new Set(names);
}

/** Where a private name is in `text`: its line numbers (the name is not said). */
export function privateNameLines(text: string, names: Set<string>): number[] {
  const hits: number[] = [];
  text.split("\n").forEach((line, i) => {
    const words = line.toLowerCase().match(/[a-z]+/g) ?? [];
    if (words.some((w, j) => names.has(w) || (j > 0 && names.has(`${words[j - 1]} ${w}`)))) hits.push(i + 1);
  });
  return hits;
}

test("public names: a word or a pair of words is found, any case, and nothing else is", () => {
  const names = readNames("# test list\nAcmeCo\n\nJane  Roe\n");
  assert.deepEqual([...names], ["acmeco", "jane roe"]);
  assert.deepEqual(privateNameLines("hello\nAcmeCo ships\nJane  Roe said\njane\nroe", names), [2, 3]);
  assert.deepEqual(privateNameLines("acmecorp, jane doe, roe", names), []);
});

test("public names: no tracked file carries a name from the private list", { skip }, () => {
  const names = readNames(readFileSync(listFile, "utf8"));
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8" }).split("\0").filter(Boolean);
  const found: string[] = [];
  for (const f of files) {
    const buf = readFileSync(join(repo, f));
    if (buf.includes(0)) continue; // binary
    for (const n of privateNameLines(buf.toString("utf8"), names)) found.push(`${f}:${n}`);
  }
  assert.deepEqual(found, [], "a private name is in these lines: scrub them before anything is pushed");
});
