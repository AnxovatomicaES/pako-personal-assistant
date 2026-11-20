// Whether this Claude Code still works the way the bridge drives it, asked of the program itself instead of read off its version number.
//
// At start, and whenever `claude --version` says something new (Claude Code updates itself while Pako runs), the bridge runs a self-test:
// the exact flags of its runs, three short `claude -p` runs side by side, about three seconds, no model tokens spent:
//   stream: the owner's conversation's flags (stream-json in and out, Pako's MCP server when its tools are on), on a model that does not
//           exist. Claude Code accepts every flag (an unknown one is "error: unknown option"), starts Pako's MCP server and lists its tools
//           in the init event (an MCP round trip through Claude Code), then the API refuses the model (404, nothing generated) and the
//           result event comes back: its shape is read as a real answer's would be;
//   json:   the background runs' flags (--output-format json, --effort when asked for), the same refused model: the result document's shape;
//   resume: --resume with a conversation id that is not on this computer: Claude Code says so before any API call, and the bridge must
//           recognise those words to start a new conversation (sessionMissing).
// Signed out or offline, Claude Code still answers each with a result (an error one): its shape is what is checked, not the answer.
//
// The outcome is kept per version (cli-probe.json in the state folder). A version that passes is used, logged, and shown on the panel's Health
// card as "tested by probe". A version that fails is still used for what it can do: with stream-json broken, every message gets a run of its
// own (the warm process and the typed tools off), with Pako's MCP server not loading, the tags; and the card shows the problem with the
// command that goes back to the last version that passed. Nothing is refused, and nothing fails silently.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { MCP_SERVER_NAME } from "../tools.ts";
import { buildClaudeArgs } from "./claude.ts";
import { SESSION_MISSING } from "./claude-errors.ts";
import { childEnv, claudeCommand } from "./cli.ts";
import { missingEssential, readResult } from "./cli-shape.ts";
import { CLAUDE_CODE_TESTED, compareVersions, parseClaudeVersion, readClaudeVersion, type CliCompat } from "./cli-version.ts";
import type { BridgeConfig } from "./config.ts";
import { mcpConfigFor, mcpDownIn } from "./mcp.ts";

/** A model name no account has: the API refuses it (404) before generating anything. */
export const PROBE_MODEL = "pako-self-test-no-such-model";
/** A conversation id no computer has. */
export const PROBE_SESSION = "00000000-0000-4000-8000-000000000000";
const PROBE_PROMPT = "Pako self-test.";

/** What one run of the self-test printed. `failed`: it could not start, or did not end in time (nothing is concluded from it). */
export interface ProbeRun {
  code: number | null;
  stdout: string;
  stderr: string;
  failed?: string;
}
export type ProbeExec = (args: string[], input: string) => Promise<ProbeRun>;

export interface ProbeOutcome {
  version: string;
  /** When it ran (ms). */
  at: number;
  ok: boolean;
  /** Each thing that did not work, as a sentence. */
  problems: string[];
  /** What works: the background runs' JSON, the conversation's stream-json, Pako's MCP server through it (null: not asked), --resume. */
  works: { json: boolean; stream: boolean; mcp: boolean | null; resume: boolean };
  /** The self-test could not run (no claude, a run that never ended): nothing is concluded, and it is not kept. */
  inconclusive?: string;
}

/** The outcomes kept per version, and the newest version that passed. */
export interface ProbeCache {
  versions: Record<string, ProbeOutcome>;
  lastGood?: string;
}

