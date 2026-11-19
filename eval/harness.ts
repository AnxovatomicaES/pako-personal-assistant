// The live chat eval (eval/README.md): one owner's turn through the bridge's own code, end to end. A case gives the owner's message and the
// context the server would send (the time, the notes, an email, a calendar line...); the bridge (assistant/bridge.ts createBridge) asks a
// fake server for that context, builds the prompt with its own contextBlock, runs `claude -p` exactly as it does for the owner, reads the
// tags with parseReply (and, with Pako's tools on, folds in the tool calls: readReply) and posts the reply, which the fake server keeps.
// Nothing of the prompt or the parsing is copied here. A check on a tag passes the same whether the model wrote the tag or called its tool.
//
// Each case holds binary checks, judged by code on what the bridge read from the answer: a tag there or not, a reminder's exact time, the
// language of the words, a pattern in the reply. A case may add one yes/no question for an LLM judge, asked only when every code check passed.
//
// test/evals/ is the other harness: golden cases for the server's validators (followups, brief, autonomy, memory) with recorded answers in
// the gate. This one covers the main chat turn, and only runs live (never in the gate): its cases record no answer.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridge, readReply, runClaude, type BridgeConfig, type ClaudeResult, type ParsedReply } from "../assistant/bridge.ts";
import { zonedTime } from "../src/followups.ts";
import { locale } from "../src/i18n.ts";
import { readLanguage } from "../src/language.ts";
import { fenced, RUBRIC_PROMPT } from "../test/evals/live.ts";

export const AREAS = ["reminders", "memory", "drafting", "injection", "language", "followups", "refusal", "ambiguous"] as const;
export type Area = (typeof AREAS)[number];

/** Every tag parseReply reads, by the field it gives. */
export const TAGS = [
  "remember", "forget", "call", "message", "send", "email", "remind", "unremind", "lists", "tasks", "done", "people", "routines", "watches",
  "facts", "know", "health", "goals", "cards", "slack", "book",
] as const;
export type TagName = (typeof TAGS)[number];

/**
 * One binary check. Patterns are regular expressions, matched case-blind (flags "iu").
 * - tag: how many of that tag the answer had (`count` exactly, or `min` / `max`).
 * - remindAt: some <remind> is at exactly that "YYYY-MM-DD HH:MM" (and repeats `every`, when given).
 * - tagText: some instance of the tag has words that match (`not`: none does; no instance passes).
 * - tagAttr: some instance has the field (as parseReply gives it: a call's `name`, a message's `to`) matching.
 * - reply: the words the owner reads (the tags taken out) match (`not`: do not).
 * - language: those words are in that language (src/language.ts: clear, or leaning to it when short).
 * - noActions: no tag at all, but those in `except`.
 * - asks: the reply asks the owner something (a question mark).
 */
export type Check = { name?: string } & (
  | { check: "tag"; tag: TagName; count?: number; min?: number; max?: number }
  | { check: "remindAt"; at: string; every?: string }
  | { check: "tagText"; tag: TagName; pattern: string; not?: boolean }
  | { check: "tagAttr"; tag: TagName; attr: string; pattern: string }
  | { check: "reply"; pattern: string; not?: boolean }
  | { check: "language"; lang: "es" | "en" }
  | { check: "noActions"; except?: TagName[] }
  | { check: "asks" }
);

export interface EvalCase {
  /** The file's name without .json. */
  id: string;
  area: Area;
  /** What it shows, as a test name. */
  behaviour: string;
  origin?: string;
  input: {
    /** The owner's local time now, "YYYY-MM-DD HH:MM". */
    now: string;
    timeZone?: string;
    /**
     * The language heard from the owner before (the context's "language" and "chatLanguage": an ISO code). Pako's own texts and context
     * lines are English whatever it is, as on a real server.
     */
    ownerLanguage?: string;
    message: string;
    /** Passed on from someone else (WhatsApp's forwarded flag): the bridge fences it as outside text. */
    forwarded?: boolean;
    /** What the server's /assistant/context adds or changes (assistant/bridge.ts Context): notes, contacts, emails, calendar... */
    context?: Record<string, unknown>;
  };
  checks: Check[];
  /** A yes/no question for an LLM judge, asked only when every code check passed. */
  judge?: string;
}

