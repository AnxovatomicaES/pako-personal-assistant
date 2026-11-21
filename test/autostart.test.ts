// Starting by itself (src/autostart.ts), its panel switch (src/autostart-panel.ts) and the installer (install.sh). The service files are written
// to a pretend disk and launchctl, systemctl and loginctl are pretend too: nothing here touches this computer's login items. The installer runs
// for real, but only as a dry run (PAKO_DRY_RUN=1) against a temporary home folder, and with pretend node and id commands for its refusals.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import { createApp, loadAppConfig, type LocalContext } from "../src/app.ts";
import {
  autostartFor, createAutostart, LASTING_EXIT, lastingExitCode, runAutostartCli, runsInMacApp, stableNode, type Autostart, type AutostartDeps,
  type AutostartFs, type AutostartResult,
} from "../src/autostart.ts";
import { mountAutostartPanel } from "../src/autostart-panel.ts";
import { createWindowsAutostart } from "../src/autostart-windows.ts";
import type { Kv } from "../src/kv.ts";
import { createLocalChannel, loadHome, localEnv, lockHolder, lockHome } from "../src/local.ts";

// git's hook settings (GIT_DIR and the like, when the tests run from a pre-push hook) must not reach the git this file runs in its own
// throwaway repositories: it would work on the real repository instead.
for (const k of Object.keys(process.env)) if (k.startsWith("GIT_")) delete process.env[k];

type Env = Record<string, string | undefined>;

const root = new URL("../", import.meta.url);
const tmp = (): string => mkdtempSync(join(tmpdir(), "pako-autostart-"));

/** A disk in memory: what was written, and how many writes. */
function memFs(): AutostartFs & { files: Map<string, string>; dirs: Set<string>; writes: number } {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const f = {
    files,
    dirs,
    writes: 0,
    read: (p: string) => files.get(p) ?? null,
    write: (p: string, s: string) => {
      f.writes++;
      files.set(p, s);
    },
    mkdir: (p: string) => void dirs.add(p),
    remove: (p: string) => void files.delete(p),
  };
  return f;
}

/** Pretend programs: each call is recorded as "cmd arg arg"; `answer` decides what one says (code 0 and nothing by default). */
function fakeExec(answer: (line: string) => { code: number; out: string } | undefined = () => undefined) {
  const calls: string[] = [];
  const exec = (cmd: string, args: string[]) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    return answer(line) ?? { code: 0, out: "" };
  };
  return { calls, exec };
}

const HOME = "/Users/ana maría";
const NODE = "/Users/ana maría/.nvm/versions/node/v22.18.0/bin/node";
const REPO = "/Users/ana maría/my pako & co";

function rig(platform: NodeJS.Platform, over: Partial<AutostartDeps> = {}) {
  const fs = memFs();
  const ex = fakeExec();
  const deps: AutostartDeps = {
    platform, home: HOME, user: "ana", uid: 501, node: NODE, repo: REPO, fs, exec: ex.exec, sleep: () => undefined, lang: () => "en",
    env: { PATH: "/opt/homebrew/bin:/usr/bin:relative/bin", PAKO_HOME: `${HOME}/.pako`, PORT: "8790", SECRET_TOKEN: "do-not-carry" },
    ...over,
  };
  return { fs, ex, a: createAutostart(deps), deps };
}

const ok = (r: AutostartResult): string => {
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.ok ? r.message : "";
};

test("macOS: a LaunchAgent that runs this folder with this Node.js at login, again only after a crash, its output in ~/.pako/logs", () => {
  const { fs, a } = rig("darwin");
  assert.deepEqual(a.status(), { supported: true, enabled: false, current: false, kind: "launchd", file: `${HOME}/Library/LaunchAgents/local.pako.plist` });
  ok(a.enable());
  const plist = fs.files.get(`${HOME}/Library/LaunchAgents/local.pako.plist`)!;
  assert.ok(plist, "the plist is written");
  assert.match(plist, /<key>Label<\/key>\s*<string>local\.pako<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/, "restarted after a crash only");
  // Paths with spaces stay whole (one <string> each), and & is escaped for XML.
  assert.ok(plist.includes(`<string>${NODE}</string>`));
  assert.ok(plist.includes("<string>/Users/ana maría/my pako &amp; co/src/server.ts</string>"));
  assert.ok(plist.includes("<key>WorkingDirectory</key>\n    <string>/Users/ana maría/my pako &amp; co</string>"));
  assert.ok(plist.includes(`<string>${HOME}/.pako/logs/pako.log</string>`) && plist.includes(`<string>${HOME}/.pako/logs/pako.err.log</string>`));
  assert.ok(fs.dirs.has(`${HOME}/.pako/logs`), "the logs folder is made: launchd does not make it");
  assert.match(plist, /<key>PAKO_NO_OPEN<\/key>\s*<string>1<\/string>/, "no browser at every login");
  // Node's own folder first, then the terminal's absolute folders (a relative one would depend on where launchd starts it).
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/Users\/ana maría\/\.nvm\/versions\/node\/v22\.18\.0\/bin:\/opt\/homebrew\/bin:\/usr\/bin:/);
  assert.ok(!plist.includes("relative/bin"));
  assert.match(plist, /<key>PORT<\/key>\s*<string>8790<\/string>/);
  assert.ok(!plist.includes("do-not-carry"), "only the settings it needs are carried");
  assert.deepEqual(a.status(), { supported: true, enabled: true, current: true, kind: "launchd", file: `${HOME}/Library/LaunchAgents/local.pako.plist` });
  // On a Mac, the file must be a property list launchd can read.
  if (process.platform === "darwin" && existsSync("/usr/bin/plutil")) {
    const path = join(tmp(), "local.pako.plist");
    writeFileSync(path, plist);
    const lint = spawnSync("/usr/bin/plutil", ["-lint", path], { encoding: "utf8" });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  }
});

