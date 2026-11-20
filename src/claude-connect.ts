// Connect Claude in one button, from the panel on any computer (macOS, Windows, Linux), with no API key and no terminal.
//
// Pako's brain is the `claude` command (Claude Code), signed in with the person's own Claude subscription. This file does, at the person's
// click, what Anthropic's docs tell a person to do in a terminal (https://code.claude.com/docs/en/setup):
//   1. no `claude` here: Anthropic's native installer (`curl -fsSL https://claude.ai/install.sh | bash`, on Windows
//      `irm https://claude.ai/install.ps1 | iex`). It needs no Node and no administrator rights (it refuses sudo itself) and puts the command
//      in ~/.local/bin, where src/local.ts already looks;
//   2. signed out: `claude auth login --claudeai` (with `--email` when Pako knows the owner's address). Claude Code opens the browser itself,
//      on Anthropic's own page, with a callback to a port of its own on this computer, so the sign-in ends by itself: nothing is pasted back.
//      Checked with Claude Code 2.1.327 spawned with no terminal (stdin closed): it prints the page's address and "Paste code here if prompted",
//      waits for the browser's callback, and exits 1 with "Couldn't log in: No authorization code received" when the person cancels there;
//   3. `claude auth status --json` every two seconds, for up to five minutes, until it says signed in.
//
// Claude Code keeps its own credentials: this file never reads them, and never logs or keeps what the commands print (the sign-in's output
// holds the page's one-time state). Only `auth status` is read, for whether it is signed in, how, the address, the plan and when it expires.
//
// The keeper (createClaudeKeeper) is the "keep it working" half: it looks at the sign-in when the server starts and every few hours, and
// when the sign-in is about to expire, has expired, or a run failed for it, it tells the owner ONE calm line, once until it works again.

import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { childEnv, claudeCommand } from "../assistant/bridge.ts";
import { claudeCandidates, claudeInstalled, hasAuthStatus } from "./local.ts";
import { texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import { readJsonRecord } from "./json-record.ts";

type Env = Record<string, string | undefined>;

export const INSTALL_SH = "https://claude.ai/install.sh";
export const INSTALL_PS1 = "https://claude.ai/install.ps1";
/** Where a free account goes to pick a plan that includes Claude Code. */
export const UPGRADE_URL = "https://claude.ai/upgrade";

// ---------- what `claude auth status` says ----------

/** The sign-in as Pako shows it: never a token (status has none), only who and which plan. */
export interface ClaudeAccount {
  loggedIn: boolean;
  /** "plan": a Claude subscription (claude.ai, or the long-lived token of `claude setup-token`); "api": Console or an API key, billed by use;
   *  "cloud": a cloud provider (Bedrock, Vertex); "none": signed out. */
  billing: "plan" | "api" | "cloud" | "none";
  email: string;
  /** Claude's own word for the plan, lower case ("pro", "max", "team", "enterprise", "free"), or "" when it does not say. */
  plan: string;
  /** When the sign-in expires (ms), or null when it does not say. */
  expiresAt: number | null;
}

const clean = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");

/**
 * Reads `claude auth status --json` (exit 0 signed in, 1 not; https://code.claude.com/docs/en/cli-reference). null for anything that is not
 * that answer (an older Claude Code, an error), so a check that could not tell never counts as signed out.
 */
export function parseClaudeAccount(code: number | null, out: string): ClaudeAccount | null {
  if (code !== 0 && code !== 1) return null;
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let j: Record<string, unknown>;
  try {
    const v = JSON.parse(out.slice(start, end + 1)) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    j = v as Record<string, unknown>;
  } catch {
    /* not JSON: not a status we know */
    return null;
  }
  if (j.loggedIn === undefined && j.authMethod === undefined) return null;
  const method = clean(j.authMethod, 40);
  const loggedIn = code === 0 && j.loggedIn !== false && method !== "none";
  if (!loggedIn) return { loggedIn: false, billing: "none", email: "", plan: "", expiresAt: null };
  const billing = method === "claude.ai" || method === "oauth_token" ? "plan" : method === "third_party" ? "cloud" : "api";
  const at = typeof j.loginExpiresAt === "string" ? Date.parse(j.loginExpiresAt) : typeof j.loginExpiresAt === "number" ? j.loginExpiresAt : NaN;
  return { loggedIn, billing, email: clean(j.email, 254), plan: clean(j.subscriptionType, 30).toLowerCase(), expiresAt: Number.isFinite(at) ? at : null };
}

/** A plan's name as people say it: "Pro", "Max", "Team"; "" when there is none. */
export const planLabel = (plan: string): string => (plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : "");

/** A sign-in that says when it expires, and that time has passed: it still reads as signed in, but runs are refused until it is renewed. */
export const expired = (a: ClaudeAccount | null, at = Date.now()): boolean => !!a && a.loggedIn && a.expiresAt !== null && a.expiresAt <= at;

/** A subscription that cannot run Claude Code (the free plan). API billing and an unknown plan are fine. */
export const needsPlan = (a: ClaudeAccount | null): boolean => !!a && a.loggedIn && a.billing === "plan" && a.plan === "free";

// ---------- running Claude Code ----------

export interface Run {
  code: number | null;
  out: string;
}

/** What a program prints on stdout within `ms`, with its exit code (null when it could not run or took longer). Never logged. */
function runOnce(spawnFn: typeof spawn, cmd: string, args: string[], env: NodeJS.ProcessEnv, ms: number): Promise<Run> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, env });
    } catch {
      /* the command could not start (not installed): no answer */
      return resolve({ code: null, out: "" });
    }
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      if (out.length < 64_000) out += d.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, out: "" });
    }, ms);
    child.on("error", () => (clearTimeout(timer), resolve({ code: null, out: "" })));
    child.on("close", (code) => (clearTimeout(timer), resolve({ code, out })));
  });
}

