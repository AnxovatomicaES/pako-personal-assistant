// The Mac app's calendar feed (desktop/mac/Discovery.swift CalendarFeed), built from the real Swift sources with a fake EventKit
// (test/fixtures/mac-calendar-feed): turning the calendars off is the last thing Pako hears, even with a push still reading its events.
// Needs macOS with swiftc; skipped elsewhere.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const repo = join(import.meta.dirname, "..");
const mac = join(repo, "desktop", "mac");
const hasSwift = process.platform === "darwin" && spawnSync("swiftc", ["--version"], { stdio: "ignore" }).status === 0;
const skip = hasSwift ? false : "needs macOS with swiftc (the Command Line Tools)";

test("turning the Mac's calendars off while a push is still reading them: the empty list is posted last, so Pako forgets them", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pako-feed-"));
  try {
    const sources = ["Core.swift", "DiscoveryCore.swift", "Pako.swift", "Discovery.swift"].map((f) => join(mac, f));
    const fw = ["-framework", "AppKit", "-framework", "EventKit", "-framework", "Contacts"];
    const main = join(repo, "test", "fixtures", "mac-calendar-feed", "main.swift");
    const b = spawnSync("swiftc", ["-Onone", "-swift-version", "5", ...fw, ...sources, main, "-o", join(dir, "feed")], { encoding: "utf8" });
    assert.equal(b.status, 0, b.stderr);
    const r = spawnSync(join(dir, "feed"), [], { encoding: "utf8", timeout: 30_000, env: { HOME: dir, PATH: "/usr/bin:/bin" } });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /PASS: Pako was told to forget last/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
