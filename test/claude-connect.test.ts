// Connect Claude in one button (src/claude-connect.ts, its routes in src/connect-setup.ts): the stand-in `claude` (test/fixtures/claude-stub.mjs)
// plays each case Claude Code 2.1.327 shows, the installer is a mocked spawn, and the sign-in is a file in a temporary folder. Nothing here
// touches this computer's own Claude: CLAUDE_STUB_AUTH is the only sign-in these runs read or change.

import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  accountLine, claudeStatusLine, createClaudeConnect, createClaudeKeeper, installerFor, lastLine, needsPlan, parseClaudeAccount, pressSignIn,
  type ClaudeAccount, type ConnectView,
} from "../src/claude-connect.ts";
import { mountConnectSetup } from "../src/connect-setup.ts";
import { auth, memoryKv, serve } from "./helpers/connect-rig.ts";

const STUB = fileURLToPath(new URL("./fixtures/claude-stub.mjs", import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;

/** A temporary sign-in for the stub, and its log. `signedIn`: what `auth status` says at the start. */
function rig(signedIn: Record<string, unknown> | null = null, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pako-claude-connect-"));
  const authFile = join(dir, "auth.json");
  const log = join(dir, "log.jsonl");
  writeFileSync(authFile, JSON.stringify(signedIn ? { loggedIn: true, ...signedIn } : { loggedIn: false }));
  const events = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { event: string; args: string[] }) : []);
  return { dir, authFile, log, events, env: { CLAUDE_STUB_AUTH: authFile, CLAUDE_STUB_LOG: log, CLAUDE_STUB_LOGIN_MS: "200", ...env } };
}

/** Waits until the flow is no longer busy (or `ms` passed). */
async function settle(c: { busy: () => boolean }, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (c.busy() && Date.now() < until) await sleep(25);
}

/** Waits until the flow shows `phase` (or `ms` passed): starting the stand-in takes a moment on a busy machine. */
async function until(c: { view: () => { phase: string } }, phase: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (c.view().phase !== phase && Date.now() < end) await sleep(20);
}

const statusCalls = (r: ReturnType<typeof rig>) => r.events().filter((e) => e.event === "auth" && e.args[1] === "status").length;
const logins = (r: ReturnType<typeof rig>) => r.events().filter((e) => e.event === "auth" && e.args[1] === "login");

test("auth status: every plan, a Console login, a cloud provider, signed out, expired, and anything else read as 'could not tell'", () => {
  const st = (o: Record<string, unknown>, code = 0) => parseClaudeAccount(code, JSON.stringify(o));
  for (const plan of ["pro", "max", "team", "enterprise"]) {
    const a = st({ loggedIn: true, authMethod: "claude.ai", email: "ana@example.com", subscriptionType: plan, loginExpiresAt: "2026-12-15T17:32:26.321Z" })!;
    assert.deepEqual(a, { loggedIn: true, billing: "plan", email: "ana@example.com", plan, expiresAt: Date.parse("2026-12-15T17:32:26.321Z") });
    assert.equal(needsPlan(a), false, plan);
  }
  assert.equal(accountLine(st({ loggedIn: true, authMethod: "claude.ai", email: "ana@example.com", subscriptionType: "max" })!, "en"), "Connected · ana@example.com · Max plan");
  const free = st({ loggedIn: true, authMethod: "claude.ai", email: "ana@example.com", subscriptionType: "free" })!;
  assert.equal(needsPlan(free), true, "the free plan cannot run Claude Code");
  const consoleLogin = st({ loggedIn: true, authMethod: "console", email: "ana@example.com" })!;
  assert.equal(consoleLogin.billing, "api");
  assert.equal(needsPlan(consoleLogin), false, "API billing is fine");
  assert.equal(accountLine(consoleLogin, "en"), "Connected (API billing)");
  assert.equal(accountLine(st({ loggedIn: true, authMethod: "api_key" })!, "en"), "Connected (API billing)");
  assert.equal(st({ loggedIn: true, authMethod: "third_party" })!.billing, "cloud");
  assert.equal(st({ loggedIn: true, authMethod: "oauth_token" })!.billing, "plan", "the long-lived token of setup-token is the plan's");
  assert.deepEqual(st({ loggedIn: false, authMethod: "none", loginExpiresAt: null }, 1), { loggedIn: false, billing: "none", email: "", plan: "", expiresAt: null });
  assert.equal(st({ loggedIn: true, authMethod: "claude.ai" }, 1)!.loggedIn, false, "the exit code is the word on being signed in");
  assert.equal(parseClaudeAccount(0, "Not JSON"), null);
  assert.equal(parseClaudeAccount(2, "{}"), null);
  assert.equal(parseClaudeAccount(null, ""), null);
  assert.equal(parseClaudeAccount(0, "{\"x\":1}"), null);
});

