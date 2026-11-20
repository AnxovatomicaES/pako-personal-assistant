// The assistant's computer can keep itself up to date (the hosted way: the bridge on the owner's other computer). It is OPT-IN: this
// computer holds the Claude sign-in and the bridge token, so whatever it runs must be something the owner signed, never just "whatever is
// on GitHub now" (whoever took the GitHub account would run code on every bridge).
//
// Off (the default): every 30 minutes, between two messages, it asks origin where its default branch is, and when that is ahead of what
// runs here it logs "update available" with the commit, once, and does nothing else. Updating is then the owner's own `git pull`.
//
// On (BRIDGE_AUTO_UPDATE=1): it only ever moves to a release tag (vX.Y.Z) whose signature verifies against the key the owner pinned in
// BRIDGE_UPDATE_SIGNER: an SSH allowed-signers file (git verify-tag with gpg.ssh.allowedSignersFile and gpg.minTrustLevel=fully), or a GPG
// fingerprint (git verify-tag --raw, and the VALIDSIG line must name that key). With no signer pinned it refuses, and says so in its log.
// It takes the newest such tag when that is a fast-forward of the checkout, the checkout is clean (no changed tracked file) and on origin's
// default branch: `git merge --ff-only` to the tag's commit, then `npm ci` only when package-lock.json changed, then a self-check (every file
// of the bridge parses, the bridge and this file import with everything they import, and the new assistant/run.ts starts with --self-check
// the way the live bridge was started). If all of that worked it starts itself again on the new version; if the install or the check
// failed it goes back to the commit it ran (`git reset --keep`, and `npm ci` again when the lock had changed) and keeps running as it was,
// and does not try that same commit again (noted on disk). And a new version that still stops before its first good round is undone at its
// next start (started()).
//
// Never with local changes, never a non-fast-forward, never another branch, never an unsigned or wrongly signed tag: then it only says why
// it did not (the Salud card and the server's warning show it). BRIDGE_AUTOUPDATE=off (the older setting) stops even the look, and it is
// always off when the bridge runs beside the server on the same computer (local mode: src/local.ts starts it, and what updates Pako there
// is the Mac app or the person's own `git pull`).
//
// What it runs is git, npm and node, with arguments fixed here: nothing it reads from the repository or the network becomes a command.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export type Run = (
  cmd: string,
  args: string[],
  o: { cwd: string; timeoutMs: number; env?: Record<string, string | undefined> },
) => Promise<{ code: number; out: string; err: string }>;

