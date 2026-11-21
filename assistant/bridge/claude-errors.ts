// Why a run of `claude -p` failed, read from what Claude Code says in structure first and from its English words only as a fallback.
//
// The order, most robust first:
//   1. the process could not start (spawn's error code, ENOENT: the command is not on this computer);
//   2. the result's own fields (`--output-format json`, and the "result" line of stream-json): `api_error_status` (the HTTP status of the API
//      call that failed) and `api_error_type` (the API's error type, such as "authentication_error" or "rate_limit_error");
//   3. the stream's other events (stream-json only): an assistant message's `error` ("authentication_failed"...) and a `rate_limit_event`
//      whose status is "rejected";
//   4. only then the English text (the result's words and the error output), each pattern with the Claude Code version it was seen in.
// A fallback that decides is counted and logged (fallbacks.ts): a newer Claude Code that changes its words is seen in the log, not guessed.
//
// Captured outputs of Claude Code 2.1.327 are in test/fixtures/claude-cli/ (test/claude-errors.test.ts says how each was made).

import { noteFallback } from "./fallbacks.ts";

/**
 * Why a run of claude failed: signed out, a limit, the command not on this computer ("missing"), a model this Claude Code is too old to run
 * ("model-needs-newer-cli": the run goes again on another model, runs.ts), or anything else.
 */
export type ClaudeTrouble = "login" | "limit" | "missing" | "model-needs-newer-cli" | "other";

/** The structured part of a failure, when Claude Code gave one. */
export interface ClaudeFailure {
  /** The API's HTTP status (`api_error_status`), when the failure was an API call. */
  status?: number;
  /** The API's error type (`api_error_type`), e.g. "not_found_error". */
  apiType?: string;
  /** What decided the kind: a structured field, or the English words (the fallback). */
  via?: "spawn" | "status" | "type" | "stream" | "text" | "none";
  /** When the plan's limit resets (ms), from a rejected rate_limit_event's `resetsAt` (stream-json only). */
  resetsAt?: number;
  /** A model this Claude Code is too old for: the version the refusal names as needed ("2.1.280"), when it names one. */
  needsCli?: string;
  /** That refusal's own words for which Claude Code refused ("Claude Code 2.1.258 does not support this model"), when they name it. */
  cliVersion?: string;
}

export class ClaudeError extends Error {
  kind: ClaudeTrouble;
  status?: number;
  apiType?: string;
  via?: ClaudeFailure["via"];
  resetsAt?: number;
  needsCli?: string;
  cliVersion?: string;
  constructor(message: string, kind: ClaudeTrouble, f: ClaudeFailure = {}) {
    super(message);
    this.kind = kind;
    if (f.status !== undefined) this.status = f.status;
    if (f.apiType !== undefined) this.apiType = f.apiType;
    if (f.via !== undefined) this.via = f.via;
    if (f.resetsAt !== undefined) this.resetsAt = f.resetsAt;
    if (f.needsCli !== undefined) this.needsCli = f.needsCli;
    if (f.cliVersion !== undefined) this.cliVersion = f.cliVersion;
  }
}

/** The fields of a result this file reads (the rest of ClaudeJson is in claude.ts). */
export interface ResultFields {
  is_error?: unknown;
  subtype?: unknown;
  api_error_status?: unknown;
  api_error_type?: unknown;
  terminal_reason?: unknown;
}

/**
 * The English fallback: the words Claude Code (or the API through it) used. Each pattern says where it was seen; "before 2.1.325" means it
 * was kept from an earlier bridge whose exact version was not written down. Ordered: missing, then login, then limit.
 */
const TEXT_PATTERNS: { kind: Exclude<ClaudeTrouble, "other" | "model-needs-newer-cli">; re: RegExp; seen: string }[] = [
  // Our own message for spawn's ENOENT (runClaude, warm.ts): kept for a warm process whose spawn error reaches the turn as text.
  { kind: "missing", re: /could not start .{0,300}\bENOENT\b/, seen: "Pako's own words for spawn ENOENT" },
  // "Not logged in · Please run /login": 2.1.327 (captured, test/fixtures/claude-cli/2.1.327/not-logged-in.json); api_error_status is null there.
  { kind: "login", re: /not logged in|please run \/login/i, seen: "2.1.327" },
  // "Invalid API key · Fix external API key": 2.1.327 (captured; it also carries api_error_status 401, which decides first).
  { kind: "login", re: /invalid api key/i, seen: "2.1.327" },
  { kind: "login", re: /authentication|oauth token|unauthori[sz]ed/i, seen: "before 2.1.325" },
  // "You've hit your 5-hour limit · resets 9pm" and the plan's other limits: before 2.1.325 (the stub in test/fixtures/claude-stub.mjs).
  { kind: "limit", re: /rate limit|usage limit|limit reached|overloaded|quota|hit your .{0,40}limit|out of (?:extra )?usage/i, seen: "before 2.1.325" },
  { kind: "limit", re: /spend limit|shared budget/i, seen: "before 2.1.325" },
  // An API key's account out of credits ("Credit balance is too low") waits like a plan's limit: answered once credits are added.
  { kind: "limit", re: /usage credits?|credit balance|(?:weekly|monthly|5-hour|opus|sonnet) limit/i, seen: "before 2.1.325" },
];

