// The bridge's base: its dependencies, the conversation's state on disk, the server's API, the reply and the notes sent to it.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { outsideOf, type OutsideSource } from "../../src/quarantine.ts";
import { systemPromptFor, toolsSystemPromptFor, type LabsOff } from "../prompt.ts";
import { toolDataOf } from "../tools.ts";
import { createBudget, loadBudgetConfig, type Budget } from "../budget.ts";
import type { VoiceConfig } from "../voice.ts";
import { REPLY_WAITS_MS, type BridgeConfig } from "./config.ts";
import { runClaude, type RunConfig } from "./claude.ts";
import { setFallbackLog } from "./fallbacks.ts";
import { mcpConfigFor, toolDataPath } from "./mcp.ts";
import { createWarmClaude, type WarmClaude } from "./warm.ts";
import type { ParsedReply } from "./reply.ts";
import type { Context } from "./context.ts";
import type { Base } from "./parts.ts";

export interface State {
  sessionId: string;
  count: number;
  contextHash: string;
  /** The last context told the assistant it was paused: the next one says the pause is over. */
  paused?: boolean;
  /**
   * This conversation has read outside text (a forwarded message, the web): it is in what the next turn resumes, so those turns are marked
   * too, until a new conversation starts.
   */
  outside?: OutsideSource[];
}

export interface BridgeDeps {
  config: BridgeConfig;
  fetch?: typeof fetch;
  run?: typeof runClaude;
  /** Turns a voice note into words (default: ffmpeg and whisper.cpp on this computer). */
  transcribe?: (audio: Buffer, mime: string, c: VoiceConfig) => Promise<string>;
  log?: (line: string) => void;
  /** The waits between the sends of one reply the server could not deliver (the tests use zeros). */
  replyWaitsMs?: number[];
  /** The budget of background runs (default: one kept in the state folder, with config.budget). */
  budget?: Budget;
  /** The owner's conversation on a process that stays up (default: one when config.warmMs is set and no `run` is given). */
  warm?: WarmClaude | null;
}

/** What the last run of Claude said about Claude itself: it answered, it is not signed in, or it is out of its usage limit for now. */
export type ClaudeHealth = "ok" | "login" | "limit";

