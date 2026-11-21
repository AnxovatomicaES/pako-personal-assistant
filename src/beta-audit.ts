// The beta's measuring audit ("Beta: help measure Pako", opt-in in the panel's How Pako acts): counting the misses a tester notices
// undercounts them, since nobody notices what was never shown. So once a week Pako asks about a small random sample of what it read:
//
//   "📏 Beta check 3 of 12. I read this and found no promise: Slack · Ana in #sales … Was there a promise here, by you or to you?"
//   Yes / No / Skip
//
// - What is sampled: the past week's conversations the follow-ups read and made nothing of (up to 8), the follow-ups made (2: "Was this a
//   real promise?") and those Pako closed on its own (2: "Was closing it right?"); a kind with too few gives its places to the others, 12 at
//   most. Each kind is split by source (mail, Slack, meetings, chat) in proportion, one at least per source while places last, and each
//   stratum's size and sample are kept with the answers: its sampling weight (src/beta-measure.ts makes the estimates).
// - How it asks: one question at a time, the next right after an answer; never in the quiet hours; a question left 12 hours counts as
//   ignored (as a nudge does, src/quality.ts), and two ignored in a row end the week's questions (gentle mode's courtesy, src/gentle.ts).
// - What is kept (AUDIT_KEY, on this computer): while opted in, each conversation read for 8 days (its source, the place and people as the
//   owner reads them, its first two lines, and how many follow-ups it gave), so a question can show it; the lines go once it is answered,
//   sampled out or 8 days old, and all of them when the tester opts out. The answers are kept a year, as counts with no text
//   (auditCounts): the only part the report, its export and the pooling ever read.