export const CASES_DIR = new URL("./cases/", import.meta.url);

const asRegExp = (p: string, where: string): RegExp => {
  try {
    return new RegExp(p, "iu");
  } catch (err) {
    throw new Error(`${where}: not a pattern: ${(err as Error).message}`);
  }
};

/** A case as its file holds it, every part checked: a broken case fails loudly before anything runs (or costs). */
export function validCase(raw: unknown, id: string): EvalCase {
  const c = raw as EvalCase;
  const bad = (why: string): never => {
    throw new Error(`${id}: ${why}`);
  };
  if (!c || typeof c !== "object") bad("not an object");
  if (!(AREAS as readonly string[]).includes(c.area)) bad(`area must be one of ${AREAS.join(", ")}`);
  if (typeof c.behaviour !== "string" || !c.behaviour.trim() || /\bTODO\b/.test(c.behaviour)) bad("needs a behaviour (and no TODO)");
  const i = c.input;
  if (!i || typeof i.message !== "string" || !i.message.trim() || /\bTODO\b/.test(i.message)) bad("input.message is needed (and no TODO)");
  if (zonedTime(i.now, i.timeZone ?? "UTC") === null) bad(`input.now must be "YYYY-MM-DD HH:MM" in input.timeZone`);
  if ("lang" in i) bad("input.lang is gone: Pako's own texts are English only (input.ownerLanguage is the language heard from the owner)");
  if (i.ownerLanguage !== undefined && !/^[a-z]{2,3}$/.test(i.ownerLanguage)) bad("input.ownerLanguage is a language code like es or en");
  if (!Array.isArray(c.checks) || !c.checks.length) bad("needs at least one check");
  if (c.judge !== undefined && (typeof c.judge !== "string" || !c.judge.trim() || /\bTODO\b/.test(c.judge))) bad("judge is a yes/no question");
  c.checks.forEach((k, n) => {
    const at = `${id} check ${n + 1}`;
    if ("tag" in k && !(TAGS as readonly string[]).includes(k.tag)) throw new Error(`${at}: unknown tag ${String(k.tag)}`);
    if ("pattern" in k) asRegExp(k.pattern, at);
    switch (k.check) {
      case "tag":
        if (k.count === undefined && k.min === undefined && k.max === undefined) throw new Error(`${at}: tag needs count, min or max`);
        break;
      case "remindAt":
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(k.at)) throw new Error(`${at}: at is "YYYY-MM-DD HH:MM"`);
        break;
      case "tagText": case "tagAttr": case "reply": case "asks":
        break;
      case "language":
        if (k.lang !== "es" && k.lang !== "en") throw new Error(`${at}: lang is es or en`);
        break;
      case "noActions":
        if (k.except?.some((t) => !(TAGS as readonly string[]).includes(t))) throw new Error(`${at}: unknown tag in except`);
        break;
      default:
        throw new Error(`${at}: unknown check ${String((k as { check?: unknown }).check)}`);
    }
  });
  return { ...c, id };
}

/** Every case in eval/cases/*.json, sorted by name. */
export function loadCases(dir: URL = CASES_DIR): EvalCase[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => validCase(JSON.parse(readFileSync(new URL(f, dir), "utf8")), f.replace(/\.json$/, "")));
}

/** The context the fake server sends: what a current server sends for an owner with nothing yet, and the case's own on top. */
export function contextOf(c: EvalCase): Record<string, unknown> {
  const tz = c.input.timeZone ?? "UTC";
  const at = zonedTime(c.input.now, tz)!;
  return {
    now: new Intl.DateTimeFormat(locale(), {
      timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
    }).format(at),
    ownerName: "Alex",
    timeZone: tz,
    contacts: [],
    memory: "",
    events: [],
    outsideEvents: [],
    nowLocal: c.input.now,
    reminders: [],
    lists: [],
    tasks: [],
    companion: 1,
    routinesOn: 1,
    paused: false,
    pauseWhy: null,
    ...(c.input.ownerLanguage ? { language: c.input.ownerLanguage } : {}),
    quarantine: 2,
    uiLanguage: "en",
    lifeOn: 1,
    knowOn: 1,
    autonomy: 1,
    emailOn: false,
    ...c.input.context,
  };
}

