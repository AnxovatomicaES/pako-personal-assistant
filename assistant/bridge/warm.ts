// The owner's conversation on one `claude -p` process kept up between their messages (createWarmClaude).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { SYSTEM_PROMPT } from "../prompt.ts";
import { childEnv, claudeCommand } from "./cli.ts";
import { buildClaudeArgs, ClaudeError, readTheWeb, runClaude, runningClaude, type ClaudeJson, type ClaudeResult, type RunConfig } from "./claude.ts";
import { classifyFailure, errorSignals } from "./claude-errors.ts";
import { missingEssential, readResult } from "./cli-shape.ts";
import { mcpDownIn, seenFields, watchTurn } from "./mcp.ts";

/**
 * The owner's conversation in one `claude -p` process that stays up between their messages: the same flags as runClaude (the same tools,
 * system prompt, empty server list and settings), with stream-json in and out, so each message is one JSON line on its standard input and
 * each answer one "result" line. Measured with Claude Code 2.1.325 on a one-word answer: a new process (resumed or not) took 3.6 to 5.2 s,
 * of which under 0.9 s was the API; the same turn on a process already up took 2.3 to 2.8 s. That start is paid once per conversation, and
 * prepare() pays it in advance, between messages.
 *
 * What does not change: a turn is still one answer read whole, its tags read by parseReply. Each turn's lines are read for tool use
 * (watchTurn: a WebSearch or WebFetch tool_use marks the turn) and for structured error signals (errorSignals); num_turns is only
 * readTheWeb's fallback, and is the turn's own (checked: 1 for each plain turn of a process). If the web counters were the process's total, a later
 * turn would be marked too: the safe side, and the conversation is marked anyway once it read the web (state.outside). The process is for one
 * session only: another session id (a new conversation, a rotation, a conversation dropped for outside text) ends it and starts another. A
 * timeout, an error, a limit or an ended process end it too; the next message starts a new one. Idle for `idleMs`, it ends by itself.
 */
