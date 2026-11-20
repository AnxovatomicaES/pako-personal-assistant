// Autostart on Windows: Pako starts by itself when you sign in to Windows, with no window, its output in ~/.pako/logs.
//
// A Task Scheduler task of your own (made with schtasks, which needs no administrator): at your sign-in it runs a small PowerShell file kept
// in ~/.pako/autostart, which starts Node with absolute paths and a hidden window. Why each piece:
//   - the task is given as XML, not as schtasks flags: the flags make a task that stops after 72 hours, never starts on battery, and (for a
//     sign-in trigger) needs an administrator unless the trigger names you, which only the XML can say;
//   - a PowerShell file, not node.exe itself: Node started by the task would open a console window, and PowerShell can start it hidden with
//     its output sent to files; it is written with a BOM, so Windows PowerShell 5.1 reads a folder like "Zoë" right;
//   - PAKO_NO_OPEN=1: no browser tab at each sign-in (`npm run panel` gives a link when you want one).
//
// Run by install.ps1, and by hand: node src/autostart-windows.ts status | enable | disable | start
// The same three calls (status, enable, disable) as the other systems' autostart, so the panel and the installer can use either.

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { texts, type Lang } from "./i18n.ts";
import { pakoHome } from "./local.ts";

type Env = Record<string, string | undefined>;

export interface AutostartStatus {
  /** False on a system this file does not handle (anything but Windows). */
  supported: boolean;
  /** Pako starts by itself at sign-in. */
  enabled: boolean;
  /** status: the launcher the task runs still starts this folder with this Node.js (false: moved, or Node.js reinstalled elsewhere). */
  current?: boolean;
  /** One sentence for the person, in Pako's language: what is so, or what went wrong. */
  detail: string;
}

export interface Autostart {
  status(): Promise<AutostartStatus>;
  enable(): Promise<AutostartStatus>;
  disable(): Promise<AutostartStatus>;
}

export interface WindowsDeps {
  platform: NodeJS.Platform;
  /** Pako's home folder (~/.pako, or PAKO_HOME): the launcher and the logs go there. */
  pakoDir: string;
  /** The Pako folder (the one with src/server.ts). */
  repo: string;
  /** The Node that runs Pako, as an absolute path (this one: the task does not depend on the PATH at sign-in). */
  node: string;
  /** The Windows account the task belongs to, as DOMAIN\name (or just the name). */
  account: string;
  lang: Lang;
  /** Runs a program with its arguments, never through a shell; the code it ended with and what it printed. */
  run: (cmd: string, args: string[]) => Promise<{ code: number; out: string }>;
  writeFile: (path: string, data: Buffer) => void;
  /** A file's text, or null when it cannot be read. */
  readFile: (path: string) => string | null;
  mkdir: (path: string) => void;
  remove: (path: string) => void;
}

const T = texts(
  {
    onlyWindows: "This autostart is Windows's; this system has its own.",
    on: "Pako starts by itself when you sign in to Windows, with no window. What it writes goes to {logs}.",
    off: "Pako does not start by itself: start it with npm.cmd start in its folder.",
    enabledNow: "Done: Pako will start by itself each time you sign in to Windows. What it writes goes to {logs}.",
    disabledNow: "Done: Pako no longer starts by itself. If it is running, it keeps running until you stop it or turn the computer off.",
    failed: "Windows did not let Pako make the task that starts it ({why}). Start it with npm.cmd start; docs/install-windows.md says what to check.",
    removeFailed: "Windows did not let Pako remove the task that starts it ({why}). Remove it by hand: schtasks /Delete /TN \"{task}\" /F",
    stale: "Pako starts by itself at sign-in, but for another folder or another Node.js: turn it on again with node src/autostart-windows.ts enable.",
    started: "Pako is starting with no window. Its link: npm.cmd run panel in its folder.",
    startFailed: "Pako's task could not be started ({why}). Start it with npm.cmd start.",
    usage: "Usage: node src/autostart-windows.ts status | enable | disable | start",
    description: "Starts Pako, your assistant, at sign-in with no window. Made by install.ps1; remove it with: node src/autostart-windows.ts disable",
  },
);

/** Task names are shared by every account on the computer: the account's name in it keeps two people's Pakos apart. */
export function taskName(account: string): string {
  const name = account.split("\\").at(-1) ?? "";
  return `Pako-${name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60) || "user"}`;
}

/** A PowerShell string that means exactly `s`: single quotes, where nothing is expanded and a quote is written twice. */
export const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

const xmlEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function launcherPaths(pakoDir: string): { dir: string; script: string; xml: string; logs: string } {
  const dir = win32.join(pakoDir, "autostart");
  return { dir, script: win32.join(dir, "start-pako.ps1"), xml: win32.join(dir, "task.xml"), logs: win32.join(pakoDir, "logs") };
}

/**
 * The PowerShell file the task runs. The last start's logs are kept as .old. A log that cannot be moved is held by a Pako already running:
 * then nothing is started (the lock would stop a second one anyway, after it had wiped the first one's log).
 */
export function launcherScript(o: { node: string; repo: string; logs: string }): string {
  const entry = win32.join(o.repo, "src", "server.ts");
  return [
    "# Starts Pako with no window, its output in the logs folder. Written by src/autostart-windows.ts (enable): change that, not this file.",
    "$ErrorActionPreference = 'Stop'",
    `$logs = ${psQuote(o.logs)}`,
    "New-Item -ItemType Directory -Force -Path $logs | Out-Null",
    "foreach ($name in 'pako.log', 'pako.err.log') {",
    "  $file = Join-Path $logs $name",
    "  if (Test-Path -LiteralPath $file) {",
    "    try { Move-Item -LiteralPath $file -Destination ($file + '.old') -Force } catch { exit 0 }", // PowerShell in a string: a log that cannot be moved is held by a running Pako
    "  }",
    "}",
    "$env:PAKO_NO_OPEN = '1'",
    // Start-Process joins the arguments with spaces as they are: the path is quoted inside, for a folder with a space in its name.
    `Start-Process -FilePath ${psQuote(o.node)} -WorkingDirectory ${psQuote(o.repo)} -WindowStyle Hidden \``,
    `  -ArgumentList '--disable-warning=ExperimentalWarning', ${psQuote(`"${entry}"`)} \``,
    "  -RedirectStandardOutput (Join-Path $logs 'pako.log') -RedirectStandardError (Join-Path $logs 'pako.err.log')",
    "",
  ].join("\r\n");
}

