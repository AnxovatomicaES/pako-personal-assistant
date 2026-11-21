// The public mirror (AnxovatomicaES/pako-personal-assistant) never carries a private name. The scrub (.claude/mirror.sh) renames them on
// export; this is the second line: in the public repository, every tracked text file is read and each word (and each pair of words) is
// hashed and compared with the hashes below, so the names themselves are not written here. In the private repository it is skipped.
// To add a name: printf 'pako-scrub:%s' "<name in lower case>" | shasum -a 256

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const repo = join(import.meta.dirname, "..");
const PRIVATE = new Set([
  "7f198f99aedcc08765e025667982301ce7416658483d24fd1ebfc0c8a00a54b9",
  "9ed328c496b273e990b5659fa57ece6888ce5a0ebc2920876d647618a9deb04f",
  "4f75b367b4fe2ba4250939547bf428264aae60b3da1d161a710f98cb12cab047",
  "44e942467f546f0bfa231b3d47c9bb46dc4a22a62f8b62de1299c5d1a03af74b",
  "5d12bf22b7dda4489454ef9de7a9e921e7e801664f5b136228d847762a06ac5c",
  "2f96920f114e450bfbe8878cd086c874418ea84ddfca5e940e9910dd9b259937",
  "9ee1a84e3eb87ca484ab41f6bcce6437d50c658e7768c45750c5ade7838473f1",
  "68291051a317c82e7a25105f31e171f13b91da452e8e22196a9b1bee1a74236e",
  "2c45eae6b72c34cc1763d42417d52e2ea7dbff692017f62dc1a4ceeaee734779",
]);
const isPublic = /pako-personal-assistant/.test(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).repository?.url ?? "");
const hash = (w: string) => createHash("sha256").update(`pako-scrub:${w}`).digest("hex");

/** Where a private name is in `text`: its line numbers (the name is not said). */
export function privateNameLines(text: string, names = PRIVATE): number[] {
  const hits: number[] = [];
  text.split("\n").forEach((line, i) => {
    const words = line.toLowerCase().match(/[a-z]+/g) ?? [];
    if (words.some((w, j) => names.has(hash(w)) || (j > 0 && names.has(hash(`${words[j - 1]} ${w}`))))) hits.push(i + 1);
  });
  return hits;
}

test("public names: a word or a pair of words is found by its hash, any case, and nothing else is", () => {
  const names = new Set([hash("acmeco"), hash("jane roe")]);
  assert.deepEqual(privateNameLines("hello\nAcmeCo ships\nJane  Roe said\njane\nroe", names), [2, 3]);
  assert.deepEqual(privateNameLines("acmecorp, jane doe, roe", names), []);
});

test("public names: the public mirror carries none of the private names", { skip: !isPublic && "the private repository" }, () => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8" }).split("\0").filter(Boolean);
  const found: string[] = [];
  for (const f of files) {
    const buf = readFileSync(join(repo, f));
    if (buf.includes(0)) continue; // binary
    for (const n of privateNameLines(buf.toString("utf8"))) found.push(`${f}:${n}`);
  }
  assert.deepEqual(found, [], "a private name is in these lines: scrub them (.claude/mirror.sh) before anything is pushed");
});
