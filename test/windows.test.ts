// Pako on Windows, tested from any system: the claude command found and started the Windows way, the browser, the file writes, the
// sign-in task (src/autostart-windows.ts) and install.ps1. The system, the files and the programs run are all stand-ins here.

import { readFileSync as readRepoFile } from "node:fs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { claudeCommand } from "../assistant/bridge.ts";
import { cli, createWindowsAutostart, launcherScript, psQuote, schtasks, taskName, taskXml, type WindowsDeps } from "../src/autostart-windows.ts";
import { browserCommand, claudeCandidates, renameRetry, superviseBridge, windowsShimTarget } from "../src/local.ts";

const HOME = "C:\\Users\\Ana María";
const APPDATA = `${HOME}\\AppData\\Roaming`;
const CLI_JS = `${APPDATA}\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;

/** A claude.cmd as npm's cmd-shim writes it for a package whose command is a .js file. */
const NPM_SHIM = [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
].join("\r\n");

const files = (list: Record<string, string>) => ({
  exists: (p: string) => Object.hasOwn(list, p),
  read: (p: string) => {
    if (!Object.hasOwn(list, p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return list[p]!;
  },
});

test("windows: the .js behind npm's claude.cmd is found, in the new and the old shim, and a .exe target too; anything else is not", () => {
  const shim = `${APPDATA}\\npm\\claude.cmd`;
  assert.equal(windowsShimTarget(shim, files({ [shim]: NPM_SHIM }).read), CLI_JS);
  const old = '@"%~dp0\\node.exe"  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
  assert.equal(windowsShimTarget(shim, () => old), CLI_JS, "npm 6's shim names node.exe first, then the script");
  const exe = '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*';
  assert.equal(windowsShimTarget(shim, () => exe), `${APPDATA}\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`);
  assert.equal(windowsShimTarget(shim, () => "@echo off\r\nbash -c claude %*"), null, "a .cmd of some other shape");
  assert.equal(windowsShimTarget(shim, () => '"%dp0%\\evil.bat" %*'), null, "never another script to run through a shell");
  assert.equal(windowsShimTarget(shim, files({}).read), null, "a file that cannot be read");
});

test("windows: claude is searched on the PATH (claude.exe first, a .cmd turned into its .js), then the installers' folders", () => {
  const nodeDir = "C:\\Program Files\\nodejs";
  const npmDir = `${APPDATA}\\npm`;
  const f = files({ [`${npmDir}\\claude.cmd`]: NPM_SHIM, [CLI_JS]: "" });
  // Windows names it "Path"; a folder may be quoted in it, and the list may end in a ;
  const env = { Path: `${nodeDir};"${npmDir}";`, APPDATA };
  assert.deepEqual(claudeCandidates({ given: "", home: HOME, env, platform: "win32", ...f }), [CLI_JS]);

  const native = `${HOME}\\.local\\bin\\claude.exe`;
  const both = files({ [native]: "", [`${npmDir}\\claude.cmd`]: NPM_SHIM, [CLI_JS]: "" });
  assert.deepEqual(
    claudeCandidates({ given: "", home: HOME, env: { PATH: `${HOME}\\.local\\bin;${npmDir}`, APPDATA }, platform: "win32", ...both }),
    [native, CLI_JS],
    "the PATH's order: the native installer's claude.exe, then npm's",
  );
  assert.deepEqual(
    claudeCandidates({ given: "", home: HOME, env: { PATH: nodeDir, APPDATA }, platform: "win32", ...both }),
    [native, CLI_JS],
    "not on the PATH: the native installer's folder, then npm's, without a duplicate",
  );
  assert.deepEqual(claudeCandidates({ given: "", home: HOME, env: { PATH: nodeDir }, platform: "win32", ...files({}) }), [], "none at all");
  const shim = files({ [`${npmDir}\\claude.cmd`]: NPM_SHIM });
  assert.deepEqual(claudeCandidates({ given: "", home: HOME, env: { PATH: npmDir }, platform: "win32", ...shim }), [], "a shim whose script is gone");

  assert.deepEqual(claudeCandidates({ given: `${npmDir}\\claude.cmd`, home: HOME, env: {}, platform: "win32", ...f }), [CLI_JS], "CLAUDE_BIN=...claude.cmd");
  assert.deepEqual(claudeCandidates({ given: "D:\\tools\\claude.exe", home: HOME, env: {}, platform: "win32", ...f }), ["D:\\tools\\claude.exe"]);
});

test("windows: macOS and Linux look for claude exactly as before", () => {
  const f = files({ "/Users/ana/.local/bin/claude": "" });
  assert.deepEqual(claudeCandidates({ given: "", home: "/Users/ana", env: { PATH: "/usr/bin" }, platform: "darwin", ...f }), ["claude", "/Users/ana/.local/bin/claude"]);
  assert.deepEqual(claudeCandidates({ given: "/opt/claude", home: "/Users/ana", env: {}, platform: "linux", ...f }), ["/opt/claude"]);
});

test("windows: a .js claude runs with this Node there; everything else, and every other system, runs the command as it is", () => {
  assert.deepEqual(claudeCommand(CLI_JS, ["-p"], "win32"), [process.execPath, [CLI_JS, "-p"]]);
  assert.deepEqual(claudeCommand("C:\\x\\claude.exe", ["-p"], "win32"), ["C:\\x\\claude.exe", ["-p"]]);
  assert.deepEqual(claudeCommand("/opt/claude.js", ["-p"], "darwin"), ["/opt/claude.js", ["-p"]]);
  assert.deepEqual(claudeCommand("claude", ["--version"], "linux"), ["claude", ["--version"]]);
});

test("windows: the bridge is started with the claude.cmd's script as CLAUDE_BIN", async () => {
  const npmDir = `${APPDATA}\\npm`;
  const f = files({ [`${npmDir}\\claude.cmd`]: NPM_SHIM, [CLI_JS]: "" });
  const checked: string[] = [];
  let bin = "";
  const fakeSpawn = ((_cmd: string, _args: string[], o: { env: NodeJS.ProcessEnv }) => {
    bin = o.env.CLAUDE_BIN ?? "";
    return Object.assign(new EventEmitter(), { kill: () => true });
  }) as unknown as typeof import("node:child_process").spawn;
  const logs: string[] = [];
  const b = superviseBridge({
    env: { PATH: npmDir, APPDATA }, home: HOME, platform: "win32", ...f, spawn: fakeSpawn, log: (s) => logs.push(s),
    installed: async (p) => (checked.push(p), true),
  });
  for (let i = 0; i < 100 && !bin; i++) await new Promise((r) => setTimeout(r, 5));
  b.stop();
  assert.deepEqual(checked, [CLI_JS], "the script is what answers --version (with this Node)");
  assert.equal(bin, CLI_JS);
  assert.equal(b.status().claude, "ok");
  assert.deepEqual(logs, [`using ${CLI_JS}`]);

  const none: string[] = [];
  const m = superviseBridge({ env: { PATH: npmDir }, home: HOME, platform: "win32", ...files({}), spawn: fakeSpawn, log: (s) => none.push(s) });
  for (let i = 0; i < 100 && m.status().claude === "starting"; i++) await new Promise((r) => setTimeout(r, 5));
  m.stop();
  assert.equal(m.status().claude, "missing");
  assert.match(none.join("\n"), /claude command was not found/);
});

test("windows: the browser is opened without cmd, so an & in the address stays in it", () => {
  const url = "http://127.0.0.1:8787/panel/login/abc?x=1&y=2";
  assert.deepEqual(browserCommand(url, "win32"), ["rundll32", ["url.dll,FileProtocolHandler", url]]);
  assert.deepEqual(browserCommand(url, "darwin"), ["open", [url]]);
  assert.deepEqual(browserCommand(url, "linux"), ["xdg-open", [url]]);
});

test("windows: a rename that an antivirus holds for a moment is tried again there; elsewhere it fails at once", () => {
  let tries = 0;
  const busy = () => {
    if (++tries < 3) throw Object.assign(new Error("busy"), { code: "EPERM" });
  };
  renameRetry("a", "b", "win32", busy as never);
  assert.equal(tries, 3);
  tries = 0;
  assert.throws(() => renameRetry("a", "b", "darwin", busy as never), /busy/);
  assert.equal(tries, 1);
  tries = 0;
  const gone = () => {
    tries++;
    throw Object.assign(new Error("gone"), { code: "ENOENT" });
  };
  assert.throws(() => renameRetry("a", "b", "win32", gone as never), /gone/);
  assert.equal(tries, 1, "only the codes a passing lock gives are tried again");
});

// ---------- the sign-in task ----------

test("autostart: the task is the account's own; the launcher quotes paths with spaces and quotes; the XML escapes them", () => {
  assert.equal(taskName("PC-ANA\\Ana María"), "Pako-Ana_Mar_a");
  assert.equal(taskName("ana"), "Pako-ana");
  assert.equal(psQuote("C:\\Users\\O'Brien"), "'C:\\Users\\O''Brien'");

  const s = launcherScript({ node: "C:\\Program Files\\nodejs\\node.exe", repo: "C:\\Users\\O'Brien\\my pako", logs: "C:\\Users\\O'Brien\\.pako\\logs" });
  assert.match(s, /-FilePath 'C:\\Program Files\\nodejs\\node\.exe'/);
  assert.match(s, /-WorkingDirectory 'C:\\Users\\O''Brien\\my pako'/);
  assert.match(s, /'"C:\\Users\\O''Brien\\my pako\\src\\server\.ts"'/, "the script's path is quoted for Start-Process and for PowerShell");
  assert.match(s, /\$env:PAKO_NO_OPEN = '1'/, "no browser tab at each sign-in");
  assert.match(s, /-WindowStyle Hidden/);
  assert.match(s, /pako\.err\.log/);
  assert.match(s, /catch \{ exit 0 \}/, "a log held by a running Pako: nothing is started");
  assert.ok(s.includes("\r\n"), "Windows line ends");

  const x = taskXml({ account: "PC\\Ana & Co", script: "C:\\a b\\.pako\\autostart\\start-pako.ps1", repo: "C:\\a b\\pako", description: "<Pako>" });
  assert.match(x, /<LogonTrigger><Enabled>true<\/Enabled><UserId>PC\\Ana &amp; Co<\/UserId><\/LogonTrigger>/, "this account's sign-in only");
  assert.match(x, /<LogonType>InteractiveToken<\/LogonType><RunLevel>LeastPrivilege<\/RunLevel>/, "no administrator, no stored password");
  assert.match(x, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/, "never stopped after 72 hours");
  assert.match(x, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/, "a laptop on battery starts it too");
  assert.match(x, /<Command>%SystemRoot%\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe<\/Command>/);
  assert.match(x, /<Arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File &quot;C:\\a b\\\.pako\\autostart\\start-pako\.ps1&quot;<\/Arguments>/);
  assert.match(x, /<Description>&lt;Pako&gt;<\/Description>/);

  assert.deepEqual(schtasks.create("Pako-ana", "C:\\a b\\task.xml"), ["/Create", "/TN", "Pako-ana", "/XML", "C:\\a b\\task.xml", "/F"]);
  assert.deepEqual(schtasks.query("Pako-ana"), ["/Query", "/TN", "Pako-ana"]);
  assert.deepEqual(schtasks.remove("Pako-ana"), ["/Delete", "/TN", "Pako-ana", "/F"]);
  assert.deepEqual(schtasks.run("Pako-ana"), ["/Run", "/TN", "Pako-ana"]);
});

function fake(over: Partial<WindowsDeps> = {}, answers: Record<string, { code: number; out: string }> = {}) {
  const calls: string[] = [];
  const written = new Map<string, Buffer>();
  const removed: string[] = [];
  const deps: Partial<WindowsDeps> = {
    platform: "win32",
    pakoDir: `${HOME}\\.pako`,
    repo: `${HOME}\\pako`,
    node: "C:\\Program Files\\nodejs\\node.exe",
    account: "PC\\Ana María",
    lang: "en",
    run: async (cmd, args) => {
      calls.push(`${cmd} ${args.join(" | ")}`);
      return answers[args[0]!] ?? { code: 0, out: "SUCCESS" };
    },
    writeFile: (p, data) => void written.set(p, data),
    mkdir: (p) => void calls.push(`mkdir ${p}`),
    remove: (p) => void removed.push(p),
    ...over,
  };
  return { a: createWindowsAutostart(deps, {}), calls, written, removed };
}

test("autostart: enable writes the launcher (UTF-8 BOM) and the task (UTF-16 BOM), registers it, and removes the XML", async () => {
  const f = fake();
  const s = await f.a.enable();
  assert.deepEqual(s, { supported: true, enabled: true, detail: `Done: Pako will start by itself each time you sign in to Windows. What it writes goes to ${HOME}\\.pako\\logs.` });
  const xml = `${HOME}\\.pako\\autostart\\task.xml`;
  assert.deepEqual(f.calls, [`mkdir ${HOME}\\.pako\\autostart`, `mkdir ${HOME}\\.pako\\logs`, `schtasks.exe /Create | /TN | Pako-Ana_Mar_a | /XML | ${xml} | /F`]);
  const ps1 = f.written.get(`${HOME}\\.pako\\autostart\\start-pako.ps1`)!;
  assert.deepEqual([...ps1.subarray(0, 3)], [0xef, 0xbb, 0xbf], "PowerShell 5.1 reads María right only with the BOM");
  assert.ok(ps1.toString("utf8").includes("Ana María\\pako\\src\\server.ts"));
  const task = f.written.get(xml)!;
  assert.deepEqual([...task.subarray(0, 2)], [0xff, 0xfe]);
  assert.match(task.toString("utf16le"), /<UserId>PC\\Ana María<\/UserId>/);
  assert.deepEqual(f.removed, [xml]);
});

test("autostart: the hidden Pako is marked as started by the task, and keeps the installer's PAKO_HOME, PORT and the other carried settings", async () => {
  // Without PAKO_SERVICE the hidden Pako printed a live sign-in link into pako.log; without PAKO_HOME it used ~/.pako while its logs (and
  // install.ps1's wait for its lock) were in the folder PAKO_HOME named.
  const written = new Map<string, Buffer>();
  const a = createWindowsAutostart({
    platform: "win32", pakoDir: "D:\\pako data", repo: `${HOME}\\pako`, node: "C:\\node.exe", account: "PC\\ana", lang: "en",
    run: async () => ({ code: 0, out: "SUCCESS" }), writeFile: (p, d) => void written.set(p, d), mkdir: () => {}, remove: () => {},
  }, { PAKO_HOME: "D:\\pako data", PORT: "9000", CLAUDE_BIN: "C:\\tools\\claude.exe", PAKO_HOST: " ", UNRELATED: "x" });
  await a.enable();
  const ps1 = written.get("D:\\pako data\\autostart\\start-pako.ps1")!.toString("utf8");
  assert.match(ps1, /\$env:PAKO_SERVICE = '1'/, "no sign-in link printed into the log file");
  assert.match(ps1, /\$env:PAKO_HOME = 'D:\\pako data'/);
  assert.match(ps1, /\$env:PORT = '9000'/);
  assert.match(ps1, /\$env:CLAUDE_BIN = 'C:\\tools\\claude\.exe'/);
  assert.doesNotMatch(ps1, /PAKO_HOST|UNRELATED/, "an empty value is not carried, nor a setting Pako does not carry");
  assert.ok(ps1.indexOf("PAKO_SERVICE") < ps1.indexOf("Start-Process"), "set before Node starts");
});

test("autostart: a refusal says Windows's own words; status and disable follow the task; nothing happens off Windows", async () => {
  const no = fake({}, { "/Create": { code: 1, out: "ERROR: Access is denied.\r\n" } });
  const s = await no.a.enable();
  assert.equal(s.enabled, false);
  assert.match(s.detail, /\(Access is denied\.\)/);
  assert.deepEqual(no.removed, [`${HOME}\\.pako\\autostart\\task.xml`], "the XML is removed either way");

  const off = fake({}, { "/Query": { code: 1, out: "ERROR: The system cannot find the file specified." } });
  assert.equal((await off.a.status()).enabled, false);
  const d = await off.a.disable();
  assert.equal(d.enabled, false);
  assert.ok(!off.calls.some((c) => c.includes("/Delete")), "nothing to remove");

  const on = fake();
  assert.equal((await on.a.status()).enabled, true);
  assert.equal((await on.a.disable()).enabled, false);
  assert.deepEqual(on.calls.slice(-2), ["schtasks.exe /Query | /TN | Pako-Ana_Mar_a", "schtasks.exe /Delete | /TN | Pako-Ana_Mar_a | /F"]);
  assert.deepEqual(on.removed, [`${HOME}\\.pako\\autostart\\start-pako.ps1`]);

  const mac = fake({ platform: "darwin" });
  for (const s2 of [await mac.a.status(), await mac.a.enable(), await mac.a.disable()]) assert.equal(s2.supported, false);
  assert.deepEqual(mac.calls, [], "schtasks is never run elsewhere");
});

test("autostart: the command line's exit codes, and its words in English", async () => {
  const out: string[] = [];
  const print = (s: string) => void out.push(s);
  assert.equal(await cli(["enable"], fake().a, print, "en"), 0);
  assert.equal(await cli(["start"], fake().a, print, "en"), 0);
  assert.equal(await cli(["start"], fake({}, { "/Run": { code: 1, out: "ERROR: x" } }).a, print, "en"), 1);
  assert.equal(await cli(["disable"], fake().a, print, "en"), 0);
  assert.equal(await cli(["status"], fake({}, { "/Query": { code: 1, out: "" } }).a, print, "en"), 1);
  assert.equal(await cli(["oops"], fake().a, print, "en"), 2);
  assert.match(out.at(-1)!, /^Usage: node src\/autostart-windows\.ts/);
  const en = fake();
  assert.equal(await cli(["enable"], en.a, print, "en"), 0);
  assert.doesNotMatch(out.join(" "), /Hecho|arrancará|[¿¡]/, "no Spanish");
  assert.doesNotMatch(en.written.get(`${HOME}\\.pako\\autostart\\task.xml`)!.toString("utf16le"), /<Description>Arranca Pako/);
});

// ---------- install.ps1 ----------

test("install.ps1: ASCII only, all inside a function, the promised steps, and no way to close the person's window", () => {
  const s = readFileSync(new URL("../install.ps1", import.meta.url), "utf8");
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(s), "PowerShell 5.1 reads a script without a BOM in the ANSI code page");
  assert.ok(!/^\s*exit\b/m.test(s), "through iex, exit would close the window: return instead");
  assert.match(s, /^function Install-Pako \{$/m);
  assert.match(s, /^Install-Pako\s*$/m);
  for (const step of [
    "winget install --id OpenJS.NodeJS.LTS -e", "winget install --id Git.Git -e", "($major -eq 22 -and $minor -ge 18)", "git clone --depth 1",
    "pull --ff-only", "ci --omit=dev --ignore-scripts", "'npm.cmd'", "irm https://claude.ai/install.ps1 | iex", "$autostart enable", "$autostart start",
    "bin\\panel.cjs", "$env:PAKO_AUTOSTART", "$env:PAKO_DIR", "$env:PAKO_REPO", "Join-Path $HOME 'pako'",
  ]) assert.ok(s.includes(step), step);
  // English only, like all of Pako's own words, whatever language Windows is in: one sentence per Say, no Spanish left, no language switch.
  const str = `('(?:''|[^'])*'|"(?:\`.|[^"\`])*")`; // PowerShell's strings: '' and a backtick escape inside them
  const says = [...s.matchAll(new RegExp(`\\bSay ${str}[ \\t]*${str}?`, "g"))];
  assert.ok(says.length > 15);
  for (const m of says) assert.ok(!m[2], `one English sentence only: ${m[0]}`);
  assert.doesNotMatch(s, /Get-UICulture|\$spanish|\^[aeioun?!]\w|Instalando|Descargando|necesita|\[S\/n\]/, "no Spanish left");
});