test("macOS: on is idempotent; from the panel it only writes, from the command line it loads (or restarts) the job; off removes it", () => {
  const { fs, ex, a } = rig("darwin");
  ok(a.enable());
  ok(a.enable());
  assert.equal(fs.writes, 1, "the same contents are not written again");
  assert.deepEqual(ex.calls, [], "the panel's on runs nothing: it applies at the next login");
  // The command line: not loaded yet, so it is bootstrapped.
  const loaded = new Set<string>();
  const mac = fakeExec((line) => {
    if (line.startsWith("launchctl print")) return { code: loaded.size ? 0 : 113, out: "" };
    if (line.startsWith("launchctl bootstrap")) loaded.add("x");
    return undefined;
  });
  const b = rig("darwin", { exec: mac.exec, fs }).a;
  assert.match(ok(b.enable({ now: true })), /starting in the background/);
  assert.deepEqual(mac.calls, ["launchctl print gui/501/local.pako", `launchctl bootstrap gui/501 ${HOME}/Library/LaunchAgents/local.pako.plist`]);
  // Again (an update): loaded with the same file, so it is restarted with kickstart -k, never loaded twice.
  mac.calls.length = 0;
  ok(b.enable({ now: true }));
  assert.deepEqual(mac.calls, ["launchctl print gui/501/local.pako", "launchctl kickstart -k gui/501/local.pako"]);
  // Off from the panel removes the file and leaves the running Pako alone; from the command line it also unloads it.
  mac.calls.length = 0;
  assert.match(ok(b.disable()), /keeps going/);
  assert.equal(fs.files.size, 0);
  assert.deepEqual(mac.calls, []);
  assert.equal(b.status().enabled, false);
  ok(b.disable({ stop: true }));
  assert.deepEqual(mac.calls, ["launchctl bootout gui/501/local.pako"]);
});

