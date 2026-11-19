// Entry point: reads the settings, builds the app (src/app.ts) and listens. `npm start` runs this file.
//
// Two ways to run, decided by one thing: whether WhatsApp is set up (WHATSAPP_ACCESS_TOKEN).
//   - Not set (the default, and the way to try Pako): local mode (src/local.ts). Listens on this computer only, opens the control panel in the browser
//     with the chat inside it, and runs the assistant with the `claude` command already signed in here. No key of any kind.
//   - Set: the hosted way (docs/server.md, "Run it on a server"): WhatsApp is the chat, the phone line and the other connections work as configured.

import { spawn } from "node:child_process";
import { utimesSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createApp, loadAppConfig, STAND_IN_NAME, type LocalContext } from "./app.ts";
import { lastingExitCode, runAutostartCli } from "./autostart.ts";
import { appliedAtStart, applyStoredSettings } from "./connections.ts";
import { createSettings, createLocalChannel, isLocalMode, loadEnvFiles, loadHome, localEnv, lockHome, openBrowser, pakoHome, superviseBridge } from "./local.ts";
import { unreadableNotice } from "./secrets.ts";
import { sqliteKv } from "./sqlite-kv.ts";
import { createLog } from "./log.ts";

const logPako = createLog("pako");

const isEntryPoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

type Env = Record<string, string | undefined>;

export interface RestartDeps {
  /** The environment as this process got it, before the files and the panel's values were added: the new start reads those again itself. */
  env: Env;
  execPath: string;
  execArgv: string[];
  argv: string[];
  platform: NodeJS.Platform;
  /** Whether a parent talks to this process over an IPC channel (a supervisor such as pm2 in fork mode). */
  ipc: boolean;
  /** Node's process.execve (22.15 and later, not on Windows): this process becomes the new one, with the same id and the same terminal. */
  execve?: (file: string, args: string[], env: Record<string, string>) => void;
  spawn: (cmd: string, args: string[], o: { stdio: "inherit"; env: Env }) => { once(ev: "spawn" | "error", f: (err?: Error) => void): unknown };
  exit: (code: number) => void;
  /** Runs what a normal exit runs (the store's last write, the lock, the bridge): execve skips the exit handlers. */
  beforeExec: () => void;
  log?: (s: string) => void;
}

/**
 * Starts this same command again once the server has stopped (src/connections-panel.ts asks for it after a change of settings), so every
 * module reads its settings anew. How depends on what started Pako:
 *   - a parent that talks to it (pm2 and the like): it exits with code 75 and that parent starts it again (a second Pako of ours would clash);
 *   - otherwise, where Node can (macOS, Linux): execve. The same process id, so a supervisor (launchd, systemd) notices nothing, and the same
 *     place in the terminal, so Ctrl+C still stops it (a new process left behind by one that ended is no longer what the terminal runs);
 *   - otherwise (Windows): a new process on the same terminal, and this one ends.
 * `node --watch` (npm run dev) is not handled here: its watcher restarts Pako when its file changes (restart in main).
 */
export function restartInPlace(o: RestartDeps): "parent" | "exec" | "spawn" {
  const log = o.log ?? ((s: string) => console.log(s));
  // The browser is already on the panel, which reloads by itself: a new tab at each restart would be one too many.
  const env: Record<string, string> = { PAKO_NO_OPEN: "1" };
  for (const [k, v] of Object.entries(o.env)) if (v !== undefined && k !== "PAKO_NO_OPEN") env[k] = v;
  const args = [...o.execArgv, ...o.argv.slice(1)];
  if (o.ipc) {
    log("\n  Restarting Pako to apply the new settings (what started it starts it again).\n");
    o.exit(75);
    return "parent";
  }
  log("\n  Restarting Pako to apply the new settings...\n");
  if (o.execve && o.platform !== "win32") {
    o.beforeExec();
    try {
      o.execve(o.execPath, [o.execPath, ...args], env);
      return "exec";
    } catch (err) {
      logPako.error(`could not restart in place (${(err as NodeJS.ErrnoException).code ?? "error"}): starting a new process instead`);
    }
  }
  // On Windows this process is still alive while the new one starts: its lock (src/local.ts, lockHome) is given back first, or the new one
  // could find it held by a running Pako and stop. (Where execve was tried, this already ran.)
  if (o.platform === "win32") o.beforeExec();
  const child = o.spawn(o.execPath, args, { stdio: "inherit", env });
  child.once("spawn", () => o.exit(0));
  child.once("error", (err) => {
    logPako.error(`could not start again (${(err as NodeJS.ErrnoException | undefined)?.code ?? "error"}): start Pako again by hand`);
    o.exit(1);
  });
  return "spawn";
}