export function createWarmClaude(o: { idleMs: number; log?: (line: string) => void }) {
  interface Proc {
    child: ChildProcess;
    key: string;
    /** The session it holds: "" until its first answer when it was started without one. */
    session: string;
    busy: boolean;
    dead: boolean;
    err: string;
    /** The process's cost so far (Claude Code counts it for the whole process): each answer's own is the difference. */
    cost: number;
    turn: ((line: string | null, why?: string) => void) | null;
    idle: ReturnType<typeof setTimeout> | null;
    /** The turn under way's tool use (a process with Pako's tools); and whether its MCP server failed to load, as its init line said. */
    watch: ReturnType<typeof watchTurn> | null;
    /** The turn under way's error signals (a stream-json event that says why it failed). */
    signals: ReturnType<typeof errorSignals> | null;
    /** spawn's error code when the process could not start. */
    spawnCode?: string;
    mcpDown: boolean;
  }
  let p: Proc | null = null;
  const log = o.log ?? (() => undefined);
  const keyOf = (c: RunConfig): string => JSON.stringify([c.claudeBin, c.tools, c.model, c.noBare === true, c.systemPrompt ?? SYSTEM_PROMPT, c.stateDir ?? "", c.effort ?? "", c.mcp ?? ""]);
  const end = (x: Proc): void => {
    if (x.idle) clearTimeout(x.idle);
    x.idle = null;
    if (p === x) p = null;
    if (x.dead) return;
    x.dead = true;
    const pid = x.child.pid;
    try {
      if (pid && process.platform !== "win32") process.kill(-pid, "SIGKILL");
      else x.child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    if (pid) runningClaude.delete(pid);
  };
  const start = (c: RunConfig, session: string): Proc => {
    if (c.stateDir) mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
    const [cmd, args] = claudeCommand(c.claudeBin, buildClaudeArgs({ ...c, stream: true }, session || undefined));
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true, env: { ...childEnv(process.env), NO_COLOR: "1" },
      ...(c.stateDir ? { cwd: c.stateDir } : {}),
    });
    const x: Proc = { child, key: keyOf(c), session, busy: false, dead: false, err: "", cost: 0, turn: null, idle: null, watch: null, signals: null, mcpDown: false };
    if (child.pid) runningClaude.add(child.pid);
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    let partial = "";
    child.stdout!.on("data", (b: string) => {
      const lines = (partial + b).split("\n");
      partial = lines.pop() ?? "";
      if (partial.length > 4_000_000) partial = "";
      for (const l of lines) {
        // The init line may come before any turn (a process prepared ahead): kept on the process, not only on the turn.
        const down = mcpDownIn(l);
        if (down !== null) x.mcpDown = down;
        x.watch?.line(l);
        x.signals?.line(l);
        if (/"type"\s*:\s*"result"/.test(l)) x.turn?.(l);
      }
    });
    child.stderr!.on("data", (b: string) => {
      x.err = (x.err + b).slice(-20_000);
    });
    // A process that already ended when a message is written: its turn fails on "close", not with an unhandled error here.
    child.stdin!.on("error", () => undefined);
    const gone = (why: string): void => {
      const was = !x.dead;
      x.dead = true;
      if (x.idle) clearTimeout(x.idle);
      if (child.pid) runningClaude.delete(child.pid);
      if (p === x) p = null;
      if (was || x.turn) x.turn?.(null, why);
    };
    child.on("error", (e) => {
      x.spawnCode = (e as NodeJS.ErrnoException).code;
      gone(`could not start ${c.claudeBin}: ${e.message}`);
    });
    child.on("close", (code) => gone(`${x.err} exit code ${code}`));
    return x;
  };
  const rest = (x: Proc): void => {
    if (x.idle) clearTimeout(x.idle);
    x.idle = setTimeout(() => end(x), o.idleMs);
    x.idle.unref?.();
  };
  return {
    /** One turn of the conversation `sessionId` ("" or none: a new one), on the process that holds it, or on a new one. */
    run(prompt: string, c: RunConfig, sessionId?: string): Promise<ClaudeResult> {
      const want = sessionId ?? "";
      // A file goes as a content block only in a run of its own; and a turn under way (never, the bridge answers one at a time) is not shared.
      if (c.files?.length || p?.busy) return runClaude(prompt, c, sessionId);
      if (p && (p.dead || p.key !== keyOf(c) || p.session !== want)) end(p);
      const x = p ?? start(c, want);
      p = x;
      x.busy = true;
      x.err = "";
      x.watch = watchTurn();
      x.signals = errorSignals();
      if (x.idle) clearTimeout(x.idle);
      return new Promise<ClaudeResult>((resolve, reject) => {
        let settled = false;
        const finish = (): boolean => {
          if (settled) return false;
          settled = true;
          clearTimeout(timer);
          x.turn = null;
          x.busy = false;
          return true;
        };
        const timer = setTimeout(() => {
          if (!finish()) return;
          end(x);
          reject(new ClaudeError(`Claude took longer than ${Math.round(c.runTimeoutMs / 1000)} s`, "other"));
        }, c.runTimeoutMs);
        x.turn = (line, why) => {
          if (!finish()) return;
          if (line === null) {
            end(x);
            const msg = (why ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || "the claude process ended";
            return reject(classifyFailure({ message: msg, ...(x.spawnCode ? { spawnCode: x.spawnCode } : {}), signals: x.signals?.done() ?? {} }));
          }
          const doc = readResult(line) as ClaudeJson | null;
          const text = typeof doc?.result === "string" ? doc.result : "";
          const shape = doc && doc.is_error !== true ? missingEssential(doc as Record<string, unknown>) : null;
          if (shape) {
            end(x);
            return reject(new ClaudeError(shape, "other", { via: "none" }));
          }
          if (!doc || doc.is_error === true || !text.trim()) {
            end(x);
            const msg = `${text} ${x.err}`.replace(/\s+/g, " ").trim().slice(0, 300) || "an empty answer";
            return reject(classifyFailure({ message: msg, doc, signals: x.signals?.done() ?? {} }));
          }
          if (typeof doc.session_id === "string" && doc.session_id) x.session = doc.session_id;
          const total = typeof doc.total_cost_usd === "number" ? doc.total_cost_usd : 0;
          const costUsd = total >= x.cost ? total - x.cost : total;
          x.cost = total;
          rest(x);
          const seen = x.watch?.done() ?? null;
          x.watch = null;
          // Only a run that asked for Pako's server can find it missing (without one, the init line lists no servers at all).
          if (seen) seen.mcpDown = !!c.mcp && (seen.mcpDown || x.mcpDown);
          const tools = c.tools.length > 0 || !!c.mcp;
          resolve({ text, sessionId: x.session, costUsd, ...(readTheWeb(doc, seen ?? undefined, tools) ? { readOutside: true } : {}), ...seenFields(seen) });
        };
        x.child.stdin!.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } })}\n`);
      });
    },
    /**
     * A process ready for the next turn of `sessionId` ("" = a new conversation): started now, while nobody waits, unless the one up already
     * holds it. Nothing is sent to Claude until a message comes.
     */
    prepare(c: RunConfig, sessionId: string): void {
      if (p?.busy) return;
      if (p && !p.dead && p.key === keyOf(c) && p.session === sessionId) return;
      if (p) end(p);
      try {
        p = start(c, sessionId);
        rest(p);
      } catch (err) {
        log(`could not start a claude process in advance: ${(err as Error).message}`);
      }
    },
    /** Ends the process (the bridge stops, or restarts onto a new version). */
    stop(): void {
      if (p) end(p);
    },
    /** Whether a process is up (tests). */
    up: (): boolean => !!p && !p.dead,
  };
}

export type WarmClaude = ReturnType<typeof createWarmClaude>;