/** Commander's words for a flag or a value it refuses ("error: unknown option '--x'", "argument 'y' is invalid"). */
const OPTION_ERROR = /unknown option|error: option '|argument '[^']*' is invalid|missing required argument|too many arguments|unknown command/i;

const firstLine = (s: string): string => (s.split("\n").map((l) => l.trim()).find(Boolean) ?? "").slice(0, 160);

/** The flag a refusal names ("--input-format"), or "". */
const flagIn = (s: string): string => /(--[a-zA-Z][\w-]*)/.exec(s)?.[1] ?? "";

/** The self-test: the three runs side by side, read for what works. */
export async function probeCli(o: {
  version: string;
  exec: ProbeExec;
  tools: string[];
  noBare?: boolean;
  /** The background runs' effort, when this Claude Code takes --effort. */
  effort?: string;
  /** Pako's MCP config, when its typed tools are on. */
  mcp?: string;
  now?: number;
}): Promise<ProbeOutcome> {
  const base = { tools: o.tools, model: PROBE_MODEL, systemPrompt: PROBE_PROMPT, ...(o.noBare ? { noBare: true } : {}) };
  const userLine = `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "ok" }] } })}\n`;
  const [stream, json, resume] = await Promise.all([
    o.exec(buildClaudeArgs({ ...base, stream: true, ...(o.mcp ? { mcp: o.mcp } : {}) }), userLine),
    o.exec(buildClaudeArgs({ ...base, ...(o.effort ? { effort: o.effort } : {}) }), "ok"),
    o.exec(buildClaudeArgs(base, PROBE_SESSION), "ok"),
  ]);
  const at = o.now ?? Date.now();
  const works: ProbeOutcome["works"] = { json: false, stream: false, mcp: o.mcp ? false : null, resume: false };
  const off = [stream, json, resume].find((r) => r.failed);
  if (off) return { version: o.version, at, ok: false, problems: [], works, inconclusive: off.failed! };
  const problems: string[] = [];
  const cc = `Claude Code ${o.version || "(version unknown)"}`;
  const refused = (r: ProbeRun, what: string): boolean => {
    const line = `${r.stderr}\n${r.stdout}`.split("\n").find((l) => OPTION_ERROR.test(l));
    if (!line) return false;
    const flag = flagIn(line);
    problems.push(`${cc} refused ${flag ? `the flag ${flag}` : "a flag"} of ${what} ("${firstLine(line)}")`);
    return true;
  };

  // The conversation: stream-json, its init event (Pako's MCP server), its result event.
  if (!refused(stream, "the conversation's runs")) {
    const events = stream.stdout.split("\n").filter((l) => l.trim().startsWith("{"));
    const parsed = events.map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null; // a line cut short: passed over, as the bridge passes it over
      }
    });
    const initAt = parsed.findIndex((d) => d?.type === "system" && d.subtype === "init");
    if (o.mcp) {
      if (initAt < 0) problems.push(`${cc} gave no init event in stream-json: whether Pako's MCP server loaded cannot be read`);
      else {
        const down = mcpDownIn(events[initAt]!);
        const tools = parsed[initAt]!.tools;
        const listed = !Array.isArray(tools) || tools.some((t) => typeof t === "string" && t.startsWith(`mcp__${MCP_SERVER_NAME}__`));
        if (down === false && listed) works.mcp = true;
        else if (down === false) problems.push(`${cc} connected Pako's MCP server but listed none of its tools`);
        else problems.push(`${cc} did not connect Pako's MCP server (its typed tools would not load)`);
      }
    }
    const resultLine = [...events].reverse().find((l, i) => parsed[events.length - 1 - i]?.type === "result");
    const doc = resultLine ? readResult(resultLine) : null;
    const missing = missingEssential(doc, o.version);
    if (!doc) problems.push(`${cc} gave no result event in stream-json (it said: "${firstLine(stream.stderr || stream.stdout) || "nothing"}")`);
    else if (missing) problems.push(missing);
    else works.stream = true;
  }

  // The background runs: one JSON result document.
  if (!refused(json, "the background runs")) {
    const doc = readResult(json.stdout.trim());
    const missing = missingEssential(doc, o.version);
    if (!doc) problems.push(`${cc} gave no JSON result with --output-format json (it said: "${firstLine(json.stderr || json.stdout) || "nothing"}")`);
    else if (missing) problems.push(missing);
    else works.json = true;
  }

  // A conversation that is not on this computer: recognised, so the bridge starts a new one.
  if (!refused(resume, "a resumed conversation")) {
    if (SESSION_MISSING.test(`${resume.stderr}\n${resume.stdout}`)) works.resume = true;
    else problems.push(`${cc} no longer says a conversation to resume is missing in words Pako knows ("${firstLine(resume.stderr || resume.stdout)}")`);
  }
  return { version: o.version, at, ok: problems.length === 0, problems, works };
}

/** The file the outcomes are kept in. */
export const probeCachePath = (stateDir: string): string => join(stateDir, "cli-probe.json");