/** A file of the repository, as text. */
const repoText = (p: string): string => readRepoFile(new URL(`../${p}`, import.meta.url), "utf8");

// A bare `npm` in PowerShell runs npm.ps1, which Windows's default policy refuses: what these files tell a person to type says npm.cmd
// there (as #180 did for src/autostart-windows.ts and install.ps1), and npm on a Mac or Linux.
test("no message tells a Windows user to type a bare npm: npm.cmd there, npm elsewhere", async () => {
  const bareNpm = /(^|[\s`'"(;])npm (run|start|install)\b/;
  for (const f of ["bin/panel.cjs", "bin/preflight.cjs", "src/autostart.ts", "src/guard-http.ts"]) {
    const said = repoText(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && /["`]/.test(l) && bareNpm.test(l));
    assert.deepEqual(said, [], f);
  }
  const { npmCommand } = (await import("../src/i18n.ts")) as { npmCommand?: (p?: string) => string };
  assert.equal(npmCommand?.("win32"), "npm.cmd");
  assert.equal(npmCommand?.("darwin"), "npm");
  assert.equal(npmCommand?.("linux"), "npm");
  const { createRequire } = await import("node:module");
  const pre = createRequire(import.meta.url)("../bin/preflight.cjs") as { message: (f: object, platform?: string) => string };
  assert.match(pre.message({ problem: "install", missing: ["x"], all: true }, "win32"), /npm\.cmd install, then npm\.cmd start/);
  assert.match(pre.message({ problem: "install", missing: ["x"], all: true }, "darwin"), /run npm install, then npm start/);
});
