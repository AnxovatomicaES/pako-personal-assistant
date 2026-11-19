// Pako starts by itself when the person logs in to their computer (local mode), so it can be installed and forgotten.
//
//   macOS: a LaunchAgent, ~/Library/LaunchAgents/local.pako.plist. It starts at login (RunAtLoad) and launchd starts it again only after a crash
//          (KeepAlive with SuccessfulExit false): a Pako stopped on purpose stays stopped. Its output goes to ~/.pako/logs.
//   Linux: a systemd unit for this user, ~/.config/systemd/user/pako.service, started again on failure only (Restart=on-failure), five times in
//          ten minutes at most. Without "lingering" it starts when the person logs in, not when the computer starts: the result says how to change that.
//   A failure that starting again cannot mend (another Pako holds the folder, the port is taken, a wrong setting) is not a crash: the background
//   Pako (PAKO_SERVICE=1) exits with 0 under launchd and with LASTING_EXIT under systemd, and neither starts it again (lastingExitCode).
//   Windows: a Task Scheduler task, made by src/autostart-windows.ts. createAutostart itself says unsupported there; autostartFor (used by
//          the command line and the panel) picks that file's version on Windows, and this one everywhere else.
//
// Both run the Node.js that set it up (its absolute path: a login session's PATH may have none, or an older one) on this folder's
// src/server.ts, as the person who set it up: never as root, since Pako keeps that person's notes and signs in with their Claude.
// The panel's restart (src/server.ts, restartInPlace) keeps the same process, so neither launchd nor systemd sees it as a stop.
//
// Command line: node src/server.ts --autostart on|off|status (npm run autostart -- on). "on" there also starts it now, "off" also stops the
// one running in the background; the panel's switch (src/autostart-panel.ts) only changes what happens at the next login, because the Pako
// answering it may be the very one launchd or systemd runs.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWindowsAutostart } from "./autostart-windows.ts";
import { npmCommand, texts, type Lang } from "./i18n.ts";
import { lockHolder, pakoHome } from "./local.ts";

type Env = Record<string, string | undefined>;

/** npm as typed here (npm.cmd on Windows: a bare npm is refused by PowerShell's default policy). */
const NPM = npmCommand();

const T = texts(
  {
    unsupported: `Starting by itself isn't available on this system yet: start Pako with ${NPM} start.`,
    inApp: "In Pako for Mac, starting by itself belongs to the app: Start with this Mac, in its menu-bar menu.",
    root: "Pako won't set itself to start as root: do this as your usual user, without sudo.",
    badPath: "The path {path} has a line break: move Pako to a folder with an ordinary name and try again.",
    noWrite: "I couldn't write {file} ({code}). Check there's free space and permission, then try again.",
    noSystemd: `systemd for your user isn't answering here (systemctl --user: {why}). Start Pako with ${NPM} start, or with the service manager you use.`,
    noLaunchd: "launchctl couldn't start it now ({why}): it will start the next time you log in.",
    on: "Pako will start by itself every time you log in ({file}).",
    started: "It's starting in the background now.",
    off: "Pako won't start by itself any more.",
    stopped: "If it was running in the background, it has stopped.",
    keepsRunning: "The Pako running now keeps going until you stop it or log out.",
    linger: "To start it when the computer starts, before you log in: loginctl enable-linger {user} (it may ask for sudo).",
    logs: "What it writes is kept in {dir}.",
    panel: `To open the panel: ${NPM} run panel, in {repo}.`,
    statusOn: "Autostart: on ({file}).",
    statusStale: "Autostart: on, but for another folder or another Node.js, perhaps since upgraded or removed ({file}). Turn it on again: --autostart on.",
    busy: `Not starting it now: a Pako is already running in another terminal (process {pid}). Stop it with Ctrl+C and start the new one with ${NPM} start;`
      + " it will start by itself when you log in.",
    statusOff: "Autostart: off.",
    usage: `Usage: node src/server.ts --autostart on|off|status (or ${NPM} run autostart -- on).`,
    logOn: "Autostart turned on from the panel",
    logOff: "Autostart turned off from the panel",
  },
);