test("macOS: a job loaded with other contents is unloaded and loaded again, retried while launchd lets go of it", () => {
  const fs = memFs();
  fs.files.set(`${HOME}/Library/LaunchAgents/local.pako.plist`, "old contents");
  let tries = 0;
  const mac = fakeExec((line) => {
    if (line.startsWith("launchctl bootstrap")) return ++tries < 3 ? { code: 5, out: "Bootstrap failed: 5: Input/output error" } : undefined;
    return undefined;
  });
  const { a } = rig("darwin", { fs, exec: mac.exec });
  assert.match(ok(a.enable({ now: true })), /starting in the background/);
  assert.deepEqual(mac.calls.slice(0, 2), ["launchctl print gui/501/local.pako", "launchctl bootout gui/501/local.pako"]);
  assert.equal(tries, 3);
  // launchctl never takes it: still on (the file is there for the next login), and the message says so.
  const never = fakeExec((line) => (line.startsWith("launchctl bootstrap") ? { code: 5, out: "Bootstrap failed: 5" } : line.startsWith("launchctl print") ? { code: 113, out: "" } : undefined));
  const b = rig("darwin", { exec: never.exec }).a;
  const r = b.enable({ now: true });
  assert.match(ok(r), /couldn't start it now \(Bootstrap failed: 5\): it will start the next time you log in/);
  assert.equal(r.ok && r.running, false, "on, but not running: the caller is told");
  assert.equal(b.status().enabled, true);
});

test("Linux: a systemd unit for this user, quoted for paths with spaces, % and $; enabled, restarted from the command line, with the linger hint", () => {
  const repo = "/home/ana/pako 100% $HOME";
  const linux = fakeExec((line) => (line.startsWith("loginctl") ? { code: 0, out: "Linger=no" } : undefined));
  const { fs, a } = rig("linux", { home: "/home/ana", repo, node: "/home/ana/node \"22\"/bin/node", exec: linux.exec, env: { PATH: "/usr/bin", PAKO_HOME: "/home/ana/.pako" } });
  const file = "/home/ana/.config/systemd/user/pako.service";
  const msg = ok(a.enable({ now: true }));
  const unit = fs.files.get(file)!;
  assert.ok(unit.includes("WorkingDirectory=/home/ana/pako 100%% $HOME\n"));
  assert.ok(unit.includes('ExecStart="/home/ana/node \\"22\\"/bin/node" --disable-warning=ExperimentalWarning "/home/ana/pako 100%% $$HOME/src/server.ts"\n'));
  assert.ok(unit.includes('Environment="PAKO_NO_OPEN=1" "PAKO_SERVICE=1" "PATH=/home/ana/node \\"22\\"/bin:/usr/bin:/usr/local/bin:/bin" "PAKO_HOME=/home/ana/.pako"\n'));
  assert.match(unit, /^Restart=on-failure$/m);
  // A failure a restart cannot mend (exit 78) is not restarted, and any other one stops after five tries in ten minutes.
  assert.match(unit, /^RestartPreventExitStatus=78$/m);
  assert.match(unit, /\[Unit\][^[]*^StartLimitIntervalSec=600$[^[]*^StartLimitBurst=5$/m);
  assert.match(unit, /^StandardOutput=append:\/home\/ana\/\.pako\/logs\/pako\.log$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.deepEqual(linux.calls, [
    "systemctl --user daemon-reload", "systemctl --user enable pako.service", "systemctl --user restart pako.service", "loginctl show-user 501 --property=Linger",
  ]);
  assert.match(msg, /loginctl enable-linger ana/);
  assert.equal(a.status().current, true);
  // Again, with lingering on: the same file, no hint, nothing restarted from the panel.
  const again = fakeExec((line) => (line.startsWith("loginctl") ? { code: 0, out: "Linger=yes" } : undefined));
  const b = rig("linux", { home: "/home/ana", repo, node: "/home/ana/node \"22\"/bin/node", fs, exec: again.exec, env: { PATH: "/usr/bin", PAKO_HOME: "/home/ana/.pako" } }).a;
  const writes = fs.writes;
  assert.doesNotMatch(ok(b.enable()), /linger/);
  assert.equal(fs.writes, writes);
  assert.ok(!again.calls.some((c) => c.includes("restart")));
  // Off: systemd is told before the file goes (it needs the unit to undo its links), then reloads.
  again.calls.length = 0;
  ok(b.disable({ stop: true }));
  assert.deepEqual(again.calls, ["systemctl --user disable --now pako.service", "systemctl --user daemon-reload"]);
  assert.equal(fs.files.has(file), false);
  assert.equal(b.status().enabled, false);
  // Off when it was never on: nothing to tell systemd.
  again.calls.length = 0;
  ok(b.disable());
  assert.deepEqual(again.calls, []);
});

test("Linux without a user systemd: an error, and no unit left behind saying on", () => {
  const none = fakeExec((line) => (line.includes("daemon-reload") ? { code: 1, out: "Failed to connect to bus: No medium found" } : undefined));
  const { fs, a } = rig("linux", { home: "/home/ana", exec: none.exec });
  const r = a.enable();
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /systemctl --user: Failed to connect to bus/);
  assert.equal(fs.files.size, 0);
  assert.equal(a.status().enabled, false);
});

test("never as root, never on a system it does not know, never with a line break in a path", () => {
  const asRoot = rig("darwin", { uid: 0 });
  const r = asRoot.a.enable({ now: true });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /as root/);
  assert.equal(asRoot.fs.files.size, 0);
  assert.deepEqual(asRoot.ex.calls, []);
  const win = rig("win32");
  assert.deepEqual(win.a.status(), { supported: false, enabled: false, current: false, kind: null, file: null });
  assert.equal(win.a.enable().ok, false);
  assert.equal(win.a.disable().ok, false);
  const odd = rig("darwin", { repo: "/Users/ana/pa\nko" });
  assert.match((odd.a.enable() as { error: string }).error, /line break/);
  assert.equal(odd.fs.files.size, 0);
});

test("status: on for another folder or another Node.js is not current", () => {
  const fs = memFs();
  rig("darwin", { fs }).a.enable();
  assert.equal(rig("darwin", { fs, repo: "/Users/ana/other pako" }).a.status().current, false);
  assert.equal(rig("darwin", { fs, node: "/usr/local/bin/node" }).a.status().current, false);
  assert.equal(rig("darwin", { fs, env: { PATH: "/somewhere/else" } }).a.status().current, true, "a different PATH does not count");
});

test("a failure a restart cannot mend is not restarted: exit 0 under launchd, 78 under systemd, 1 by hand; the files mark the background Pako", () => {
  assert.equal(lastingExitCode({}, "darwin"), 1, "npm start: as before");
  assert.equal(lastingExitCode({}, "linux"), 1);
  assert.equal(lastingExitCode({ PAKO_SERVICE: "1" }, "darwin"), 0, "launchd starts again after any exit but 0");
  assert.equal(lastingExitCode({ PAKO_SERVICE: "1" }, "linux"), LASTING_EXIT);
  assert.equal(LASTING_EXIT, 78);
  const { fs, a } = rig("darwin");
  ok(a.enable());
  assert.match(fs.files.get(`${HOME}/Library/LaunchAgents/local.pako.plist`)!, /<key>PAKO_SERVICE<\/key>\s*<string>1<\/string>/);
  // The server: a held lock exits with that code (src/server.ts), and the lock says who holds it (src/local.ts).
  const server = readFileSync(new URL("src/server.ts", root), "utf8");
  assert.equal(server.match(/process\.exit\(lastingExitCode\(process\.env\)\)/g)?.length, 2, "the lock and the settings");
  assert.match(server, /EADDRINUSE" && localMode \? lastingExitCode\(process\.env\)/);
  const dir = tmp();
  const release = lockHome(dir, 8787, undefined, true);
  assert.match(readFileSync(join(dir, ".lock"), "utf8"), /^\d+\n8787\n\d+\nservice\n\d+\n$/);
  release();
  writeFileSync(join(dir, ".lock"), `${process.ppid}\n8787\n1\n`);
  assert.deepEqual(lockHolder(dir, 1000), { pid: process.ppid, service: false }, "a live Pako started by hand");
  assert.equal(lockHolder(dir, 0), null, "from before the computer restarted");
  writeFileSync(join(dir, ".lock"), "999999999\n8787\n1\nservice\n");
  assert.equal(lockHolder(dir, 1000), null, "a process that is gone");
});

test("a Pako started by hand holds the folder: on is set for the next login, nothing is started into its lock, and the command line says 3", async () => {
  const held = () => ({ pid: 4242, service: false });
  // macOS, with a job loaded from before (perhaps failing on that lock): unloaded, never bootstrapped or kickstarted.
  const mac = fakeExec();
  const { fs, a } = rig("darwin", { exec: mac.exec, running: held });
  const r = a.enable({ now: true });
  assert.match(ok(r), /already running in another terminal \(process 4242\)/);
  assert.equal(r.ok && r.running, false);
  assert.deepEqual(mac.calls, ["launchctl print gui/501/local.pako", "launchctl bootout gui/501/local.pako"]);
  assert.equal(a.status().enabled, true, "it starts by itself at the next login");
  // The background Pako's own lock is no reason not to: it is restarted with what's new.
  const again = fakeExec();
  ok(rig("darwin", { fs, exec: again.exec, running: () => ({ pid: 4242, service: true }) }).a.enable({ now: true }));
  assert.deepEqual(again.calls, ["launchctl print gui/501/local.pako", "launchctl kickstart -k gui/501/local.pako"]);
  // Linux: enabled, not restarted.
  const linux = fakeExec();
  const l = rig("linux", { home: "/home/ana", exec: linux.exec, running: held }).a.enable({ now: true });
  assert.equal(l.ok && l.running, false);
  assert.ok(!linux.calls.some((c) => c.includes("restart")), linux.calls.join("\n"));
  // The command line: 3, and no "open the panel" for a Pako that is not the new one.
  const said: string[] = [];
  const code = await runAutostartCli("on", {
    platform: "darwin", home: HOME, uid: 501, node: NODE, repo: REPO, fs: memFs(), exec: fakeExec().exec, sleep: () => undefined,
    lang: () => "en", env: {}, running: held, print: (s) => void said.push(s),
  });
  assert.equal(code, 3);
  assert.doesNotMatch(said.at(-1)!, /npm run panel, in/);
  // launchctl failing to start it now: 3 as well.
  const never = fakeExec((line) => (line.startsWith("launchctl bootstrap") ? { code: 5, out: "Bootstrap failed: 5" } : line.startsWith("launchctl print") ? { code: 113, out: "" } : undefined));
  assert.equal(await runAutostartCli("on", {
    platform: "darwin", home: HOME, uid: 501, node: NODE, repo: REPO, fs: memFs(), exec: never.exec, sleep: () => undefined,
    lang: () => "en", env: {}, running: () => null, print: () => undefined,
  }), 3);
});

test("Homebrew's Node.js is written by its stable link, not by the Cellar folder an upgrade removes; others as they are", () => {
  const cellar = "/opt/homebrew/Cellar/node/24.1.0/bin/node";
  const links: Record<string, string> = {
    [cellar]: cellar, "/opt/homebrew/opt/node/bin/node": cellar, "/opt/homebrew/bin/node": cellar,
    "/usr/local/Cellar/node@22/22.18.0/bin/node": "/usr/local/Cellar/node@22/22.18.0/bin/node",
    "/usr/local/bin/node": "/usr/local/Cellar/node/25.0.0/bin/node",
  };
  const real = (p: string): string | null => links[p] ?? null;
  assert.equal(stableNode(cellar, real), "/opt/homebrew/opt/node/bin/node");
  assert.equal(stableNode("/usr/local/Cellar/node@22/22.18.0/bin/node", real), "/usr/local/Cellar/node@22/22.18.0/bin/node", "no link leads to it: kept");
  assert.equal(stableNode(NODE, real), NODE, "nvm's: kept (the docs say to run on again)");
  assert.equal(stableNode("/usr/bin/node", real), "/usr/bin/node");
  const onlyBin = (p: string): string | null => (p === "/opt/homebrew/bin/node" || p === cellar ? cellar : null);
  assert.equal(stableNode(cellar, onlyBin), "/opt/homebrew/bin/node");
});

test("Windows: status says whether the task's launcher still starts this folder with this Node.js", async () => {
  const files = new Map<string, string>();
  const make = (node: string, repo: string) =>
    createWindowsAutostart({
      platform: "win32", lang: "en", pakoDir: "C:\\Users\\ana\\.pako", repo, node, account: "PC\\ana",
      run: async () => ({ code: 0, out: "" }), writeFile: (p, data) => void files.set(p, data.toString("utf8")), readFile: (p) => files.get(p) ?? null,
      mkdir: () => undefined, remove: (p) => void files.delete(p),
    });
  await make("C:\\node\\node.exe", "C:\\pako").enable();
  assert.equal((await make("C:\\node\\node.exe", "C:\\pako").status()).current, true);
  const moved = await make("C:\\node\\node.exe", "D:\\pako").status();
  assert.equal(moved.current, false);
  assert.match(moved.detail, /another folder or another Node\.js/);
  assert.equal((await make("C:\\Program Files\\nodejs\\node.exe", "C:\\pako").status()).current, false);
  const a = autostartFor({ platform: "win32", lang: () => "en", env: {}, windows: () => make("C:\\nodejs\\node.exe", "C:\\pako") });
  assert.equal((await a.status()).current, false, "the panel and status --autostart see it too");
  files.clear();
  assert.equal((await make("C:\\node\\node.exe", "C:\\pako").status()).current, false, "the launcher is gone");
});

test("inside Pako for Mac (PAKO_APP_BUNDLE=1) no LaunchAgent is written: the app's own login item starts it, and the panel's card hides", async () => {
  assert.equal(runsInMacApp({ PAKO_APP_BUNDLE: "1" }, "darwin"), true);
  assert.equal(runsInMacApp({ PAKO_APP_BUNDLE: "1" }, "linux"), false);
  assert.equal(runsInMacApp({}, "darwin"), false);
  const { fs, ex, a } = rig("darwin", { env: { PAKO_APP_BUNDLE: "1", PATH: "/usr/bin" } });
  assert.deepEqual(a.status(), { supported: false, enabled: false, current: false, kind: null, file: null });
  const on = a.enable({ now: true });
  assert.ok(!on.ok && /Start with this Mac, in its menu-bar menu/.test(on.error), JSON.stringify(on));
  assert.ok(!a.disable({ stop: true }).ok);
  assert.equal(fs.writes, 0);
  assert.deepEqual(ex.calls, []);
  const said: string[] = [];
  const d = { platform: "darwin" as const, home: HOME, uid: 501, node: NODE, repo: REPO, fs, exec: ex.exec, sleep: () => undefined, lang: () => "en" as const };
  assert.equal(await runAutostartCli("status", { ...d, env: { PAKO_APP_BUNDLE: "1" }, print: (x: string) => void said.push(x) }), 1);
  assert.match(said.at(-1)!, /Start with this Mac/);
  assert.equal(await runAutostartCli("on", { ...d, env: { PAKO_APP_BUNDLE: "1" }, print: (x: string) => void said.push(x) }), 1);
  assert.equal(fs.writes, 0);
});

test("the command line: on starts it now, off stops it, status answers with its exit code, anything else prints the usage", async () => {
  const fs = memFs();
  const ex = fakeExec((line) => (line.startsWith("launchctl print") ? { code: 113, out: "" } : undefined));
  const said: string[] = [];
  const d = {
    platform: "darwin" as const, home: HOME, uid: 501, node: NODE, repo: REPO, fs, exec: ex.exec, sleep: () => undefined, lang: () => "en" as const, env: {},
    print: (s: string) => void said.push(s), running: () => null,
  };
  assert.equal(await runAutostartCli("status", d), 1);
  assert.match(said.at(-1)!, /Autostart: off/);
  assert.equal(await runAutostartCli("on", d), 0);
  assert.match(said.at(-1)!, /start by itself every time you log in .* npm run panel, in \/Users\/ana maría\/my pako & co\./);
  assert.ok(ex.calls.some((c) => c.startsWith("launchctl bootstrap")));
  assert.equal(await runAutostartCli("status", d), 0);
  assert.match(said.at(-1)!, /Autostart: on/);
  assert.equal(await runAutostartCli("off", d), 0);
  assert.ok(ex.calls.includes("launchctl bootout gui/501/local.pako"));
  assert.equal(await runAutostartCli(undefined, d), 2);
  assert.match(said.at(-1)!, /--autostart on\|off\|status/);
  assert.equal(await runAutostartCli("on", { ...d, uid: 0 }), 1);
});

test("on Windows the command line and the panel use the Task Scheduler task (src/autostart-windows.ts), with the same answers", async () => {
  const calls: string[] = [];
  let task = false;
  const run = async (cmd: string, args: string[]) => {
    calls.push(`${cmd} ${args[0]}`);
    if (args[0] === "/Query") return { code: task ? 0 : 1, out: task ? "" : "ERROR: not found" };
    if (args[0] === "/Create") task = true;
    if (args[0] === "/Delete") task = false;
    return { code: 0, out: "" };
  };
  const windows = (lang: "en") =>
    createWindowsAutostart({
      platform: "win32", lang, pakoDir: "C:\\Users\\ana\\.pako", repo: "C:\\pako", node: "C:\\node\\node.exe", account: "PC\\ana",
      run, writeFile: () => undefined, mkdir: () => undefined, remove: () => undefined,
    });
  const a = autostartFor({ platform: "win32", lang: () => "en", env: {}, windows });
  assert.deepEqual(await a.status(), { supported: true, enabled: false, current: false, kind: "task", file: null });
  const on = await a.enable({ now: true });
  assert.ok(on.ok && /each time you sign in to Windows/.test(on.message) && /starting in the background/.test(on.message), JSON.stringify(on));
  assert.deepEqual(calls.filter((c) => !c.endsWith("/Query")), ["schtasks.exe /Create", "schtasks.exe /Run"]);
  assert.equal((await a.status()).enabled, true);
  const off = await a.disable({ stop: true });
  assert.ok(off.ok && !off.enabled, JSON.stringify(off));
  assert.equal(task, false);

  const said: string[] = [];
  const d = { platform: "win32" as const, lang: () => "en" as const, env: {}, windows, print: (s: string) => void said.push(s) };
  assert.equal(await runAutostartCli("status", d), 1);
  assert.equal(await runAutostartCli("on", d), 0);
  assert.match(said.at(-1)!, /each time you sign in to Windows.*starting in the background/);
  assert.equal(await runAutostartCli("status", d), 0);
  assert.equal(await runAutostartCli("off", d), 0);
  assert.equal(task, false);

  // Windows refusing the task is an error, not "on".
  const refused = autostartFor({
    platform: "win32", lang: () => "en", env: {},
    windows: (lang) => createWindowsAutostart({
      platform: "win32", lang, pakoDir: "C:\\p", repo: "C:\\pako", node: "C:\\node.exe", account: "ana",
      run: async () => ({ code: 1, out: "ERROR: Access is denied." }), writeFile: () => undefined, mkdir: () => undefined, remove: () => undefined,
    }),
  });
  const r = await refused.enable();
  assert.ok(!r.ok && /Access is denied/.test(r.error));
});

// ---------- the panel's route ----------

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A switch that only records what it was asked. */
function fakeAutostart() {
  const asked: string[] = [];
  let on = false;
  const auto: Autostart = {
    status: () => ({ supported: true, enabled: on, current: on, kind: "launchd", file: "/x/local.pako.plist" }),
    enable: (o) => (asked.push(`enable ${JSON.stringify(o ?? {})}`), (on = true), { ok: true, enabled: true, message: "on" }),
    disable: (o) => (asked.push(`disable ${JSON.stringify(o ?? {})}`), (on = false), { ok: true, enabled: false, message: "off" }),
  };
  return { asked, auto };
}

test("the panel's route: the signed-in cookie, x-pako on a change, a boolean; on and off from the next login only; 404 without local mode", async () => {
  const { asked, auto } = fakeAutostart();
  const logged: string[] = [];
  const app = express();
  mountAutostartPanel(app, {
    signedIn: (req) => req.get("cookie") === "ok=1", lang: () => "en", env: {}, autostart: auto,
    control: { log: (_k: string, text: string) => void logged.push(text) } as never,
  });
  const server = createServer(app);
  const base = await listen(server);
  const post = (body: string, headers: Record<string, string>) =>
    fetch(`${base}/panel/api/autostart`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  try {
    assert.equal((await fetch(`${base}/panel/api/autostart`)).status, 401);
    const got = await fetch(`${base}/panel/api/autostart`, { headers: { cookie: "ok=1" } });
    assert.equal(got.headers.get("cache-control"), "no-store");
    assert.deepEqual(await got.json(), { supported: true, enabled: false, current: false, kind: "launchd" });
    assert.equal((await post('{"on":true}', { "x-pako": "1" })).status, 401, "no cookie");
    assert.equal((await post('{"on":true}', { cookie: "ok=1" })).status, 401, "no x-pako: another site's form");
    assert.equal((await post('{"on":"yes"}', { cookie: "ok=1", "x-pako": "1" })).status, 400);
    assert.deepEqual(asked, []);
    assert.deepEqual(await (await post('{"on":true}', { cookie: "ok=1", "x-pako": "1" })).json(), { ok: true, enabled: true, message: "on" });
    assert.deepEqual(await (await post('{"on":false}', { cookie: "ok=1", "x-pako": "1" })).json(), { ok: true, enabled: false, message: "off" });
    // The panel never asks to start or stop now: the Pako answering may be the one launchd or systemd runs.
    assert.deepEqual(asked, ["enable {}", "disable {}"]);
    assert.deepEqual(logged, ["Autostart turned on from the panel", "Autostart turned off from the panel"]);
  } finally {
    server.close();
    server.closeAllConnections();
  }
  const hostedApp = express();
  mountAutostartPanel(hostedApp, null);
  const hosted = createServer(hostedApp);
  const hb = await listen(hosted);
  try {
    assert.equal((await fetch(`${hb}/panel/api/autostart`)).status, 404);
    assert.equal((await fetch(`${hb}/panel/api/autostart`, { method: "POST", headers: { "x-pako": "1" } })).status, 404);
  } finally {
    hosted.close();
    hosted.closeAllConnections();
  }
});

function memoryKv(): Kv {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

test("the real app: a computer's panel has the route behind its sign-in and the card's script; a hosted server answers 404", async () => {
  const home = loadHome({ PAKO_HOME: join(tmp(), "home"), PAKO_NAME: "Ana" });
  const env: Env = { ...localEnv({}, home, 0), PAKO_HOME: home.dir };
  const kv = memoryKv();
  const local: LocalContext = {
    kv, channel: createLocalChannel({ kv }), bridgeToken: home.bridgeToken, panelSecret: home.panelSecret, bridge: { status: () => ({ claude: "ok", running: true }) },
  };
  const server = createServer(createApp(loadAppConfig(env), env, local));
  const base = await listen(server);
  try {
    assert.equal((await fetch(`${base}/panel/api/autostart`)).status, 401);
    const { link } = (await (await fetch(`${base}/panel/api/link`, { method: "POST", headers: { authorization: `Bearer ${home.bridgeToken}` } })).json()) as { link: string };
    const login = await fetch(link.replace(/^http:\/\/127\.0\.0\.1:\d+/, base), { redirect: "manual" });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    // Only read: this computer's own login items are looked at, never changed.
    const got = (await (await fetch(`${base}/panel/api/autostart`, { headers: { cookie } })).json()) as { supported: unknown; enabled: unknown };
    assert.equal(typeof got.supported, "boolean");
    assert.equal(typeof got.enabled, "boolean");
    assert.equal((await fetch(`${base}/panel/api/autostart`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: '{"on":true}' })).status, 401);
    const page = await (await fetch(`${base}/panel/assets/autostart.js`, { headers: { cookie } })).text();
    assert.match(page, /\/panel\/api\/autostart/);
    // A setting, not content: in Settings, General, never on the dashboard.
    const settings = readFileSync(new URL("src/panel/settings.html", root), "utf8");
    assert.match(settings, /<script type="module" src="\/panel\/assets\/autostart\.js"><\/script>/);
    assert.doesNotMatch(readFileSync(new URL("src/panel/index.html", root), "utf8"), /autostart\.js/);
  } finally {
    server.close();
    server.closeAllConnections();
  }
  const hostedEnv: Env = {
    PERSONAL_CALLER_TOKEN: "p".repeat(32), PERSONAL_OWNER_NAME: "Ana", PERSONAL_OWNER_NUMBER: "+34600111222", WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
    WHATSAPP_PHONE_NUMBER_ID: "109876543210", WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef", WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  };
  const hosted = createServer(createApp(loadAppConfig(hostedEnv), hostedEnv));
  const hb = await listen(hosted);
  try {
    assert.equal((await fetch(`${hb}/panel/api/autostart`)).status, 404);
    assert.equal((await fetch(`${hb}/panel/api/autostart`, { method: "POST", headers: { "x-pako": "1", "content-type": "application/json" }, body: "{}" })).status, 404);
  } finally {
    hosted.close();
    hosted.closeAllConnections();
  }
});

test("the panel card's words: one English table with every key it uses", async () => {
  const src = readFileSync(new URL("src/panel/autostart.js", root), "utf8");
  const words = src.slice(src.indexOf("const WORDS = {"), src.indexOf("};", src.indexOf("const WORDS = {")) + 2);
  const parsed = new Function(`${words}; return WORDS;`)() as Record<string, string>;
  assert.equal("es" in parsed, false);
  assert.doesNotMatch(Object.values(parsed).join(" "), /[áéíóúñ¿¡]/);
  for (const m of src.matchAll(/\bt\("(\w+)"\)/g)) assert.ok(Object.hasOwn(parsed, m[1]!), `${m[1]} is in WORDS`);
});

// ---------- the installer ----------

const INSTALL = new URL("install.sh", root).pathname;
const shells = ["sh", "bash", "dash", "zsh"].filter((s) => spawnSync("sh", ["-c", `command -v ${s}`]).status === 0);

// install.sh refuses to run as root, by design. When the tests themselves run as root (a Linux container, say), every run of it would stop
// there, so the runs that are not about that refusal find an id first on the PATH that answers an ordinary user's number to `id -u` and
// hands anything else to the real one. As any other user nothing is added and the real id answers, as before.
const ROOT = process.getuid?.() === 0;
let notRootBin = "";
/** A folder holding only that id, made once, and only when running as root. */
function notRoot(): string {
  if (!notRootBin) {
    const real = spawnSync("sh", ["-c", "command -v id"], { encoding: "utf8" }).stdout.trim();
    notRootBin = join(tmp(), "not-root");
    mkdirSync(notRootBin);
    writeFileSync(join(notRootBin, "id"), `#!/bin/sh\n[ "$1" = -u ] && [ $# = 1 ] && { echo 1000; exit 0; }\nexec ${real} "$@"\n`);
    chmodSync(join(notRootBin, "id"), 0o755);
  }
  return notRootBin;
}

/**
 * Runs install.sh with a shell and settings of its own (none of this terminal's but PATH), in a dry run unless told otherwise. As root, the
 * pretend id above goes first on the PATH unless `asRoot` is set: only the test of the refusal itself wants the script to see root.
 */
function install(shell: string, env: Env, home: string, o: { asRoot?: boolean } = {}) {
  const path = env.PATH ?? process.env.PATH;
  const r = spawnSync(shell, [INSTALL], {
    encoding: "utf8",
    env: { HOME: home, LANG: "en_US.UTF-8", PAKO_DRY_RUN: "1", ...env, PATH: ROOT && !o.asRoot ? `${notRoot()}:${path}` : path } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("install.sh: every shell reads it (sh -n); a dry run says each step against a temporary home, and changes nothing", () => {
  assert.ok(shells.includes("sh"));
  for (const shell of shells) {
    const n = spawnSync(shell, ["-n", INSTALL], { encoding: "utf8" });
    assert.equal(n.status, 0, `${shell} -n: ${n.stderr}`);
  }
  const text = readFileSync(INSTALL, "utf8");
  assert.ok(text.startsWith("#!/bin/sh\n"));
  assert.doesNotMatch(text, /\bsudo\s+(?!apt install git)/, "never sudo by itself (only named in a hint)");
  assert.doesNotMatch(text, /\b(curl|wget)\b/, "no network but git and npm");
  assert.doesNotMatch(text, /\beval\b/);
  // The address it clones is the one in package.json.
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as { repository: { url: string } };
  const repo = /DEFAULT_REPO="([^"]+)"/.exec(text)?.[1];
  assert.equal(repo, pkg.repository.url.replace(/^git\+/, ""));
  // install.ps1 clones the same address, and every one-line address in the scripts and the docs is OWNER/REPO from package.json on one
  // branch: raw.githubusercontent.com/OWNER/REPO/BRANCH/install.sh|ps1 (the publish step checks OWNER, REPO and BRANCH once more).
  const ps1 = readFileSync(new URL("install.ps1", root), "utf8");
  assert.equal(/\$DefaultRepo = '([^']+)'/.exec(ps1)?.[1], repo);
  const [, owner, name] = /github\.com\/([^/]+)\/([^/.]+)/.exec(repo!)!;
  const raw = ["install.sh", "install.ps1", "README.md", "docs/install.md", "docs/install-windows.md"]
    .flatMap((f) => [...readFileSync(new URL(f, root), "utf8").matchAll(/https:\/\/raw\.githubusercontent\.com\/[^\s`)|]+/g)].map((m) => `${f}: ${m[0]}`))
    .filter((u) => !u.includes("/OWNER/REPO/BRANCH/"));
  assert.ok(raw.some((u) => u.startsWith("install.sh:")) && raw.some((u) => u.startsWith("install.ps1:")), raw.join("\n"));
  for (const u of raw) assert.match(u, new RegExp(`: https://raw\\.githubusercontent\\.com/${owner}/${name}/main/install\\.(sh|ps1)$`), u);
  for (const shell of shells) {
    const home = tmp();
    const dir = join(home, "my pako");
    const r = install(shell, { PAKO_DIR: dir, PAKO_AUTOSTART: "1" }, home);
    assert.equal(r.code, 0, `${shell}: ${r.out}`);
    assert.match(r.out, /Dry run/);
    assert.ok(r.out.includes(`$ git clone ${repo} '${dir}'`), r.out);
    assert.ok(r.out.includes(`$ npm ci --omit=dev --ignore-scripts --prefix '${dir}'`), r.out);
    assert.ok(r.out.includes(`$ node --disable-warning=ExperimentalWarning '${dir}/src/server.ts' --autostart on`), r.out);
    assert.match(r.out, /http:\/\/127\.0\.0\.1:8787\/panel/);
    assert.deepEqual(readdirSync(home), [], `${shell}: the dry run made nothing`);
  }
  // Without autostart: Pako is started in this terminal instead; PORT shows in the address; English on a Spanish computer too.
  const home = tmp();
  const r = install("sh", { PAKO_DIR: join(home, "p"), PAKO_AUTOSTART: "0", PORT: "8790", LANG: "es_ES.UTF-8" }, home);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Starting Pako/);
  assert.doesNotMatch(r.out, /[áéíóúñ¿¡]|Arrancando/);
  assert.match(r.out, /\$ npm start\n/);
  assert.match(r.out, /127\.0\.0\.1:8790\/panel/);
  assert.doesNotMatch(r.out, /--autostart on/);
});

/** The files that make a folder a copy of Pako for both installers (install.sh is_pako, install.ps1 $isPako). */
function pakoLike(dir: string): void {
  for (const f of ["src/server.ts", "src/autostart.ts", "src/autostart-windows.ts", "bin/panel.cjs"]) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), "");
  }
  writeFileSync(join(dir, "package.json"), '{\n  "name": "pako",\n  "version": "0.2.0"\n}\n');
}

/** Pretend git and npm that only write down how they were called; node stays the real one unless `node` says otherwise. */
function recorders(node?: string) {
  const bin = join(tmp(), "bin");
  const log = join(bin, "calls.log");
  mkdirSync(bin);
  for (const name of ["git", "npm"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  if (node) {
    writeFileSync(join(bin, "node"), `#!/bin/sh\n${node}\n`);
    chmodSync(join(bin, "node"), 0o755);
  }
  return { PATH: `${bin}:${process.env.PATH}`, calls: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
}

test("install.sh: a git folder that is not Pako (the npm library called pako too) is left alone: no pull, no npm, before anything", () => {
  const home = tmp();
  const dir = join(home, "pako");
  mkdirSync(join(dir, ".git"), { recursive: true });
  // nodeca/pako's package.json has the same name: the name alone is not enough.
  writeFileSync(join(dir, "package.json"), '{\n  "name": "pako",\n  "description": "zlib port to javascript"\n}\n');
  for (const dry of ["1", "0"]) {
    const rec = recorders();
    const r = install("sh", { PATH: rec.PATH, PAKO_DIR: dir, PAKO_AUTOSTART: "0", PAKO_DRY_RUN: dry, PAKO_HOME: join(home, ".pako") }, home);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /already exists and isn't a copy of Pako: leaving it alone/);
    assert.doesNotMatch(r.out, /pull|npm ci|npm install|npm start|--autostart/);
    assert.equal(rec.calls(), "", "neither git nor npm ran");
  }
  // install.ps1: the same check, before its git pull and its npm ci (PowerShell is not run here: its text is read).
  const ps1 = readFileSync(new URL("install.ps1", root), "utf8");
  for (const f of ["'package.json'", "'src\\server.ts'", "'src\\autostart-windows.ts'", "'bin\\panel.cjs'", `'"name": "pako"'`]) assert.ok(ps1.includes(f), f);
  const leave = ps1.indexOf("is not a copy of Pako: leaving it alone");
  assert.ok(leave > 0 && leave < ps1.indexOf("& git -C $dir pull") && leave < ps1.indexOf("& $npm ci"), "refused before git or npm runs");
  assert.match(ps1, /if \(\$isPako -and \(Test-Path -LiteralPath \(Join-Path \$dir '\.git'\)\)\)/);
  assert.match(ps1, /\} elseif \(\$isPako\) \{/);
});

test("install.sh: with a Pako running in another terminal, the update stops before autostart or npm start, and gives that Pako's panel", () => {
  const home = tmp();
  const pakoHome = join(home, ".pako");
  mkdirSync(pakoHome);
  // This test's own process stands for the Pako in the terminal: alive, started by hand, the computer not restarted since.
  writeFileSync(join(pakoHome, ".lock"), `${process.pid}\n8787\n1\n`);
  const dir = join(home, "p");
  let r = install("sh", { PAKO_DIR: dir, PAKO_AUTOSTART: "1", PAKO_HOME: pakoHome }, home);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`Pako is running in another terminal \\(process ${process.pid}\\)`));
  assert.ok(r.out.includes(`$ node ${dir}/bin/panel.cjs`), r.out);
  assert.doesNotMatch(r.out, /--autostart on|\$ npm start/);
  // The background Pako's own lock (autostart on already): no reason to stop, it is restarted with what's new.
  writeFileSync(join(pakoHome, ".lock"), `${process.pid}\n8787\n1\nservice\n`);
  r = install("sh", { PAKO_DIR: dir, PAKO_AUTOSTART: "1", PAKO_HOME: pakoHome }, home);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /--autostart on/);
  // A lock from before the computer restarted, or of a process that is gone, or whose number now belongs to a process that started at another
  // time (Pako was killed, the number came round again; its fifth line says when Pako started): nothing is running.
  for (const lock of [`${process.pid}\n8787\n999999999\n`, "999999999\n8787\n1\n", `${process.pid}\n8787\n1\n\n1000\n`]) {
    writeFileSync(join(pakoHome, ".lock"), lock);
    r = install("sh", { PAKO_DIR: dir, PAKO_AUTOSTART: "0", PAKO_HOME: pakoHome }, home);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\$ npm start/);
  }
});

test("install.sh: autostart on but not started now (exit code 3) starts Pako in the terminal instead of printing an address nobody answers", () => {
  const home = tmp();
  const dir = join(home, "pako");
  mkdirSync(join(dir, ".git"), { recursive: true });
  pakoLike(dir);
  writeFileSync(join(dir, "package-lock.json"), "{}");
  // node: the real one, except --autostart (status: off; on: 3, as when launchctl cannot start it now).
  const rec = recorders(
    `case "$*" in *"--autostart status"*) exit 1 ;; *"--autostart on"*) echo "on, not started"; exit 3 ;; esac\nexec ${process.execPath} "$@"`,
  );
  const r = install("sh", { PATH: rec.PATH, PAKO_DIR: dir, PAKO_AUTOSTART: "1", PAKO_DRY_RUN: "0", PAKO_HOME: join(home, ".pako") }, home);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /It will start by itself when you log in, but it couldn't start in the background now/);
  assert.doesNotMatch(r.out, /Pako is at http/);
  assert.match(rec.calls(), /^git -C .* pull --ff-only\nnpm ci --omit=dev --ignore-scripts --prefix .*\nnpm start\n$/);
});

test("install.sh: all of it inside main, called on the last line, so a download cut halfway runs nothing", () => {
  const text = readFileSync(INSTALL, "utf8");
  assert.match(text, /\nmain\(\) \{\n/);
  assert.match(text, /\n\}\n\nmain "\$@"\n$/);
  const home = tmp();
  for (const cut of [0.3, 0.6, 0.95]) {
    const part = text.slice(0, Math.floor(text.length * cut));
    const r = spawnSync("sh", [], { input: part, encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, PAKO_DRY_RUN: "1" } as NodeJS.ProcessEnv });
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /Checking this computer|Dry run|\$ git/, `cut at ${cut}`);
  }
});

test("install.sh: running it again updates; a folder that is not Pako, an old Node.js, no Node.js and root each stop it with what to do", () => {
  const home = tmp();
  const dir = join(home, "pako");
  mkdirSync(join(dir, ".git"), { recursive: true });
  pakoLike(dir);
  let r = install("sh", { PAKO_DIR: dir, PAKO_AUTOSTART: "0" }, home);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes(`$ git -C ${dir} pull --ff-only`), r.out);
  assert.doesNotMatch(r.out, /git clone/);

  const other = join(home, "photos");
  mkdirSync(other);
  writeFileSync(join(other, "cat.jpg"), "");
  r = install("sh", { PAKO_DIR: other, PAKO_AUTOSTART: "0" }, home);
  assert.equal(r.code, 1);
  assert.match(r.out, /already exists and isn't a copy of Pako/);

  // Pretend commands, first on the PATH: an old node, and an id that says root.
  const bin = join(tmp(), "bin");
  const bare = join(tmp(), "bare");
  mkdirSync(bin);
  mkdirSync(bare);
  const fakeIn = (folder: string, name: string, body: string) => {
    writeFileSync(join(folder, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(folder, name), 0o755);
  };
  const fake = (name: string, body: string) => fakeIn(bin, name, body);
  fake("node", "echo 20.11.1");
  r = install("sh", { PATH: `${bin}:${process.env.PATH}`, PAKO_DIR: join(home, "x") }, home);
  assert.equal(r.code, 1);
  assert.match(r.out, /needs Node\.js 22\.18 or newer, and this is Node\.js 20\.11\.1/);
  assert.match(r.out, /nodejs\.org/);
  assert.doesNotMatch(r.out, /git clone/);

  // No node at all: a PATH with only the basic tools the script uses before it looks for Node.js.
  for (const tool of ["uname", "id", "cut"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    assert.ok(found, tool);
    fakeIn(bare, tool, `exec ${found} "$@"`);
  }
  r = install("/bin/sh", { PATH: bare, PAKO_DIR: join(home, "y") }, home);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /there is no Node\.js here/);

  fake("node", `exec ${process.execPath} "$@"`);
  fake("id", "echo 0");
  r = install("sh", { PATH: `${bin}:${process.env.PATH}`, PAKO_DIR: join(home, "z") }, home, { asRoot: true });
  assert.equal(r.code, 1);
  assert.match(r.out, /Don't run this as root or with sudo/);
  assert.equal(existsSync(join(home, "x")) || existsSync(join(home, "y")) || existsSync(join(home, "z")), false);
});