/**
 * The installer to run, per system, as a program with its arguments (no terminal, no administrator rights), and the one line a person can
 * paste in a terminal when it fails here. Anthropic's own commands, word for word (https://code.claude.com/docs/en/setup).
 */
export function installerFor(platform: NodeJS.Platform): { cmd: string; args: string[]; fix: string } {
  if (platform === "win32") {
    const fix = `irm ${INSTALL_PS1} | iex`;
    return { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", fix], fix };
  }
  const fix = `curl -fsSL ${INSTALL_SH} | bash`;
  return { cmd: "/bin/bash", args: ["-c", fix], fix };
}

/** The last line a program printed, for a failure: links left out (a sign-in's address carries its one-time state), terminal colours dropped. */
export function lastLine(out: string): string {
  const plain = out.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/https?:\/\/\S+/g, "…");
  const lines = plain.split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean);
  return (lines.at(-1) ?? "").slice(0, 200);
}

// ---------- the flow ----------

export type ConnectPhase =
  | "idle" // nothing under way: `account` says how it is (null: not looked at yet)
  | "checking"
  | "installing"
  | "signing-in"
  | "connected"
  | "needs-plan"
  | "install-failed"
  | "failed" // the sign-in ended without signing in (cancelled in the browser, or an error)
  | "cancelled"
  | "timeout"
  | "missing"; // no `claude` here (only said before the person pressed anything)

export interface ConnectView {
  phase: ConnectPhase;
  /** Seconds since the step under way started (the installer's "20 s"). */
  seconds: number;
  account: (ClaudeAccount & { planLabel: string }) | null;
  /** The one line to paste in a terminal when the installer failed here. */
  fix: string;
  /** What the program said last, for a failure (no link, no token). */
  detail: string;
  upgradeUrl: string;
  /** The owner's address Pako knows (the sign-in page is filled with it), for the Mac app's own sign-in; "" when none. */
  emailHint: string;
}