/** The English fallback alone (kept for callers that have only words, and for modelUnavailable). */
export const classify = (s: string): ClaudeTrouble => TEXT_PATTERNS.find((p) => p.re.test(s))?.kind ?? "other";

/** The kind an HTTP status says, when it says one: 401/403 the sign-in, 429 a limit, 529 overloaded (waits like a limit). */
export function kindOfStatus(status: number): ClaudeTrouble | null {
  if (status === 401 || status === 403) return "login";
  if (status === 429 || status === 529) return "limit";
  return null;
}

/** The kind the API's error type says (https://docs.anthropic.com/en/api/errors). */
export function kindOfApiType(type: string): ClaudeTrouble | null {
  if (type === "authentication_error" || type === "permission_error") return "login";
  if (type === "rate_limit_error" || type === "overloaded_error" || type === "billing_error") return "limit";
  return null;
}

/**
 * The kind an assistant message's `error` says (stream-json): "authentication_failed" seen in 2.1.327 (captured, signed out); the others are
 * the values Claude Code's SDK types name for that field.
 */
export function kindOfStreamError(e: string): ClaudeTrouble | null {
  if (e === "authentication_failed") return "login";
  if (e === "rate_limit" || e === "billing_error") return "limit";
  return null;
}

/** What a stream-json run said about a failure apart from its result line: collected line by line (errorSignals). */
export interface StreamSignals {
  /** The `error` of an assistant message that was an API error ("authentication_failed"...). */
  streamError?: string;
  /** A rate_limit_event said "rejected": this account is at its limit now. */
  rateLimited?: boolean;
  /** That event's `resetsAt` (epoch seconds there, ms here): when the limit renews. 2.1.327 (captured, web-search.stream.json, "allowed"). */
  resetsAt?: number;
}

/** Reads the stream's lines for StreamSignals. Lines it does not know are passed over. */
export function errorSignals() {
  const s: StreamSignals = {};
  return {
    line(l: string): void {
      if (!/"(?:rate_limit_event|error)"/.test(l)) return;
      let doc: { type?: unknown; error?: unknown; rate_limit_info?: { status?: unknown; resetsAt?: unknown } };
      try {
        doc = JSON.parse(l) as typeof doc;
      } catch {
        return; // not a whole JSON line: nothing structured to read
      }
      if (doc.type === "assistant" && typeof doc.error === "string") s.streamError = doc.error;
      if (doc.type === "rate_limit_event" && doc.rate_limit_info?.status === "rejected") {
        s.rateLimited = true;
        const at = doc.rate_limit_info.resetsAt;
        if (typeof at === "number" && Number.isFinite(at) && at > 1e9) s.resetsAt = at < 1e12 ? at * 1000 : at;
      }
    },
    done: (): StreamSignals => s,
  };
}

/** Everything known about one failed run. */
export interface RunFailure {
  /** The words to show and log: the result's text and the error output, already trimmed. */
  message: string;
  /** spawn's error code when the process could not start ("ENOENT"). */
  spawnCode?: string;
  /** The result document, when there was one. */
  doc?: ResultFields | null;
  signals?: StreamSignals;
}

/**
 * A model this Claude Code is too old to run: "API Error: 400 Claude Code 2.1.258 does not support this model; version 2.1.280 or newer is
 * required. Run 'claude update', or update the Claude desktop app, then try again." (2.1.258, seen on the owner's Mac; is_error true,
 * subtype "success", terminal_reason "api_error", api_error_status 400, no api_error_type). The stderr's "[claude-code:unrecognized_model]"
 * does not decide it: 2.1.327 prints the same tag for a model that does not exist (a 404, test/fixtures/claude-cli/2.1.327/).
 * Null when the words are not these; else the version needed and the version that refused, each when the words name it.
 */
const NEEDS_NEWER_CLI = /does not support this model\b|\bversion \d+\.\d+\.\d+ or newer is required\b/i;
export function modelNeedsNewerCli(message: string): { needsCli?: string; cliVersion?: string } | null {
  if (!NEEDS_NEWER_CLI.test(message) || !/\bmodel\b/i.test(message)) return null;
  const needs = /\bversion (\d+\.\d+\.\d+) or newer is required/i.exec(message)?.[1];
  const cli = /\bClaude Code (\d+\.\d+\.\d+) does not support\b/i.exec(message)?.[1];
  return { ...(needs ? { needsCli: needs } : {}), ...(cli ? { cliVersion: cli } : {}) };
}

