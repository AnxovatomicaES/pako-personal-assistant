// The owner's assistant, running on the owner's own computer. It asks the server for the owner's WhatsApp messages, answers each one with
// Claude Code in print mode (the owner's own login, the unmodified `claude` program), and sends the answer back through the server.
//
// Claude is given as little as possible: no shell, no files, no connectors, no other servers and no settings or plugins (they make the
// context a hundred times bigger and the call slower and dearer). Its reach is a web search and a few plain tags in its answer, which this
// file reads, removes and sends to the server: a note to keep, a note to delete, a proposed call, a WhatsApp for the owner to send, a message
// for the assistant to send from its own number. The server
// shows the owner the exact call with a button (nothing is rung unless the owner presses it) and gives a WhatsApp as a link the owner opens
// and sends from their own phone. This file never runs anything Claude wrote.
//
// With a Claude Code that can load it, the owner's conversation also gets Pako's own MCP server (assistant/mcp-server.ts): the same actions
// as typed tools with checked arguments. They change nothing by themselves: this file reads the accepted calls from the run's output and folds
// them into the same reply the tags give (readReply), so what the server does with a reply does not depend on how Claude wrote it.

// The code is in parts under assistant/bridge/; this file builds the bridge from them and is what the rest of Pako imports.

import type { Usage } from "./budget.ts";
import type { Bridge } from "./bridge/parts.ts";
import { mountCore } from "./bridge/core.ts";
import { mountRuns } from "./bridge/runs.ts";
import { mountLanguage } from "./bridge/language.ts";
import { mountMail } from "./bridge/mail.ts";
import { mountSlack } from "./bridge/slack.ts";
import { mountMeetings } from "./bridge/meetings.ts";
import { mountJobs } from "./bridge/jobs.ts";
import { mountPapers } from "./bridge/papers.ts";
import { mountTurn } from "./bridge/turn.ts";
import { mountTick } from "./bridge/tick.ts";
import { parseReply } from "./bridge/reply.ts";
import type { BridgeDeps } from "./bridge/core.ts";

export { DEFAULT_MODEL, DEFAULT_WRITING_MODEL, defaultStateDir, loadBridgeConfig, OLD_STATE_DIR_NAME, STATE_DIR_NAME } from "./bridge/config.ts";
export type { BridgeConfig } from "./bridge/config.ts";
export { childEnv, claudeCommand, offersFlag, offersNoBare } from "./bridge/cli.ts";
export { buildClaudeArgs, ClaudeError, modelUnavailable, readTheWeb, runClaude, stopRunningClaude } from "./bridge/claude.ts";
export type { ClaudeResult, FileBlock, RunConfig } from "./bridge/claude.ts";
export { mcpConfigFor, mcpDownIn, offersMcpTools, toolDataPath, watchTurn } from "./bridge/mcp.ts";
export type { TurnSeen } from "./bridge/mcp.ts";
export { createWarmClaude } from "./bridge/warm.ts";
export type { WarmClaude } from "./bridge/warm.ts";
export { parseReply, readReply } from "./bridge/reply.ts";
export type { FactTag, KnowTag, ParsedReply, PersonTag } from "./bridge/reply.ts";
export { parseEmailVerdict } from "./bridge/items.ts";
export type { BriefJob, Email, FollowupJob, JudgeJob, Meeting, Paper, ProactiveJob, Review } from "./bridge/items.ts";
export { contextOutside, languageLine, namedPeople } from "./bridge/context.ts";
export type { BridgeDeps, ClaudeHealth } from "./bridge/core.ts";

export function createBridge(d: BridgeDeps) {
  // The bridge is built in parts (assistant/bridge/), in the order it always set itself up: each adds its names to `b` for the parts after it.
  const b = { d } as Bridge;
  Object.assign(b, mountCore(b));
  Object.assign(b, mountRuns(b));
  Object.assign(b, mountLanguage(b));
  Object.assign(b, mountMail(b));
  Object.assign(b, mountSlack(b));
  Object.assign(b, mountMeetings(b));
  Object.assign(b, mountJobs(b));
  Object.assign(b, mountPapers(b));
  Object.assign(b, mountTurn(b));
  Object.assign(b, mountTick(b));
  const { config, budget, warm, chat, readState, pendingNotes, handledUnacked, setVersion, tick, handle } = b;

  return {
    tick,
    handle,
    parseReply,
    /** What this computer runs (assistant/update.ts), told to the server on the next round. */
    setVersion,
    /**
     * Something is still under way between two rounds (notes to keep, an answered message whose ack the server has not taken): no
     * self-update now. A message still waiting (for Claude, or for its reply to be sent again) is in the inbox, so its round is not idle.
     */
    busy: (): boolean => pendingNotes.length > 0 || handledUnacked.size > 0,
    /** The day's runs of Claude, interactive and background, and the background jobs answered without one (assistant/budget.ts). */
    usage: (): Usage => budget.usage(),
    /** A claude process ready for the owner's next message (at the start: the conversation the state folder holds). */
    warmUp: (): void => {
      if (!warm) return;
      const s = readState();
      warm.prepare(chat(), s.count >= config.rotateAfter ? "" : s.sessionId);
    },
    /** Ends the process kept for the conversation (before a restart onto a new version). */
    stopWarm: (): void => warm?.stop(),
  };
}
