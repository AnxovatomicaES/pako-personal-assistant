// Quality: whether what Pako says on its own is worth saying, measured from day one.
//
// - Feedback: every follow-up nudge carries a quiet 👍/👎 (buttons after its three where the chat has room for them: Telegram, the panel's
//   chat; on WhatsApp, three at most, a "Useful? yes/no" line instead, answered by text). The written brief says the same line on the chat,
//   and its page has 👍/👎 on every to-do and update. A typed "yes"/"no" counts only as the very next thing after the card or the brief:
//   anything Pako sends or the owner writes meanwhile and the question is gone (a "no" is never taken from another conversation).
// - What is kept (FEEDBACK_KEY, 90 days): each verdict {what, verdict, when, source} and each nudge given with what the owner pressed on it.
// - Read back as the panel's "Quality" card (the last 7 days: nudges sent, Done, Not mine, ignored, 👍/👎, the brief's 👍/👎) and, on a
//   Monday only, ONE line in the brief when the nudges did poorly ("3 of 7 nudges weren't useful: tell me what to ignore"). Never more than that.

import express, { type Express, type Request, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import type { FollowupsQuality } from "./followups.ts";
import { texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import { createLog } from "./log.ts";

const log = createLog("quality");

export const FEEDBACK_KEY = "feedback";
const TTL_SECONDS = 90 * 24 * 3600;
const KEEP_MS = 90 * 24 * 3600_000;
const WEEK_MS = 7 * 24 * 3600_000;
/** A nudge nobody answered (no press, no 👍/👎) for this long counts as ignored. */
const IGNORED_AFTER_MS = 12 * 3600_000;
/** A typed "yes"/"no" answers the last card or brief for this long at most. */
const ASK_MS = 6 * 3600_000;
const VERDICTS_MAX = 600;
const NUDGES_MAX = 400;
const WHAT_MAX = 160;
const HEX10 = /^[0-9a-f]{10}$/;

/** g1/g0: a nudge's 👍/👎 (the loop's id); h1/h0: the brief's on the chat (the brief's id). */
export const FEEDBACK_BUTTON = /^([gh])([01]):([0-9a-f]{10})$/;

export type FeedbackSource = "nudge" | "brief" | "brief_todo" | "brief_update";
export interface Verdict {
  /** What was judged, as the owner read it (a nudge's title, "brief 2026-11-16", a to-do's title). */
  what: string;
  verdict: "up" | "down";
  at: number;
  source: FeedbackSource;
  /** The loop's id, the brief's id, or the brief's id and the item (abc.t2, abc.u0). */
  ref: string;
}
interface NudgeSeen {
  at: number;
  ref: string;
  what: string;
  /** What the owner pressed on it: Done, In 1 h, Not mine. */
  outcome?: "done" | "snooze" | "notmine";
}
interface State {
  verdicts: Verdict[];
  nudges: NudgeSeen[];
}

export interface QualityStats {
  days: 7;
  nudges: { sent: number; done: number; notMine: number; snoozed: number; ignored: number; up: number; down: number };
  brief: { up: number; down: number };
  /** Nudges that did not serve: Not mine or 👎, each nudge once. */
  unhelpful: number;
}

const T = texts(
  {
    line: "Useful? Reply yes or no.",
    briefLine: "Was the brief useful? Reply yes or no.",
    thanksUp: "Noted 👍",
    thanksDown: "Noted 👎. If something like it isn't yours, press “Not mine” and I won't say it again.",
    thanksBriefDown: "Noted 👎. Tell me what to leave out or what was missing, and I'll keep it in mind.",
    gone: "I no longer have that.",
    monday: "{n} of {of} reminders weren't useful to you: tell me what to ignore.",
    brief: "brief of {day}",
    week: "Quality, last 7 days: {sent} reminders ({done} done, {notMine} not yours, {ignored} unanswered), 👍 {up} · 👎 {down}; "
      + "the brief, 👍 {bup} · 👎 {bdown}.",
    weekNone: "Quality, last 7 days: no reminders and no 👍/👎 yet.",
  },
);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const SOURCES: readonly FeedbackSource[] = ["nudge", "brief", "brief_todo", "brief_update"];

/** The stored record, every part checked. */
export function qualityStateOf(raw: unknown): State {
  const o = isObject(raw) ? raw : {};
  const verdicts = (Array.isArray(o.verdicts) ? o.verdicts : []).flatMap((v): Verdict[] =>
    isObject(v) && typeof v.at === "number" && (v.verdict === "up" || v.verdict === "down") && SOURCES.includes(v.source as FeedbackSource)
      && typeof v.ref === "string" && typeof v.what === "string"
      ? [{ what: v.what.slice(0, WHAT_MAX), verdict: v.verdict, at: v.at, source: v.source as FeedbackSource, ref: v.ref.slice(0, 24) }]
      : []);
  const nudges = (Array.isArray(o.nudges) ? o.nudges : []).flatMap((n): NudgeSeen[] =>
    isObject(n) && typeof n.at === "number" && typeof n.ref === "string" && HEX10.test(n.ref) && typeof n.what === "string"
      ? [{
          at: n.at, ref: n.ref, what: n.what.slice(0, WHAT_MAX),
          ...(n.outcome === "done" || n.outcome === "snooze" || n.outcome === "notmine" ? { outcome: n.outcome } : {}),
        }]
      : []);
  return { verdicts: verdicts.slice(-VERDICTS_MAX), nudges: nudges.slice(-NUDGES_MAX) };
}

/** The last 7 days, as the panel's card shows them. */
export function statsOf(s: State, now: number): QualityStats {
  const since = now - WEEK_MS;
  const sent = s.nudges.filter((n) => n.at >= since);
  const verdicts = s.verdicts.filter((v) => v.at >= since);
  const judged = new Map(s.verdicts.filter((v) => v.source === "nudge").map((v) => [v.ref, v.verdict]));
  const nudgeVerdicts = verdicts.filter((v) => v.source === "nudge");
  const briefVerdicts = verdicts.filter((v) => v.source !== "nudge");
  const refs = new Set(sent.map((n) => n.ref));
  const unhelpful = new Set([
    ...sent.filter((n) => n.outcome === "notmine").map((n) => n.ref),
    ...[...refs].filter((r) => judged.get(r) === "down"),
  ]);
  return {
    days: 7,
    nudges: {
      sent: sent.length,
      done: sent.filter((n) => n.outcome === "done").length,
      notMine: sent.filter((n) => n.outcome === "notmine").length,
      snoozed: sent.filter((n) => n.outcome === "snooze").length,
      ignored: sent.filter((n) => !n.outcome && !judged.has(n.ref) && now - n.at >= IGNORED_AFTER_MS).length,
      up: nudgeVerdicts.filter((v) => v.verdict === "up").length,
      down: nudgeVerdicts.filter((v) => v.verdict === "down").length,
    },
    brief: { up: briefVerdicts.filter((v) => v.verdict === "up").length, down: briefVerdicts.filter((v) => v.verdict === "down").length },
    unhelpful: unhelpful.size,
  };
}

/** Poor: at least 3 nudges in the week, at least 2 of them not useful, and that is a third of them or more. */
export const poorPrecision = (q: QualityStats): boolean => q.nudges.sent >= 3 && q.unhelpful >= 2 && q.unhelpful * 3 >= q.nudges.sent;

/** A typed answer to "Useful?": yes, no, or not one. */
export function verdictOfText(text: string): "up" | "down" | null {
  const raw = text.trim();
  if (/^👍(?:\p{EMod})?$/u.test(raw)) return "up";
  if (/^👎(?:\p{EMod})?$/u.test(raw)) return "down";
  const w = raw.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, " ").trim();
  // English words only, like every command: the card asks "Useful?" in English.
  if (/^(yes|useful|yes useful)$/.test(w)) return "up";
  if (/^(no|not useful)$/.test(w)) return "down";
  return null;
}

export interface QualityDeps {
  kv: Kv | null;
  timeZone: string;
  now?: () => number;
  lang?: () => Lang;
}

interface Asking {
  source: "nudge" | "brief";
  ref: string;
  what: string;
  at: number;
}

export function createQuality(d: QualityDeps) {
  const now = d.now ?? Date.now;
  const lang = d.lang ?? ((): Lang => "en");
  let memory: State = { verdicts: [], nudges: [] };
  let chain: Promise<unknown> = Promise.resolve();
  /** The one card or brief a typed "yes"/"no" can answer now (in memory: a restart forgets the question, never takes a wrong answer). */
  let asking: Asking | null = null;

  /** The record after the changes already asked for (a nudge counted a moment ago is in it). */
  const read = async (): Promise<State> => {
    await chain.catch(() => undefined);
    return readNow();
  };
  const readNow = async (): Promise<State> => {
    if (!d.kv) return structuredClone(memory);
    const raw = await d.kv.get(FEEDBACK_KEY);
    if (!raw) return { verdicts: [], nudges: [] };
    try {
      return qualityStateOf(JSON.parse(raw));
    } catch {
      log.error("the stored record is not valid JSON: starting again");
      return { verdicts: [], nudges: [] };
    }
  };
  /** One change at a time; what is older than 90 days goes with every write. */
  const mutate = <R>(fn: (s: State) => R): Promise<R> => {
    const run = chain.then(async () => {
      const s = await readNow();
      const out = fn(s);
      const t = now();
      s.verdicts = s.verdicts.filter((v) => t - v.at < KEEP_MS).slice(-VERDICTS_MAX);
      s.nudges = s.nudges.filter((n) => t - n.at < KEEP_MS).slice(-NUDGES_MAX);
      if (d.kv) await d.kv.set(FEEDBACK_KEY, JSON.stringify(s), TTL_SECONDS);
      memory = s;
      return out;
    });
    chain = run.catch(() => undefined);
    return run;
  };
  const quietly = (p: Promise<unknown>, what: string): void => void p.catch((err: Error) => log.error(`${what}: ${err.message}`));

  /** One verdict per thing judged: a second press changes the first. */
  const record = (v: Omit<Verdict, "at">): Promise<void> =>
    mutate((s) => {
      s.verdicts = [...s.verdicts.filter((x) => !(x.ref === v.ref && x.source === v.source)), { ...v, what: v.what.slice(0, WHAT_MAX), at: now() }];
    });

  const thanks = (source: FeedbackSource, verdict: "up" | "down", l: Lang): string =>
    T(l)(verdict === "up" ? "thanksUp" : source === "nudge" ? "thanksDown" : "thanksBriefDown");

  /** The engine's side (src/followups.ts): the 👍/👎 a nudge carries, each nudge given, each press on one. */
  const followups: FollowupsQuality = {
    ask: (loop, lg) => ({
      buttons: [{ id: `g1:${loop.id}`, title: "👍" }, { id: `g0:${loop.id}`, title: "👎" }],
      line: T(lg)("line"),
    }),
    nudged: (loop, sent) => {
      if (!HEX10.test(loop.id)) return;
      quietly(mutate((s) => void s.nudges.push({ at: now(), ref: loop.id, what: loop.title.slice(0, WHAT_MAX) })), "a nudge could not be counted");
      asking = sent ? { source: "nudge", ref: loop.id, what: loop.title, at: now() } : null;
    },
    pressed: (button, loop) => {
      const outcome = button === "1" ? "done" : button === "2" ? "snooze" : "notmine";
      quietly(mutate((s) => {
        const n = s.nudges.filter((x) => x.ref === loop.id).pop();
        if (n) n.outcome = outcome;
      }), "a press could not be counted");
    },
  };

  return {
    followups,
    /** Anything else Pako sends: the question is no longer the last thing the owner read. */
    clearAsk: (): void => {
      asking = null;
    },
    /** The written brief went to the chat with its "Was this useful?" line. */
    briefAsked: (doc: { id: string; day: string }): void => {
      if (HEX10.test(doc.id)) asking = { source: "brief", ref: doc.id, what: T(lang())("brief", { day: doc.day }), at: now() };
    },
    /** The line the brief ends with on the chat. */
    briefLine: (l: Lang = lang()): string => T(l)("briefLine"),
    /**
     * A message the owner typed: when it is a yes or a no and the last thing Pako sent was a card or a brief that asked, its verdict is kept and
     * the thanks returned; otherwise null (the message goes on as before). Either way the question is gone.
     */
    answerText: async (text: string): Promise<string | null> => {
      const a = asking;
      asking = null;
      const verdict = verdictOfText(text);
      if (!a || !verdict || now() - a.at > ASK_MS) return null;
      await record({ what: a.what, verdict, source: a.source, ref: a.ref });
      return thanks(a.source, verdict, lang());
    },
    /** A 👍/👎 button (FEEDBACK_BUTTON); null when the id is not one. */
    press: async (buttonId: string, what: (kind: "nudge" | "brief", ref: string) => Promise<string | null>): Promise<string | null> => {
      const m = FEEDBACK_BUTTON.exec(buttonId);
      if (!m) return null;
      const source = m[1] === "g" ? "nudge" : "brief";
      const verdict = m[2] === "1" ? "up" : "down";
      asking = null;
      const title = await what(source, m[3]!).catch(() => null);
      if (!title) return T(lang())("gone");
      await record({ what: title, verdict, source, ref: m[3]! });
      return thanks(source, verdict, lang());
    },
    /** A 👍/👎 on a to-do or an update of the brief's page. */
    item: (o: { doc: string; kind: "todo" | "update"; i: number; what: string; verdict: "up" | "down" }): Promise<void> =>
      record({ what: o.what, verdict: o.verdict, source: o.kind === "todo" ? "brief_todo" : "brief_update", ref: `${o.doc}.${o.kind[0]}${o.i}` }),
    /** The page's own verdicts for one brief: "t0" → up. */
    itemsOf: async (doc: string): Promise<Record<string, "up" | "down">> =>
      Object.fromEntries((await read()).verdicts.filter((v) => v.ref.startsWith(`${doc}.`)).map((v) => [v.ref.slice(doc.length + 1), v.verdict])),
    stats: async (): Promise<QualityStats> => statsOf(await read(), now()),
    /** The Quality card in one line, for HEALTH on the chat. */
    weekText: async (l: Lang = lang()): Promise<string> => {
      const q = statsOf(await read(), now());
      const n = q.nudges;
      if (!n.sent && !n.up && !n.down && !q.brief.up && !q.brief.down) return T(l)("weekNone");
      return T(l)("week", {
        sent: n.sent, done: n.done, notMine: n.notMine, ignored: n.ignored, up: n.up, down: n.down, bup: q.brief.up, bdown: q.brief.down,
      });
    },
    /** The Monday brief's one line, only when the week's nudges did poorly; null otherwise (and every other day). */
    monday: async (): Promise<string | null> => {
      const t = now();
      const weekday = new Intl.DateTimeFormat("en-US", { timeZone: d.timeZone, weekday: "short" }).format(t);
      if (weekday !== "Mon") return null;
      const q = statsOf(await read(), t);
      return poorPrecision(q) ? T(lang())("monday", { n: q.unhelpful, of: q.nudges.sent }) : null;
    },
    read,
  };
}

export type Quality = ReturnType<typeof createQuality>;

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

/**
 * The panel's side: GET /panel/api/quality (the card's numbers), GET /panel/api/quality/brief?doc= (the brief page's own verdicts), and POST
 * /panel/api/quality/brief {doc, kind, i, verdict} (a 👍/👎 on the page; the x-pako header). `briefItem`: the title of today's brief's item,
 * null when that brief or item is not today's.
 */
export function mountQualityPanel(app: Express, d: {
  signedIn: (req: Request) => boolean;
  quality: Quality | null;
  briefItem?: (doc: string, kind: "todo" | "update", i: number) => Promise<string | null>;
}): void {
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false });
  const auth = (change: boolean): RequestHandler => (req, res, next) => {
    res.set(HEADERS);
    if (!d.signedIn(req) || (change && req.get("x-pako") !== "1")) return void res.status(401).json({ error: "sign in" });
    if (!d.quality) return void res.status(404).json({ error: "off" });
    next();
  };
  app.get("/panel/api/quality", auth(false), limiter, async (_req, res) => {
    try {
      res.json({ stats: await d.quality!.stats() });
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });
  app.get("/panel/api/quality/brief", auth(false), limiter, async (req, res) => {
    const doc = typeof req.query.doc === "string" && HEX10.test(req.query.doc) ? req.query.doc : "";
    if (!doc) return void res.status(400).json({ error: "send ?doc=" });
    try {
      res.json({ verdicts: await d.quality!.itemsOf(doc) });
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });
  app.post("/panel/api/quality/brief", auth(true), limiter, express.json({ limit: "1kb" }), async (req, res) => {
    const b = (req.body ?? {}) as { doc?: unknown; kind?: unknown; i?: unknown; verdict?: unknown };
    const ok = typeof b.doc === "string" && HEX10.test(b.doc) && (b.kind === "todo" || b.kind === "update") && Number.isInteger(b.i)
      && (b.i as number) >= 0 && (b.i as number) < 20 && (b.verdict === "up" || b.verdict === "down");
    if (!ok) return void res.status(400).json({ error: "send { doc, kind, i, verdict }" });
    try {
      const what = d.briefItem ? await d.briefItem(b.doc as string, b.kind as "todo" | "update", b.i as number) : null;
      if (!what) return void res.status(409).json({ error: "reload" });
      await d.quality!.item({ doc: b.doc as string, kind: b.kind as "todo" | "update", i: b.i as number, what, verdict: b.verdict as "up" | "down" });
      res.json({ ok: true });
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });
}

