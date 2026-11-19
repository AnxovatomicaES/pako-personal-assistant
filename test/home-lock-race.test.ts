import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const run = (dir: string, at: number) => new Promise<string>((resolve) => {
  const c = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "home-lock-child.ts"), dir, String(at)]);
  let out = "";
  c.stdout.on("data", (b) => (out += b));
  c.on("exit", () => resolve(out.trim()));
});

test("two Pakos started at the same moment on one home: only one gets the lock", async () => {
  let both = 0;
  let raced = 0;
  for (let i = 0; i < 8; i++) {
    const dir = mkdtempSync(join(tmpdir(), "pako-hunt-lock-"));
    const at = Date.now() + 1500;
    const r = await Promise.all([run(dir, at), run(dir, at)]);
    // A real race only: both took or tried within a second of each other, while the other still held its lock (each holds 3 s). On a busy
    // machine one child can take the lock after the other has already let go: both say LOCKED, rightly, one after the other.
    const held = r.map((x) => Number(x.split(" ")[2]));
    if (held.some((n) => !Number.isFinite(n)) || Math.abs(held[0]! - held[1]!) > 1000) continue;
    raced++;
    if (r.every((x) => x.startsWith("LOCKED"))) both++;
  }
  assert.ok(raced >= 3, `only ${raced} of 8 tries raced: the machine was too busy to test the race`);
  assert.equal(both, 0, `both processes held the lock in ${both} of ${raced} races`);
});

test("a stale lock is still taken over, and a lock held by a live Pako still refuses", async () => {
  const { lockHome } = await import("../src/local.ts");
  const { writeFileSync, readFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "pako-hunt-lock-"));
  writeFileSync(join(dir, ".lock"), "999999\n18999\n1\n\n\n");
  const release = lockHome(dir, 18999, 10);
  assert.equal(Number.parseInt(readFileSync(join(dir, ".lock"), "utf8"), 10), process.pid);
  release();
  writeFileSync(join(dir, ".lock"), `${process.ppid}\n18999\n1\n\n\n`);
  assert.throws(() => lockHome(dir, 18999, 10), /already running/);
});