export function mountCore(b: Base) {
  const { d } = b;
  const { config } = d;
  const f = d.fetch ?? fetch;
  const runOnce = d.run ?? runClaude;
  const log = d.log ?? ((l: string) => console.log(`${new Date().toISOString()} ${l}`));
  // The fallbacks from Claude Code's structured signals to weaker ones (fallbacks.ts) go to this bridge's log.
  setFallbackLog(log);
  const budget = d.budget ?? createBudget({ config: config.budget ?? loadBudgetConfig({}).config, stateDir: config.stateDir, log });
  // Only with the real runner: a test that gives its own `run` gets every turn through it.
  const warm = d.warm !== undefined ? d.warm : !d.run && (config.warmMs ?? 0) > 0 ? createWarmClaude({ idleMs: config.warmMs!, log }) : null;
  /**
   * The settings of the owner's conversation: with Pako's tools, their MCP server and the short system prompt; without, exactly as before.
   * The background runs (an email, a meeting, a paper...) never get them: they read other people's text and act on nothing.
   */
  // The persona follows the server's Labs (beta-plan step 4): a chief of staff, and the friend, health companion and teacher only with Labs
  // on. Kept from the last turn's context, so the process warmed for the next turn has the same prompt (its key includes the prompt).
  let companion = false;
  // The labs off on the server (table booking, phone calls: src/labs.ts), kept the same way: their tags leave the prompt.
  let off: LabsOff = {};
  const chat = (labs?: boolean, labsOff?: LabsOff): RunConfig => {
    if (labs !== undefined) companion = labs;
    if (labsOff !== undefined) off = labsOff;
    if (config.mcpTools) return { ...config, systemPrompt: toolsSystemPromptFor(companion, off), mcp: mcpConfigFor(config.stateDir) };
    // Without Labs, without a lab off and without tools, exactly the settings as before (the default system prompt).
    return companion || off.book || off.call ? { ...config, systemPrompt: systemPromptFor(companion, off) } : config;
  };
  /** The copy of this turn's context the read tools answer from, and the flags that say which actions this server takes. */
  const writeToolData = (turn: string, ctx: Context): void => {
    if (!config.mcpTools) return;
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    const path = toolDataPath(config.stateDir);
    try {
      writeFileSync(`${path}.tmp`, JSON.stringify(toolDataOf(turn, ctx as unknown as Record<string, unknown>)), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    } catch (err) {
      log(`could not write the tools' data: ${(err as Error).message}`);
    }
  };
  const statePath = join(config.stateDir, "state.json");
  const attempts = new Map<string, number>();
  /** Not before this time (ms): an item that hit Claude's limit or a lost login waits instead of being tried every few seconds. */
  const retryAt = new Map<string, number>();
  /** Answered, but the server did not confirm the ack: acknowledged again, never answered twice. */
  const handledUnacked = new Set<string>();
  /** The reply already worked out for a message whose sending failed: sent again as it is, without asking Claude (and acting) again. */
  const replyCache = new Map<string, Parameters<typeof say>[0]>();
  const toldAt = { limit: 0, login: 0 };

  const readState = (): State => {
    try {
      const s = JSON.parse(readFileSync(statePath, "utf8")) as Partial<State>;
      return {
        sessionId: typeof s.sessionId === "string" ? s.sessionId : "",
        count: Number(s.count) || 0,
        contextHash: typeof s.contextHash === "string" ? s.contextHash : "",
        paused: s.paused === true,
        ...(outsideOf(s.outside).length ? { outside: outsideOf(s.outside) } : {}),
      };
    } catch {
      return { sessionId: "", count: 0, contextHash: "" };
    }
  };
  const writeState = (s: State): void => {
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${statePath}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
      renameSync(tmp, statePath);
    } catch (err) {
      log(`could not save the conversation state: ${(err as Error).message}`);
    }
  };

  /**
   * The lines of other people's text (contextOutside) the owner's last turn had in front of it, by a short hash: a line not among them is new,
   * and marks the turn that reads it. Kept apart from the conversation's state: a new conversation does not make old lines new.
   */
  const seenPath = join(config.stateDir, "outside-seen.json");
  const readSeen = (): Set<string> => {
    try {
      const v = JSON.parse(readFileSync(seenPath, "utf8")) as unknown;
      return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 2000) : []);
    } catch {
      return new Set();
    }
  };
  const writeSeen = (keys: string[]): void => {
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${seenPath}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(keys.slice(0, 2000)), { mode: 0o600 });
      renameSync(tmp, seenPath);
    } catch (err) {
      log(`could not save the outside lines seen: ${(err as Error).message}`);
    }
  };

  const api = async (path: string, init: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {}): Promise<Response> =>
    f(`${config.server}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${config.token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    });

  type SayBody = {
    text?: string; notice?: boolean; call?: ParsedReply["call"]; message?: ParsedReply["message"]; send?: ParsedReply["send"]; remind?: ParsedReply["remind"];
    email?: ParsedReply["email"]; heard?: string;
    unremind?: string[]; book?: ParsedReply["book"]; lists?: ParsedReply["lists"]; tasks?: ParsedReply["tasks"]; done?: string[]; people?: ParsedReply["people"];
    routines?: ParsedReply["routines"]; watches?: ParsedReply["watches"];
    health?: ParsedReply["health"]; goals?: string[]; cards?: ParsedReply["cards"];
    /** A turn marked as outside text (src/quarantine.ts): why, and its notes, which the server then holds with the rest for the owner's press. */
    outside?: OutsideSource[]; remember?: string[]; forget?: string[];
    /**
     * A server that holds part of a reply (quarantine 2): new outside text was in this turn's context, and where from. It holds the reply's
     * destructive and standing tags (its `forget` too, sent here instead of to /assistant/memory) and asks before words Pako wrote go out.
     */
    context?: OutsideSource[];
  };
  const say = async (body: SayBody): Promise<boolean> => {
    try {
      const r = await api("/assistant/reply", { method: "POST", body });
      if (!r.ok) log(`reply refused: ${r.status}`);
      return r.ok;
    } catch (err) {
      log(`reply failed: ${(err as Error).message}`);
      return false;
    }
  };

  const waits = d.replyWaitsMs ?? REPLY_WAITS_MS;
  // `key`: the message the notes answer. The server waits for that answer's reply and tells the owner what changed in one receipt after its text.
  const pendingNotes: { remember: string[]; forget: string[]; key: string }[] = [];
  const flushNotes = async (): Promise<void> => {
    while (pendingNotes.length) {
      try {
        const r = await api("/assistant/memory", { method: "POST", body: pendingNotes[0] });
        if (!r.ok) {
          log(`notes refused: ${r.status} (kept to try again)`);
          return;
        }
        pendingNotes.shift();
      } catch (err) {
        log(`notes failed: ${(err as Error).message} (kept to try again)`);
        return;
      }
    }
  };
  return {
    config, f, runOnce, log, budget, warm, chat, writeToolData, attempts, retryAt, handledUnacked, replyCache, toldAt, readState,
    writeState, readSeen, writeSeen, api, say, waits, pendingNotes, flushNotes,
  };
}

export type Core = ReturnType<typeof mountCore>;