export interface ClaudeConnectOptions {
  env: Env;
  platform?: NodeJS.Platform;
  home?: string;
  spawn?: typeof spawn;
  now?: () => number;
  /** The `claude` command to use, or null when there is none (default: the bridge's own search, src/local.ts). */
  find?: () => Promise<string | null>;
  /** The owner's address, for the sign-in page (`--email`), when Pako knows it. */
  email?: () => string;
  /** Called when the sign-in changed (connected, signed out): the bridge looks again, the keeper forgets its notice. */
  /** `why`: "signed-out" when the owner pressed Sign out (a choice, never a "sign in again" notice); "switching" mid Switch account. */
  changed?: (a: ClaudeAccount | null, why: "connected" | "signed-out" | "switching") => void;
  pollMs?: number;
  loginMs?: number;
  installMs?: number;
}

export type ClaudeConnect = ReturnType<typeof createClaudeConnect>;

export function createClaudeConnect(o: ClaudeConnectOptions) {
  const platform = o.platform ?? process.platform;
  const sp = o.spawn ?? spawn;
  const now = o.now ?? Date.now;
  const pollMs = o.pollMs ?? 2000;
  const loginMs = o.loginMs ?? 5 * 60_000;
  const installMs = o.installMs ?? 15 * 60_000;
  const home = o.home ?? homedir();
  // Not unref'd: a sign-in under way is work the server is doing (it ends by itself within loginMs).
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  let phase: ConnectPhase = "idle";
  let startedAt = 0;
  let account: ClaudeAccount | null = null;
  let lookedAt = 0;
  let detail = "";
  let fix = "";
  let child: ChildProcess | null = null;
  let cancelled = false;
  let running: Promise<void> | null = null;

  const find = o.find ?? (async (): Promise<string | null> => {
    const env = { ...process.env, ...o.env };
    for (const c of claudeCandidates({ given: (o.env.CLAUDE_BIN ?? "").trim(), home, env, platform })) if (await claudeInstalled(c)) return c;
    return null;
  });
  /** Claude's environment as the bridge gives it, without an API key: the sign-in and its status are about the plan, not a key. */
  const env = (): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...childEnv({ ...process.env, ...o.env }), NO_COLOR: "1" };
    delete e.ANTHROPIC_API_KEY;
    delete e.ANTHROPIC_AUTH_TOKEN;
    return e;
  };
  const run = (bin: string, args: string[], ms = 15_000): Promise<Run> => {
    const [cmd, a] = claudeCommand(bin, args, platform);
    return runOnce(sp, cmd, a, env(), ms);
  };
  /** `claude auth status`, only on a Claude Code that has it (2.1.268 or newer): an older one could take it for a question to Claude. */
  const status = async (bin: string): Promise<ClaudeAccount | null> => {
    const v = await run(bin, ["--version"]);
    if (v.code !== 0 || !hasAuthStatus(v.out)) return null;
    const r = await run(bin, ["auth", "status", "--json"]);
    const a = parseClaudeAccount(r.code, r.out);
    if (a) {
      account = a;
      lookedAt = now();
    }
    return a;
  };
  const stopChild = (): void => {
    const c = child;
    child = null;
    if (c && c.exitCode === null) {
      c.kill("SIGTERM");
      setTimeout(() => c.exitCode === null && c.kill("SIGKILL"), 3000).unref?.();
    }
  };
  /**
   * A long program (the installer, the sign-in): its output kept for its last line only, in memory, never logged. The error output is what a
   * failure is about ("Couldn't log in: …"), so its last line comes first; stdout's only when it said nothing there.
   */
  const start = (cmd: string, args: string[], e: NodeJS.ProcessEnv): { done: Promise<number | null>; out: () => string } => {
    const buf = { out: "", err: "" };
    const keep = (k: "out" | "err") => (d: Buffer) => {
      buf[k] += d.toString("utf8");
      if (buf[k].length > 32_000) buf[k] = buf[k].slice(-16_000);
    };
    let c: ChildProcess;
    try {
      c = sp(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: e });
    } catch (err) {
      return { done: Promise.resolve(null), out: () => (err as Error).message };
    }
    child = c;
    c.stdout?.on("data", keep("out"));
    c.stderr?.on("data", keep("err"));
    const done = new Promise<number | null>((resolve) => {
      c.on("error", (err) => (keep("err")(Buffer.from(`\n${err.message}`)), resolve(null)));
      c.on("close", (code) => resolve(code));
    });
    return { done, out: () => (lastLine(buf.err) ? buf.err : buf.out) };
  };
  const set = (p: ConnectPhase): void => {
    phase = p;
    startedAt = now();
  };
  const finish = (a: ClaudeAccount): void => {
    set(needsPlan(a) ? "needs-plan" : "connected");
    o.changed?.(a, "connected");
  };

  const install = async (): Promise<string | null> => {
    set("installing");
    const i = installerFor(platform);
    fix = i.fix;
    // The system's own tools (curl, bash, PowerShell): nothing from a shell's setup, never sudo.
    const e: NodeJS.ProcessEnv = env();
    delete e.SUDO_USER;
    if (platform !== "win32") e.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    const p = start(i.cmd, i.args, e);
    const timer = new Promise<"late">((r) => setTimeout(() => r("late"), installMs).unref?.());
    const code = await Promise.race([p.done, timer]);
    // Still running only when it outlived its time: stopped then.
    stopChild();
    if (cancelled) return null;
    if (code !== 0) {
      detail = code === "late" ? "" : lastLine(p.out());
      set("install-failed");
      return null;
    }
    const bin = await find();
    if (!bin) {
      detail = lastLine(p.out());
      set("install-failed");
    }
    return bin;
  };

  /** `before`: the sign-in there was (signing in again over one about to expire): only a new one counts. */
  const signIn = async (bin: string, before: ClaudeAccount | null): Promise<void> => {
    set("signing-in");
    const email = emailHint();
    const args = ["auth", "login", "--claudeai", ...(email ? ["--email", email] : [])];
    const [cmd, a] = claudeCommand(bin, args, platform);
    const p = start(cmd, a, env());
    let ended: number | null | undefined;
    void p.done.then((c) => (ended = c));
    const until = now() + loginMs;
    while (!cancelled) {
      await sleep(pollMs);
      if (cancelled) break;
      const endedBefore = ended;
      let s = await status(bin);
      // The login may have ended while that look was running: the look may then show the sign-in from before. Once more, now it has ended.
      if (ended === 0 && endedBefore !== 0) s = await status(bin);
      const fresh = !before?.loggedIn || ended === 0 || s?.expiresAt !== before.expiresAt || s?.email !== before.email;
      if (s?.loggedIn && fresh) {
        // It ends by itself once signed in; stopped either way.
        stopChild();
        return finish(s);
      }
      if (ended !== undefined) {
        // It ended without a sign-in: one more look, as its last write may have just landed.
        const again = await status(bin);
        if (again?.loggedIn && (ended === 0 || !before?.loggedIn)) return finish(again);
        child = null;
        detail = lastLine(p.out());
        return set("failed");
      }
      if (now() >= until) {
        stopChild();
        return set("timeout");
      }
    }
    stopChild();
  };

  /** `again`: sign in even when signed in (the sign-in is about to expire, or a run was refused for it). */
  const flow = async (switchAccount: boolean, again: boolean): Promise<void> => {
    detail = "";
    fix = "";
    set("checking");
    let bin = await find();
    if (cancelled) return set("cancelled");
    if (!bin) {
      bin = await install();
      if (cancelled) return set("cancelled");
      if (!bin) return;
    }
    if (switchAccount) {
      await run(bin, ["auth", "logout"]);
      account = null;
      o.changed?.(null, "switching");
    }
    const s = await status(bin);
    if (cancelled) return set("cancelled");
    if (s?.loggedIn && !again && !expired(s, now())) return finish(s);
    await signIn(bin, s?.loggedIn ? s : null);
    if (cancelled) set("cancelled");
  };

  /** A plain address only: it becomes an argument of the sign-in, never anything that reads as a flag. */
  function emailHint(): string {
    const e = (o.email?.() ?? "").trim();
    return /^[^\s@-][^\s@]*@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : "";
  }
  const busy = (): boolean => phase === "checking" || phase === "installing" || phase === "signing-in";

  return {
    view: (): ConnectView => ({
      phase,
      seconds: busy() ? Math.max(0, Math.round((now() - startedAt) / 1000)) : 0,
      account: account ? { ...account, planLabel: planLabel(account.plan) } : null,
      fix: phase === "install-failed" ? fix : "",
      detail: phase === "install-failed" || phase === "failed" ? detail : "",
      upgradeUrl: UPGRADE_URL,
      emailHint: emailHint(),
    }),
    busy,
    /** The button: installs when needed, signs in when needed, says how it is. `switch`: signs out first (Switch account). */
    start: (opts: { switch?: boolean; again?: boolean } = {}): Promise<void> => {
      if (running) return running;
      cancelled = false;
      running = flow(!!opts.switch, !!opts.again)
        .catch((err: Error) => {
          detail = lastLine(err.message);
          set("failed");
        })
        .finally(() => {
          running = null;
        });
      return running;
    },
    cancel: async (): Promise<void> => {
      if (!busy()) return;
      cancelled = true;
      stopChild();
      await running;
    },
    /** Sign out (`claude auth logout`): Claude Code forgets its own credentials; Pako never had them. */
    signOut: async (): Promise<boolean> => {
      if (busy()) return false;
      const bin = await find();
      if (!bin) return false;
      const r = await run(bin, ["auth", "logout"]);
      await status(bin);
      set("idle");
      o.changed?.(account, "signed-out");
      return r.code === 0;
    },
    /**
     * How it is now, looked at again when the last look is older than `maxAgeMs` (and nothing is under way). null when it could not tell;
     * "missing" when there is no `claude` at all.
     */
    check: async (maxAgeMs = 0): Promise<ClaudeAccount | "missing" | null> => {
      if (busy() || (lookedAt && now() - lookedAt < maxAgeMs)) return account;
      const bin = await find();
      if (!bin) {
        account = null;
        if (phase === "idle" || phase === "connected") phase = "missing";
        return "missing";
      }
      if (phase === "missing") phase = "idle";
      return status(bin);
    },
  };
}