/** The name launchd knows the job by, and systemd's unit. One per user: a second Pako with another PAKO_HOME is started by hand. */
export const LAUNCHD_LABEL = "local.pako";
export const SYSTEMD_UNIT = "pako.service";

/**
 * Settings from the terminal that set it up which the background Pako needs too, as they were then. PATH, so the claude command (and
 * Homebrew's or nvm's tools) are found as in the terminal; the rest are Pako's own (docs/configuration.md), which ~/.pako/.env can also hold.
 */
const CARRIED = ["PATH", "PAKO_HOME", "PORT", "PAKO_HOST", "CLAUDE_BIN", "PAKO_SECRET_STORE"] as const;

export interface AutostartStatus {
  /** False on a system this module does not handle (Windows). */
  supported: boolean;
  /** The LaunchAgent or the unit is there: Pako starts at the next login. */
  enabled: boolean;
  /** It runs this folder with this Node.js; false when enabled from another folder or with a Node.js that may be gone. */
  current: boolean;
  /** "task": Windows's Task Scheduler (src/autostart-windows.ts). */
  kind: "launchd" | "systemd" | "task" | null;
  file: string | null;
}

/** `running` false: on, but it could not be started now (it starts at the next login); the command line exits with code 3 then. */
export type AutostartResult = { ok: true; enabled: boolean; message: string; running?: boolean } | { ok: false; error: string };

/** The exit code of a failure that starting again cannot mend, for systemd (RestartPreventExitStatus): EX_CONFIG. */
export const LASTING_EXIT = 78;

/**
 * How Pako ends when it cannot start for a reason a restart cannot mend (the folder held by another Pako, the port taken, a wrong setting): 1
 * when started by hand; started by launchd or systemd (PAKO_SERVICE=1, set in their files), a code they do not start it again for, so a
 * Pako stopped in its terminal does not come back by itself 30 seconds later, and the log does not fill with the same line.
 */
export function lastingExitCode(env: Env, platform: NodeJS.Platform = process.platform): number {
  if (env.PAKO_SERVICE !== "1") return 1;
  // launchd's KeepAlive SuccessfulExit false starts again after any exit that is not 0.
  return platform === "darwin" ? 0 : LASTING_EXIT;
}

/**
 * The Node.js to write in the files: Homebrew's own stable link when this one is in its Cellar (a versioned folder that `brew upgrade` removes),
 * if that link leads to this very Node.js; else this path as it is (nvm's are versioned too: after `nvm uninstall`, run --autostart on again).
 */
export function stableNode(execPath: string, real: (p: string) => string | null = realOrNull): string {
  const m = /^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/.exec(execPath);
  if (!m) return execPath;
  const target = real(execPath) ?? execPath;
  for (const link of [`${m[1]}/opt/${m[2]}/bin/node`, `${m[1]}/bin/node`]) if (real(link) === target) return link;
  return execPath;
}

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

export interface Autostart {
  status(): AutostartStatus;
  /** `now`: also start it at once (the command line); without it, from the next login (the panel). */
  enable(o?: { now?: boolean }): AutostartResult;
  /** `stop`: also stop the one running in the background (the command line). */
  disable(o?: { stop?: boolean }): AutostartResult;
}

type Maybe<T> = T | Promise<T>;

/** The same three calls on any system: synchronous on macOS and Linux, waiting for schtasks on Windows. */
export interface AnyAutostart {
  status(): Maybe<AutostartStatus>;
  enable(o?: { now?: boolean }): Maybe<AutostartResult>;
  disable(o?: { stop?: boolean }): Maybe<AutostartResult>;
}

/** What it reads and writes on disk; the tests give their own. */
export interface AutostartFs {
  read(path: string): string | null;
  write(path: string, text: string): void;
  mkdir(path: string): void;
  remove(path: string): void;
}

/** Runs a program and waits (with a time limit); code is not 0 when it failed or could not start. */
export type AutostartExec = (cmd: string, args: string[]) => { code: number; out: string };

