// The scripts that run the tests (bin/gate.sh, bin/zone-tests.sh, bin/nightly-gate.sh, bin/with-tmp.sh): a failing step must fail them, and
// the nightly one must say so. git, osascript and the gate itself are stand-ins here: nothing is fetched, nothing is shown.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");
const tmp = (): string => mkdtempSync(join(tmpdir(), "pako-gate-"));

function tool(bin: string, name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

test("with-tmp.sh: the command's own exit code comes back, and its folder is gone afterwards", () => {
  const outer = tmp();
  const r = spawnSync("sh", [join(ROOT, "bin", "with-tmp.sh"), "sh", "-c", 'echo "$TMPDIR"; exit 7'], { encoding: "utf8", env: { ...process.env, TMPDIR: `${outer}/` } });
  assert.equal(r.status, 7);
  assert.ok(r.stdout.startsWith(outer) && r.stdout.includes("/pako-run."), r.stdout);
  assert.deepEqual(readdirSync(outer), [], "removed");
});

test("nightly-gate.sh: when the fetch fails (offline at 03:30) it still says so, and leaves no folder behind", () => {
  const home = tmp();
  const bin = join(home, "bin");
  mkdirSync(bin);
  const said = join(home, "said");
  tool(bin, "git", 'case "$*" in *fetch*) echo "fatal: unable to access" >&2; exit 128 ;; esac; exit 0');
  tool(bin, "osascript", `printf '%s\\n' "$*" >> '${said}'`);
  const temp = join(home, "temp");
  mkdirSync(temp);
  const r = spawnSync("sh", [join(ROOT, "bin", "nightly-gate.sh")], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: `${temp}/` },
  });
  assert.notEqual(r.status, 0, "a gate that did not run is not a pass");
  assert.ok(existsSync(said), "a notification, as for failing tests");
  assert.match(readFileSync(said, "utf8"), /Pako nightly/);
  const logs = join(home, "Library", "Logs", "pako-nightly");
  assert.equal(readdirSync(logs).length, 1);
  assert.match(readFileSync(join(logs, readdirSync(logs)[0]!), "utf8"), /unable to access/);
  assert.deepEqual(readdirSync(temp), [], "the throwaway folder is removed");
});
