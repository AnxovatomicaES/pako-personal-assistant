// How often the bridge fell back from a structured signal of Claude Code to a weaker one: counted, and logged the first time and every 25th.
// A Claude Code update that drops a field shows here as a fallback that suddenly decides every run, instead of a silent change of behaviour.
//   error-text:  a failure's kind decided by its English words (claude-errors.ts), not by a status, an error type or a stream event;
//   web-turns:   whether a run read the web decided by num_turns (claude.ts webRead), not by a WebSearch/WebFetch tool_use event;
//   tags:        an action taken from a text tag of the answer instead of a typed tool call (turn.ts): MCP was not available for the turn;
//   tags-beside-tools: an action taken from a tag although Pako's typed tools were loaded (the model wrote the old way; still honoured).

export type FallbackKind = "error-text" | "web-turns" | "tags" | "tags-beside-tools";

const counts: Record<FallbackKind, number> = { "error-text": 0, "web-turns": 0, tags: 0, "tags-beside-tools": 0 };
let logLine: (line: string) => void = (line) => console.log(`${new Date().toISOString()} ${line}`);

/** Where the lines go (the bridge's own log, set when it is built). */
export function setFallbackLog(log: (line: string) => void): void {
  logLine = log;
}

/** Counts one fallback, and logs it the first time and every 25th time after. */
export function noteFallback(kind: FallbackKind, detail: string): void {
  const n = ++counts[kind];
  if (n === 1 || n % 25 === 0) logLine(`fallback ${kind} (${n} so far in this run): ${detail}`);
}

/** The counts since this process started (tests, and the log). */
export const fallbackCounts = (): Readonly<Record<FallbackKind, number>> => ({ ...counts });

/** Back to zero (tests). */
export function resetFallbacks(): void {
  for (const k of Object.keys(counts) as FallbackKind[]) counts[k] = 0;
}