/** Classifies a failed run: the structured signals first, the English words last (counted as a fallback when they decide). */
export function classifyFailure(f: RunFailure): ClaudeError {
  const status = typeof f.doc?.api_error_status === "number" ? f.doc.api_error_status : undefined;
  const apiType = typeof f.doc?.api_error_type === "string" ? f.doc.api_error_type : undefined;
  const resetsAt = f.signals?.resetsAt;
  const base = { ...(status !== undefined ? { status } : {}), ...(apiType !== undefined ? { apiType } : {}), ...(resetsAt ? { resetsAt } : {}) };
  const make = (kind: ClaudeTrouble, via: NonNullable<ClaudeFailure["via"]>): ClaudeError => new ClaudeError(f.message, kind, { ...base, via });
  if (f.spawnCode === "ENOENT") return make("missing", "spawn");
  // A model this Claude Code is too old for: an API error with a 400 (or no status), told apart from other 400s by its words only.
  const tooOld = status === undefined || status === 400 ? modelNeedsNewerCli(f.message) : null;
  if (tooOld) {
    noteFallback("error-text", `a model this Claude Code is too old for, from the words (status ${status ?? "none"})`);
    return new ClaudeError(f.message, "model-needs-newer-cli", { ...base, ...tooOld, via: "text" });
  }
  const byStatus = status !== undefined ? kindOfStatus(status) : null;
  if (byStatus) return make(byStatus, "status");
  const byType = apiType ? kindOfApiType(apiType) : null;
  if (byType) return make(byType, "type");
  const byStream = f.signals?.streamError ? kindOfStreamError(f.signals.streamError) : null;
  if (byStream) return make(byStream, "stream");
  if (f.signals?.rateLimited) return make("limit", "stream");
  const byText = classify(f.message);
  if (byText !== "other") {
    noteFallback("error-text", `${byText} from the words alone (status ${status ?? "none"}, type ${apiType ?? "none"})`);
    return make(byText, "text");
  }
  return make("other", "none");
}

/**
 * Whether a limit is only Claude being overloaded (HTTP 529, "overloaded_error", or the word), not this plan's usage limit: it usually passes
 * in minutes and names no reset, so the owner is told differently (runs.ts).
 */
export function overloaded(e: ClaudeError): boolean {
  if (e.kind !== "limit") return false;
  if (e.status === 529 || e.apiType === "overloaded_error") return true;
  if (e.status !== undefined || e.apiType !== undefined || e.resetsAt !== undefined) return false;
  return /overloaded/i.test(e.message);
}

/**
 * Whether a failed `--resume` says the conversation is not on this computer (cleared): the bridge then starts a new one. Claude Code gives
 * no structured field for it: "No conversation found with session ID: …" on the error output and exit 1, 2.1.327 (captured,
 * test/fixtures/claude-cli/2.1.327/no-such-session.stderr.txt); the other two wordings were kept from before 2.1.325.
 */
export const SESSION_MISSING = /no conversation found|could not find (the )?(session|conversation)|session .{0,60}not found/i;
export function sessionMissing(message: string): boolean {
  const yes = SESSION_MISSING.test(message);
  if (yes) noteFallback("error-text", "a resume that found no conversation, from the words");
  return yes;
}

/**
 * Whether a failed run says this account cannot use `model` now: the plan does not include it, the model is not there, or a limit that names
 * it ("You've hit your Opus limit"). An overloaded model is not one: that passes. Only asked of a run on the writing model (runs.ts), which
 * then runs again on the general model instead of failing. Structured first: a 404 not_found_error on a run that named a model is the model
 * (2.1.327, captured: test/fixtures/claude-cli/2.1.327/no-such-model.json).
 */
export function modelUnavailable(message: string, model: string, f: ClaudeFailure = {}): boolean {
  if (f.apiType === "not_found_error" || f.status === 404) return true;
  if (f.apiType === "overloaded_error" || f.status === 529) return false;
  const family = /(opus|sonnet|haiku)/i.exec(model)?.[1]?.toLowerCase() ?? "";
  const named = message.toLowerCase().includes(model.toLowerCase()) || (!!family && new RegExp(`\\b${family}\\b`, "i").test(message));
  // "There's an issue with the selected model (…). It may not exist or you may not have access to it.": 2.1.327 (captured).
  const gone = new RegExp(
    "\\b(?:invalid|unknown|unsupported) model\\b|not_found_error|issue with the selected model"
      + "|\\bmodel\\b.{0,80}\\b(?:not (?:found|available|supported|allowed|enabled|included)|unavailable|does(?: not|n't) exist)",
    "i",
  );
  const notHere = /not (?:available|found|supported|allowed|enabled|included)|unavailable|does(?: not|n't) exist|(?:no|not have|without) access|upgrade|not part of/i;
  if (gone.test(message)) return true;
  return named && (notHere.test(message) || (classify(message) === "limit" && !/overloaded/i.test(message)));
}
