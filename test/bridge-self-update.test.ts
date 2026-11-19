// The assistant's computer keeps itself up to date (assistant/update.ts), with real git repositories made here (a bare origin and a clone):
// it fast-forwards its own branch only, runs npm ci only when the lock changed, checks itself with the real node, goes back when the new
// version does not load, and never touches a checkout with local changes, on another branch, or ahead of origin. And the bridge says its
// version to the server.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { createBridge, loadBridgeConfig } from "../assistant/bridge.ts";
import { createUpdater, loadUpdateConfig, restartSelf, runCommand, RESTART_CODE, type Run, type UpdateConfig } from "../assistant/update.ts";

// git's hook settings (GIT_DIR and the like, when the tests run from a pre-push hook) must not reach the git this file runs in its own
// throwaway repositories: it would work on the real repository instead.
for (const k of Object.keys(process.env)) if (k.startsWith("GIT_")) delete process.env[k];

const ROOT = new URL("../", import.meta.url).pathname;
const ON: UpdateConfig = { on: true, why: "", everyMs: 30 * 60_000, firstMs: 5 * 60_000 };
/** The settings the live bridge would have (the self-check starts the new assistant/run.ts with them): nothing real. */
const BRIDGE_ENV = { PATH: process.env.PATH, ASSISTANT_SERVER_URL: "https://pako.example.com", ASSISTANT_BRIDGE_TOKEN: "t".repeat(32) };
const entryOf = (dir: string) => ({ execArgv: [], env: { ...BRIDGE_ENV, ASSISTANT_STATE_DIR: join(dir, "bridge-state") } });
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * An origin (bare, default branch main) with the bridge's real files (assistant/ and src/), a clone to push from, and the assistant
 * computer's own clone.
 */