// ---------- keeping it working ----------

const NOTICE = texts(
  {
    again: "Claude needs you to sign in again.",
    button: "Sign in again",
    opened: "I opened Claude's sign-in page in the browser on your computer: finish there and I'm back.",
    already: "Claude is already connected.",
    noComputer: "Open Pako on your computer and press “Connect your Claude account”.",
  },
);
export const claudeNotice = NOTICE;

/** The button the notice carries ("cl:" and ten hex digits, like every other card button). */
export const CLAUDE_BUTTON = /^cl:[0-9a-f]{10}$/;

export interface KeeperOptions {
  check: () => Promise<ClaudeAccount | "missing" | null>;
  /** Tells the owner, once: true when it went out. */
  notify: () => Promise<boolean>;
  /** Where the keeper remembers between starts that it told the owner, and that Claude was ever connected here. */
  kv?: Pick<Kv, "get" | "set">;
  now?: () => number;
  /** A sign-in that expires within this is "near" (default a day). */
  nearMs?: number;
}

/** Two flags only (told, seen): never an address or a token. Listed in src/data.ts DATA_KEYS. */
const KEY = "claude-keeper";
const KEEP_S = 400 * 86_400;

export function createClaudeKeeper(o: KeeperOptions) {
  const now = o.now ?? Date.now;
  const near = o.nearMs ?? 24 * 3600_000;
  let mem: { told: boolean; seen: boolean } | null = null;
  let broken = false;
  /** A run failed for the sign-in (the bridge said "login"), until a run works again. */
  let runFailed = false;
  let ticking: Promise<void> | null = null;
  const load = async (): Promise<{ told: boolean; seen: boolean }> => {
    if (mem) return mem;
    try {
      const v = ((o.kv ? await readJsonRecord(o.kv, KEY) : undefined) ?? {}) as { told?: unknown; seen?: unknown };
      mem = { told: v.told === true, seen: v.seen === true };
    } catch {
      /* not JSON, or no store: nothing told yet */
      mem = { told: false, seen: false };
    }
    return mem;
  };
  const save = async (): Promise<void> => {
    const kv = o.kv;
    if (mem) await kv?.set(KEY, JSON.stringify(mem), KEEP_S).catch(() => undefined);
  };
  const tick = async (): Promise<void> => {
    const m = await load();
    const a = await o.check().catch(() => null);
    if (a === null) return; // could not tell: nothing decided
    const signedIn = a !== "missing" && a.loggedIn;
    const expiring = signedIn && a.expiresAt !== null && a.expiresAt - now() < near;
    const healthy = signedIn && !expiring && !runFailed;
    if (healthy) {
      broken = false;
      if (!m.seen || m.told) {
        m.seen = true;
        m.told = false;
        await save();
      }
      return;
    }
    // "Again" only for a Pako that has worked here: a first run without Claude is the first-run flow's, not a notice.
    broken = m.seen;
    if (!broken || m.told) return;
    if (await o.notify().catch(() => false)) {
      m.told = true;
      await save();
    }
  };
  return {
    /** Looks now (at the start, every few hours, after a connect). Calls in flight are shared. */
    tick: (): Promise<void> => (ticking ??= tick().finally(() => (ticking = null))),
    /** What the bridge said after a run: "login" is an auth failure, "ok" clears it. */
    reported: (said: "ok" | "login" | "limit"): Promise<void> | void => {
      if (said === "login" && !runFailed) {
        runFailed = true;
        return tick();
      }
      if (said === "ok" && runFailed) {
        runFailed = false;
        return tick();
      }
    },
    /** The owner signed out on purpose: Pako forgets that Claude worked here, so no "sign in again" follows. */
    signedOut: async (): Promise<void> => {
      const m = await load();
      m.seen = false;
      m.told = false;
      broken = false;
      runFailed = false;
      await save();
    },
    /** Connected again from the panel: a run that failed before no longer counts. */
    connected: (): Promise<void> => {
      runFailed = false;
      return tick();
    },
    broken: (): boolean => broken,
    /** A run was refused for the sign-in (it may still say signed in: a revoked one). */
    refused: (): boolean => runFailed,
  };
}