/** The outcomes kept so far; an empty cache when there is no file or it cannot be read (the self-test then runs again). */
export function loadProbeCache(file: string): ProbeCache {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as Partial<ProbeCache>;
    const versions = v.versions && typeof v.versions === "object" ? v.versions : {};
    return { versions, ...(typeof v.lastGood === "string" ? { lastGood: v.lastGood } : {}) };
  } catch {
    return { versions: {} }; // no file yet, or a broken one: the self-test runs again and writes it anew
  }
}

/** Keeps an outcome (not an inconclusive one): the newest twenty versions, and the newest that passed. */
export function recordProbe(cache: ProbeCache, r: ProbeOutcome): ProbeCache {
  if (r.inconclusive || !r.version) return cache;
  const versions = { ...cache.versions, [r.version]: r };
  const keep = Object.keys(versions).sort(compareVersions).slice(-20);
  const lastGood = r.ok && (!cache.lastGood || compareVersions(r.version, cache.lastGood) >= 0) ? r.version : cache.lastGood;
  return { versions: Object.fromEntries(keep.map((k) => [k, versions[k]!])), ...(lastGood ? { lastGood } : {}) };
}

export function saveProbeCache(file: string, cache: ProbeCache): void {
  try {
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, JSON.stringify(cache, null, 2), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.error(`could not keep the Claude Code self-test's outcome: ${(err as Error).message} (it runs again at the next start)`);
  }
}

/**
 * The command that installs Claude Code `version`: npm's when this `claude` is an npm package, the native installer's otherwise (Claude
 * Code's own installer puts it under ~/.local/share/claude). `resolve`: the program's real path, for the tests.
 */
export function fixCommand(bin: string, version: string, resolve: (bin: string) => string = realPathOf): string {
  const real = resolve(bin).replace(/\\/g, "/");
  const native = /\/\.local\/share\/claude\/|\/claude\/versions\//.test(real) && !/node_modules/.test(real);
  return native ? `claude install ${version}` : `npm i -g @anthropic-ai/claude-code@${version}`;
}

function realPathOf(bin: string): string {
  try {
    if (isAbsolute(bin)) return realpathSync(bin);
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
      const p = join(dir, bin);
      if (dir && existsSync(p)) return realpathSync(p);
    }
  } catch {
    /* not found: npm's command is given, the usual install */
  }
  return bin;
}

const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

/**
 * How this Claude Code stands, for the log and the panel: from the self-test when it ran, from the tested range when it could not. In the
 * range Pako's captured outputs come from, a pass is plain "ok"; outside it, "probed" with the day it passed.
 */
export function compatFrom(
  version: string, r: ProbeOutcome | null, cache: ProbeCache, fix: (v: string) => string,
  tested: { min: string; maxTested: string } = CLAUDE_CODE_TESTED,
): CliCompat {
  if (!version) return { version: "", status: "unknown", note: "Pako could not read which Claude Code this is (claude --version said no version)" };
  if (!r || r.inconclusive) {
    const why = r?.inconclusive ? `Pako's self-test could not run (${r.inconclusive.slice(0, 80)}), it tries again later` : "";
    const inRange = compareVersions(version, tested.min) >= 0 && compareVersions(version, tested.maxTested) <= 0;
    if (inRange) return { version, status: "ok" };
    const where = compareVersions(version, tested.maxTested) > 0 ? "newer" : "older";
    return { version, status: where, note: `Claude Code ${version} is ${where} than the versions Pako was tested with${why ? `; ${why}` : ""}` };
  }
  if (r.ok) {
    const inRange = compareVersions(version, tested.min) >= 0 && compareVersions(version, tested.maxTested) <= 0;
    return inRange ? { version, status: "ok" } : { version, status: "probed", note: `Claude Code ${version}: tested by probe (Pako's self-test passed on ${dayOf(r.at)})` };
  }
  const back = cache.lastGood && cache.lastGood !== version ? cache.lastGood : tested.maxTested;
  const keeps = r.works.json && !r.works.stream
    ? "Pako keeps answering, one claude run per message and without its typed tools"
    : r.works.mcp === false && r.works.stream
      ? "Pako keeps answering, through tags instead of its typed tools"
      : "Pako keeps trying";
  const more = r.problems.length > 1 ? ` (and ${r.problems.length - 1} more)` : "";
  return {
    version, status: "failed", lastGood: back,
    note: `Claude Code ${version} failed Pako's self-test: ${r.problems[0] ?? "unknown"}${more}. ${keeps}. To go back to ${back}: ${fix(back)}`,
  };
}

