// install.sh's catch_up_git: a clone made before the public history was rewritten (21 November 2026) is no longer a fast-forward of
// origin. A clean copy whose files are one of origin's versions moves to origin's newest; a copy with changes or commits of its own is left.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = readFileSync(join(import.meta.dirname, "..", "install.sh"), "utf8");
const fn = /# >>> catch_up_git\n([\s\S]*?)# <<< catch_up_git/.exec(script)![1]!;
const helpers = 'DRY=0\nmsg() { printf \'%s\\n\' "$1"; }\nrun() { "$@"; }\n';

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const commit = (cwd: string, file: string, text: string, msg: string) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", msg);
};
const catchUp = (dir: string) => {
  try {
    const out = execFileSync("sh", ["-c", `${helpers}${fn}\ncatch_up_git "$1"`, "sh", dir], { env, encoding: "utf8", stdio: "pipe" });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: String((e as { stdout?: string }).stdout ?? "") };
  }
};

/** An origin with two versions, a clone of it, then origin's history rewritten (same files, new commits) with a third version on top. */
function rewritten() {
  const root = mkdtempSync(join(tmpdir(), "pako-history-"));
  const origin = join(root, "origin");
  execFileSync("mkdir", ["-p", origin]);
  git(origin, "init", "-q", "-b", "main");
  commit(origin, "a.txt", "one\n", "v1");
  commit(origin, "a.txt", "two\n", "v2");
  git(root, "clone", "-q", origin, "copy");
  const copy = join(root, "copy");
  git(origin, "checkout", "-q", "--orphan", "new");
  commit(origin, "a.txt", "one\n", "v1 again");
  commit(origin, "a.txt", "two\n", "v2 again");
  commit(origin, "a.txt", "three\n", "v3");
  git(origin, "branch", "-q", "-M", "new", "main");
  return { root, origin, copy };
}

test("install: a clean copy from before the rewrite moves to origin's newest, saying why", () => {
  const { root, origin, copy } = rewritten();
  try {
    const r = catchUp(copy);
    assert.equal(r.ok, true, r.out);
    assert.match(r.out, /history was rewritten/);
    assert.equal(git(copy, "rev-parse", "HEAD"), git(origin, "rev-parse", "main"));
    assert.equal(readFileSync(join(copy, "a.txt"), "utf8"), "three\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install: a copy with changed files or a commit of its own is left as it was", () => {
  const { root, copy } = rewritten();
  try {
    writeFileSync(join(copy, "a.txt"), "mine\n");
    assert.equal(catchUp(copy).ok, false, "changed files");
    assert.equal(readFileSync(join(copy, "a.txt"), "utf8"), "mine\n");
    commit(copy, "a.txt", "mine\n", "my own");
    const before = git(copy, "rev-parse", "HEAD");
    assert.equal(catchUp(copy).ok, false, "a commit of its own");
    assert.equal(git(copy, "rev-parse", "HEAD"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install: an ordinary fast-forward is still just a pull", () => {
  const root = mkdtempSync(join(tmpdir(), "pako-history-"));
  try {
    const origin = join(root, "origin");
    execFileSync("mkdir", ["-p", origin]);
    git(origin, "init", "-q", "-b", "main");
    commit(origin, "a.txt", "one\n", "v1");
    git(root, "clone", "-q", origin, "copy");
    commit(origin, "a.txt", "two\n", "v2");
    const r = catchUp(join(root, "copy"));
    assert.equal(r.ok, true, r.out);
    assert.doesNotMatch(r.out, /rewritten/);
    assert.equal(readFileSync(join(root, "copy", "a.txt"), "utf8"), "two\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install: origin out of reach (offline, GitHub down) is not taken for a rewrite: it fails, saying so, and the copy is as it was", () => {
  const root = mkdtempSync(join(tmpdir(), "pako-history-"));
  try {
    const origin = join(root, "origin");
    execFileSync("mkdir", ["-p", origin]);
    git(origin, "init", "-q", "-b", "main");
    commit(origin, "a.txt", "one\n", "v1");
    git(root, "clone", "-q", origin, "copy");
    const copy = join(root, "copy");
    commit(origin, "a.txt", "two\n", "v2");
    execFileSync("mv", [origin, join(root, "gone")]);
    const before = git(copy, "rev-parse", "HEAD");
    const r = catchUp(copy);
    assert.equal(r.ok, false, r.out);
    assert.doesNotMatch(r.out, /rewritten/);
    assert.match(r.out, /Couldn't reach Pako/);
    assert.equal(git(copy, "rev-parse", "HEAD"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