import { randomBytes } from "node:crypto";
import express, { type Express, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import type { Job, Loop, SourceKind } from "./followups.ts";
import { quietAt, UNANSWERED_STOP } from "./gentle.ts";
import { texts } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";
import { inline } from "./quarantine.ts";
import { IGNORED_AFTER_MS } from "./quality.ts";
import { AUDIT_KINDS, AUDIT_SOURCES, type AuditKind, type AuditSource, type Stratum } from "./beta-measure.ts";
import { panelGuard } from "./panel-guard.ts";

const log = createLog("beta");

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export const AUDIT_KEY = "beta-audit";
/** xy Yes, xn No, xs Skip: x<answer>:<question id>. */
export const AUDIT_BUTTON = /^x([yns]):([0-9a-f]{10})$/;
/** A week's questions: threads with no follow-up, follow-ups made, follow-ups Pako closed; 12 at most in all. */
export const AUDIT_PLAN: Record<AuditKind, number> = { thread: 8, loop: 2, closed: 2 };
export const ASKS_MAX = 12;
export const ROUND_MS = 7 * DAY;
/** A conversation read is kept this long (a round looks back a week), then its lines go. */
const SEEN_KEEP_MS = 8 * DAY;
const ROUNDS_KEEP_MS = 365 * DAY;
const SEEN_MAX = 3000;
const TTL_SECONDS = 400 * 24 * 3600;
const HEX10 = /^[0-9a-f]{10}$/;

export type Answer = "yes" | "no" | "skip" | "ignored" | "gone";

/** A conversation the follow-ups read, while opted in. `loops` undefined: its job is still out. */
export interface Seen {
  id: string;
  at: number;
  source: AuditSource;
  label: string;
  people: string[];
  lines: string[];
  loops?: number;
}

export interface Question {
  id: string;
  kind: AuditKind;
  source: AuditSource;
  /** The conversation's id (a thread) or the loop's. */
  ref: string;
  /** Its stratum in the round. */
  stratum: number;
  askedAt?: number;
  answer?: Answer;
  answeredAt?: number;
  /** A thread's place, people and first lines, until it is answered. */
  show?: { label: string; people: string[]; lines: string[] };
}

export interface Round {
  id: string;
  at: number;
  /** The week it looked back on: [from, at). */
  from: number;
  strata: { kind: AuditKind; source: AuditSource; N: number; drawn: number }[];
  questions: Question[];
  /** Questions ignored in a row; UNANSWERED_STOP of them end the round. */
  ignoredRun: number;
  stopped?: boolean;
}

export interface AuditState {
  on: boolean;
  /** When it was last turned on: the first round looks back no further. */
  since: number;
  /** A random id for this install, so the pooling counts one tester once (it says nothing about who). */
  tester: string;
  seen: Seen[];
  rounds: Round[];
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const isSource = (v: unknown): v is AuditSource => (AUDIT_SOURCES as readonly unknown[]).includes(v);
const isKind = (v: unknown): v is AuditKind => (AUDIT_KINDS as readonly unknown[]).includes(v);
const strs = (v: unknown, max: number, len: number): string[] =>
  (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string").slice(0, max).map((x) => x.slice(0, len));
const ANSWERS: readonly Answer[] = ["yes", "no", "skip", "ignored", "gone"];

export const emptyAudit = (): AuditState => ({ on: false, since: 0, tester: "", seen: [], rounds: [] });

/** The stored record, every part checked. */
export function auditStateOf(raw: unknown): AuditState {
  const o = isObject(raw) ? raw : {};
  const seen = (Array.isArray(o.seen) ? o.seen : []).flatMap((v): Seen[] =>
    isObject(v) && typeof v.id === "string" && v.id.length <= 40 && num(v.at) !== undefined && isSource(v.source)
      ? [{
          id: v.id, at: num(v.at)!, source: v.source, label: typeof v.label === "string" ? v.label.slice(0, 120) : "",
          people: strs(v.people, 4, 60), lines: strs(v.lines, 2, 160), ...(num(v.loops) !== undefined ? { loops: num(v.loops)! } : {}),
        }]
      : []).slice(-SEEN_MAX);
  const rounds = (Array.isArray(o.rounds) ? o.rounds : []).flatMap((r): Round[] => {
    if (!isObject(r) || typeof r.id !== "string" || !HEX10.test(r.id) || num(r.at) === undefined || num(r.from) === undefined) return [];
    const strata = (Array.isArray(r.strata) ? r.strata : []).flatMap((s): Round["strata"] =>
      isObject(s) && isKind(s.kind) && isSource(s.source) && Number.isInteger(s.N) && Number.isInteger(s.drawn) && (s.N as number) >= (s.drawn as number)
        && (s.drawn as number) >= 0
        ? [{ kind: s.kind, source: s.source, N: s.N as number, drawn: s.drawn as number }]
        : []);
    const questions = (Array.isArray(r.questions) ? r.questions : []).flatMap((q): Question[] => {
      if (!isObject(q) || typeof q.id !== "string" || !HEX10.test(q.id) || !isKind(q.kind) || !isSource(q.source) || typeof q.ref !== "string") return [];
      if (!Number.isInteger(q.stratum) || (q.stratum as number) < 0 || (q.stratum as number) >= strata.length) return [];
      const show = isObject(q.show)
        ? { show: { label: typeof q.show.label === "string" ? q.show.label.slice(0, 120) : "", people: strs(q.show.people, 4, 60), lines: strs(q.show.lines, 2, 160) } }
        : {};
      return [{
        id: q.id, kind: q.kind, source: q.source, ref: q.ref.slice(0, 40), stratum: q.stratum as number,
        ...(num(q.askedAt) !== undefined ? { askedAt: num(q.askedAt)! } : {}),
        ...(ANSWERS.includes(q.answer as Answer) ? { answer: q.answer as Answer } : {}),
        ...(num(q.answeredAt) !== undefined ? { answeredAt: num(q.answeredAt)! } : {}),
        ...show,
      }];
    }).slice(0, ASKS_MAX);
    return [{
      id: r.id, at: num(r.at)!, from: num(r.from)!, strata, questions, ignoredRun: Math.min(99, num(r.ignoredRun) ?? 0),
      ...(r.stopped === true ? { stopped: true } : {}),
    }];
  });
  return {
    on: o.on === true, since: num(o.since) ?? 0, tester: typeof o.tester === "string" && /^[0-9a-f]{8,16}$/.test(o.tester) ? o.tester : "", seen, rounds,
  };
}

// ---------- sampling ----------

/**
 * `n` places over strata of these sizes: in proportion (largest remainder), one at least for each non-empty one while places last (the
 * largest first), never more than a stratum holds.
 */
export function allocate(n: number, sizes: readonly number[]): number[] {
  const out = sizes.map(() => 0);
  let left = Math.min(n, sizes.reduce((a, b) => a + b, 0));
  const order = sizes.map((s, i) => ({ s, i })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i);
  for (const x of order) {
    if (!left) break;
    out[x.i] = 1;
    left--;
  }
  while (left > 0) {
    const room = order.filter((x) => out[x.i]! < x.s);
    if (!room.length) break;
    const total = room.reduce((a, x) => a + x.s, 0);
    // What each stratum's share of the places left is, and the one furthest below it gets the next.
    const want = room.map((x) => ({ i: x.i, gap: (x.s / total) * (left + room.reduce((a, y) => a + out[y.i]!, 0)) - out[x.i]! }));
    want.sort((a, b) => b.gap - a.gap || a.i - b.i);
    out[want[0]!.i]!++;
    left--;
  }
  return out;
}

/** Each kind's places: its plan, then what a kind could not use given to the others (follow-ups first, then threads), 12 at most. */
export function planOf(sizes: Record<AuditKind, number>, plan: Record<AuditKind, number> = AUDIT_PLAN, max = ASKS_MAX): Record<AuditKind, number> {
  const got = Object.fromEntries(AUDIT_KINDS.map((k) => [k, Math.min(plan[k], sizes[k])])) as Record<AuditKind, number>;
  let spare = Math.min(max, AUDIT_KINDS.reduce((a, k) => a + plan[k], 0)) - AUDIT_KINDS.reduce((a, k) => a + got[k], 0);
  for (const k of ["loop", "closed", "thread"] as const) {
    const more = Math.max(0, Math.min(spare, sizes[k] - got[k]));
    got[k] += more;
    spare -= more;
  }
  return got;
}

export interface Population {
  kind: AuditKind;
  source: AuditSource;
  ids: string[];
}

/** A week's sample: its strata (size and places) and the picks, in a random order (so ignoring the last ones favours no kind). */
export function drawSample(pop: readonly Population[], rand: () => number = Math.random): {
  strata: Round["strata"];
  picks: { kind: AuditKind; source: AuditSource; ref: string; stratum: number }[];
} {
  const strata: Round["strata"] = [];
  const picks: { kind: AuditKind; source: AuditSource; ref: string; stratum: number }[] = [];
  const sizes = Object.fromEntries(AUDIT_KINDS.map((k) => [k, pop.filter((p) => p.kind === k).reduce((a, p) => a + p.ids.length, 0)])) as Record<AuditKind, number>;
  const places = planOf(sizes);
  for (const kind of AUDIT_KINDS) {
    const parts = AUDIT_SOURCES.map((source) => ({ source, ids: [...new Set(pop.filter((p) => p.kind === kind && p.source === source).flatMap((p) => p.ids))] }))
      .filter((p) => p.ids.length);
    const n = allocate(places[kind], parts.map((p) => p.ids.length));
    parts.forEach((p, i) => {
      const stratum = strata.push({ kind, source: p.source, N: p.ids.length, drawn: n[i]! }) - 1;
      // A partial Fisher-Yates: the first n of a shuffled copy, each id as likely as any other.
      const ids = [...p.ids];
      for (let j = 0; j < n[i]!; j++) {
        const k = j + Math.floor(rand() * (ids.length - j));
        [ids[j], ids[k]] = [ids[k]!, ids[j]!];
        picks.push({ kind, source: p.source, ref: ids[j]!, stratum });
      }
    });
  }
  for (let j = picks.length - 1; j > 0; j--) {
    const k = Math.floor(rand() * (j + 1));
    [picks[j], picks[k]] = [picks[k]!, picks[j]!];
  }
  return { strata, picks };
}

const sourceOf = (k: SourceKind | undefined): AuditSource | null => (k && isSource(k) ? k : null);

/**
 * The week's populations: conversations read with no follow-up made, follow-ups made (not those a "you missed …" made: those are told
 * misses, never caught ones), and follow-ups Pako closed on its own, in [from, to).
 */
export function populationsOf(s: AuditState, loops: readonly Loop[], told: ReadonlySet<string>, from: number, to: number): Population[] {
  const out: Population[] = [];
  const add = (kind: AuditKind, source: AuditSource | null, id: string): void => {
    if (!source) return;
    const p = out.find((x) => x.kind === kind && x.source === source) ?? (out.push({ kind, source, ids: [] }), out[out.length - 1]!);
    p.ids.push(id);
  };
  for (const x of s.seen) if (x.at >= from && x.at < to && x.loops === 0) add("thread", x.source, x.id);
  for (const l of loops) {
    const src = sourceOf(l.sources[0]?.kind);
    if (l.createdAt >= from && l.createdAt < to && !told.has(l.id)) add("loop", src, l.id);
    if (l.status === "done" && l.autoClosed && l.autoClosed.at >= from && l.autoClosed.at < to) add("closed", src, l.id);
  }
  return out;
}

// ---------- the counts ----------

/** The rounds that began in [now - days, now], as strata of counts (src/beta-measure.ts), and how the asking went. No text at all. */
export function auditCounts(raw: unknown, o: { now: number; days: number }): {
  strata: Stratum[];
  rounds: number;
  asked: number;
  answered: number;
  skipped: number;
  ignored: number;
} {
  const s = auditStateOf(raw);
  const since = o.now - o.days * DAY;
  const rounds = s.rounds.filter((r) => r.at >= since && r.at <= o.now);
  const strata: Stratum[] = [];
  const out = { strata, rounds: rounds.length, asked: 0, answered: 0, skipped: 0, ignored: 0 };
  for (const r of rounds) {
    r.strata.forEach((st, i) => {
      const qs = r.questions.filter((q) => q.stratum === i);
      const yes = qs.filter((q) => q.answer === "yes").length;
      const n = yes + qs.filter((q) => q.answer === "no").length;
      strata.push({ kind: st.kind, source: st.source, N: st.N, n: Math.min(n, st.N), yes: Math.min(yes, st.N) });
    });
    for (const q of r.questions) {
      if (q.askedAt !== undefined) out.asked++;
      if (q.answer === "yes" || q.answer === "no") out.answered++;
      else if (q.answer === "skip") out.skipped++;
      else if (q.answer === "ignored") out.ignored++;
    }
  }
  return out;
}

// ---------- the words ----------

export const AUDIT_WORDS = {
  head: "📏 Beta check {i} of {n}.",
  thread: "{head} I read this and found no promise:\n{where}{people}\n{lines}\n\nWas there a promise here, by you or to you?",
  loop: "{head} I made this follow-up: “{title}”{who} ({where}).\n\nWas this a real promise?",
  closed: "{head} I closed this follow-up on my own: “{title}”, because {why}\n\nWas closing it right?",
  people: "\nPeople: {list}",
  who: ", with {who}",
  line: "“{text}”",
  noLines: "(no lines kept)",
  btnYes: "Yes",
  btnNo: "No",
  btnSkip: "Skip",
  thanks: "Noted, thanks.",
  thanksLast: "Noted, thanks. That's all for this week.",
  gone: "That question has expired.",
  mail: "Email",
  slack: "Slack",
  meeting: "Meeting",
  chat: "Chat with Pako",
  logRound: "Beta check: {n} questions this week.",
  logStopped: "Beta check: two questions went unanswered, so no more this week.",
};
const AT = texts(AUDIT_WORDS);

// ---------- the engine ----------

export interface BetaAuditDeps {
  kv: Kv | null;
  timeZone: string;
  now?: () => number;
  rand?: () => number;
  quiet: { start: number; end: number } | null;
  /** Every follow-up, closed ones too (src/followups.ts read). */
  loops: () => Promise<Loop[]>;
  /** The follow-ups "you missed …" made (src/quality.ts misses' loops). */
  told: () => Promise<string[]>;
  card: (body: string, buttons: { id: string; title: string }[]) => Promise<boolean>;
  log?: (text: string) => void;
}

export function createBetaAudit(d: BetaAuditDeps) {
  const now = d.now ?? Date.now;
  const rand = d.rand ?? Math.random;
  let memory = emptyAudit();
  // A store that does not answer throws (src/json-record.ts): nothing is then written over the answers kept.
  const load = async (): Promise<AuditState> => (d.kv ? auditStateOf((await readJsonRecord(d.kv, AUDIT_KEY)) ?? {}) : structuredClone(memory));
  const save = async (s: AuditState): Promise<void> => {
    const t = now();
    s.seen = s.seen.filter((x) => t - x.at < SEEN_KEEP_MS).slice(-SEEN_MAX);
    s.rounds = s.rounds.filter((r) => t - r.at < ROUNDS_KEEP_MS);
    // A round's week is over: what it showed goes, its answers stay.
    for (const r of s.rounds) if (t - r.at >= ROUND_MS) for (const q of r.questions) delete q.show;
    memory = s;
    if (d.kv) await d.kv.set(AUDIT_KEY, JSON.stringify(s), TTL_SECONDS);
  };
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const quietly = (p: Promise<unknown>, what: string): void => void p.catch((err: Error) => log.error(`${what}: ${err.message}`));
  /** Whether it is on, without a read for each conversation: refreshed on every load. */
  let on: boolean | null = null;
  const isOn = async (): Promise<boolean> => (on ??= (await load()).on);

  /** The question as a card, or null when its follow-up is gone (then it is not asked). */
  const compose = (r: Round, q: Question, loops: readonly Loop[]): { body: string; buttons: { id: string; title: string }[] } | null => {
    const t = AT();
    const i = r.questions.indexOf(q) + 1;
    const head = t("head", { i, n: r.questions.length });
    const where = t(q.source);
    const yesNo = [{ id: `xy:${q.id}`, title: t("btnYes") }, { id: `xn:${q.id}`, title: t("btnNo") }];
    if (q.kind === "thread") {
      const sh = q.show ?? { label: "", people: [], lines: [] };
      const lines = sh.lines.length ? sh.lines.map((x) => t("line", { text: inline(x, 160) })).join("\n") : t("noLines");
      const people = sh.people.length ? t("people", { list: sh.people.map((p) => inline(p, 60)).join(", ") }) : "";
      return {
        body: t("thread", { head, where: sh.label ? `${where} · ${inline(sh.label, 120)}` : where, people, lines }),
        buttons: [...yesNo, { id: `xs:${q.id}`, title: t("btnSkip") }],
      };
    }
    const l = loops.find((x) => x.id === q.ref);
    if (!l) return null;
    if (q.kind === "loop") {
      return { body: t("loop", { head, title: inline(l.title, 140), who: l.who ? t("who", { who: inline(l.who, 60) }) : "", where }), buttons: yesNo };
    }
    if (!l.autoClosed) return null;
    return { body: t("closed", { head, title: inline(l.title, 140), why: inline(l.autoClosed.why, 160) }), buttons: yesNo };
  };

  const current = (s: AuditState, t: number): Round | null => {
    const r = s.rounds.at(-1);
    return r && t - r.at < ROUND_MS ? r : null;
  };

  /** The next question of the round asked, if any is left and it may be now. Inside serial(). Whether one went. */
  const askNext = async (s: AuditState, r: Round, t: number): Promise<boolean> => {
    if (r.stopped || r.questions.some((q) => q.askedAt !== undefined && !q.answer)) return false;
    if (d.quiet && quietAt(d.quiet, t, d.timeZone)) return false;
    const loops = r.questions.some((q) => !q.answer && q.kind !== "thread") ? await d.loops() : [];
    for (const q of r.questions) {
      if (q.answer || q.askedAt !== undefined) continue;
      const card = compose(r, q, loops);
      if (!card) {
        Object.assign(q, { answer: "gone", answeredAt: t });
        continue;
      }
      if (!(await d.card(card.body, card.buttons).catch(() => false))) {
        await save(s);
        return false;
      }
      q.askedAt = t;
      await save(s);
      return true;
    }
    await save(s);
    return false;
  };

  /** A new round: the week since the last one (or since it was turned on), sampled. Inside serial(). */
  const draw = async (s: AuditState, t: number): Promise<Round> => {
    const last = s.rounds.at(-1);
    const from = Math.max(s.since, last ? last.at : 0, t - ROUND_MS);
    const told = new Set(await d.told().catch(() => [] as string[]));
    const { strata, picks } = drawSample(populationsOf(s, await d.loops(), told, from, t), rand);
    const seenById = new Map(s.seen.map((x) => [x.id, x]));
    const r: Round = {
      id: randomBytes(5).toString("hex"), at: t, from, strata, ignoredRun: 0,
      questions: picks.map((p) => {
        const x = p.kind === "thread" ? seenById.get(p.ref) : undefined;
        return {
          id: randomBytes(5).toString("hex"), kind: p.kind, source: p.source, ref: p.ref, stratum: p.stratum,
          ...(x ? { show: { label: x.label, people: x.people, lines: x.lines } } : {}),
        };
      }),
    };
    s.rounds.push(r);
    // What the round looked back on is sampled: the lines of the conversations it did not pick go now.
    const picked = new Set(r.questions.map((q) => q.ref));
    for (const x of s.seen) if (x.at < t && !picked.has(x.id)) x.lines = [];
    if (r.questions.length) d.log?.(AT()("logRound", { n: r.questions.length }));
    return r;
  };

  return {
    /** The follow-ups' side (src/followups/types.ts FollowupsAudit): told of each conversation read. Kept only while opted in. */
    followups: {
      queued: (job: Job, material: string[], people: string[]): void => {
        const source = sourceOf(job.source);
        if (!source) return;
        quietly(serial(async () => {
          if (!(await isOn())) return;
          const s = await load();
          if (s.seen.some((x) => x.id === job.id)) return;
          // Its first two lines of words, as the job carried them: the header line and the timestamps left out.
          const lines = material.slice(1).map((x) => x.replace(/^\*?\s*\[[^\]]{0,40}\]\s*/, "").trim()).filter((x) => x.length >= 2).slice(0, 2)
            .map((x) => inline(x, 160));
          s.seen.push({ id: job.id, at: job.whenSaid, source, label: inline(job.label, 120), people: people.slice(0, 4).map((p) => inline(p, 60)), lines });
          await save(s);
        }), "a conversation read could not be kept");
      },
      answered: (o: { id?: string; source: SourceKind; label: string; at: number; loops: number }): void => {
        const source = sourceOf(o.source);
        if (!source) return;
        quietly(serial(async () => {
          if (!(await isOn())) return;
          const s = await load();
          const x = o.id ? s.seen.find((y) => y.id === o.id) : undefined;
          if (x) x.loops = o.loops;
          else s.seen.push({ id: o.id ?? randomBytes(5).toString("hex"), at: o.at, source, label: inline(o.label, 120), people: [], lines: [], loops: o.loops });
          await save(s);
        }), "a conversation read could not be counted");
      },
    },

    /**
     * The look (every tick of the durable jobs): a round once a week, its unanswered question counted ignored after 12 hours (two in a row
     * end the round), and the next question asked when none is waiting and it is not the quiet hours. Whether a question went.
     */
    sweep: (): Promise<boolean> => serial(async () => {
      const s = await load();
      on = s.on;
      if (!s.on) return false;
      const t = now();
      let r = current(s, t);
      let changed = false;
      if (!r) {
        const last = s.rounds.at(-1);
        if (t - Math.max(s.since, last ? last.at : 0) < ROUND_MS) return false;
        r = await draw(s, t);
        changed = true;
      }
      const waiting = r.questions.find((q) => q.askedAt !== undefined && !q.answer);
      if (waiting && t - waiting.askedAt! >= IGNORED_AFTER_MS) {
        changed = true;
        Object.assign(waiting, { answer: "ignored", answeredAt: t });
        delete waiting.show;
        r.ignoredRun++;
        if (r.ignoredRun >= UNANSWERED_STOP) {
          r.stopped = true;
          d.log?.(AT()("logStopped"));
        }
      }
      // Kept before asking: a round drawn (or a question counted ignored) in the quiet hours is not drawn (or counted) again.
      if (changed) await save(s);
      return askNext(s, r, t);
    }).catch((err: Error) => {
      log.error(`the beta's audit: ${err.message}`);
      return false;
    }),

    /** A Yes, No or Skip (AUDIT_BUTTON): what to tell the tester. The next question follows with next(). */
    pressed: (a: "y" | "n" | "s", id: string): Promise<string> => serial(async () => {
      const s = await load();
      const t = now();
      const r = s.rounds.find((x) => x.questions.some((q) => q.id === id));
      const q = r?.questions.find((x) => x.id === id);
      if (!r || !q || t - r.at >= ROUND_MS || (q.answer && q.answer !== "ignored")) return AT()("gone");
      // A late answer to one counted ignored still counts; any answer starts the ignored run again.
      const answer: Answer = a === "y" ? "yes" : a === "n" ? "no" : "skip";
      Object.assign(q, { answer, answeredAt: t });
      delete q.show;
      r.ignoredRun = 0;
      await save(s);
      const left = r.questions.some((x) => !x.answer && x.askedAt === undefined);
      return AT()(left && !r.stopped ? "thanks" : "thanksLast");
    }),

    /** After an answer: the next question, at once (outside the quiet hours). */
    next: (): Promise<boolean> => serial(async () => {
      const s = await load();
      const r = current(s, now());
      return r ? askNext(s, r, now()) : false;
    }).catch((err: Error) => {
      log.error(`the beta's audit: ${err.message}`);
      return false;
    }),

    /** Opted in or out. Out: every line kept goes at once; the answers stay (counts only). */
    set: (value: boolean): Promise<AuditState> => serial(async () => {
      const s = await load();
      if (value && !s.on) s.since = now();
      s.on = value;
      on = value;
      if (!s.tester) s.tester = randomBytes(6).toString("hex");
      if (!value) {
        s.seen = [];
        for (const r of s.rounds) for (const q of r.questions) delete q.show;
      }
      await save(s);
      return s;
    }),

    /** The panel's view: on or off, and this week's questions as numbers. */
    view: async (): Promise<{ on: boolean; since: number; week: { questions: number; asked: number; answered: number; stopped: boolean } | null }> => {
      const s = await load();
      const r = current(s, now());
      return {
        on: s.on, since: s.since,
        week: r ? {
          questions: r.questions.length, asked: r.questions.filter((q) => q.askedAt !== undefined).length,
          answered: r.questions.filter((q) => q.answer === "yes" || q.answer === "no" || q.answer === "skip").length, stopped: !!r.stopped,
        } : null,
      };
    },
    /** The record, after the changes already asked for. */
    read: (): Promise<AuditState> => serial(load),
  };
}

export type BetaAudit = ReturnType<typeof createBetaAudit>;

// ---------- the panel ----------


/** The opt-in's description on the settings card. */
export const AUDIT_DESCRIPTION = "Once a week, up to 12 one-tap questions about a random few of the conversations Pako read, so the beta can measure "
  + "what it misses. Answers stay on this computer; only a report of counts you choose to send ever leaves it.";

/** GET and POST /panel/api/beta-audit ({ on }): the opt-in and this week's numbers. Same protection as the gentle mode's. */
export function mountBetaAuditPanel(app: Express, d: { signedIn: (req: Request) => boolean; audit: () => BetaAudit | null }): void {
  const limit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false });
  const auth = panelGuard(d.signedIn, { off: () => !d.audit() });
  app.get("/panel/api/beta-audit", auth(false), limit, async (_req, res) => {
    try {
      res.json({ ...(await d.audit()!.view()), description: AUDIT_DESCRIPTION });
    } catch (err) {
      log.warn(`the beta's audit: the store did not answer: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });
  app.post("/panel/api/beta-audit", auth(true), limit, express.json({ limit: "1kb" }), async (req, res) => {
    const v = (req.body as { on?: unknown } | undefined)?.on;
    if (typeof v !== "boolean") return void res.status(400).json({ error: "send { on }" });
    try {
      await d.audit()!.set(v);
      res.json({ ...(await d.audit()!.view()), description: AUDIT_DESCRIPTION });
    } catch (err) {
      log.warn(`the beta's audit: the store did not answer: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });
}