/** Runs `claude` with `args` and `input` on its standard input, from `cwd`, for at most `ms`. */
export function execClaude(bin: string, cwd: string, ms = 30_000): ProbeExec {
  return (args, input) => new Promise<ProbeRun>((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (r: ProbeRun): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const [cmd, a] = claudeCommand(bin, args);
    const child = spawn(cmd, a, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, cwd, env: { ...childEnv(process.env), NO_COLOR: "1" } });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout, stderr, failed: `a run took longer than ${Math.round(ms / 1000)} s` });
    }, ms);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (b: string) => {
      if (stdout.length < 1_000_000) stdout += b;
    });
    child.stderr.on("data", (b: string) => {
      if (stderr.length < 20_000) stderr += b;
    });
    child.on("error", (e) => finish({ code: null, stdout, stderr, failed: `could not start ${bin}: ${e.message}` }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

/**
 * The self-test kept up while the bridge runs: `check()` at start (before the bridge is built, so its choices hold from the first message),
 * then again on an idle round every `everyMs` (`due()`): a version not seen before is tested; a failed one again after an hour (a failure
 * may have been passing, like a slow start); a passed one is not tested again. Each outcome sets what the bridge uses (`config`): a
 * failure turns off what it found broken, and a later pass gives back what was asked for at start.
 */
export function createCliWatch(o: {
  config: BridgeConfig;
  readVersion?: () => string;
  exec?: ProbeExec;
  log?: (line: string) => void;
  now?: () => number;
  everyMs?: number;
  cacheFile?: string;
}) {
  const { config } = o;
  const now = o.now ?? Date.now;
  const log = o.log ?? ((l: string) => console.log(l));
  const file = o.cacheFile ?? probeCachePath(config.stateDir);
  const readVersion = o.readVersion ?? (() => readClaudeVersion(config.claudeBin));
  const exec = o.exec ?? execClaude(config.claudeBin, config.stateDir);
  const everyMs = o.everyMs ?? 10 * 60_000;
  // What was asked for at start, given back when a version passes after one that failed.
  const wanted = { warmMs: config.warmMs, mcpTools: config.mcpTools };
  let current: CliCompat | null = null;
  let checkedAt = 0;
  let seen = "";
  const apply = (r: ProbeOutcome | null): void => {
    if (!r || r.inconclusive) return;
    config.warmMs = r.works.stream || !r.works.json ? wanted.warmMs : 0;
    config.mcpTools = wanted.mcpTools && r.works.stream && r.works.mcp !== false;
  };
  return {
    async check(): Promise<CliCompat> {
      checkedAt = now();
      const version = parseClaudeVersion(readVersion()) ?? "";
      let cache = loadProbeCache(file);
      let r: ProbeOutcome | null = version ? cache.versions[version] ?? null : null;
      const stale = !!r && !r.ok && now() - r.at >= 60 * 60_000;
      // The same version as last time, with an outcome still good to go by: nothing to do. One that could not be tested is tried again.
      if (version === seen && current && (r || !version) && !stale) return current;
      if (version && (!r || stale)) {
        r = await probeCli({
          version, exec, tools: config.tools, ...(config.noBare ? { noBare: true } : {}),
          ...(config.effortOk && config.backgroundEffort ? { effort: config.backgroundEffort } : {}),
          ...(wanted.mcpTools ? { mcp: mcpConfigFor(config.stateDir) } : {}), now: now(),
        });
        cache = recordProbe(cache, r);
        if (!r.inconclusive) saveProbeCache(file, cache);
      }
      apply(r);
      const c = compatFrom(version, r, cache, (v) => fixCommand(config.claudeBin, v));
      if (c.status === "failed") for (const p of r?.problems ?? []) log(`Claude Code self-test: ${p}`);
      if (c.note) log(`${c.status === "failed" || c.status === "unknown" ? "Warning: " : ""}${c.note}`);
      else log(`Claude Code ${version}: Pako's self-test passed${r && !r.inconclusive ? ` on ${dayOf(r.at)}` : ""}`);
      seen = version;
      current = c;
      return c;
    },
    /** Whether an idle round should look at the version again. */
    due: (): boolean => now() - checkedAt >= everyMs,
    /** The last answer of check(). */
    compat: (): CliCompat | null => current,
  };
}

export type CliWatch = ReturnType<typeof createCliWatch>;