test("the installer is Anthropic's own one-liner, per system, run without a terminal or administrator rights", () => {
  assert.deepEqual(installerFor("darwin"), { cmd: "/bin/bash", args: ["-c", "curl -fsSL https://claude.ai/install.sh | bash"], fix: "curl -fsSL https://claude.ai/install.sh | bash" });
  assert.deepEqual(installerFor("linux"), installerFor("darwin"));
  const w = installerFor("win32");
  assert.equal(w.cmd, "powershell.exe");
  assert.equal(w.fix, "irm https://claude.ai/install.ps1 | iex");
  assert.deepEqual(w.args.slice(-2), ["-Command", "irm https://claude.ai/install.ps1 | iex"]);
  for (const p of ["darwin", "linux", "win32"] as const) assert.doesNotMatch(JSON.stringify(installerFor(p)), /sudo|runas|-Verb/i, p);
  assert.equal(lastLine("Opening…\nvisit: https://claude.com/cai/oauth/authorize?state=secret-state\n\u001b[31mCouldn't log in: No authorization code received\u001b[0m\n"),
    "Couldn't log in: No authorization code received");
  assert.equal(lastLine("visit: https://claude.com/x?state=secret-state"), "visit: …", "a link never reaches the page");
});

/** A spawn that runs the installer as a stand-in (exit `code` after a moment, with `say` on stderr) and anything else for real. */
function mockSpawn(o: { code: number; say?: string; installed?: () => void }) {
  const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const fn = ((cmd: string, args: string[], opts: SpawnOptions): ChildProcess => {
    calls.push({ cmd, args, env: { ...(opts.env ?? {}) } });
    if (cmd === "/bin/bash" || cmd === "powershell.exe") {
      const script = `setTimeout(() => { ${o.say ? `process.stderr.write(${JSON.stringify(o.say)});` : ""} process.exit(${o.code}); }, 150);`;
      const c = spawn(process.execPath, ["-e", script], opts);
      c.on("close", (code) => code === 0 && o.installed?.());
      return c;
    }
    return spawn(cmd, args, opts);
  }) as unknown as typeof spawn;
  return { fn, calls };
}

