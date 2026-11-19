// One Pako per home folder (src/local.ts lockHome): two started at the same moment never both hold it. Each one used to remove whatever lock
// was there before making its own, so the second could delete the first's fresh lock and both ran on the same notes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockHome } from "../src/local.ts";

const local = new URL("../src/local.ts", import.meta.url).href;
const start = (dir: string, at: number) => new Promise<string>((resolve) => {
  const code = `const { lockHome } = await import(${JSON.stringify(local)}); while (Date.now() < ${at}) {}
try { lockHome(${JSON.stringify(dir)}, 18999); console.log("LOCKED " + Date.now()); setTimeout(() => {}, 1200); } catch (e) { console.log("REFUSED " + e.message); }`;
  const c = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code]);
  let out = "";
  c.stdout.on("data", (d) => (out += d));
  c.on("close", () => resolve(out.trim()));
});

test("two Pakos started at the same moment on one folder: exactly one holds it, the other is told", async () => {
  for (let i = 0; i < 6; i++) {
    const dir = mkdtempSync(join(tmpdir(), "pako-lock-"));
    try {
      const at = Date.now() + 900;
      const outs = await Promise.all([start(dir, at), start(dir, at + 5)]);
      // Each holder keeps the lock 1.2 s. On a loaded machine the second child may only start after the first one has exited, and then it
      // rightly takes the free folder: two locks count as a race only when they were held at the same time.
      const held = outs.filter((o) => o.startsWith("LOCKED")).map((o) => Number(o.split(" ")[1]));
      if (held.length === 2 && Math.abs(held[0]! - held[1]!) >= 1200) continue;
      assert.equal(held.length, 1, outs.join(" | "));
      assert.match(outs.find((o) => o.startsWith("REFUSED"))!, /already (running|starting) for this folder/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a lock left behind is still taken over, and nothing else is left in the folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "pako-lock-"));
  try {
    writeFileSync(join(dir, ".lock"), "999999999\n8787\n1\n\n\n");
    const release = lockHome(dir, 8787);
    assert.equal(readFileSync(join(dir, ".lock"), "utf8").split("\n")[0], String(process.pid));
    assert.deepEqual(readdirSync(dir), [".lock"], "the copy written aside is gone");
    release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