/** The task, in Task Scheduler's own XML: at this account's sign-in, as this account, no time limit, on battery too. */
export function taskXml(o: { account: string; script: string; repo: string; description: string }): string {
  const user = xmlEscape(o.account);
  // %SystemRoot% is expanded by Task Scheduler itself: the real Windows PowerShell, whatever the PATH holds.
  const args = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${o.script}"`;
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    `  <RegistrationInfo><Description>${xmlEscape(o.description)}</Description></RegistrationInfo>`,
    `  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${user}</UserId></LogonTrigger></Triggers>`,
    "  <Principals>",
    `    <Principal id="Author"><UserId>${user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>`,
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    "      <Command>%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe</Command>",
    `      <Arguments>${xmlEscape(args)}</Arguments>`,
    `      <WorkingDirectory>${xmlEscape(o.repo)}</WorkingDirectory>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

/** schtasks' command lines: each argument on its own, so Node quotes a path with spaces, and no shell reads them. */
export const schtasks = {
  create: (task: string, xml: string): string[] => ["/Create", "/TN", task, "/XML", xml, "/F"],
  query: (task: string): string[] => ["/Query", "/TN", task],
  remove: (task: string): string[] => ["/Delete", "/TN", task, "/F"],
  run: (task: string): string[] => ["/Run", "/TN", task],
};

/** The first line schtasks printed, for the person (its own words, in the system's language); "code N" when it printed nothing. */
const why = (r: { code: number; out: string }): string =>
  r.out.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.replace(/^(ERROR|ERREUR|FEHLER):\s*/i, "").slice(0, 200) || `code ${r.code}`;

/** The language of Pako's texts: always English (src/i18n.ts). */
const pakoLang = (_dir: string, _env: Env): Lang => "en";

function defaults(env: Env): WindowsDeps {
  const pakoDir = pakoHome(env);
  return {
    platform: process.platform,
    pakoDir,
    repo: fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]+$/, ""),
    node: process.execPath,
    // Set by Windows: the computer's name for a local account, or the domain's; a task's UserId takes DOMAIN\name.
    account: [(env.USERDOMAIN ?? "").trim(), userInfo().username].filter(Boolean).join("\\") || "user",
    lang: pakoLang(pakoDir, env),
    run: (cmd, args) =>
      new Promise((resolve) => {
        execFile(cmd, args, { windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
          resolve({ code, out: `${stderr}\n${stdout}`.trim() });
        });
      }),
    writeFile: (p, data) => writeFileSync(p, data),
    readFile: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        /* not there yet: nothing to read */
        return null;
      }
    },
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    remove: (p) => rmSync(p, { force: true }),
  };
}

/** What `start` says: `ok` when the task was started. */
export type StartResult = AutostartStatus & { ok: boolean };

export function createWindowsAutostart(over: Partial<WindowsDeps> = {}, env: Env = process.env): Autostart & { start(): Promise<StartResult> } {
  const d: WindowsDeps = { ...defaults(env), ...over };
  const t = T(d.lang);
  const task = taskName(d.account);
  const paths = launcherPaths(d.pakoDir);
  const unsupported = (): AutostartStatus => ({ supported: false, enabled: false, detail: t("onlyWindows") });
  const isOn = async (): Promise<boolean> => (await d.run("schtasks.exe", schtasks.query(task))).code === 0;
  return {
    status: async () => {
      if (d.platform !== "win32") return unsupported();
      const enabled = await isOn();
      if (!enabled) return { supported: true, enabled, current: false, detail: t("off") };
      // What the launcher starts, not the whole file: the same node.exe and the same src\server.ts as this copy would write.
      const script = d.readFile(paths.script);
      const want = launcherScript({ node: d.node, repo: d.repo, logs: paths.logs }).split("\r\n").filter((l) => /^\s*(Start-Process|-ArgumentList)/.test(l));
      const current = script !== null && want.every((l) => script.includes(l));
      return { supported: true, enabled, current, detail: current ? t("on", { logs: paths.logs }) : t("stale") };
    },
    enable: async () => {
      if (d.platform !== "win32") return unsupported();
      d.mkdir(paths.dir);
      d.mkdir(paths.logs);
      // UTF-8 with a BOM for PowerShell 5.1, UTF-16 with a BOM for schtasks: each reads a name like "Zoë" right only in its own.
      d.writeFile(paths.script, Buffer.from(`﻿${launcherScript({ node: d.node, repo: d.repo, logs: paths.logs })}`, "utf8"));
      const xml = taskXml({ account: d.account, script: paths.script, repo: d.repo, description: t("description") });
      d.writeFile(paths.xml, Buffer.from(`﻿${xml}`, "utf16le"));
      const r = await d.run("schtasks.exe", schtasks.create(task, paths.xml));
      d.remove(paths.xml);
      if (r.code !== 0) return { supported: true, enabled: false, detail: t("failed", { why: why(r) }) };
      return { supported: true, enabled: true, detail: t("enabledNow", { logs: paths.logs }) };
    },
    disable: async () => {
      if (d.platform !== "win32") return unsupported();
      if (!(await isOn())) {
        d.remove(paths.script);
        return { supported: true, enabled: false, detail: t("off") };
      }
      const r = await d.run("schtasks.exe", schtasks.remove(task));
      if (r.code !== 0) return { supported: true, enabled: true, detail: t("removeFailed", { why: why(r), task }) };
      d.remove(paths.script);
      return { supported: true, enabled: false, detail: t("disabledNow") };
    },
    /** Runs the task now (install.ps1, right after enabling it): Pako starts as it will at each sign-in. */
    start: async () => {
      if (d.platform !== "win32") return { ...unsupported(), ok: false };
      const r = await d.run("schtasks.exe", schtasks.run(task));
      const ok = r.code === 0;
      return { supported: true, enabled: ok || (await isOn()), ok, detail: ok ? t("started") : t("startFailed", { why: why(r) }) };
    },
  };
}

/** The command line: prints the one sentence; the exit code says whether it did what was asked (status: whether autostart is on). */
export async function cli(argv: string[], a: ReturnType<typeof createWindowsAutostart>, print: (s: string) => void, lang: Lang): Promise<number> {
  const what = argv[0] ?? "";
  if (what !== "status" && what !== "enable" && what !== "disable" && what !== "start") {
    print(T(lang)("usage"));
    return 2;
  }
  if (what === "start") {
    const s = await a.start();
    print(s.detail);
    return s.ok ? 0 : 1;
  }
  const s = await a[what]();
  print(s.detail);
  if (!s.supported) return 1;
  return (what === "disable" ? !s.enabled : s.enabled) ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = createWindowsAutostart();
  const lang = pakoLang(pakoHome(process.env), process.env);
  process.exitCode = await cli(process.argv.slice(2), a, (s) => console.log(`\n  ${s}\n`), lang);
}