/** Runs one program with fixed arguments, no shell; never throws (a program that cannot start or takes too long answers code -1). */
export const runCommand: Run = (cmd, args, o) =>
  new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    const finish = (code: number): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out, err });
    };
    let child: ReturnType<typeof spawn>;
    try {
      // GIT_TERMINAL_PROMPT=0: a remote that asks for a password fails at once instead of waiting for a terminal nobody watches. No other
      // GIT_* setting is passed on (GIT_DIR and the like, from a hook): git works on the repository at cwd and nothing else.
      const env = Object.fromEntries(Object.entries(o.env ?? process.env).filter(([k]) => !k.startsWith("GIT_")));
      child = spawn(cmd, args, { cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...env, GIT_TERMINAL_PROMPT: "0" } });
    } catch (e) {
      resolve({ code: -1, out: "", err: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      err += `\n(stopped after ${Math.round(o.timeoutMs / 1000)} s)`;
      child.kill("SIGKILL");
      finish(-1);
    }, o.timeoutMs);
    child.stdout?.on("data", (b: Buffer) => (out = (out + b.toString("utf8")).slice(-20_000)));
    child.stderr?.on("data", (b: Buffer) => (err = (err + b.toString("utf8")).slice(-20_000)));
    child.on("error", (e) => {
      err += e.message;
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
  });

export interface UpdateConfig {
  /** Updates itself (BRIDGE_AUTO_UPDATE=1), to signed release tags only. */
  on: boolean;
  /** Off, but still looks and logs "update available" (the default for a hosted bridge). */
  notify?: boolean;
  /** BRIDGE_UPDATE_SIGNER: an SSH allowed-signers file, or a GPG fingerprint. "" = none pinned (then it refuses to update). */
  signer?: string;
  /** Why it is off ("" when on). */
  why: string;
  /** How often it looks (30 minutes); the first look comes `firstMs` after the start. */
  everyMs: number;
  firstMs: number;
}

const truthy = (v: string | undefined): boolean => ["1", "on", "true", "yes"].includes((v ?? "").trim().toLowerCase());

/**
 * BRIDGE_AUTO_UPDATE=1 turns self-updating on (signed tags only, BRIDGE_UPDATE_SIGNER); unset, it only says "update available". Always off
 * for a bridge beside its server (local mode: PAKO_PARENT_PID, or a server on this computer), and with BRIDGE_AUTOUPDATE=off.
 */
export function loadUpdateConfig(env: Record<string, string | undefined>, server: string): UpdateConfig {
  const base = { everyMs: 30 * 60_000, firstMs: 5 * 60_000 };
  if ((env.PAKO_PARENT_PID ?? "").trim() || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(server)) {
    return { ...base, on: false, why: "off (it runs beside its server: Pako itself is updated instead)" };
  }
  if ((env.BRIDGE_AUTOUPDATE ?? "").trim().toLowerCase() === "off") return { ...base, on: false, why: "off (BRIDGE_AUTOUPDATE=off)" };
  if (!truthy(env.BRIDGE_AUTO_UPDATE)) return { ...base, on: false, notify: true, why: "off (BRIDGE_AUTO_UPDATE=1 turns it on)" };
  return { ...base, on: true, signer: (env.BRIDGE_UPDATE_SIGNER ?? "").trim(), why: "" };
}

/** What the bridge says about itself on POST /assistant/health (src/watchdog.ts reads it). */
export interface SelfVersion {
  sha: string;
  committedAt: number;
  updatedAt?: number;
  /** "on", "off ...", or why the last look did not update. */
  autoupdate: string;
}

export type UpdateOutcome =
  | { kind: "off"; why: string }
  | { kind: "current"; sha: string }
  | { kind: "available"; sha: string }
  | { kind: "skipped"; why: string }
  | { kind: "updated"; from: string; to: string }
  | { kind: "failed"; why: string; rolledBack: boolean };

export interface UpdaterDeps {
  /** The checkout's root (the folder with package.json and assistant/). */
  repo: string;
  /** Where it notes the last update (update.json), next to the bridge's state. */
  stateDir: string;
  config: UpdateConfig;
  run?: Run;
  now?: () => number;
  log?: (line: string) => void;
  /** The node that runs the self-check: this one. */
  node?: string;
  /**
   * How the live bridge was started, for the self-check to start the new entry point the same way (`assistant/run.ts --self-check`): the
   * same node flags (--env-file among them), the same settings and the same folder. By default this process's own.
   */
  entry?: { execArgv?: string[]; env?: Record<string, string | undefined>; cwd?: string };
}

/** What update.json holds: the last update, whether the new version has proved it runs, and a commit not to take again. */
interface Noted {
  from?: string;
  to?: string;
  at?: number;
  lockChanged?: boolean;
  /** false from the restart onto `to` until its first good round (or two minutes up); a second start before that undoes it. */
  verified?: boolean;
  starts?: number;
  refused?: string;
}

/** The files of the bridge that must parse, and the two that must import with all they import. */
const BRIDGE_FILES = ["assistant/run.ts", "assistant/bridge.ts", "assistant/update.ts", "assistant/prompt.ts", "assistant/voice.ts"];

export function createUpdater(d: UpdaterDeps) {
  const run = d.run ?? runCommand;
  const now = d.now ?? Date.now;
  const log = d.log ?? ((l: string) => console.log(`${new Date().toISOString()} [update] ${l}`));
  const node = d.node ?? process.execPath;
  const noted = join(d.stateDir, "update.json");
  const startedAt = now();
  let lastLook = 0;
  let status = d.config.on ? "on" : d.config.why;
  const readNoted = (): Noted => {
    try {
      const n = JSON.parse(readFileSync(noted, "utf8")) as unknown;
      return n && typeof n === "object" ? (n as Noted) : {};
    } catch {
      return {};
    }
  };
  const writeNoted = (n: Noted): void => {
    try {
      mkdirSync(d.stateDir, { recursive: true, mode: 0o700 });
      writeFileSync(`${noted}.tmp`, JSON.stringify(n), { mode: 0o600 });
      renameSync(`${noted}.tmp`, noted);
    } catch {
      /* only the date shown in the panel, and the guard below, are lost */
    }
  };
  /** A commit whose install, check or first start failed: not tried again (a newer one is). Kept on disk, so a restart remembers it. */
  const refusedBefore = readNoted().refused;
  let refused = typeof refusedBefore === "string" ? refusedBefore : "";

  const git = (args: string[], timeoutMs = 30_000) => run("git", args, { cwd: d.repo, timeoutMs });
  const line = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 200);

  /** npm next to this node (Homebrew and the installers put both there), else the one on the PATH. */
  const npm = (): string => {
    const near = join(dirname(node), process.platform === "win32" ? "npm.cmd" : "npm");
    return existsSync(near) ? near : "npm";
  };

  /** Null when this is no git checkout (a copy, the Mac app's bundle): there is no version to say. */
  const version = async (): Promise<SelfVersion | null> => {
    const r = await git(["log", "-1", "--format=%H %ct"], 5000);
    const [sha, at] = r.code === 0 ? r.out.trim().split(" ") : [];
    if (!/^[0-9a-f]{40}$/.test(sha ?? "") || !(Number(at) > 0)) return null;
    let updatedAt: number | undefined;
    const n = readNoted();
    if (typeof n.at === "number" && n.to === sha) updatedAt = n.at;
    return {
      sha: sha!,
      committedAt: Number(at) * 1000,
      ...(updatedAt ? { updatedAt } : {}),
      autoupdate: status,
    };
  };

  /** Due when it is on (or only says what is new), and the last look (or the start) was long enough ago. */
  const due = (): boolean => (d.config.on || !!d.config.notify) && now() - (lastLook || startedAt - d.config.everyMs + d.config.firstMs) >= d.config.everyMs;

  // `node --check` says nothing of a .ts file (it passes any), so each file is parsed with Node's own TypeScript parser instead; then the
  // bridge and this file are imported, which loads every file they import. Then the new entry point itself is started the way the live
  // bridge was (same node flags, settings and folder) with --self-check: it loads its settings and everything it imports, builds the bridge,
  // and exits 0 before its loop. A new import that does not load, a throw at its top level or a setting it now refuses fails here, before
  // the restart, and not in a crash loop after it.
  const entry = {
    // Flags of a test runner or an inspector are not the bridge's.
    execArgv: (d.entry?.execArgv ?? process.execArgv).filter((a) => !/^--(test|inspect|watch)/.test(a)),
    env: d.entry?.env ?? process.env,
    cwd: d.entry?.cwd ?? process.cwd(),
  };
  const entryCheck = async (): Promise<string> => {
    const args = [...entry.execArgv, join(d.repo, "assistant/run.ts"), "--self-check"];
    const r = await run(node, args, { cwd: entry.cwd, env: entry.env, timeoutMs: 60_000 });
    if (r.code === 0 && /self-check ok/.test(r.out)) return "";
    const why = r.err.split("\n").filter((l) => /Error|error|must|invalid/.test(l)).slice(0, 2).join(" ") || r.err || `exit ${r.code}`;
    return `the new assistant/run.ts does not start: ${line(why)}`;
  };
  const selfCheck = async (): Promise<string> => {
    const files = BRIDGE_FILES.filter((f) => existsSync(join(d.repo, f)));
    const url = (f: string): string => JSON.stringify(pathToFileURL(join(d.repo, f)).href);
    const script = [
      'import { stripTypeScriptTypes } from "node:module";',
      'import { readFileSync } from "node:fs";',
      `for (const f of ${JSON.stringify(files)}) {`,
      `  try { stripTypeScriptTypes(readFileSync(new URL(f, ${url("./")}), "utf8")); }`,
      '  catch (e) { console.error(`${f} does not parse: ${e.message}`); process.exit(4); }',
      "}",
      `const b = await import(${url("assistant/bridge.ts")});`,
      `const u = await import(${url("assistant/update.ts")});`,
      "if (typeof b.createBridge !== 'function' || typeof b.loadBridgeConfig !== 'function' || typeof u.createUpdater !== 'function') process.exit(3);",
    ].join("\n");
    const r = await run(node, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], { cwd: d.repo, timeoutMs: 60_000 });
    if (r.code === 0) return entryCheck();
    if (r.code === 4) return line(r.err.split("\n").find((l) => / does not parse: /.test(l)) ?? r.err);
    return `the bridge does not load: ${line(r.err.split("\n").filter((l) => /Error|error/.test(l)).slice(0, 2).join(" ") || r.err) || `exit ${r.code}`}`;
  };

  const install = async (): Promise<string> => {
    // --ignore-scripts, as the installers (install.sh): no dependency's install script runs on the computer that holds the Claude sign-in and
    // the bridge token. What is installed is the lock of a release tag the owner signed (verifyTag): nothing else gets this far.
    const r = await run(npm(), ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: d.repo, timeoutMs: 10 * 60_000 });
    return r.code === 0 ? "" : `npm ci failed: ${line(r.err.split("\n").filter((l) => /err/i.test(l)).slice(-3).join(" ") || r.err)}`;
  };

  /**
   * "" when the tag carries a good signature from the pinned signer, else why not. An existing file is an SSH allowed-signers file: git
   * must name a principal from it ("Good "git" signature for ..."), with gpg.minTrustLevel=fully so a valid signature by an unknown key never
   * passes. 40 hex characters are a GPG fingerprint: the VALIDSIG line of `verify-tag --raw` must name that key (any other key in the
   * keyring does not count). A lightweight tag has no signature: git refuses it.
   */
  const verifyTag = async (tag: string): Promise<string> => {
    const signer = d.config.signer ?? "";
    const fpr = signer.replace(/\s+/g, "").toUpperCase();
    if (signer && existsSync(signer)) {
      const r = await git(["-c", `gpg.ssh.allowedSignersFile=${signer}`, "-c", "gpg.minTrustLevel=fully", "verify-tag", tag], 30_000);
      if (r.code === 0 && /Good "git" signature for /.test(`${r.out}\n${r.err}`)) return "";
      return `${tag} is not signed by a key in BRIDGE_UPDATE_SIGNER (${line(r.err || r.out) || `exit ${r.code}`})`;
    }
    if (/^[0-9A-F]{40}$/.test(fpr)) {
      const r = await git(["verify-tag", "--raw", tag], 30_000);
      const valid = `${r.out}\n${r.err}`.split("\n").filter((l) => l.startsWith("[GNUPG:] VALIDSIG "));
      const ok = valid.some((l) => l.split(/\s+/).slice(2).some((f) => f.toUpperCase() === fpr));
      if (r.code === 0 && ok) return "";
      return `${tag} is not signed by the GPG key ${fpr.slice(-16)} (BRIDGE_UPDATE_SIGNER)`;
    }
    return "BRIDGE_UPDATE_SIGNER is neither an allowed-signers file that exists nor a 40-character GPG fingerprint";
  };

  /** Off: only says, once per commit, that origin's default branch is ahead of what runs here. */
  let announced = "";
  const notify = async (): Promise<UpdateOutcome> => {
    try {
      const remote = await git(["ls-remote", "--symref", "origin", "HEAD"], 30_000);
      const m = /^([0-9a-f]{40})\s+HEAD$/m.exec(remote.out);
      const head = (await git(["rev-parse", "HEAD"], 5000)).out.trim();
      if (remote.code !== 0 || !m || !/^[0-9a-f]{40}$/.test(head)) return { kind: "off", why: d.config.why };
      const tip = m[1]!;
      // Already here, or behind what runs here (a commit this checkout has): nothing to say.
      if (tip === head || (await git(["merge-base", "--is-ancestor", tip, "HEAD"], 15_000)).code === 0) return { kind: "current", sha: head };
      if (announced !== tip) log(`update available: ${tip} on origin (running ${head.slice(0, 7)}); auto-update is off, so nothing changes here`);
      announced = tip;
      return { kind: "available", sha: tip };
    } catch {
      return { kind: "off", why: d.config.why };
    }
  };

  /** One look: see the header of this file. Never throws. */
  const check = async (): Promise<UpdateOutcome> => {
    lastLook = now();
    if (!d.config.on) return d.config.notify ? notify() : { kind: "off", why: d.config.why };
    const skip = (why: string): UpdateOutcome => {
      if (status !== why) log(`not updating: ${why}`);
      status = why;
      return { kind: "skipped", why };
    };
    if (!d.config.signer) return skip("no signer pinned (set BRIDGE_UPDATE_SIGNER): auto-update refuses unsigned updates");
    try {
      const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], 5000);
      if (head.code !== 0) return skip("not on a branch (a detached checkout)");
      const branch = head.out.trim();
      // origin's default branch, as origin says it now (not a remote HEAD noted at clone time, which goes stale).
      const remote = await git(["ls-remote", "--symref", "origin", "HEAD"], 30_000);
      const def = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(remote.out)?.[1];
      if (remote.code !== 0 || !def) return skip("origin cannot be reached");
      if (branch !== def) return skip(`on branch ${branch}, not ${def}`);
      const dirty = await git(["status", "--porcelain", "--untracked-files=no"], 15_000);
      if (dirty.code !== 0) return skip("git status failed");
      if (dirty.out.trim()) return skip("local changes");
      // The branch and its tags; an existing tag is never moved (no --force): a tag that changed on origin makes the fetch fail.
      const fetched = await git(["fetch", "--quiet", "--tags", "origin", def], 120_000);
      if (fetched.code !== 0) return skip(`git fetch failed: ${line(fetched.err) || "origin cannot be reached"}`);
      const tags = (await git(["tag", "--list", "v*", "--sort=-v:refname"], 5000)).out.split("\n").map((t) => t.trim());
      const tag = tags.find((t) => /^v\d+\.\d+\.\d+$/.test(t));
      if (!tag) return skip("no release tag (vX.Y.Z) to update to");
      const from = (await git(["rev-parse", "HEAD"], 5000)).out.trim();
      const target = (await git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`], 5000)).out.trim();
      if (!/^[0-9a-f]{40}$/.test(from) || !/^[0-9a-f]{40}$/.test(target)) return skip("git rev-parse failed");
      // The newest release is what runs here, or behind it (a checkout ahead of the last release): nothing to take.
      if (from === target || (await git(["merge-base", "--is-ancestor", target, "HEAD"], 15_000)).code === 0) {
        status = "on";
        return { kind: "current", sha: from };
      }
      if ((await git(["merge-base", "--is-ancestor", "HEAD", target], 15_000)).code !== 0) return skip("not a fast-forward (commits here that origin does not have)");
      if (target === refused) return skip(`${target.slice(0, 7)} failed before`);
      const unsigned = await verifyTag(tag);
      if (unsigned) return skip(`refusing ${tag}: ${unsigned}`);
      const lockOf = async (rev: string): Promise<string> => (await git(["rev-parse", `${rev}:package-lock.json`], 5000)).out.trim();
      const lockBefore = await lockOf("HEAD");
      log(`updating ${from.slice(0, 7)} → ${target.slice(0, 7)} (${tag}, signature verified)`);
      // The commit the verified tag names, by its id (not the tag's name again): a fast-forward or nothing.
      const merged = await git(["merge", "--ff-only", "--quiet", target], 120_000);
      if (merged.code !== 0) return skip(`git merge --ff-only failed: ${line(merged.err)}`);
      const to = (await git(["rev-parse", "HEAD"], 5000)).out.trim();
      const lockChanged = (await lockOf("HEAD")) !== lockBefore;
      const problem = (lockChanged ? await install() : "") || (await selfCheck());
      if (problem) {
        refused = to;
        writeNoted({ ...readNoted(), refused: to });
        log(`${problem}: going back to ${from.slice(0, 7)}`);
        const back = await git(["reset", "--keep", from], 30_000);
        const reinstalled = back.code === 0 && lockChanged ? !(await install()) : back.code === 0;
        status = `update to ${to.slice(0, 7)} failed (${problem.slice(0, 40)})`;
        if (!reinstalled) log(`could not go back cleanly: run git reset --keep ${from.slice(0, 7)} and npm ci in ${d.repo}`);
        return { kind: "failed", why: problem, rolledBack: reinstalled };
      }
      // On probation until the new version has run a good round (see started() and proved()).
      writeNoted({ from, to, at: now(), lockChanged, verified: false, starts: 0, ...(refused ? { refused } : {}) });
      status = "on";
      log(`updated to ${to}${lockChanged ? " (npm ci ran)" : ""}`);
      return { kind: "updated", from, to };
    } catch (err) {
      return skip(`the look failed: ${line((err as Error).message)}`);
    }
  };

  /**
   * The last-known-good guard, called by run.ts as it starts. After a self-update the new version is on probation: its first start is
   * counted; a second start before it proved itself (proved(): a good round, or two minutes up) means it crashed and was started again
   * (launchd), so it goes back to the commit it came from (`git reset --keep`, and npm ci when the lock had changed), refuses that commit
   * for good, and answers "rolled-back" for run.ts to start itself again on the old version. Never throws.
   */
  const started = async (): Promise<"ok" | "rolled-back" | "stuck"> => {
    try {
      const n = readNoted();
      if (n.verified !== false || !n.to || !n.from) return "ok";
      const head = (await git(["rev-parse", "HEAD"], 5000)).out.trim();
      if (head !== n.to) return "ok";
      const starts = (n.starts ?? 0) + 1;
      if (starts < 2) {
        writeNoted({ ...n, starts });
        return "ok";
      }
      log(`${n.to.slice(0, 7)} stopped before its first good round: going back to ${n.from.slice(0, 7)}`);
      refused = n.to;
      const back = await git(["reset", "--keep", n.from], 30_000);
      const ok = back.code === 0 && (!n.lockChanged || !(await install()));
      writeNoted({ ...n, starts, verified: true, refused: n.to });
      status = `update to ${n.to.slice(0, 7)} failed (it did not start)`;
      if (!ok) log(`could not go back cleanly: run git reset --keep ${n.from.slice(0, 7)} and npm ci in ${d.repo}`);
      return ok ? "rolled-back" : "stuck";
    } catch (err) {
      log(`the start check failed: ${line((err as Error).message)}`);
      return "ok";
    }
  };

  /** The running version works (a good round, or two minutes up): the probation ends. */
  let provedOnce = false;
  const proved = (): void => {
    if (provedOnce) return;
    provedOnce = true;
    const n = readNoted();
    if (n.verified === false) writeNoted({ ...n, verified: true });
  };

  return { version, due, check, started, proved, status: (): string => status };
}

export type Updater = ReturnType<typeof createUpdater>;

/** The exit code that asks to be started again: launchd's KeepAlive (the LaunchAgent) or any supervisor starts the bridge again on it. */
export const RESTART_CODE = 75;

/**
 * Starts this same command again on the new files: in place where Node can (execve: the same process id, so launchd, caffeinate and a
 * terminal notice nothing), otherwise by exiting with RESTART_CODE for what started it to start it again.
 */
export function restartSelf(o: {
  execve?: (file: string, args: string[], env: Record<string, string>) => void;
  exit: (code: number) => void;
  platform?: NodeJS.Platform;
  log?: (line: string) => void;
}): void {
  const log = o.log ?? ((l: string) => console.log(l));
  if (o.execve && (o.platform ?? process.platform) !== "win32") {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    try {
      log("restarting on the new version (in place)");
      o.execve(process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], env);
      return;
    } catch (err) {
      log(`could not restart in place (${(err as Error).message}): exiting with ${RESTART_CODE} so it is started again`);
    }
  }
  o.exit(RESTART_CODE);
}