for (const platform of ["darwin", "linux", "win32"] as const) {
  test(`not installed (${platform}): the installer runs with a progress count, then the sign-in opens, then Connected`, async () => {
    const r = rig(null, { CLAUDE_STUB_PLAN: "max" });
    let installed = false;
    const sp = mockSpawn({ code: 0, installed: () => (installed = true) });
    const c = createClaudeConnect({ env: r.env, platform, spawn: sp.fn, find: async () => (installed ? STUB : null), pollMs: 50, email: () => "ana@example.com" });
    const run = c.start();
    await sleep(60);
    assert.equal(c.view().phase, "installing");
    assert.equal(typeof c.view().seconds, "number");
    await run;
    const inst = sp.calls.find((x) => x.cmd === installerFor(platform).cmd)!;
    assert.deepEqual(inst.args, installerFor(platform).args, "the platform's own installer");
    assert.equal(inst.env.SUDO_USER, undefined);
    if (platform !== "win32") assert.equal(inst.env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin", "the system's own curl and bash");
    const v = c.view();
    assert.equal(v.phase, "connected");
    assert.equal(v.account?.planLabel, "Max");
    assert.deepEqual(logins(r)[0]!.args, ["auth", "login", "--claudeai", "--email", "ana@example.com"]);
  });
}

test("the installer fails: the exact one-line fix, per system, and what it said last", async () => {
  for (const platform of ["darwin", "win32"] as const) {
    const sp = mockSpawn({ code: 1, say: "curl: (6) Could not resolve host: downloads.claude.ai\n" });
    const c = createClaudeConnect({ env: {}, platform, spawn: sp.fn, find: async () => null, pollMs: 50 });
    await c.start();
    const v = c.view();
    assert.equal(v.phase, "install-failed");
    assert.equal(v.fix, platform === "win32" ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash");
    assert.equal(v.detail, "curl: (6) Could not resolve host: downloads.claude.ai");
  }
});

test("already signed in: Connected with the address and the plan at once, nothing to click, no browser page", async () => {
  const r = rig({ email: "ana@example.com", subscriptionType: "team", loginExpiresAt: new Date(Date.now() + 20 * DAY).toISOString() });
  const c = createClaudeConnect({ env: r.env, find: async () => STUB });
  assert.equal(await c.check(0).then((a) => (a as ClaudeAccount).loggedIn), true);
  await c.start();
  assert.equal(c.view().phase, "connected");
  assert.equal(claudeStatusLine(c.view(), "en")?.detail, "Connected · ana@example.com · Team plan");
  assert.equal(logins(r).length, 0, "no sign-in started");
});

test("signed out: the sign-in opens (with the owner's address), status every poll, and the polling stops once signed in", async () => {
  const r = rig(null, { CLAUDE_STUB_LOGIN_MS: "600", CLAUDE_STUB_PLAN: "pro" });
  const c = createClaudeConnect({ env: r.env, find: async () => STUB, pollMs: 60, email: () => "ana@example.com" });
  const run = c.start();
  await until(c, "signing-in");
  assert.equal(c.view().phase, "signing-in");
  await run;
  assert.equal(c.view().phase, "connected");
  assert.equal(accountLine(c.view().account!, "en"), "Connected · ana@example.com · Pro plan");
  const n = statusCalls(r);
  assert.ok(n >= 3, `asked while waiting (${n})`);
  await sleep(400);
  assert.equal(statusCalls(r), n, "no more polling after success");
});

test("an address Pako knows that could read as a flag is never passed to the sign-in", async () => {
  const r = rig(null);
  const c = createClaudeConnect({ env: r.env, find: async () => STUB, pollMs: 50, email: () => "--console@x.y" });
  await c.start();
  assert.deepEqual(logins(r)[0]!.args, ["auth", "login", "--claudeai"]);
  assert.equal(c.view().emailHint, "");
});

test("a free plan: signed in, and the plan check says Claude Code needs Pro, Max or Team, with the upgrade link", async () => {
  const r = rig(null, { CLAUDE_STUB_PLAN: "free" });
  const c = createClaudeConnect({ env: r.env, find: async () => STUB, pollMs: 50 });
  await c.start();
  const v = c.view();
  assert.equal(v.phase, "needs-plan");
  assert.equal(v.upgradeUrl, "https://claude.ai/upgrade");
  assert.deepEqual(claudeStatusLine(v, "en"), { state: "needsAction", detail: "Claude Code needs a Pro, Max or Team plan" });
  // Upgraded, then Check again: the same button, now connected.
  writeFileSync(r.authFile, JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "ana@example.com", subscriptionType: "pro" }));
  await c.start();
  assert.equal(c.view().phase, "connected");
});

test("a Console (API billing) sign-in is fine: Connected (API billing)", async () => {
  const r = rig(null, { CLAUDE_STUB_METHOD: "console" });
  const c = createClaudeConnect({ env: r.env, find: async () => STUB, pollMs: 50 });
  await c.start();
  assert.equal(c.view().phase, "connected");
  assert.equal(claudeStatusLine(c.view(), "en")?.detail, "Connected (API billing)");
});

test("cancelled on Claude's page: a calm retry with Claude's own last line, never its link", async () => {
  const r = rig(null, { CLAUDE_STUB_LOGIN: "cancel" });
  const c = createClaudeConnect({ env: r.env, find: async () => STUB, pollMs: 50 });
  await c.start();
  const v = c.view();
  assert.equal(v.phase, "failed");
  assert.equal(v.detail, "Couldn't log in: No authorization code received");
  assert.doesNotMatch(JSON.stringify(v), /stub-state|oauth/);
});

test("nobody finishes: after the time allowed the sign-in is stopped, polling stops, and it says timeout", async () => {
  const r = rig(null, { CLAUDE_STUB_LOGIN: "hang" });
  const c = createClaudeConnect({ env: r.env, find: async () => STUB, pollMs: 50, loginMs: 600 });
  await c.start();
  assert.equal(c.view().phase, "timeout");
  const n = statusCalls(r);
  await sleep(300);
  assert.equal(statusCalls(r), n, "no more polling after the timeout");
});

test("Cancel while signing in: the sign-in is stopped and nothing more is asked", async () => {
  const r = rig(null, { CLAUDE_STUB_LOGIN: "hang" });
  const c = createClaudeConnect({ env: r.env, find: async () => STUB, pollMs: 50 });
  void c.start();
  await until(c, "signing-in");
  assert.equal(c.view().phase, "signing-in");
  await c.cancel();
  assert.equal(c.view().phase, "cancelled");
  const n = statusCalls(r);
  await sleep(250);
  assert.equal(statusCalls(r), n);
});