export type ClaudeKeeper = ReturnType<typeof createClaudeKeeper>;

/** What the notice's button says back when pressed: the sign-in started on the computer, or why not. */
export async function pressSignIn(c: ClaudeConnect | null, l: Lang, o: { refused?: boolean } = {}): Promise<string> {
  const t = NOTICE(l);
  if (!c) return t("noComputer");
  const a = await c.check(0);
  const expiring = !!a && a !== "missing" && a.expiresAt !== null && a.expiresAt - Date.now() < 24 * 3600_000;
  if (a && a !== "missing" && a.loggedIn && !expiring && !o.refused) return t("already");
  void c.start({ again: true });
  return t("opened");
}

const LINE = texts(
  {
    connected: "Connected",
    plan: "{plan} plan",
    api: "Connected (API billing)",
    cloud: "Connected (cloud provider)",
    needsPlan: "Claude Code needs a Pro, Max or Team plan",
    signIn: "Claude needs you to sign in again",
    missing: "Claude Code isn't installed: press “Connect your Claude account”",
  },
);

/** "Connected · ana@example.com · Pro plan", "Connected (API billing)": the one line the connections page shows for a signed-in Claude. */
export function accountLine(a: ClaudeAccount, l: Lang): string {
  const t = LINE(l);
  if (a.billing === "api") return t("api");
  if (a.billing === "cloud") return t("cloud");
  return [t("connected"), a.email, a.plan ? t("plan", { plan: planLabel(a.plan) }) : ""].filter(Boolean).join(" · ");
}

/** Claude's line on the connections page, from what the connect flow last saw; null when it has not looked yet (the watchdog's word stands). */
export function claudeStatusLine(v: ConnectView, l: Lang): { state: "connected" | "needsAction"; detail: string } | null {
  const t = LINE(l);
  if (v.phase === "missing") return { state: "needsAction", detail: t("missing") };
  const a = v.account;
  if (!a) return null;
  if (!a.loggedIn || expired(a)) return { state: "needsAction", detail: t("signIn") };
  if (needsPlan(a)) return { state: "needsAction", detail: t("needsPlan") };
  return { state: "connected", detail: accountLine(a, l) };
}
