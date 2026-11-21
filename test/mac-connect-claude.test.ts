// The Connect Claude window of Pako.app (desktop/mac/Claude.swift, Connect.swift), driven by the real Swift sources with a stand-in `claude`
// (test/fixtures/mac-connect-*/fake-claude) and a temporary HOME and PAKO_HOME: nothing of the person's own Claude or Pako is touched.
// Needs macOS with swiftc; skipped elsewhere.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const repo = join(import.meta.dirname, "..");
const mac = join(repo, "desktop", "mac");
const hasSwift = process.platform === "darwin" && spawnSync("swiftc", ["--version"], { stdio: "ignore" }).status === 0;
const skip = hasSwift ? false : "needs macOS with swiftc (the Command Line Tools)";

/** Builds the fixture's main.swift with these app sources into a fresh folder, runs it with a fake claude there, and gives its output. */
const run = (fixture: string, sources: string[], appkit: boolean): { status: number | null; out: string; dir: string } => {
  const dir = mkdtempSync(join(tmpdir(), "pako-connect-"));
  cpSync(join(repo, "test", "fixtures", fixture), dir, { recursive: true });
  const fw = appkit ? ["-framework", "AppKit", "-framework", "WebKit"] : [];
  const b = spawnSync("swiftc", ["-Onone", "-swift-version", "5", "-module-name", "Pako", ...fw, ...sources.map((f) => join(mac, f)), join(dir, "main.swift"), "-o", join(dir, "repro")], { encoding: "utf8" });
  assert.equal(b.status, 0, b.stderr);
  mkdirSync(join(dir, "home"));
  const fake = join(dir, "fake-claude");
  const r = spawnSync(join(dir, "repro"), [fake], {
    encoding: "utf8", timeout: 90_000,
    env: { HOME: join(dir, "home"), PAKO_HOME: join(dir, "home", ".pako"), CLAUDE_BIN: fake, PATH: "/usr/bin:/bin" },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, dir };
};

test("a code Claude refuses, twice in a row: the field opens again each time, says why, and shows 'Checking the code…' meanwhile", { skip }, () => {
  const r = run("mac-connect-code", ["Core.swift", "Pako.swift", "Claude.swift", "Texts.swift", "Update.swift", "Connect.swift", "Status.swift"], true);
  assert.equal(r.status, 0, `the code field stayed disabled after a refused code:\n${r.out}`);
  assert.match(r.out, /right after pressing Continue for code 1: title="Checking the code…"/, r.out);
  assert.doesNotMatch(r.out, /Press Try again/, "the window names a Try again button it does not show");
  assert.match(r.out, /paste it again/, r.out);
});

test("the one-button window in every state: Connect your Claude account, the install's seconds, the browser, Connected with the address and plan, the free plan", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pako-connect-states-"));
  cpSync(join(repo, "test", "fixtures", "mac-connect-states"), dir, { recursive: true });
  const sources = ["Core.swift", "Pako.swift", "Claude.swift", "Texts.swift", "Update.swift", "Connect.swift", "Status.swift"].map((f) => join(mac, f));
  const b = spawnSync("swiftc", ["-Onone", "-swift-version", "5", "-module-name", "Pako", "-framework", "AppKit", "-framework", "WebKit", ...sources, join(dir, "main.swift"), "-o", join(dir, "states")], { encoding: "utf8" });
  assert.equal(b.status, 0, b.stderr);
  // PAKO_CONNECT_SHOTS: a folder for a PNG of each state (the PR's screenshots); without it, only the words are checked.
  const shots = process.env.PAKO_CONNECT_SHOTS;
  const r = spawnSync(join(dir, "states"), shots ? [shots] : [], { encoding: "utf8", timeout: 60_000, env: { HOME: join(dir), PATH: "/usr/bin:/bin" } });
  assert.equal(r.status, 0, r.stderr);
  const line = (name: string) => r.stdout.split("\n").find((l) => l.startsWith(`STATE ${name} |`)) ?? "";
  assert.match(line("signed-out"), /Use your Claude subscription\. No API key\./);
  assert.match(line("signed-out"), /buttons: .*Connect your Claude account/);
  assert.match(line("signed-out"), /API key \(advanced\)/, "the key stays, tucked away");
  assert.match(line("not-installed"), /buttons: .*Connect your Claude account/);
  assert.match(line("installing"), /Installing Claude Code… 20 s/);
  assert.match(line("signing-in"), /Finish signing in in your browser…/);
  assert.match(line("connected"), /Connected \/ .*ana@example\.com · Pro plan/);
  assert.match(line("already-connected"), /ana@example\.com · Pro plan/);
  assert.match(line("api-billing"), /Connected \(API billing\)/);
  assert.match(line("needs-plan"), /Claude Code needs a Pro, Max, Team or Enterprise plan/);
  assert.match(line("needs-plan"), /buttons: .*Upgrade your plan.*Check again|buttons: .*Check again.*Upgrade your plan/);
  assert.match(line("cancelled"), /No problem: press Try again whenever you like/);
  assert.doesNotMatch(r.stdout, /Terminal|terminal/, "never a terminal");
});

test("Cancel pressed while Connect is still looking for Claude: the sign-in (the browser page) does not start", { skip }, () => {
  const r = run("mac-connect-cancel", ["Core.swift", "Pako.swift", "Claude.swift"], false);
  assert.equal(existsSync(join(r.dir, "login-started.txt")), false, `\`claude auth login\` was started after Cancel:\n${r.out}`);
  assert.equal(r.status, 0, r.out);
});
