// Local mode: Pako on your own computer with no key of any kind.
//
// Without WhatsApp's settings the server runs for one person on this machine: the chat is a window in the control panel, the assistant is the
// `claude` command already logged in on this computer (the bridge, started and kept alive here), and what Pako keeps (notes, reminders, the chat)
// is a file in ~/.pako. WhatsApp, mail, calendar, Slack, tables and the phone are added later, one by one, by putting their settings in
// ~/.pako/.env (see docs/configuration.md): nothing about them is needed to start.
//
// The same door as WhatsApp serves both (src/whatsapp.ts): in local mode what it would send to Meta goes to the chat window instead (the
// LocalChannel below), and what you type there arrives as a message from you. Nothing here opens a port other than the server's own.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, uptime } from "node:os";
import { join, resolve as absolute, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv, claudeCommand, type ClaudeHealth } from "../assistant/bridge.ts";
import type { Kv } from "./kv.ts";
import type { StoreKind } from "./secret-store.ts";
import { readSecrets, renameRetry, SECRETS_FILE, secretsProblem, secretsWhere, settleSecrets, writeSecrets } from "./secrets.ts";
import type { StoreLost } from "./store-guard.ts";
import { createLog } from "./log.ts";

const logPako = createLog("pako");
const logBridge = createLog("bridge");

type Env = Record<string, string | undefined>;

/** A number that cannot ring anyone (fictional NANP range 555-01xx): the owner's number in local mode, where no call is ever placed. */
export const LOCAL_OWNER_NUMBER = "+15555550100";

/** Settings that only a hosting platform sets: a server meant to be reached from outside, never a person's own computer. */
const HOSTED_BY = ["RENDER", "RAILWAY_ENVIRONMENT", "FLY_APP_NAME", "K_SERVICE", "DYNO", "WEBSITE_SITE_NAME", "VERCEL", "KOYEB_APP_NAME"];

/**
 * Local mode is the default for someone who has set nothing up. It is off when WhatsApp is set up (that is a server, reached by Meta), on a hosting
 * platform (Render and the like), or with PAKO_LOCAL=0; PAKO_LOCAL=1 forces it on. The phone line's settings alone do not leave it: the phone line
 * works from a computer too (its connector is then reachable from this computer only).
 */
export function isLocalMode(env: Env): boolean {
  const forced = (env.PAKO_LOCAL ?? "").trim();
  if (forced === "0") return false;
  if (forced === "1") return true;
  return !(env.WHATSAPP_ACCESS_TOKEN ?? "").trim() && !HOSTED_BY.some((k) => (env[k] ?? "").trim());
}

export function pakoHome(env: Env): string {
  return (env.PAKO_HOME ?? "").trim() || join(homedir(), ".pako");
}

const token = (): string => randomBytes(24).toString("hex");

export interface LocalHome {
  dir: string;
  bridgeToken: string;
  callerToken: string;
  panelSecret: string;
  name: string;
  /** Set by loadHome: there was no secrets.json before this start, so this is the person's first run (src/store-guard.ts never pauses then). */
  firstRun?: boolean;
  /** Where the secrets are kept after this start (src/secrets.ts): secrets.json, or the system's store. */
  secretsAt?: "file" | StoreKind;
  /**
   * Set when the secrets are in the system's store and it does not give them (a keychain still locked, a folder copied from another
   * computer): this start runs on tokens of its own that are written nowhere, so nothing kept is overwritten, and the owner is told why.
   */
  secretsProblem?: string;
}

function readJson(path: string): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// renameRetry lives beside the secrets' own writes (src/secrets.ts), which need it without the rest of this file.
export { renameRetry };

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameRetry(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* a file system without modes: nothing to do */
  }
}

/** Takes group and other access away from a file or folder of this user that has any. Never the home folder itself, should PAKO_HOME name it. */
function keepPrivate(path: string, mode: number): void {
  try {
    if (absolute(path) === absolute(homedir())) return;
    const st = statSync(path);
    if ((st.mode & 0o077) !== 0 && st.uid === process.getuid?.()) chmodSync(path, mode);
  } catch {
    /* not there yet, or a file system without modes: nothing to do */
  }
}