function world() {
  const dir = mkdtempSync(join(tmpdir(), "pako-update-"));
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  const work = join(dir, "work");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
  git(dir, "clone", "--quiet", origin, seed);
  cpSync(join(ROOT, "assistant"), join(seed, "assistant"), { recursive: true, filter: (p) => !p.endsWith(".env") });
  cpSync(join(ROOT, "src"), join(seed, "src"), { recursive: true });
  writeFileSync(join(seed, "package.json"), '{ "name": "pako", "type": "module" }\n');
  writeFileSync(join(seed, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "first");
  git(seed, "push", "--quiet", "origin", "main");
  git(dir, "clone", "--quiet", origin, work);
  // node_modules: the real one (the self-check imports what the bridge imports).
  execFileSync("ln", ["-s", join(ROOT, "node_modules"), join(work, "node_modules")]);
  writeFileSync(join(work, ".git", "info", "exclude"), "node_modules\n");
  const upstream = (file: string, text: string, msg = "change"): string => {
    writeFileSync(join(seed, file), text);
    git(seed, "add", "-A");
    git(seed, "commit", "--quiet", "-m", msg);
    git(seed, "push", "--quiet", "origin", "main");
    return git(seed, "rev-parse", "HEAD");
  };
  return { dir, origin, seed, work, upstream, head: () => git(work, "rev-parse", "HEAD") };
}

/** git and node for real; npm faked (no network, no install): its calls are counted. */
function runner(npmCode = 0) {
  const npm: string[][] = [];
  const run: Run = (cmd, args, o) => {
    if (/npm(\.cmd)?$/.test(cmd)) {
      npm.push(args);
      return Promise.resolve({ code: npmCode, out: "", err: npmCode ? "npm ERR! network" : "" });
    }
    return runCommand(cmd, args, o);
  };
  return { run, npm };
}

test("a new commit on origin's default branch is pulled (fast-forward), checked with the real node, and noted; no npm ci when the lock did not change", async () => {
  const w = world();
  const before = w.head();
  const target = w.upstream("assistant/NOTE.md", "a note\n");
  const r = runner();
  const state = join(w.dir, "state");
  const u = createUpdater({ repo: w.work, stateDir: state, config: ON, run: r.run, log: () => undefined, entry: entryOf(w.dir) });
  const outcome = await u.check();
  assert.deepEqual(outcome, { kind: "updated", from: before, to: target });
  assert.equal(w.head(), target);
  assert.deepEqual(r.npm, [], "the lock did not change");
  const v = await u.version();
  assert.equal(v?.sha, target);
  assert.equal(v?.autoupdate, "on");
  assert.ok(v?.updatedAt && v.updatedAt > 0, "the update's date, for the panel");
  assert.equal(JSON.parse(readFileSync(join(state, "update.json"), "utf8")).to, target);
  assert.deepEqual(await u.check(), { kind: "current", sha: target }, "nothing more to take");
});

test("a changed package-lock.json runs npm ci once, before the self-check", async () => {
  const w = world();
  w.upstream("package-lock.json", '{ "lockfileVersion": 3, "packages": {} }\n', "deps");
  const r = runner();
  const u = createUpdater({ repo: w.work, stateDir: join(w.dir, "state"), config: ON, run: r.run, log: () => undefined, entry: entryOf(w.dir) });
  assert.equal((await u.check()).kind, "updated");
  // --ignore-scripts (security review F5): a dependency's install script never runs on the bridge computer, as with the installer.
  assert.deepEqual(r.npm, [["ci", "--ignore-scripts", "--no-audit", "--no-fund"]]);
});

test("a commit that breaks the bridge is undone: back to the commit it ran, still running, and that commit is not tried again", async () => {
  const w = world();
  const before = w.head();
  const bad = w.upstream("assistant/bridge.ts", "export const broken: number = ;\n", "broken");
  const lines: string[] = [];
  const u = createUpdater({ repo: w.work, stateDir: join(w.dir, "state"), config: ON, run: runner().run, log: (l) => lines.push(l), entry: entryOf(w.dir) });
  const outcome = await u.check();
  assert.equal(outcome.kind, "failed");
  assert.match((outcome as { why: string }).why, /assistant\/bridge\.ts does not parse/);
  assert.equal((outcome as { rolledBack: boolean }).rolledBack, true);
  assert.equal(w.head(), before, "back where it was");
  assert.equal(git(w.work, "status", "--porcelain", "--untracked-files=no"), "", "and clean");
  assert.match(u.status(), new RegExp(`update to ${bad.slice(0, 7)} failed`));
  const again = await u.check();
  assert.deepEqual(again, { kind: "skipped", why: `${bad.slice(0, 7)} failed before` });
  assert.equal(w.head(), before);
  // A fixed commit after it is taken.
  const fixed = w.upstream("assistant/bridge.ts", readFileSync(join(ROOT, "assistant/bridge.ts"), "utf8"), "fixed");
  assert.equal((await u.check()).kind, "updated");
  assert.equal(w.head(), fixed);
});

test("a failed npm ci goes back too, and installs the old lock again", async () => {
  const w = world();
  const before = w.head();
  w.upstream("package-lock.json", '{ "lockfileVersion": 3, "x": 1 }\n', "deps");
  const r = runner(1);
  const u = createUpdater({ repo: w.work, stateDir: join(w.dir, "state"), config: ON, run: r.run, log: () => undefined, entry: entryOf(w.dir) });
  const outcome = await u.check();
  assert.equal(outcome.kind, "failed");
  assert.match((outcome as { why: string }).why, /^npm ci failed/);
  assert.equal(w.head(), before);
  assert.equal(r.npm.length, 2, "the new lock (failed), then the old one again");
});

test("a new assistant/run.ts that cannot start is undone before the restart: a broken new import, a throw at its top level, a refused setting", async () => {
  const cases: [string, (run: string, w: ReturnType<typeof world>) => string][] = [
    ["a broken new import", (run, w) => {
      writeFileSync(join(w.seed, "assistant/extra.ts"), "export const x: number = ;\n");
      return run.replace("import { setTimeout as sleep }", 'import "./extra.ts";\nimport { setTimeout as sleep }');
    }],
    ["a throw at its top level", (run) => 'throw new Error("boom at start");\n' + run],
    ["a setting it now refuses", (run) => run.replace("config = loadBridgeConfig(process.env);", 'config = loadBridgeConfig({ ...process.env, ASSISTANT_MODEL: "no good!" });')],
  ];
  for (const [name, change] of cases) {
    const w = world();
    const before = w.head();
    const bad = w.upstream("assistant/run.ts", change(readFileSync(join(w.seed, "assistant/run.ts"), "utf8"), w), name);
    const u = createUpdater({ repo: w.work, stateDir: join(w.dir, "state"), config: ON, run: runner().run, log: () => undefined, entry: entryOf(w.dir) });
    const outcome = await u.check();
    assert.equal(outcome.kind, "failed", `${name}: ${JSON.stringify(outcome)}`);
    assert.match((outcome as { why: string }).why, /the new assistant\/run\.ts does not start/, name);
    assert.equal(w.head(), before, `${name}: back on the version that runs`);
    // Noted on disk: a bridge started again (a reboot) does not try it either.
    const fresh = createUpdater({ repo: w.work, stateDir: join(w.dir, "state"), config: ON, run: runner().run, log: () => undefined, entry: entryOf(w.dir) });
    assert.deepEqual(await fresh.check(), { kind: "skipped", why: `${bad.slice(0, 7)} failed before` }, name);
  }
});

test("the real assistant/run.ts --self-check loads everything, accepts its settings and stops before its loop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pako-selfcheck-"));
  const r = await runCommand(process.execPath, [join(ROOT, "assistant/run.ts"), "--self-check"], {
    cwd: dir,
    timeoutMs: 30_000,
    env: { ...BRIDGE_ENV, ASSISTANT_STATE_DIR: join(dir, "state") },
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /self-check ok/);
  const bad = await runCommand(process.execPath, [join(ROOT, "assistant/run.ts"), "--self-check"], { cwd: dir, timeoutMs: 30_000, env: { PATH: process.env.PATH } });
  assert.notEqual(bad.code, 0, "no settings: it does not pass");
});