export interface AutostartDeps {
  platform?: NodeJS.Platform;
  /** The person's home folder. */
  home?: string;
  user?: string;
  uid?: number;
  /** The absolute path of the Node.js to run. */
  node?: string;
  /** Pako's folder (the one with package.json). */
  repo?: string;
  env?: Env;
  lang?: () => Lang;
  fs?: AutostartFs;
  exec?: AutostartExec;
  /** Waits a moment, between two of launchctl's steps. */
  sleep?: (ms: number) => void;
  /** The Pako holding ~/.pako's lock now, if any (src/local.ts lockHolder); the tests give their own. */
  running?: () => { pid: number; service: boolean } | null;
  /** Windows's version (src/autostart-windows.ts) in the language given; the tests give their own. */
  windows?: (lang: Lang) => ReturnType<typeof createWindowsAutostart>;
}

const realFs: AutostartFs = {
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  write: (path, text) => writeFileSync(path, text, { mode: 0o644 }),
  mkdir: (path) => void mkdirSync(path, { recursive: true, mode: 0o700 }),
  remove: (path) => rmSync(path, { force: true }),
};

const realExec: AutostartExec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || (r.error ? r.error.message : "") };
};

/** A synchronous pause without spinning: the command line has nothing else to do meanwhile, and the panel's call is rare. */
const realSleep = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** A value inside double quotes in a unit file: systemd expands % (specifiers) and $ (variables) there, and reads backslash escapes. */
const unitQuoted = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
/** A path as the whole value of a unit setting (WorkingDirectory, append:): only the specifiers are special there. */
const unitPath = (s: string): string => s.replace(/%/g, "%%");

/** The PATH the background Pako gets: Node's own folder first (its npm-installed tools, claude among them), then the terminal's. */
function carriedPath(node: string, given: string | undefined): string {
  const parts = [dirname(node), ...(given ?? "").split(":"), "/usr/local/bin", "/usr/bin", "/bin"].filter((p) => p.startsWith("/"));
  return [...new Set(parts)].join(":");
}

export interface ServiceSpec {
  node: string;
  repo: string;
  logs: string;
  env: Record<string, string>;
}