/** The home folder with its secrets (made on first use, readable only by you) and the name Pako calls you by. Throws a sentence a person can act on. */
export function loadHome(env: Env): LocalHome {
  const dir = pakoHome(env);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new Error(`Pako cannot use ${dir} to keep your notes and settings (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). Pick another folder: PAKO_HOME=/some/folder npm start`);
  }
  // mkdir's mode applies only to a folder it makes: one made by hand before the first start (to write the .env in), or copied without its
  // modes, is made private here. It holds the secrets, the notes and the chat; its .env holds the keys of every connection.
  keepPrivate(dir, 0o700);
  keepPrivate(join(dir, ".env"), 0o600);
  const secretsPath = join(dir, SECRETS_FILE);
  keepPrivate(secretsPath, 0o600);
  const firstRun = !existsSync(secretsPath);
  const fresh = { bridgeToken: token(), callerToken: token(), panelSecret: token() };
  const config = readJson(join(dir, "config.json"));
  const name = String(env.PAKO_NAME ?? config.name ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  const read = readSecrets(dir);
  if (read === null && secretsWhere(dir) !== "file") {
    // The secrets are in the system's store and it does not give them. New ones written down would lose the real ones for good (the
    // Telegram bot, the connections, every browser's session): this start runs on its own, written nowhere, and the owner is told why.
    const why = secretsProblem(dir) ?? "the store did not answer";
    logPako.error(`could not read Pako's secrets from the ${secretsWhere(dir)} store (${why}): running on temporary ones until it can`);
    return { dir, ...fresh, name, firstRun: false, secretsAt: secretsWhere(dir), secretsProblem: why };
  }
  // A damaged file (not JSON) is made again, as it always was: the three secrets the server runs with are new then.
  const saved = read ?? {};
  const secrets = {
    bridgeToken: typeof saved.bridgeToken === "string" && saved.bridgeToken.length >= 32 ? saved.bridgeToken : fresh.bridgeToken,
    callerToken: typeof saved.callerToken === "string" && saved.callerToken.length >= 32 ? saved.callerToken : fresh.callerToken,
    panelSecret: typeof saved.panelSecret === "string" && saved.panelSecret.length >= 32 ? saved.panelSecret : fresh.panelSecret,
  };
  // What else the file keeps (the Telegram bot token set in the panel) stays when one of these three is made again.
  if (JSON.stringify(secrets) !== JSON.stringify({ bridgeToken: saved.bridgeToken, callerToken: saved.callerToken, panelSecret: saved.panelSecret })) {
    writeSecrets(dir, { ...saved, ...secrets });
  }
  // Into the system's store when there is one that works (or back into the file with PAKO_SECRET_STORE=file). A move that fails leaves
  // every secret where it was.
  const settled = settleSecrets(dir, env);
  if (settled.moved.length) {
    logPako.info(`${settled.moved.length} secrets moved ${settled.where === "file" ? `back into ${SECRETS_FILE}` : `into the ${settled.where} store`}`);
  }
  if (settled.problem) logPako.error(`secrets: ${settled.problem}; they stay ${settled.where === "file" ? `in ${SECRETS_FILE}` : `in the ${settled.where} store`}`);
  return { dir, ...secrets, name, firstRun, secretsAt: settled.where };
}

/** What Pako calls the person on a computer until they give a name (the panel's welcome asks). */
export const STAND_IN_NAME = "friend";

/**
 * What the person chose in the panel (src/dashboard.ts): the name Pako calls them by, and whether they have been through the
 * welcome. A `lang` field an older Pako wrote there (when the panel offered Spanish or English) is left alone and never read: Pako's own texts
 * are English only now. Kept in ~/.pako/config.json, read once and then from memory; PAKO_NAME still wins over the saved name.
 */
export interface LocalSettings {
  name: () => string;
  setName: (n: string) => void;
  welcomed: () => boolean;
  setWelcomed: () => void;
  /**
   * The Telegram bot token set in the panel (src/telegram-panel.ts), "" when there is none. A secret: kept in secrets.json beside the others
   * (mode 600), never in config.json, never printed. TELEGRAM_BOT_TOKEN, when it is set, wins over it (src/app.ts).
   */
  telegramToken?: () => string;
  /** Keeps a token the panel checked with Telegram; false when it could not be written (nothing is changed then). */
  setTelegramToken?: (token: string) => boolean;
  /**
   * The owner's WhatsApp set up in the panel (src/whatsapp-computer.ts): Meta's values and the tunnel's on/off, kept in secrets.json beside
   * the other secrets (mode 600), never printed; null when there are none. `setWhatsapp(null)` forgets them; false when it could not write.
   */
  whatsapp?: () => Record<string, unknown> | null;
  setWhatsapp?: (v: Record<string, unknown> | null) => boolean;
}

const cleanName = (v: unknown): string => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);

/** `_firstRun`: this home was made at this start (loadHome's firstRun); kept for the callers, nothing depends on it any more. */
export function createSettings(dir: string, env: Env, _firstRun = false): LocalSettings {
  const path = join(dir, "config.json");
  const secretsPath = join(dir, SECRETS_FILE);
  let c = readJson(path);
  /** The secrets as they are now (src/secrets.ts: the file or the system's store); null when they cannot be read (writing then would lose the others). */
  const secrets = (): Record<string, unknown> | null => readSecrets(dir);
  // Read again before writing: another start may have written meanwhile, and only the changed field is ours to set.
  const save = (patch: Record<string, unknown>): void => {
    c = { ...readJson(path), ...patch };
    try {
      writeJson(path, c);
    } catch (err) {
      logPako.error(`could not save ${path}: ${(err as Error).message}`);
    }
  };
  return {
    name: () => cleanName(env.PAKO_NAME) || cleanName(c.name),
    setName: (n) => save({ name: cleanName(n) }),
    welcomed: () => c.welcomed === true,
    setWelcomed: () => save({ welcomed: true }),
    telegramToken: () => {
      const v = secrets()?.telegramBotToken;
      return typeof v === "string" ? v.trim() : "";
    },
    setTelegramToken: (token) => {
      const now = secrets();
      if (!now) {
        logPako.error(`could not read ${secretsPath}: the Telegram bot token was not kept`);
        return false;
      }
      try {
        writeSecrets(dir, { ...now, telegramBotToken: token });
        return true;
      } catch (err) {
        // Only the error's code: its text names a file, and nothing about the token may reach the terminal.
        logPako.error(`could not save ${secretsPath} (${(err as NodeJS.ErrnoException).code ?? "error"}): the Telegram bot token was not kept`);
        return false;
      }
    },
    whatsapp: () => {
      const v = secrets()?.whatsappComputer;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    },
    setWhatsapp: (v) => {
      const now = secrets();
      if (!now) return false;
      try {
        const { whatsappComputer: _old, ...rest } = now;
        writeSecrets(dir, v ? { ...rest, whatsappComputer: v } : rest);
        return true;
      } catch (err) {
        logPako.error(`could not save ${secretsPath} (${(err as NodeJS.ErrnoException).code ?? "error"}): the WhatsApp settings were not kept`);
        return false;
      }
    },
  };
}