test("a new version that stops before its first good round is undone at its next start, refused for good, and a proved one is kept", async () => {
  const w = world();
  const before = w.head();
  const target = w.upstream("assistant/NOTE.md", "a note\n");
  const state = join(w.dir, "state");
  const make = () => createUpdater({ repo: w.work, stateDir: state, config: ON, run: runner().run, log: () => undefined, entry: entryOf(w.dir) });
  assert.equal((await make().check()).kind, "updated");
  assert.equal(JSON.parse(readFileSync(join(state, "update.json"), "utf8")).verified, false, "on probation");
  // The restart onto it (its first start), then it dies before a good round, and launchd starts it again.
  assert.equal(await make().started(), "ok");
  assert.equal(w.head(), target);
  const second = make();
  assert.equal(await second.started(), "rolled-back");
  assert.equal(w.head(), before, "back on the version that ran");
  assert.equal(git(w.work, "status", "--porcelain", "--untracked-files=no"), "");
  assert.match(second.status(), /failed \(it did not start\)/);
  assert.deepEqual(await make().check(), { kind: "skipped", why: `${target.slice(0, 7)} failed before` }, "and not taken again");
  // A version that proves itself stays, however often it is started after that.
  const w2 = world();
  const t2 = w2.upstream("assistant/NOTE.md", "b\n");
  const s2 = join(w2.dir, "state");
  const make2 = () => createUpdater({ repo: w2.work, stateDir: s2, config: ON, run: runner().run, log: () => undefined, entry: entryOf(w2.dir) });
  assert.equal((await make2().check()).kind, "updated");
  const first = make2();
  assert.equal(await first.started(), "ok");
  first.proved();
  for (let i = 0; i < 3; i++) assert.equal(await make2().started(), "ok");
  assert.equal(w2.head(), t2);
});

test("never with local changes, never on another branch, never when this checkout has commits origin does not have", async () => {
  const quiet = { log: () => undefined, config: ON };
  {
    const w = world();
    const before = w.head();
    w.upstream("assistant/NOTE.md", "x\n");
    writeFileSync(join(w.work, "assistant", "prompt.ts"), "// changed here\n");
    const u = createUpdater({ repo: w.work, stateDir: join(w.dir, "s"), run: runner().run, ...quiet, entry: entryOf(w.dir) });
    assert.deepEqual(await u.check(), { kind: "skipped", why: "local changes" });
    assert.equal(w.head(), before);
    assert.equal(u.status(), "local changes", "said to the server with the version");
  }
  {
    const w = world();
    git(w.work, "checkout", "--quiet", "-b", "experiment");
    w.upstream("assistant/NOTE.md", "x\n");
    const u = createUpdater({ repo: w.work, stateDir: join(w.dir, "s"), run: runner().run, ...quiet, entry: entryOf(w.dir) });
    assert.deepEqual(await u.check(), { kind: "skipped", why: "on branch experiment, not main" });
  }
  {
    const w = world();
    writeFileSync(join(w.work, "LOCAL.md"), "mine\n");
    git(w.work, "add", "LOCAL.md");
    git(w.work, "commit", "--quiet", "-m", "local");
    const mine = w.head();
    w.upstream("assistant/NOTE.md", "x\n");
    const u = createUpdater({ repo: w.work, stateDir: join(w.dir, "s"), run: runner().run, ...quiet, entry: entryOf(w.dir) });
    assert.deepEqual(await u.check(), { kind: "skipped", why: "not a fast-forward (commits here that origin does not have)" });
    assert.equal(w.head(), mine);
  }
  {
    // An untracked file of the owner's (assistant/.env) is not a local change.
    const w = world();
    writeFileSync(join(w.work, "assistant", ".env"), "ASSISTANT_BRIDGE_TOKEN=x\n");
    const target = w.upstream("assistant/NOTE.md", "x\n");
    const u = createUpdater({ repo: w.work, stateDir: join(w.dir, "s"), run: runner().run, ...quiet, entry: entryOf(w.dir) });
    assert.equal((await u.check()).kind, "updated");
    assert.equal(w.head(), target);
    assert.ok(existsSync(join(w.work, "assistant", ".env")));
  }
});

