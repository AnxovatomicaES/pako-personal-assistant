// Reading a result of `claude -p` without leaning on one Claude Code version's exact shape. The result document (`--output-format json`, and
// the "result" line of stream-json) is read for a handful of fields; everything else in it is ignored, so a field Claude Code adds changes
// nothing. A field Claude Code renames to its camelCase spelling (session_id -> sessionId) or to a known alternative is still found, and that
// is counted as a fallback (fallbacks.ts): seen in the log, not guessed. `--output-format json` with --verbose writes an array of every event
// instead of the one result: the last "result" event of it is taken. Only a result with no answer text under any name is an error, and the
// error says which fields it did have, so a Claude Code that changed its output is named for what it is.

import { noteFallback } from "./fallbacks.ts";

/**
 * The fields Pako reads, each with the other names Claude Code could give it. The first name is the one 2.1.325 to 2.1.327 write
 * (test/fixtures/claude-cli/2.1.327/); the camelCase spelling of each is always accepted too.
 */
export const RESULT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  result: ["text", "output", "response"],
  session_id: ["session"],
  total_cost_usd: ["cost_usd", "costUSD", "cost"],
  num_turns: ["turns"],
  is_error: ["error"],
  subtype: [],
  api_error_status: ["error_status", "status_code"],
  api_error_type: ["error_type"],
  terminal_reason: [],
  usage: [],
};

const camel = (s: string): string => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** The names `field` may come under, the usual one first. */
export const namesOf = (field: string): string[] => [...new Set([field, camel(field), ...(RESULT_ALIASES[field] ?? [])])];

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Whether a value is what `field` holds (an `error` that is an object is an error's details, not is_error's yes or no). */
function fits(field: string, v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (field === "result" || field === "session_id" || field === "subtype" || field === "api_error_type" || field === "terminal_reason") {
    return typeof v === "string";
  }
  if (field === "is_error") return typeof v === "boolean";
  if (field === "usage") return isRecord(v);
  return typeof v === "number";
}

/**
 * A result document with each field Pako reads under its usual name: found under another name, it is copied to the usual one (and counted
 * as a fallback, once per field per process in the log). The document's other fields are kept as they are, and ignored.
 */
export function normalizeResult(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...doc };
  for (const field of Object.keys(RESULT_ALIASES)) {
    if (fits(field, out[field])) continue;
    const alt = namesOf(field).slice(1).find((n) => fits(field, doc[n]));
    if (!alt) continue;
    out[field] = doc[alt];
    noteFallback("result-shape", `the result's ${field} was found as ${alt}`);
  }
  return out;
}

/**
 * The result document in what `--output-format json` (or a "result" line of stream-json) wrote: the object itself, or the last "result"
 * event of an array of events. Null when it is not JSON, or holds no result.
 */
export function readResult(out: string): Record<string, unknown> | null {
  let v: unknown;
  try {
    v = JSON.parse(out);
  } catch {
    return null; // not JSON at all: the caller says what came instead
  }
  if (Array.isArray(v)) {
    const last = [...v].reverse().find((e) => isRecord(e) && e.type === "result");
    return last ? normalizeResult(last as Record<string, unknown>) : null;
  }
  return isRecord(v) ? normalizeResult(v) : null;
}

/**
 * Why a result Pako needs to read cannot be read, or null when it can: its answer text is the one field nothing works without. The sentence
 * names the fields it had (names only, never values) and the version, for the log and the panel.
 */
export function missingEssential(doc: Record<string, unknown> | null, version = ""): string | null {
  if (!doc) return null;
  if (typeof doc.result === "string") return null;
  const had = Object.keys(doc).slice(0, 40).join(", ") || "none";
  const cc = version ? `Claude Code ${version}` : "This Claude Code";
  return `${cc} gave a result with no answer text under any name Pako knows (${namesOf("result").join(", ")}; it had: ${had})`;
}