/** The settings the server needs to start for one person: yours win, these only fill what is missing. */
export function localEnv(env: Env, home: LocalHome, port: number): Env {
  // A setting left blank (`PERSONAL_OWNER_NAME=` in a file) is not a setting: it must not wipe what local mode fills in.
  const given = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  return {
    PAKO_LOCAL: "1",
    PERSONAL_CALLER_TOKEN: home.callerToken,
    PERSONAL_OWNER_NAME: home.name || STAND_IN_NAME,
    PERSONAL_OWNER_NUMBER: LOCAL_OWNER_NUMBER,
    ASSISTANT_STATE_DIR: join(home.dir, "assistant"),
    PERSONAL_TIMEZONE: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...given,
    // The pair that joins the bridge to this server is never taken from outside: a stray value would leave the chat saying "online" with a bridge that is refused for ever.
    ASSISTANT_BRIDGE_TOKEN: home.bridgeToken,
    ASSISTANT_SERVER_URL: `http://127.0.0.1:${port}`,
    // Never live in local mode unless the owner's real number is set too: the stand-in number must not be dialled.
    ...(given.PERSONAL_OWNER_NUMBER ? {} : { PERSONAL_LIVE: "" }),
  };
}

/**
 * The Pako that holds this home folder's lock now, or null: a lock whose process is gone, or from before the computer last restarted, holds
 * nothing. `service`: that Pako was started by launchd or systemd (src/autostart.ts), not by hand.
 */
export function lockHolder(
  dir: string, upSeconds: number = uptime(), startOf: (pid: number) => number | null = processStart,
): { pid: number; service: boolean } | null {
  let text: string;
  try {
    text = readFileSync(join(dir, ".lock"), "utf8");
  } catch {
    return null;
  }
  const [first, , up, mark, started] = text.split("\n");
  const pid = Number.parseInt(first ?? "", 10);
  // The computer has restarted since (it has been up for less time than it had then): that process number may now belong to another program,
  // which must not keep Pako from starting. Uptime, not the clock, which can be set back and forth.
  const restarted = /^\d+$/.test(up ?? "") && upSeconds < Number(up);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || restarted) return null;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return null;
  }
  // The process number is in use, but maybe by another program now (Pako was killed, or the Mac lost power, and the number came round
  // again): it holds the lock only if it started when the lock says. Unknown (an older lock, or no answer from ps): as before, it holds it.
  if (/^\d+$/.test(started ?? "")) {
    const actual = startOf(pid);
    if (actual !== null && Math.abs(actual - Number(started)) > 2) return null;
  }
  return { pid, service: mark === "service" };
}

/**
 * When process `pid` started, in whole seconds since 1970, as the system keeps it (`ps -o lstart=`; the Mac app reads the same with
 * proc_pidinfo): unchanged by an in-place restart (execve), unlike process.uptime(). null where it cannot be told (Windows, no ps).
 */
export function processStart(pid: number): number | null {
  if (process.platform === "win32") return null;
  try {
    // LC_ALL=C: the day and month in English, which Date.parse reads. TZ=UTC: a local time is ambiguous in the hour repeated when the clocks go
    // back, and Date.parse would pick the first one, an hour off what the kernel (and the Mac app, desktop/mac/Core.swift readLock) says.
    const env = { ...process.env, LC_ALL: "C", TZ: "UTC" };
    const r = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 3000, env });
    return r.status === 0 ? lstartSeconds(r.stdout ?? "") : null;
  } catch {
    return null;
  }
}