/** What one turn gave: the answer as Claude wrote it, as the bridge read it, and what the bridge posted to the server. */
export interface Outcome {
  raw: string;
  reply: ParsedReply;
  /** The bodies posted to /assistant/reply and /assistant/memory. */
  sent: Record<string, unknown>[];
  notes: Record<string, unknown>[];
  /** The prompt the bridge built (its context lines and the message). */
  prompt: string;
  /** The bridge marked the turn as outside text (the server holds its tags for the owner's press). */
  held: boolean;
  costUsd: number;
  ms: number;
}

type Run = typeof runClaude;

/**
 * One owner's turn through the bridge, against a fake server that serves the case's context and keeps what is posted. A fresh state folder
 * each time (a new conversation, nothing resumed), removed after. A failed run of Claude throws (a limit, a lost login, a timeout): it is no
 * answer to judge.
 */
export async function runTurn(c: EvalCase, config: BridgeConfig, run: Run = runClaude): Promise<Outcome> {
  const dir = mkdtempSync(join(tmpdir(), "pako-eval-turn-"));
  const ctx = contextOf(c);
  const sent: Record<string, unknown>[] = [];
  const notes: Record<string, unknown>[] = [];
  let first: { prompt: string; result: ClaudeResult } | null = null;
  let failure: unknown = null;
  const fake = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url)).pathname;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (path === "/assistant/context") return Response.json(ctx);
    if (path === "/assistant/reply") return (sent.push(body), Response.json({ ok: true }));
    if (path === "/assistant/memory") return (notes.push(body), Response.json({ ok: true }));
    if (path === "/assistant/health") return Response.json({ ok: true });
    if (path === "/assistant/slack/search") return Response.json({ results: [] });
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;
  const t0 = Date.now();
  let cost = 0;
  try {
    const bridge = createBridge({
      config: { ...config, stateDir: dir, noticeMs: 600_000 },
      fetch: fake,
      log: () => undefined,
      replyWaitsMs: [0],
      run: async (prompt, cfg, sessionId) => {
        try {
          const r = await run(prompt, cfg, sessionId);
          cost += r.costUsd;
          first ??= { prompt, result: r };
          return r;
        } catch (err) {
          failure ??= err;
          throw err;
        }
      },
    });
    await bridge.handle({ id: `eval-${c.id}-${t0}`, at: t0, text: c.input.message, ...(c.input.forwarded ? { forwarded: true } : {}) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (failure) throw failure;
  const got = first as { prompt: string; result: ClaudeResult } | null;
  if (!got) throw new Error("the bridge never ran Claude for this message");
  return {
    raw: got.result.text,
    reply: readReply(got.result),
    sent,
    notes,
    prompt: got.prompt,
    held: sent.some((b) => b.outside !== undefined || b.context !== undefined),
    costUsd: cost,
    ms: Date.now() - t0,
  };
}

// ---------- the checks ----------

export interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
}

/** The instances of a tag in a parsed answer. */
const instances = (r: ParsedReply, tag: TagName): unknown[] => {
  const v = (r as unknown as Record<string, unknown>)[tag];
  return v === null || v === undefined ? [] : Array.isArray(v) ? v : [v];
};
/** An instance's words, whatever its shape (a note, a reminder's text, a message's text and subject, a list's items). */
const wordsOf = (x: unknown): string =>
  typeof x === "string" ? x : x && typeof x === "object" ? Object.values(x).map(wordsOf).join(" ") : x === undefined || x === null ? "" : String(x);

export const tagCounts = (r: ParsedReply): Partial<Record<TagName, number>> =>
  Object.fromEntries(TAGS.map((t) => [t, instances(r, t).length]).filter(([, n]) => n));

const nameOf = (k: Check): string => {
  if (k.name) return k.name;
  switch (k.check) {
    case "tag": return `<${k.tag}> ${k.count !== undefined ? `×${k.count}` : `${k.min ?? 0}..${k.max ?? "∞"}`}`;
    case "remindAt": return `<remind> at ${k.at}${k.every ? ` every ${k.every}` : ""}`;
    case "tagText": return `<${k.tag}> ${k.not ? "never" : "says"} /${k.pattern}/`;
    case "tagAttr": return `<${k.tag}> ${k.attr} /${k.pattern}/`;
    case "reply": return `reply ${k.not ? "never" : "says"} /${k.pattern}/`;
    case "language": return `in ${k.lang}`;
    case "noActions": return `no tag${k.except?.length ? ` but ${k.except.join(", ")}` : ""}`;
    case "asks": return "asks the owner";
  }
};

const cut = (s: string, n = 160): string => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, " ");

