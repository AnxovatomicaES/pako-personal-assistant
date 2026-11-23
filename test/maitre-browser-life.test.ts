// Maître's browser and the Pako that started it, on a real local Chrome (headless, a temporary profile; nothing leaves this computer):
// it ends with that Pako, and one left running by a Pako that was killed is closed by the next start instead of blocking every booking.
// Skipped without a Chromium browser, and on Windows (no ps to count the browser's processes with).

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrowserPool, findBrowser } from "../src/maitre/cdp.ts";
import { eventually } from "./helpers/wait.ts";

const exe = findBrowser();
const skip = !exe ? "no Chrome, Edge, Brave or Chromium installed here" : process.platform === "win32" ? "needs ps" : false;
const child = join(import.meta.dirname, "maitre-browser-child.ts");

/** The processes of a browser started on this profile. */
function browsersOn(profile: string): number[] {
  return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 20_000_000 })
    .split("\n")
    .filter((l) => l.includes(`--user-data-dir=${profile}`))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
}

/** Runs the stand-in Pako to its end; what it printed. */
const runChild = (mode: "exit" | "kill", profile: string): Promise<string> =>
  new Promise((resolve) => {
    execFile(process.execPath, ["--disable-warning=ExperimentalWarning", child, mode, profile], { timeout: 90_000 }, (_err, stdout) => resolve(stdout));
  });

async function withProfile(fn: (profile: string) => Promise<void>): Promise<void> {
  const profile = mkdtempSync(join(tmpdir(), "pako-maitre-life-"));
  try {
    await fn(profile);
  } finally {
    // Whatever a failed test left running goes, so no browser outlives the run.
    for (const pid of browsersOn(profile)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone already */
      }
    }
    rmSync(profile, { recursive: true, force: true });
  }
}

test("maitre browser: when Pako ends, the browser it started ends too", { skip }, async () => {
  await withProfile(async (profile) => {
    assert.match(await runChild("exit", profile), /READY/);
    await eventually(() => browsersOn(profile).length === 0, { ms: 20_000 });
  });
});

test("maitre browser: a browser left on the profile by a Pako that was killed is closed by the next launch, which then works", { skip }, async () => {
  await withProfile(async (profile) => {
    assert.match(await runChild("kill", profile), /READY/);
    assert.ok(browsersOn(profile).length > 0, "a killed Pako leaves its browser running (nothing could close it)");
    const pool = new BrowserPool({ executable: exe!, profileDir: profile, idleMs: 60_000, launchTimeoutMs: 60_000 });
    try {
      assert.equal(await pool.withPage(async (page) => (await page.goto("about:blank")).status >= 0), true, "the new browser opens on the same profile");
    } finally {
      await pool.close();
    }
    await eventually(() => browsersOn(profile).length === 0, { ms: 20_000 });
  });
});