/** A `ps -o lstart=` line printed with TZ=UTC (processStart), in whole seconds since 1970, whatever this computer's zone; null if unreadable. */
export function lstartSeconds(text: string): number | null {
  const t = Date.parse(`${text.trim().replace(/\s+/g, " ")} UTC`);
  return text.trim() && Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/**
 * One Pako per home folder: two instances would each keep the whole file in memory and overwrite each other's notes, reminders and STOP. The lock is a
 * file with the process id, the port (so `npm run panel`, bin/panel.cjs, finds the running server whatever its terminal's settings say), how long
 * the computer had been up, and "service" when launchd or systemd started it (`service`). A lock left by a process that is gone, or from before
 * the computer last restarted, is taken over. Returns a function that gives it back.
 */
export function lockHome(dir: string, port?: number, upSeconds: number = uptime(), service = false): () => void {
  const path = join(dir, ".lock");
  // Its fifth line: when this process started (processStart), so that a lock whose number now belongs to another program is not trusted.
  // Worked out before the lock is looked at, so the look and the write follow each other at once.
  const started = port ? processStart(process.pid) : null;
  const lines = port
    ? `${process.pid}\n${port}\n${Math.floor(upSeconds)}\n${service ? "service" : ""}\n${started ?? ""}\n`
    : String(process.pid);
  const running = (pid: number): Error => new Error(
    `Pako is already running for this folder (process ${pid}). Open its panel with: npm run panel. Stop it with Ctrl+C in its terminal; `
    + `a second one would overwrite its notes. (If no Pako is running, delete ${path} and start again.)`,
  );
  const starting = (): Error =>
    new Error(`Pako is already starting for this folder (${path} appeared at the same moment). Open its panel with: npm run panel.`);
  // The file is created only if it is not there, whole at once (written aside, then linked in): two Pakos starting at the same moment cannot
  // both make it, and neither ever reads it half written. Only a lock found again to hold nothing (left behind) is removed, never the one
  // another start has just made (removing first, whatever was there, let both run).
  const take = (): boolean => {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, lines, { mode: 0o600 });
    try {
      linkSync(tmp, path);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      // A file system without hard links: created only if it is not there (wx).
      try {
        writeFileSync(path, lines, { mode: 0o600, flag: "wx" });
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw e;
      }
    } finally {
      rmSync(tmp, { force: true });
    }
  };
  if (!take()) {
    let seen: string;
    try {
      seen = readFileSync(path, "utf8");
    } catch {
      throw starting();
    }
    const other = lockHolder(dir, upSeconds);
    if (other) throw running(other.pid);
    // An empty lock is one another Pako has just created and not yet written (unless it is old: then its writer died).
    if (!seen.trim() && Date.now() - (statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) < 10_000) throw starting();
    // The one left behind is moved aside under a name only this process uses, and taken over only if it was the stale one just read:
    // another Pako may have replaced it in between, and that lock is put back.
    const aside = `${path}.${process.pid}`;
    try {
      renameSync(path, aside);
    } catch {
      throw starting();
    }
    let moved = "";
    try {
      moved = readFileSync(aside, "utf8");
    } catch {
      /* compared below as empty */
    }
    if (moved !== seen) {
      try {
        linkSync(aside, path);
      } catch {
        /* a third one holds it now */
      }
      rmSync(aside, { force: true });
      throw starting();
    }
    rmSync(aside, { force: true });
    if (!take()) throw starting();
  }
  const release = (): void => {
    process.off("exit", release);
    try {
      if (Number.parseInt(readFileSync(path, "utf8"), 10) === process.pid) rmSync(path);
    } catch {
      /* already gone */
    }
  };
  process.on("exit", release);
  return release;
}

/** Loads ~/.pako/.env and then ./.env into the process settings; a setting already there (the shell's) wins. Missing files are fine. */
export function loadEnvFiles(dir: string): void {
  const load = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof load !== "function") return;
  for (const path of [join(dir, ".env"), join(process.cwd(), ".env")]) {
    if (!existsSync(path)) continue;
    try {
      load.call(process, path);
    } catch (err) {
      logPako.error(`could not read ${path}: ${(err as Error).message}`);
    }
  }
}

// ---------- what Pako keeps: a small file instead of the Key Value store ----------

/** The store on a computer (src/sqlite-kv.ts). */
export interface FileKv extends Kv {
  lost: StoreLost | null;
  /** Every key held now with its value and when it expires (null: never), expired ones left out: for the export (src/data.ts). */
  entries: () => { key: string; value: string; expires: number | null }[];
  /**
   * Delete everything (src/data.ts): the store keeps only `keep` and is written at once. From then on it takes no more writes: the modules
   * still hold their own copies in memory (the log, the chat, the reminders) and would write them back; Pako starts again right after, and
   * reads the file as it is now. When the emptied file cannot be written, the old one is removed instead (the one line kept is written again
   * when the process ends). False when neither could be done: the old file, with everything in it, is still there.
   */
  wipe: (keep?: { key: string; value: string; ttlSeconds: number }[]) => boolean;
  /** Each save of the file, as it goes (the watchdog, src/watchdog.ts): true when it was written, false with why when not. */
  onSave: (report: (ok: boolean, detail?: string) => void) => void;
}

// ---------- the chat window ----------

export interface ChatMessage {
  n: number;
  at: number;
  who: "pako" | "you";
  text: string;
  /** Answers Pako offers (a call to confirm, a table to request): pressed in the window like WhatsApp's buttons. */
  buttons?: { id: string; title: string }[];
  /**
   * A copy of what Pako started by itself (a reminder, a notice, a card) and sent to the owner's Telegram while it is paired: the window keeps
   * it so it still shows everything. Its buttons work here too (a card answered twice says so). "whatsapp": the same, sent to the owner's
   * WhatsApp set up in the panel (src/whatsapp-computer.ts).
   */
  via?: "telegram" | "whatsapp";
  /** It holds a secret the owner asked to see (CODE's one-time codes): shown here, never exported (src/data.ts). */
  secret?: true;
  /**
   * Pako wrote it by itself (a reminder, a routine, a notice), not as the answer to what the owner just wrote: the Mac app tells the person
   * about these with a notification and a Dock badge (GET /panel/api/notices, src/dashboard.ts), since the panel may be hidden.
   */
  started?: true;
}