/** One check on one outcome. */
export function runCheck(k: Check, o: Outcome): CheckResult {
  const r = o.reply;
  const res = (pass: boolean, detail?: string): CheckResult => ({ name: nameOf(k), pass, ...(pass || !detail ? {} : { detail }) });
  switch (k.check) {
    case "tag": {
      const n = instances(r, k.tag).length;
      const pass = (k.count === undefined || n === k.count) && (k.min === undefined || n >= k.min) && (k.max === undefined || n <= k.max);
      return res(pass, `had ${n}`);
    }
    case "remindAt": {
      const all = r.remind;
      const pass = all.some((x) => x.at === k.at && (k.every === undefined || x.every === k.every));
      return res(pass, all.length ? `had ${all.map((x) => `${x.at}${x.every ? ` every ${x.every}` : ""}`).join(", ")}` : "no <remind>");
    }
    case "tagText": {
      const re = asRegExp(k.pattern, nameOf(k));
      const hits = instances(r, k.tag).filter((x) => re.test(wordsOf(x)));
      return k.not ? res(!hits.length, `had ${cut(wordsOf(hits[0]))}`) : res(hits.length > 0, `had ${instances(r, k.tag).map((x) => cut(wordsOf(x))).join(" | ") || "none"}`);
    }
    case "tagAttr": {
      const re = asRegExp(k.pattern, nameOf(k));
      const got = instances(r, k.tag).map((x) => (x && typeof x === "object" ? wordsOf((x as Record<string, unknown>)[k.attr]) : ""));
      return res(got.some((v) => re.test(v)), `had ${got.join(" | ") || "none"}`);
    }
    case "reply": {
      const hit = asRegExp(k.pattern, nameOf(k)).test(r.text);
      return res(k.not ? !hit : hit, `reply: ${cut(r.text)}`);
    }
    case "language": {
      const l = readLanguage(r.text);
      const said = l.clear ?? l.lean;
      return res(said === k.lang, `read as ${said ?? "unclear"}: ${cut(r.text, 80)}`);
    }
    case "noActions": {
      const counts = tagCounts(r);
      const extra = Object.keys(counts).filter((t) => !(k.except ?? []).includes(t as TagName));
      return res(!extra.length, `had ${extra.map((t) => `<${t}>`).join(", ")}`);
    }
    case "asks":
      return res(/[?¿]/.test(r.text), `reply: ${cut(r.text)}`);
  }
}

export const runChecks = (c: EvalCase, o: Outcome): CheckResult[] => c.checks.map((k) => runCheck(k, o));

/**
 * The LLM judge for what code cannot decide: one yes/no question about one output, in a run of its own with no tools, the material fenced as
 * test/evals/live.ts fences it. PASS or FAIL, nothing in between.
 */
export async function judgeTurn(c: EvalCase, o: Outcome, config: BridgeConfig, run: Run = runClaude): Promise<{ pass: boolean; why: string; costUsd: number }> {
  const actions = JSON.stringify(Object.fromEntries(TAGS.map((t) => [t, instances(o.reply, t)]).filter(([, v]) => (v as unknown[]).length)));
  const f = fenced(`QUESTION: ${c.judge}\n\nMATERIAL (what the assistant was given):\n${o.prompt}\n\nOUTPUT (the reply the owner reads):\n${o.reply.text}\n\n`
    + `ACTIONS the reply asked for (tags; {} = none):\n${actions}`, "JUDGE");
  const dir = mkdtempSync(join(tmpdir(), "pako-eval-judge-"));
  try {
    const r = await run(f.prompt, { ...config, tools: [], stateDir: dir, systemPrompt: RUBRIC_PROMPT.replaceAll("JUDGE", f.fence) });
    const said = r.text.trim();
    return { pass: /^PASS\b/i.test(said), why: said.slice(0, 200), costUsd: r.costUsd };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