/** The LaunchAgent: started at login, again only after a crash, at most every 30 seconds, its output in ~/.pako/logs. */
export function launchdPlist(s: ServiceSpec): string {
  const vars = Object.entries(s.env).map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    `    <key>Label</key>\n    <string>${LAUNCHD_LABEL}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    `      <string>${xml(s.node)}</string>`,
    "      <string>--disable-warning=ExperimentalWarning</string>",
    `      <string>${xml(join(s.repo, "src", "server.ts"))}</string>`,
    "    </array>",
    `    <key>WorkingDirectory</key>\n    <string>${xml(s.repo)}</string>`,
    "    <key>EnvironmentVariables</key>",
    "    <dict>",
    ...vars,
    "    </dict>",
    "    <key>RunAtLoad</key>\n    <true/>",
    "    <key>KeepAlive</key>\n    <dict>\n      <key>SuccessfulExit</key>\n      <false/>\n    </dict>",
    "    <key>ThrottleInterval</key>\n    <integer>30</integer>",
    `    <key>StandardOutPath</key>\n    <string>${xml(join(s.logs, "pako.log"))}</string>`,
    `    <key>StandardErrorPath</key>\n    <string>${xml(join(s.logs, "pako.err.log"))}</string>`,
    "  </dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** The systemd unit for this user: started at login, again only on failure, its output appended to ~/.pako/logs. */
export function systemdUnit(s: ServiceSpec): string {
  const vars = Object.entries(s.env).map(([k, v]) => unitQuoted(`${k}=${v}`)).join(" ");
  return [
    "[Unit]",
    "Description=Pako, your personal assistant",
    // Started again five times in ten minutes at most: a failure that keeps coming back stops there (systemctl --user status pako says why).
    "StartLimitIntervalSec=600",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${unitPath(s.repo)}`,
    `ExecStart=${unitQuoted(s.node)} --disable-warning=ExperimentalWarning ${unitQuoted(join(s.repo, "src", "server.ts"))}`,
    `Environment=${vars}`,
    "Restart=on-failure",
    "RestartSec=30",
    `RestartPreventExitStatus=${LASTING_EXIT}`,
    `StandardOutput=append:${unitPath(join(s.logs, "pako.log"))}`,
    `StandardError=append:${unitPath(join(s.logs, "pako.err.log"))}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * The file that makes Pako start by itself (a file, not a store key): the LaunchAgent, the systemd unit, or on Windows the folder with the
 * launcher the task runs (the task itself lives in Task Scheduler, named Pako-<user>). The privacy page names it; deleting everything keeps it.
 */
export function autostartFile(platform: NodeJS.Platform, home: string, pakoDir: string): string | null {
  if (platform === "darwin") return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  if (platform === "linux") return join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
  if (platform === "win32") return join(pakoDir, "autostart");
  return null;
}

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");

export function createAutostart(d: AutostartDeps = {}): Autostart {
  const platform = d.platform ?? process.platform;
  const home = d.home ?? homedir();
  const env = d.env ?? process.env;
  const node = d.node ?? stableNode(process.execPath);
  const repo = (d.repo ?? REPO).replace(/\/+$/, "");
  const uid = d.uid ?? process.getuid?.() ?? -1;
  const fs = d.fs ?? realFs;
  const exec = d.exec ?? realExec;
  const sleep = d.sleep ?? realSleep;
  const say = () => T(d.lang?.() ?? "en");
  const logs = join(pakoHome(env), "logs");
  // The server inside Pako for Mac (PAKO_APP_BUNDLE=1, set by the app): the app's own login item starts it. A LaunchAgent written from here
  // would name the node and the folder inside the app, which moves, is replaced by an update or is deleted, and then fails at every login.
  const inApp = runsInMacApp(env, platform);
  const kind = inApp ? null : platform === "darwin" ? "launchd" : platform === "linux" ? "systemd" : null;
  const file = kind ? autostartFile(platform, home, pakoHome(env)) : null;

  const spec = (): ServiceSpec => {
    // The browser opens when the person starts Pako, not at every login: `npm run panel` (or the panel's bookmark) opens it then.
    // PAKO_SERVICE: the background Pako knows launchd or systemd runs it (lastingExitCode).
    const vars: Record<string, string> = { PAKO_NO_OPEN: "1", PAKO_SERVICE: "1" };
    for (const name of CARRIED) {
      const v = (env[name] ?? "").trim();
      if (name === "PATH") vars.PATH = carriedPath(node, v);
      else if (v) vars[name] = v;
    }
    return { node, repo, logs, env: vars };
  };
  const contents = (): string => (kind === "launchd" ? launchdPlist(spec()) : systemdUnit(spec()));

  const status = (): AutostartStatus => {
    const text = file ? fs.read(file) : null;
    // What it runs, not the whole file: the PATH carried from the terminal differs from the background Pako's own, and must not count.
    const runs = kind === "launchd" ? [xml(node), xml(join(repo, "src", "server.ts"))] : [unitQuoted(node), unitQuoted(join(repo, "src", "server.ts"))];
    return { supported: kind !== null, enabled: text !== null, current: text !== null && runs.every((r) => text.includes(r)), kind, file };
  };

  const notes = (...lines: string[]): string => lines.filter(Boolean).join(" ");

  const enable = (o: { now?: boolean } = {}): AutostartResult => {
    const t = say();
    if (!kind || !file) return { ok: false, error: t(inApp ? "inApp" : "unsupported") };
    if (uid === 0) return { ok: false, error: t("root") };
    const odd = [node, repo, logs].find((p) => /[\u0000-\u001f\u007f]/.test(p));
    if (odd !== undefined) return { ok: false, error: t("badPath", { path: JSON.stringify(odd) }) };
    const before = fs.read(file);
    const text = contents();
    try {
      fs.mkdir(logs);
      fs.mkdir(dirname(file));
      if (before !== text) fs.write(file, text);
    } catch (err) {
      return { ok: false, error: t("noWrite", { file, code: (err as NodeJS.ErrnoException).code ?? "error" }) };
    }
    const done = t("on", { file });
    const logLine = t("logs", { dir: logs });
    // A Pako started by hand holds the folder: one started now would stop at once on its lock (and, before, be started again and again).
    const holder = o.now ? (d.running ?? (() => lockHolder(pakoHome(env))))() : null;
    const busy = holder && !holder.service ? t("busy", { pid: holder.pid }) : null;
    if (kind === "launchd") {
      if (!o.now) return { ok: true, enabled: true, message: notes(done, logLine) };
      if (busy) {
        // A job loaded before may be the one failing on that lock: unloaded; the file loads it again at the next login.
        if (exec("launchctl", ["print", `gui/${uid}/${LAUNCHD_LABEL}`]).code === 0) exec("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]);
        return { ok: true, enabled: true, running: false, message: notes(done, busy, logLine) };
      }
      const target = `gui/${uid}`;
      const job = `${target}/${LAUNCHD_LABEL}`;
      const loaded = exec("launchctl", ["print", job]).code === 0;
      let r = { code: 0, out: "" };
      if (loaded && before === text) r = exec("launchctl", ["kickstart", "-k", job]);
      else {
        // A job loaded with other contents is unloaded first, so the new file is the one launchd runs; unloading takes a moment.
        if (loaded) exec("launchctl", ["bootout", job]);
        for (let i = 0; i < 5; i++) {
          r = exec("launchctl", ["bootstrap", target, file]);
          if (r.code === 0) break;
          sleep(500);
        }
      }
      if (r.code !== 0) {
        const why = r.out.split("\n")[0] || `code ${r.code}`;
        return { ok: true, enabled: true, running: false, message: notes(done, t("noLaunchd", { why }), logLine) };
      }
      return { ok: true, enabled: true, message: notes(done, t("started"), logLine) };
    }
    const reload = exec("systemctl", ["--user", "daemon-reload"]);
    const on = reload.code === 0 ? exec("systemctl", ["--user", "enable", SYSTEMD_UNIT]) : reload;
    if (on.code !== 0) {
      // A unit no systemd will read would say "on" for nothing: the file goes again (unless it was there before).
      if (before === null) {
        try {
          fs.remove(file);
        } catch {
          /* status then says on; the error below still says why */
        }
      }
      return { ok: false, error: t("noSystemd", { why: on.out.split("\n")[0] || `code ${on.code}` }) };
    }
    const start = o.now && !busy ? exec("systemctl", ["--user", "restart", SYSTEMD_UNIT]) : null;
    const linger = exec("loginctl", ["show-user", String(uid), "--property=Linger"]);
    const user = d.user ?? safeUser();
    return {
      ok: true,
      enabled: true,
      ...(o.now ? { running: !busy && start?.code === 0 } : {}),
      message: notes(
        done,
        busy ?? (start ? (start.code === 0 ? t("started") : t("noSystemd", { why: start.out.split("\n")[0] || `code ${start.code}` })) : ""),
        /Linger=yes/.test(linger.out) ? "" : t("linger", { user }),
        logLine,
      ),
    };
  };

  const disable = (o: { stop?: boolean } = {}): AutostartResult => {
    const t = say();
    if (!kind || !file) return { ok: false, error: t(inApp ? "inApp" : "unsupported") };
    const there = fs.read(file) !== null;
    // Told before the file goes: systemd needs the unit to undo its links. A failure here is no reason to keep the file.
    if (kind === "systemd" && there) exec("systemctl", ["--user", "disable", ...(o.stop ? ["--now"] : []), SYSTEMD_UNIT]);
    if (kind === "launchd" && o.stop) exec("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]);
    try {
      if (there) fs.remove(file);
    } catch (err) {
      return { ok: false, error: t("noWrite", { file, code: (err as NodeJS.ErrnoException).code ?? "error" }) };
    }
    if (kind === "systemd" && there) exec("systemctl", ["--user", "daemon-reload"]);
    return { ok: true, enabled: false, message: notes(t("off"), o.stop ? t("stopped") : t("keepsRunning")) };
  };

  return { status, enable, disable };
}

/** True for the server Pako for Mac carries inside itself (desktop/mac/package.sh), which the app starts with PAKO_APP_BUNDLE=1. */
export function runsInMacApp(env: Env, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" && env.PAKO_APP_BUNDLE === "1";
}

/**
 * The autostart of the system Pako runs on: Windows's task (src/autostart-windows.ts) on Windows, else createAutostart. On Windows, `stop`
 * is not offered: the hidden Pako keeps running until it is stopped from the panel or the computer is turned off, and the answer says so.
 */
export function autostartFor(d: AutostartDeps = {}): AnyAutostart {
  if ((d.platform ?? process.platform) !== "win32") return createAutostart(d);
  const env = d.env ?? process.env;
  const lang = (): Lang => d.lang?.() ?? cliLang(env);
  const win = (): ReturnType<typeof createWindowsAutostart> => (d.windows ? d.windows(lang()) : createWindowsAutostart({ lang: lang() }, env));
  return {
    status: async () => {
      const s = await win().status();
      // current: the launcher the task runs still names this folder and this Node.js (src/autostart-windows.ts status).
      return { supported: s.supported, enabled: s.enabled, current: s.enabled && s.current !== false, kind: s.supported ? "task" : null, file: null };
    },
    enable: async (o = {}) => {
      const w = win();
      const s = await w.enable();
      if (!s.enabled) return { ok: false, error: s.detail };
      if (!o.now) return { ok: true, enabled: true, message: s.detail };
      const started = await w.start();
      return { ok: true, enabled: true, running: started.ok, message: `${s.detail} ${started.ok ? T(lang())("started") : started.detail}` };
    },
    disable: async () => {
      const s = await win().disable();
      return s.enabled || !s.supported ? { ok: false, error: s.detail } : { ok: true, enabled: false, message: s.detail };
    },
  };
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "$USER";
  }
}

/** The language of the command line's sentences: always English (src/i18n.ts). */
const cliLang = (_env: Env): Lang => "en";

/**
 * node src/server.ts --autostart on|off|status: prints what happened, and gives the exit code (status: 0 when on). "on": 0 when on and started
 * now, 3 when on but it could not be started now (install.sh then starts Pako in its terminal), 1 when it could not be turned on.
 */
export async function runAutostartCli(arg: string | undefined, d: AutostartDeps & { print?: (s: string) => void } = {}): Promise<number> {
  const env = d.env ?? process.env;
  const lang = d.lang ?? (() => cliLang(env));
  const t = T(lang());
  const print = d.print ?? ((s: string) => console.log(`\n  ${s}\n`));
  const a = autostartFor({ ...d, lang });
  const repo = (d.repo ?? REPO).replace(/\/+$/, "");
  if (arg === "status") {
    const s = await a.status();
    const unsupported = t(runsInMacApp(env, d.platform) ? "inApp" : "unsupported");
    print(!s.supported ? unsupported : !s.enabled ? t("statusOff") : s.current ? t("statusOn", { file: s.file ?? "" }) : t("statusStale", { file: s.file ?? "" }));
    return s.enabled ? 0 : 1;
  }
  if (arg !== "on" && arg !== "off") {
    print(t("usage"));
    return 2;
  }
  const r = arg === "on" ? await a.enable({ now: true }) : await a.disable({ stop: true });
  if (!r.ok) {
    print(r.error);
    return 1;
  }
  if (arg === "on" && r.running === false) {
    print(r.message);
    return 3;
  }
  print(arg === "on" ? `${r.message} ${t("panel", { repo })}` : r.message);
  return 0;
}

/** The panel's log lines (src/autostart-panel.ts), in the same texts as the rest of this module. */
export const autostartLog = (l: Lang, on: boolean): string => T(l)(on ? "logOn" : "logOff");