const CHAT_KEY = "pako-local-chat";
const CHAT_MAX = 300;

/** What the door would send to WhatsApp, kept as a conversation the panel shows. */
export function createLocalChannel(o: { kv: Kv | null; now?: () => number }) {
  const now = o.now ?? Date.now;
  let messages: ChatMessage[] | null = null;
  const all = async (): Promise<ChatMessage[]> => {
    if (messages) return messages;
    try {
      const raw = o.kv ? await o.kv.get(CHAT_KEY) : null;
      const list = raw ? (JSON.parse(raw) as ChatMessage[]) : [];
      messages = Array.isArray(list) ? list : [];
    } catch {
      messages = [];
    }
    return messages;
  };
  const push = async (
    who: ChatMessage["who"], text: string, buttons?: ChatMessage["buttons"], via?: ChatMessage["via"], secret?: boolean, started?: boolean,
  ): Promise<ChatMessage> => {
    const list = await all();
    const m: ChatMessage = {
      n: (list.at(-1)?.n ?? 0) + 1, at: now(), who, text: text.slice(0, 8000), ...(buttons?.length ? { buttons } : {}), ...(via ? { via } : {}),
      ...(secret ? { secret: true as const } : {}), ...(started && who === "pako" ? { started: true as const } : {}),
    };
    list.push(m);
    if (list.length > CHAT_MAX) list.splice(0, list.length - CHAT_MAX);
    try {
      await o.kv?.set(CHAT_KEY, JSON.stringify(list), 90 * 24 * 3600);
    } catch (err) {
      logPako.error(`could not keep the chat: ${(err as Error).message}`);
    }
    return m;
  };
  /**
   * The body the door built for Meta's API, turned into a chat message. Anything that is not text or buttons is not shown. `via`: it went to
   * Telegram, and this is the window's copy (src/whatsapp.ts, graph). `started`: Pako wrote it by itself (ChatMessage.started).
   */
  const deliver = async (body: Record<string, unknown>, o: { via?: ChatMessage["via"]; secret?: boolean; started?: boolean } = {}): Promise<boolean> => {
    const b = body as {
      type?: string;
      text?: { body?: string };
      interactive?: { body?: { text?: string }; action?: { buttons?: { reply?: { id?: string; title?: string } }[] } };
      template?: { components?: { parameters?: { text?: string }[] }[] };
    };
    if (b.type === "text" && typeof b.text?.body === "string") {
      await push("pako", b.text.body, undefined, o.via, o.secret, o.started);
      return true;
    }
    if (b.type === "interactive" && typeof b.interactive?.body?.text === "string") {
      const buttons = (b.interactive.action?.buttons ?? [])
        .map((x) => ({ id: String(x.reply?.id ?? ""), title: String(x.reply?.title ?? "") }))
        .filter((x) => x.id && x.title);
      await push("pako", b.interactive.body.text, buttons, o.via, false, o.started);
      return true;
    }
    if (b.type === "template") {
      const text = b.template?.components?.flatMap((c) => c.parameters ?? []).map((p) => p.text).find((t) => typeof t === "string");
      if (text) await push("pako", text, undefined, undefined, false, o.started);
      return true;
    }
    return true;
  };
  return {
    push,
    deliver,
    /** Forgets the conversation held in memory (after everything was deleted, src/data.ts): the window starts empty. */
    forget: (): void => {
      messages = [];
    },
    /** Messages after `since`, and the id the next call should ask after. */
    list: async (since: number): Promise<ChatMessage[]> => (await all()).filter((m) => m.n > since),
    /** What Pako wrote by itself after the time `after` (ms), oldest first, at most `max` (the newest): the Mac app's notifications. */
    notices: async (after: number, max = 50): Promise<ChatMessage[]> => (await all()).filter((m) => m.started && m.at > after).slice(-max),
  };
}

export type LocalChannel = ReturnType<typeof createLocalChannel>;

// ---------- the assistant: the `claude` command on this computer ----------

/** What the bridge found when it last ran Claude (assistant/bridge.ts tells it): it answered, it is not signed in, or it is out of its limit. */
export type BridgeHealth = ClaudeHealth;

export interface BridgeStatus {
  /**
   * "ok": the claude command answers; "missing": it is not installed (or not on the PATH); "starting": not checked yet; "login": installed but not
   * signed in; "limit": out of Claude's usage limit for now (the last two as the running bridge reported them).
   */
  claude: "ok" | "missing" | "starting" | "login" | "limit";
  running: boolean;
  /** The bridge stops by itself right after it starts (the reason is in the terminal): messages would wait with no word. */
  failing?: boolean;
  /**
   * How the claude command is signed in, as its own `claude auth status` says (https://code.claude.com/docs/en/cli-reference): "plan", a
   * claude.ai login or the long-lived token of `claude setup-token` (the person's Pro or Max plan); "key", an API key or an apiKeyHelper; "other",
   * a cloud provider. Absent until it has answered, or when it cannot (an older Claude Code). Only that word is kept: never an address or a token.
   */
  auth?: "plan" | "key" | "other";
  /**
   * ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) is set for Claude, and in `claude -p` it is always used over the plan
   * (https://code.claude.com/docs/en/iam, "Authentication precedence"): set in the panel's Connections card, or in the environment (the shell,
   * ~/.pako/.env, the Pako folder's .env). Only where it came from, never the key.
   */
  key?: "connections" | "environment";
}