test("Switch account signs out first, then the sign-in; Sign out signs out", async () => {
  const r = rig({ email: "old@example.com", subscriptionType: "pro" }, { CLAUDE_STUB_EMAIL: "new@example.com", CLAUDE_STUB_PLAN: "max" });
  const changed: string[] = [];
  const c = createClaudeConnect({ env: r.env, find: async () => STUB, pollMs: 50, changed: (_a, why) => changed.push(why) });
  await c.start({ switch: true });
  const order = r.events().filter((e) => e.event === "auth" && e.args[1] !== "status").map((e) => e.args[1]);
  assert.deepEqual(order, ["logout", "login"]);
  assert.equal(c.view().account?.email, "new@example.com");
  assert.equal(await c.signOut(), true);
  assert.equal(c.view().account?.loggedIn, false);
  assert.deepEqual(changed, ["switching", "connected", "signed-out"], "the bridge and the keeper hear of each change, and why");
});

test("signing in again over one about to expire waits for the new sign-in, not the old one", async () => {
  const soon = new Date(Date.now() + 3600_000).toISOString();
  const r = rig({ email: "ana@example.com", subscriptionType: "pro", loginExpiresAt: soon }, { CLAUDE_STUB_LOGIN_MS: "800" });
  const c = createClaudeConnect({ env: r.env, find: async () => STUB, pollMs: 50 });
  assert.match(await pressSignIn(c, "en"), /opened Claude's sign-in page/);
  await until(c, "signing-in");
  await sleep(300);
  assert.equal(c.view().phase, "signing-in", "the old sign-in does not count as done");
  await settle(c);
  assert.equal(c.view().phase, "connected");
  assert.notEqual(c.view().account?.expiresAt, Date.parse(soon));
  assert.equal(await pressSignIn(c, "en"), "Claude is already connected.");
  assert.equal(await pressSignIn(null, "en"), "Open Pako on your computer and press “Connect your Claude account”.");
});

test("no token, and not the sign-in page's one-time state, is ever logged or shown", async () => {
  const said: string[] = [];
  const keep = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a: unknown[]) => void said.push(a.join(" "));
  console.error = console.log;
  console.warn = console.log;
  try {
    for (const login of ["ok", "cancel"]) {
      const r = rig(null, { CLAUDE_STUB_LOGIN: login });
      const c = createClaudeConnect({ env: r.env, find: async () => STUB, pollMs: 50 });
      await c.start();
      assert.doesNotMatch(JSON.stringify(c.view()), /stub-state|token/i);
    }
  } finally {
    Object.assign(console, keep);
  }
  assert.deepEqual(said.filter((s) => /stub-state|oauth|token/i.test(s)), []);
});

// ---------- the keeper ----------

function keeperRig(start: ClaudeAccount | "missing" | null) {
  let a = start;
  let now = Date.parse("2026-11-18T10:00:00Z");
  const told: number[] = [];
  const kv = memoryKv();
  const make = () => createClaudeKeeper({
    check: async () => a,
    notify: async () => (told.push(now), true),
    kv,
    now: () => now,
  });
  return { set: (x: ClaudeAccount | "missing" | null) => (a = x), at: (t: number) => (now = t), now: () => now, told, kv, make };
}
const acct = (o: Partial<ClaudeAccount> = {}): ClaudeAccount => ({ loggedIn: true, billing: "plan", email: "ana@example.com", plan: "pro", expiresAt: null, ...o });

test("the keeper: one notice when the sign-in is lost, not at every check, and again only after it worked in between", async () => {
  const k = keeperRig(acct());
  const keep = k.make();
  await keep.tick();
  assert.deepEqual(k.told, []);
  k.set(acct({ loggedIn: false, billing: "none", email: "", plan: "" }));
  for (let i = 0; i < 5; i++) await keep.tick();
  assert.equal(k.told.length, 1, "once, not every check");
  assert.equal(keep.broken(), true, "the dashboard's one line");
  // A restart (a save in the panel restarts Pako): still told once.
  const again = k.make();
  await again.tick();
  assert.equal(k.told.length, 1, "remembered across a restart");
  k.set(acct());
  await again.tick();
  assert.equal(again.broken(), false);
  k.set(acct({ loggedIn: false, billing: "none" }));
  await again.tick();
  assert.equal(k.told.length, 2, "lost again after working: told again");
});