async function main(): Promise<void> {
  // As this process got it: a restart (restartInPlace) starts from here again, so a value removed from a file or from the panel goes away.
  const startEnv: Env = { ...process.env };
  // Settings written in ~/.pako/.env or ./.env are read first: a setting already in the shell wins.
  loadEnvFiles(pakoHome(process.env));
  let local: LocalContext | undefined;
  let bridge: ReturnType<typeof superviseBridge> | undefined;
  const localMode = isLocalMode(process.env);
  if (localMode) {
    // The connections set in the panel (src/connections.ts), before anything reads the settings: the shell's and the files' values win.
    applyStoredSettings(pakoHome(process.env), process.env);
    const port = Number(process.env.PORT) || 8787;
    let home;
    try {
      home = loadHome(process.env);
      // The port goes in the lock too: `npm run panel` (bin/panel.cjs), run from another terminal, finds this server by it.
      lockHome(home.dir, port, undefined, process.env.PAKO_SERVICE === "1");
    } catch (err) {
      console.error(`\n  ${(err as Error).message}\n`);
      // Started by launchd or systemd, a code they do not start it again for: another Pako holds the folder (src/autostart.ts).
      process.exit(lastingExitCode(process.env));
    }
    // No question in this terminal: the panel's welcome asks for the name, and it applies at once (src/app.ts). PAKO_NAME
    // still wins. The phone line's settings need a name from the start: until one is given, a stand-in.
    const settings = createSettings(home.dir, process.env, home.firstRun === true);
    home.name = settings.name() || STAND_IN_NAME;
    Object.assign(process.env, localEnv(process.env, home, port));
    const kv = sqliteKv(home.dir);
    local = {
      kv,
      channel: createLocalChannel({ kv }),
      bridgeToken: home.bridgeToken,
      panelSecret: home.panelSecret,
      bridge: {
        status: () => bridge?.status() ?? { claude: "starting", running: false },
        report: (claude) => bridge?.report(claude),
        refresh: async () => (bridge ? bridge.refresh() : { claude: "starting", running: false }),
      },
      storeStart: { firstRun: home.firstRun === true, lost: kv.lost },
      settings,
    };
    // The secrets are in the system's store and it did not give them (src/local.ts loadHome): this start runs on temporary ones. The owner
    // reads why in the chat (the Mac app shows it as a notice), not only in a log nobody opens.
    if (home.secretsProblem && home.secretsAt && home.secretsAt !== "file") {
      void local.channel.push("pako", unreadableNotice("en", home.secretsAt, home.secretsProblem), undefined, undefined, false, true);
    }
  }

  const config = loadAppConfig();
  if (localMode && !config.personalCaller) {
    // The settings the person put in ~/.pako/.env are wrong (the line above says which): saying "Pako is running" would be a lie, and nothing would answer.
    console.error("\n  Pako cannot start: a setting in ~/.pako/.env or ./.env is wrong (see the line above). Fix it, or remove that line, and start again.\n");
    process.exit(lastingExitCode(process.env));
  }
  const app = createApp(config, process.env, local);
  // Local mode answers this computer only: nothing on the network can reach the panel or the chat.
  const host = localMode ? (process.env.PAKO_HOST ?? "").trim() || "127.0.0.1" : undefined;
  const telegram = app.locals.telegram as { start(): void; stop(): void } | undefined;
  // Slack's Socket Mode (src/slack-socket.ts, SLACK_APP_TOKEN): its connection is opened once the server listens and closed on shutdown.
  const slackSocket = app.locals.slackSocket as { start(): void; stop(): void } | undefined;
  const storeGuard = app.locals.storeGuard as { start(): void; stop(): void } | undefined;
  const watchdog = app.locals.watchdog as { start(): void; stop(): void } | undefined;
  // The owner's WhatsApp set up in the panel (src/whatsapp-computer.ts): its tunnel comes back with Pako, and goes with it.
  const whatsappComputer = app.locals.whatsappComputer as { start(): void; stop(): void } | undefined;
  const onListening = (err?: Error): void => {
    if (err) return; // Express 5 calls this with the error when listening fails: the error handler below tells the person, and nothing is started
    // First, before any request is handled: until the store guard has looked at the store, the pause counts as on (src/store-guard.ts).
    storeGuard?.start();
    telegram?.start();
    watchdog?.start();
    slackSocket?.start();
    whatsappComputer?.start();
    if (!localMode) {
      console.log(`assistant listening on port ${config.port}`);
      console.log(`  Phone line: ${config.personalCaller ? (config.personalCaller.live ? "live" : "dry run") : "off (PERSONAL_CALLER_TOKEN unset or a setting is wrong)"}`);
      if (!config.adminKey) console.log("  Note: ADMIN_KEY is not set, so the /admin routes are closed.");
      return;
    }
    bridge = superviseBridge({ env: process.env, fromPanel: (k) => appliedAtStart().has(k) });
    const open = process.env.PAKO_NO_OPEN !== "1";
    // A sign-in link is a live key to the panel for 10 minutes. Nobody reads it when the Mac app started this Pako (PAKO_APP_PID: the app
    // asks for its own link, and this output goes to app.log, which people attach to bug reports) or launchd or systemd did (PAKO_SERVICE:
    // a log file): then none is made at all.
    if (!printsLink(process.env)) {
      console.log("\n  Pako is running for you on this computer. Open its panel from the Pako app, or with `npm run panel` in its folder.\n");
    } else {
      const link = (app.locals.panelLink as (() => string) | undefined)?.() ?? `http://127.0.0.1:${config.port}/panel`;
      console.log(
        `\n  Pako is running for you on this computer.\n\n    ${link}\n\n  (${open ? "opening your browser; " : ""}that link works once, for 10 minutes: `
        + "`npm run panel` in this folder gives a new one. Ctrl+C stops Pako.)\n",
      );
      if (open) openBrowser(link);
    }
    // Started by the Mac app (PAKO_APP_PID): when that app is gone without stopping it (Force Quit, a crash), this Pako stops too, as the
    // bridge does with its server. Left running, it could not be stopped from any window, and kept going after the app was deleted.
    // Not under launchd (PAKO_SERVICE), which is meant to outlive any app.
    watchParent(process.env, () => shutdown("The end of the Pako app (PAKO_APP_PID)"));
  };
  const server = host ? app.listen(config.port, host, onListening) : app.listen(config.port, onListening);
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `\n  Port ${config.port} is already in use. If Pako is already running, open its panel instead with: npm run panel `
        + `(a second one would clash on the same folder); otherwise use another port: PORT=${config.port + 1} npm start\n`,
      );
    }
    else console.error(err);
    process.exit(err.code === "EADDRINUSE" && localMode ? lastingExitCode(process.env) : 1);
  });

  // Render sends SIGTERM before replacing an instance: stop taking requests, let in-flight ones finish (bounded).
  let stopping = false;
  /** Ctrl+C (or SIGTERM) while the panel's restart is under way: the person's stop wins, Pako does not come back. */
  let stopWanted = false;
  /** `restart`: what to do once stopped, instead of exiting (the panel's restart); it runs even if stopping takes too long. */
  const shutdown = (signal: string, restart?: () => void) => {
    if (stopping) {
      if (!restart) stopWanted = true;
      return;
    }
    stopping = true;
    console.log(restart ? "Restarting: shutting down first." : `${signal} received: shutting down.`);
    bridge?.stop();
    telegram?.stop();
    slackSocket?.stop();
    whatsappComputer?.stop();
    storeGuard?.stop();
    watchdog?.stop();
    let done = false;
    const end = (code: number): void => {
      if (done) return;
      done = true;
      if (restart && !stopWanted) restart();
      else process.exit(code);
    };
    const force = setTimeout(() => {
      console.error("Shutdown took too long; exiting.");
      end(1);
    }, 10_000);
    // A restart must happen even when nothing else keeps the process up; a plain stop lets the process end by itself if it can.
    if (!restart) force.unref();
    server.close(() => end(0));
    server.closeIdleConnections();
    // The assistant's long wait for a message (up to 25 s) is a connection in use: given a moment to end by itself, then closed, so Ctrl+C is quick.
    setTimeout(() => server.closeAllConnections(), localMode ? 1000 : 8000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  // Windows never sends SIGTERM. Closing the console window is SIGHUP (Windows ends the process a few seconds later) and Ctrl+Break is
  // SIGBREAK: both stop Pako the same way, so the store's last write and the lock are not lost.
  if (process.platform === "win32") for (const signal of ["SIGHUP", "SIGBREAK"] as const) process.on(signal, () => shutdown(signal));
  if (localMode) {
    // After a change of connections in the panel (src/connections-panel.ts): the same command again, so every module reads its settings anew.
    const entry = process.argv[1]!;
    /** False when it cannot restart (the panel then says the change applies at the next start, and takes changes again). */
    app.locals.restart = (): boolean => {
      if (stopping) return true;
      // npm run dev: `node --watch` starts Pako again when its file changes, and first stops this one with SIGTERM (the shutdown above). Its
      // file is only touched: its contents stay as they are.
      if (process.env.WATCH_REPORT_DEPENDENCIES === "1") {
        try {
          const now = new Date();
          utimesSync(entry, now, now);
          return true;
        } catch (err) {
          logPako.error(`could not ask node --watch to restart (${(err as NodeJS.ErrnoException).code ?? "error"}): stop Pako and start it again`);
          return false;
        }
      }
      const execve = (process as unknown as { execve?: RestartDeps["execve"] }).execve;
      shutdown("restart", () =>
        restartInPlace({
          env: startEnv,
          execPath: process.execPath,
          execArgv: process.execArgv,
          argv: process.argv,
          platform: process.platform,
          ipc: typeof process.send === "function",
          ...(execve ? { execve: execve.bind(process) } : {}),
          spawn: (cmd, args, o) => spawn(cmd, args, o as Parameters<typeof spawn>[2]),
          exit: (code) => process.exit(code),
          beforeExec: () => void process.emit("exit", 0),
        }));
      return true;
    };
  }
  process.on("unhandledRejection", (reason) => logPako.error("Unhandled promise rejection:", reason));
}

/** Whether a sign-in link is made and printed at start: not when the Mac app or launchd/systemd started Pako (its output goes to a file). */
export function printsLink(env: Env): boolean {
  return !(env.PAKO_APP_PID ?? "").trim() && env.PAKO_SERVICE !== "1";
}

/**
 * Calls `gone` once the process named by PAKO_APP_PID has ended (checked every two seconds). Nothing when it is not set, is this process or
 * its own parent's number is 1 already (nothing to follow), or when PAKO_SERVICE=1 (launchd or systemd own it). Returns a stop function.
 */
export function watchParent(env: Env, gone: () => void, o: { every?: number; alive?: (pid: number) => boolean } = {}): () => void {
  const pid = Number(env.PAKO_APP_PID);
  if (env.PAKO_SERVICE === "1" || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) return () => {};
  const alive = o.alive ?? ((p: number) => {
    try {
      process.kill(p, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  });
  const timer = setInterval(() => {
    if (alive(pid)) return;
    clearInterval(timer);
    gone();
  }, o.every ?? 2000);
  timer.unref();
  return () => clearInterval(timer);
}

// `--autostart on|off|status` (src/autostart.ts) sets up how Pako starts by itself, and ends: it starts no server of its own.
const autostartAt = process.argv.indexOf("--autostart");
if (isEntryPoint && autostartAt >= 2) process.exitCode = await runAutostartCli(process.argv[autostartAt + 1]);
else if (isEntryPoint) await main();