/** What `claude auth status` said, or null when it said nothing this can trust (an older Claude Code, an error, output that is not its JSON). */
export type ClaudeAuth = "plan" | "key" | "other" | "none";

/**
 * Reads the answer of `claude auth status` (https://code.claude.com/docs/en/cli-reference): JSON, exit code 0 when signed in and 1 when not; its
 * `authMethod` is one of none, claude.ai, oauth_token, api_key, api_key_helper or third_party. Only that field is looked at.
 */
export function authFromStatus(code: number | null, out: string): ClaudeAuth | null {
  if (code !== 0 && code !== 1) return null;
  let method: unknown;
  try {
    const j = JSON.parse(out.trim()) as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j)) return null;
    method = (j as { authMethod?: unknown }).authMethod;
    if (method === undefined && code === 1 && (j as { loggedIn?: unknown }).loggedIn === false) return "none";
  } catch {
    return null;
  }
  if (code === 1) return method === "none" ? "none" : null;
  if (method === "claude.ai" || method === "oauth_token") return "plan";
  if (method === "api_key" || method === "api_key_helper") return "key";
  return method === "third_party" ? "other" : null;
}

/**
 * Whether `claude --version` names a Claude Code that has `claude auth status`: 2.1.268 or newer, the first version the docs name for its JSON
 * (its configDirectory field). An older one might take "auth status" for a question to Claude and run it: it is not asked.
 */
export function hasAuthStatus(versionOut: string): boolean {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(versionOut);
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return a > 2 || (a === 2 && (b > 1 || (b === 1 && c >= 268)));
}

/** What a program prints on stdout within ten seconds, with its exit code (null when it could not run or took longer). */
function output(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string } | null> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, env });
      let out = "";
      child.stdout?.on("data", (d: Buffer) => {
        if (out.length < 64_000) out += d.toString("utf8");
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(null);
      }, 10_000);
      child.on("error", () => (clearTimeout(timer), resolve(null)));
      child.on("close", (code) => (clearTimeout(timer), resolve({ code, out })));
    } catch {
      resolve(null);
    }
  });
}

/**
 * Runs `claude auth status` with the environment the bridge gives Claude (so a key there counts as it would), within ten seconds. Its output
 * (it names the account) is read here for the one field above and goes nowhere else: not to the log, not to the panel.
 */
export async function claudeAuth(bin: string, env: Env): Promise<ClaudeAuth | null> {
  const e = { ...childEnv(env), NO_COLOR: "1" };
  const v = await output(...claudeCommand(bin, ["--version"]), e);
  if (!v || v.code !== 0 || !hasAuthStatus(v.out)) return null;
  const r = await output(...claudeCommand(bin, ["auth", "status"]), e);
  return r ? authFromStatus(r.code, r.out) : null;
}

/**
 * Where Claude Code's own installers put the command, for when the PATH that `npm start` sees has none: the native installer's ~/.local/bin
 * (on the PATH only once the person added it) and the older local install's ~/.claude/local (reached through a shell alias, which no program
 * sees). Without these, a person whose `claude` works in their terminal would be told to install it.
 */