test("off with BRIDGE_AUTOUPDATE=off, and always beside its own server (local mode); otherwise on, first look 5 minutes after the start, then every 30", () => {
  assert.equal(loadUpdateConfig({ BRIDGE_AUTOUPDATE: "off" }, "https://pako.example.com").on, false);
  assert.equal(loadUpdateConfig({ PAKO_PARENT_PID: "123" }, "https://pako.example.com").on, false);
  assert.equal(loadUpdateConfig({}, "http://127.0.0.1:8787").on, false);
  const on = loadUpdateConfig({}, "https://pako.example.com");
  assert.equal(on.on, true);
  let t = 1_000_000;
  const u = createUpdater({ repo: ROOT, stateDir: tmpdir(), config: on, now: () => t, run: async () => ({ code: 1, out: "", err: "" }), log: () => undefined });
  assert.equal(u.due(), false);
  t += 5 * 60_000;
  assert.equal(u.due(), true);
  void u.check();
  t += 29 * 60_000;
  assert.equal(u.due(), false);
  t += 60_000;
  assert.equal(u.due(), true);
  const off = createUpdater({ repo: ROOT, stateDir: tmpdir(), config: loadUpdateConfig({ BRIDGE_AUTOUPDATE: "off" }, "https://x.example"), log: () => undefined });
  assert.equal(off.due(), false);
  assert.equal(off.status(), "off (BRIDGE_AUTOUPDATE=off)");
});

test("it starts itself again in place where Node can, otherwise it exits with 75 for the LaunchAgent to start it again", () => {
  // A new list for each case: assert.deepEqual narrows the one it was given to the expected value's type.
  let calls: unknown[] = [];
  restartSelf({ execve: (file, args) => void calls.push(["execve", file, args.slice(1)]), exit: (c) => void calls.push(["exit", c]), platform: "darwin", log: () => undefined });
  assert.deepEqual(calls, [["execve", process.execPath, [...process.execArgv, ...process.argv.slice(1)]]]);
  calls = [];
  restartSelf({ exit: (c) => void calls.push(["exit", c]), platform: "darwin", log: () => undefined });
  assert.deepEqual(calls, [["exit", RESTART_CODE]]);
  calls = [];
  restartSelf({ execve: () => { throw new Error("EPERM"); }, exit: (c) => void calls.push(["exit", c]), platform: "darwin", log: () => undefined });
  assert.deepEqual(calls, [["exit", 75]]);
});

test("the bridge says its version to the server once, and again when it changes; a server without the route is not asked again", async () => {
  const posts: unknown[] = [];
  let status = 200;
  const app = express();
  app.use(express.json());
  app.get("/assistant/inbox", (_req, res) => void res.json({ messages: [] }));
  app.post("/assistant/health", (req, res) => {
    posts.push(req.body);
    res.status(status).json({});
  });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const config = loadBridgeConfig({ ASSISTANT_SERVER_URL: url, ASSISTANT_BRIDGE_TOKEN: "t".repeat(48), ASSISTANT_STATE_DIR: mkdtempSync(join(tmpdir(), "pako-b-")) });
    const bridge = createBridge({ config, log: () => undefined });
    const v = { sha: "a".repeat(40), committedAt: 1, autoupdate: "on" };
    bridge.setVersion(v);
    await bridge.tick(0);
    await bridge.tick(0);
    assert.deepEqual(posts, [{ version: v }], "once");
    bridge.setVersion({ ...v, autoupdate: "local changes" });
    status = 404;
    await bridge.tick(0);
    await bridge.tick(0);
    assert.equal(posts.length, 2, "again when it changed; a 404 is not asked again");
    assert.equal(bridge.busy(), false, "nothing under way between rounds");
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