test("the keeper: a sign-in that expires within a day, or has expired, is told once; a far one is not", async () => {
  const k = keeperRig(acct({ expiresAt: Date.parse("2026-12-15T00:00:00Z") }));
  const keep = k.make();
  await keep.tick();
  assert.deepEqual(k.told, []);
  k.at(Date.parse("2026-12-14T12:00:00Z"));
  await keep.tick();
  await keep.tick();
  assert.equal(k.told.length, 1, "near: told once");
  k.at(Date.parse("2026-12-16T12:00:00Z"));
  await keep.tick();
  assert.equal(k.told.length, 1, "past: still the same notice");
});

test("the keeper: a run refused for the sign-in is told once; a first run with no Claude yet is not a notice; could-not-tell decides nothing", async () => {
  const k = keeperRig(acct());
  const keep = k.make();
  await keep.tick();
  await keep.reported("login");
  await keep.reported("login");
  assert.equal(k.told.length, 1);
  assert.equal(keep.refused(), true);
  await keep.reported("ok");
  assert.equal(keep.broken(), false);
  const fresh = keeperRig("missing");
  const f = fresh.make();
  await f.tick();
  assert.deepEqual(fresh.told, [], "never connected here: the first-run flow, not 'sign in again'");
  assert.equal(f.broken(), false);
  // Signed out on purpose (Sign out): no "sign in again" for that.
  const out = keeperRig(acct());
  const o = out.make();
  await o.tick();
  await o.signedOut();
  out.set(acct({ loggedIn: false, billing: "none" }));
  await o.tick();
  assert.deepEqual(out.told, []);
  const unknown = keeperRig(null);
  await unknown.make().tick();
  assert.deepEqual(unknown.told, []);
});

// ---------- the routes ----------

test("the routes: the view, start, cancel, and Sign out only with its confirmation; a server's panel has none of them", async () => {
  const r = rig(null, { CLAUDE_STUB_LOGIN: "hang" });
  const c = createClaudeConnect({ env: r.env, find: async () => STUB, pollMs: 50 });
  const p = await serve((app) => mountConnectSetup(app, { ...auth, lang: () => "en", saver: null, claude: c }));
  try {
    const first = await p.get("/panel/api/claude/connect");
    assert.equal(first.status, 200);
    assert.equal((first.body as ConnectView).account?.loggedIn, false);
    assert.equal((await p.get("/panel/api/claude/connect", {})).status, 401, "signed in only");
    assert.equal((await p.post("/panel/api/claude/connect", {}, { cookie: "ok=1" })).status, 401, "a change needs the x-pako header");
    const started = await p.post("/panel/api/claude/connect", {});
    assert.ok(["checking", "signing-in"].includes(started.body.phase), started.body.phase);
    await until(c, "signing-in");
    assert.equal((await p.get("/panel/api/claude/connect")).body.phase, "signing-in");
    assert.equal((await p.post("/panel/api/claude/connect/cancel", {})).body.phase, "cancelled");
    assert.equal((await p.post("/panel/api/claude/signout", {})).status, 400, "Sign out asks first");
    assert.equal((await p.post("/panel/api/claude/signout", { confirm: true })).body.ok, true);
  } finally {
    await p.close();
  }
  const none = await serve((app) => mountConnectSetup(app, null));
  try {
    assert.equal((await none.get("/panel/api/claude/connect")).status, 404);
  } finally {
    await none.close();
  }
});

test("a sign-in that has expired is not 'Connected': the line asks to sign in again, and the button signs in instead of saying done", async () => {
  const gone = new Date(Date.now() - DAY).toISOString();
  const r = rig({ email: "ana@example.com", subscriptionType: "pro", loginExpiresAt: gone }, { CLAUDE_STUB_LOGIN_MS: "300" });
  const c = createClaudeConnect({ env: r.env, find: async () => STUB, pollMs: 50 });
  await c.check(0);
  assert.deepEqual(claudeStatusLine(c.view(), "en"), { state: "needsAction", detail: "Claude needs you to sign in again" });
  await c.start();
  assert.equal(logins(r).length, 1, "the sign-in opened");
  assert.equal(c.view().phase, "connected");
  assert.ok((c.view().account?.expiresAt ?? 0) > Date.now(), "a new sign-in");
  assert.equal(claudeStatusLine(c.view(), "en")?.state, "connected");
});