function claudeFallbacks(home: string): string[] {
  return [join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude")];
}

/** A setting read whatever its case: Windows keeps the PATH as "Path", and a copy of process.env loses its case-blind lookup. */
function envGet(env: Env, name: string): string {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key ? (env[key] ?? "").trim() : "";
}

/**
 * What a claude.cmd made by npm runs: the last "%dp0%\..." path in it that is not node.exe, taken from the folder of the .cmd. A .js is then
 * run with Node (assistant/bridge.ts, claudeCommand), a .exe as it is. Null when the file cannot be read or holds no such path.
 */
export function windowsShimTarget(cmdPath: string, read: (p: string) => string = (p) => readFileSync(p, "utf8")): string | null {
  let text: string;
  try {
    text = read(cmdPath);
  } catch {
    return null;
  }
  const targets = [...text.matchAll(/"%~?dp0%?\\?([^"%]+)"/gi)].map((m) => m[1]!).filter((t) => !/(^|\\)node\.exe$/i.test(t));
  const last = targets.at(-1);
  if (!last || !/\.(exe|[cm]?js)$/i.test(last)) return null;
  return win32.resolve(win32.dirname(cmdPath), last);
}

/**
 * The commands to try, in order, for the claude command. On macOS and Linux as always: the path the person gave, or `claude` on the PATH and
 * then Claude Code's own folders. On Windows a program cannot find a .cmd by its bare name, and must not start one without a shell: the PATH
 * is searched here (claude.exe, then claude.cmd), each .cmd is turned into what it runs, and the folders of Claude Code's installers (the
 * native one's %USERPROFILE%\.local\bin\claude.exe, npm's %APPDATA%\npm) come after it.
 */
export function claudeCandidates(o: {
  given: string;
  home: string;
  env: Env;
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  read?: (p: string) => string;
}): string[] {
  const exists = o.exists ?? existsSync;
  if ((o.platform ?? process.platform) !== "win32") {
    return o.given ? [o.given] : ["claude", ...claudeFallbacks(o.home).filter((p) => exists(p))];
  }
  const usable = (p: string): string | null => (/\.(cmd|bat)$/i.test(p) ? windowsShimTarget(p, o.read) : p);
  // A .cmd given that leads nowhere stays as it was: its check then fails, and the log names CLAUDE_BIN.
  if (o.given) return [usable(o.given) ?? o.given];
  const dirs = envGet(o.env, "PATH").split(";").map((d) => d.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  const appData = envGet(o.env, "APPDATA");
  const places = [
    ...dirs.flatMap((d) => [win32.join(d, "claude.exe"), win32.join(d, "claude.cmd")]),
    win32.join(o.home, ".local", "bin", "claude.exe"),
    ...(appData ? [win32.join(appData, "npm", "claude.cmd")] : []),
    win32.join(o.home, ".claude", "local", "claude.cmd"),
  ];
  const out: string[] = [];
  for (const p of places) {
    if (!exists(p)) continue;
    const u = usable(p);
    if (u && exists(u) && !out.some((x) => x.toLowerCase() === u.toLowerCase())) out.push(u);
  }
  return out;
}

/** The command is there when `claude --version` answers (within ten seconds; asked without holding the server up). */
export function claudeInstalled(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const [cmd, args] = claudeCommand(bin, ["--version"]);
      const child = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(false);
      }, 10_000);
      child.on("error", () => (clearTimeout(timer), resolve(false)));
      child.on("exit", (code) => (clearTimeout(timer), resolve(code === 0)));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Starts the Mac bridge (assistant/run.ts) as a child of the server and keeps it up; looks again every 15 seconds for a `claude` command
 * that was not there at the start (the person installs it while Pako is open). Stops with the server.
 *
 * The status says what the chat's banner needs: the command is missing, the running bridge reported that Claude is not signed in or is out of
 * its limit (`report`, from POST /assistant/health), or the bridge keeps stopping right after it starts.
 */
export function superviseBridge(o: {
  env: Env;
  log?: (s: string) => void;
  /** For the tests: whether the claude command answers, how the bridge process is started, the clock, the user's home folder, the system. */
  installed?: (bin: string) => Promise<boolean>;
  spawn?: typeof spawn;
  now?: () => number;
  home?: string;
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  read?: (p: string) => string;
  /** How the command is signed in (claudeAuth). By default asked of the real command; with a stand-in `installed` (the tests), not asked unless given. */
  auth?: (bin: string, env: Env) => Promise<ClaudeAuth | null>;
  /** Whether a setting came from the panel's Connections card (src/connections.ts appliedAtStart), for where an API key was set. */
  fromPanel?: (key: string) => boolean;
}): { status: () => BridgeStatus; report: (claude: BridgeHealth) => void; refresh: () => Promise<BridgeStatus>; stop: () => void } {
  const log = o.log ?? ((s) => logBridge.info(`${s}`));
  const now = o.now ?? Date.now;
  const given = (o.env.CLAUDE_BIN ?? "").trim();
  let bin = given || "claude";
  const entry = fileURLToPath(new URL("../assistant/run.ts", import.meta.url));
  let child: ChildProcess | null = null;
  let stopped = false;
  let claude: "ok" | "missing" | "starting" = "starting";
  /** What the running bridge last said about Claude; forgotten when a bridge starts or stops (a report from a bridge that is gone means nothing). */
  let health: BridgeHealth | null = null;
  let startedAt = 0;
  /** The last bridge stopped by itself within 30 seconds of starting. */
  let quickExit = false;
  let restartAt = 0;
  let wait = 2000;
  let timer: NodeJS.Timeout | null = null;
  let checking = false;
  const authCheck = o.auth ?? (o.installed ? null : claudeAuth);
  /** What `claude auth status` last said (null: not asked yet, or it could not tell). */
  let auth: ClaudeAuth | null = null;
  let authAt = 0;
  let authing: Promise<void> | null = null;
  const checkAuth = (): Promise<void> => {
    if (!authCheck || claude !== "ok" || stopped) return Promise.resolve();
    authing ??= (async () => {
      try {
        const was = auth;
        const said = await authCheck(bin, { ...process.env, ...o.env });
        authAt = now();
        if (said === null) return;
        auth = said;
        // Signed in just now (it said not before): the lost login the bridge reported is over. Its waiting messages are tried again by themselves
        // (every 20 s on this computer), each run starting a new `claude -p` that reads the new login: no restart is needed.
        if (was === "none" && said !== "none" && health === "login") health = null;
      } finally {
        authing = null;
      }
    })();
    return authing;
  };
  const launch = async (): Promise<void> => {
    if (stopped || child || checking) return;
    checking = true;
    const check = o.installed ?? claudeInstalled;
    // A path the person gave is the one to use; otherwise the PATH's command, and with none there, Claude Code's own folders.
    const candidates = claudeCandidates({
      given,
      home: o.home ?? homedir(),
      env: { ...process.env, ...o.env },
      ...(o.platform ? { platform: o.platform } : {}),
      ...(o.exists ? { exists: o.exists } : {}),
      ...(o.read ? { read: o.read } : {}),
    });
    let found = "";
    for (const candidate of candidates) {
      if (!(await check(candidate))) continue;
      found = candidate;
      break;
    }
    checking = false;
    if (stopped || child) return;
    if (!found) {
      if (claude !== "missing") {
        log(
          given
            ? `CLAUDE_BIN=${given} does not answer \`--version\`: fix that path where it is set (~/.pako/.env or ./.env), or remove it to use the claude `
              + "command on the PATH, and start Pako again."
            : "the claude command was not found: install Claude Code (https://claude.com/claude-code) and run `claude` once to sign in; Pako will pick it "
              + "up by itself. If it is installed somewhere else, put its path in ~/.pako/.env as CLAUDE_BIN=/path/to/claude and start Pako again.",
        );
      }
      claude = "missing";
      return;
    }
    // On Windows the command is always found as a full path (the PATH is searched here), so that note would be wrong there.
    if (found !== bin && found !== "claude") log((o.platform ?? process.platform) === "win32" ? `using ${found}` : `using ${found} (the PATH has no claude command)`);
    bin = found;
    claude = "ok";
    if (now() < restartAt) return;
    const started = now();
    startedAt = started;
    health = null;
    // The bridge gets what it needs to run and to find this server (its own ASSISTANT_* settings), not the keys of every connection this process holds.
    const env = { ...process.env, ...o.env };
    const own = Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && /^ASSISTANT_/.test(k)));
    // CLAUDE_BIN: the command this check found, so the bridge runs that one (a path from Claude Code's own folders, too).
    const c = (o.spawn ?? spawn)(process.execPath, ["--disable-warning=ExperimentalWarning", entry], {
      env: { ...childEnv(env), ...own, CLAUDE_BIN: bin, PAKO_PARENT_PID: String(process.pid) } as NodeJS.ProcessEnv,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true, // only Windows reads it: under the hidden autostart a console window would open for the bridge
    });
    child = c;
    let gone = false;
    const ended = (why: string): void => {
      if (gone) return; // a process that fails to start can say so twice ("error", then "exit")
      gone = true;
      if (child === c) child = null;
      health = null;
      if (stopped) return;
      // A bridge that dies at once is not restarted at once.
      quickExit = now() - started <= 30_000;
      wait = quickExit ? Math.min(wait * 2, 60_000) : 2000;
      restartAt = now() + wait;
      log(`stopped (${why}); starting again in ${Math.round(wait / 1000)} s`);
    };
    c.on("exit", (code) => ended(`code ${code}`));
    c.on("error", (err) => ended(err.message));
  };
  /** Looks for the command (launch), then asks how it is signed in: every round until it is, then every five minutes. */
  const tick = async (): Promise<void> => {
    await launch();
    if (claude === "ok" && now() - authAt >= (auth && auth !== "none" ? 300_000 : 15_000)) await checkAuth();
  };
  let refreshing: Promise<void> | null = null;
  let refreshedAt = -Infinity;
  void tick();
  timer = setInterval(() => void tick(), 15_000);
  timer.unref?.();
  const stop = (): void => {
    if (stopped) return; // Ctrl+C stops it, and so does the exit that follows: the bridge is told once
    stopped = true;
    process.off("exit", stop);
    if (timer) clearInterval(timer);
    child?.kill("SIGTERM");
  };
  process.on("exit", stop);
  const status = (): BridgeStatus => {
    const set = (k: string): boolean => (o.env[k] ?? "").trim() !== "";
    const keyName = set("ANTHROPIC_API_KEY") ? "ANTHROPIC_API_KEY" : set("ANTHROPIC_AUTH_TOKEN") ? "ANTHROPIC_AUTH_TOKEN" : "";
    const reported = claude === "ok" && child && health && health !== "ok" ? health : claude;
    return {
      // Not signed in, as `claude auth status` says: known before any message has to fail for it.
      claude: reported === "ok" && auth === "none" ? "login" : reported,
      running: child !== null,
      // Said from the first quick stop until a bridge has stayed up for 30 seconds: a banner that would blink on and off at each restart says nothing.
      ...(quickExit && (!child || now() - startedAt <= 30_000) ? { failing: true } : {}),
      ...(claude === "ok" && auth && auth !== "none" ? { auth } : {}),
      ...(keyName ? { key: o.fromPanel?.(keyName) ? "connections" : "environment" } : {}),
    };
  };
  return {
    status,
    report: (said) => {
      if (child) health = said;
    },
    /**
     * Looks again now (the command, then how it is signed in), for the Mac app while it waits for the person to install or sign in: at most once
     * every three seconds, however often it is asked; the answer waits for that look.
     */
    refresh: async () => {
      if (!refreshing && now() - refreshedAt >= 3000) {
        refreshedAt = now();
        refreshing = (async () => {
          await launch();
          await checkAuth();
        })().finally(() => {
          refreshing = null;
        });
      }
      await refreshing;
      return status();
    },
    stop,
  };
}

// ---------- the browser ----------

/**
 * The program that opens `url` in the default browser. On Windows not `cmd /c start`: cmd reads an & in an address as the end of the
 * command, and a console window flashes; rundll32's URL handler takes the address as it is.
 */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

/** Opens a page in the default browser (a no-op where there is none). */
export function openBrowser(url: string): void {
  try {
    const [cmd, args] = browserCommand(url);
    const p = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    p.on("error", () => undefined);
    p.unref();
  } catch {
    /* no browser: the address is printed anyway */
  }
}
