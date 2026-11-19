// The rehearsal (REHEARSAL on the chat, the panel's “Rehearse” button): what Pako WOULD have said, from what it already keeps, in a dry run.
//
// - Read from the store, nothing fetched for it: the Slack messages kept for the owner (src/slack.ts) of the last 48 hours, one job per
//   conversation; the mail summaries the owner was told about (src/mail.ts); the meeting summaries (src/zoom.ts); and today's written brief.
// - Each goes to the assistant's computer as the very same isolated job a real one is (assistant/bridge.ts handleFollowup, handleBrief: no
//   tools, no conversation), built by the same code (src/followups.ts rehearse.draft, src/brief-v2.ts draft), under inbox ids of its own
//   (rh:, rb:). Its answer is read the same way, against a COPY of the follow-ups' record: what loops it would make, the check each would get
//   (run now: the checks only read), and the nudge's words or why none would go. Nothing is kept as a loop, nothing moves a check, nothing is
//   sent, no budget is spent. The brief is checked by the same validator and shown with the text the chat would get.
// - Cost-capped: one extraction job per conversation, at most JOBS_MAX jobs a run (the brief included), one run at a time.
// - An older bridge lets these jobs go unread (it acknowledges them without an answer): the page says to update the assistant's computer.
//
// One key in the store (REHEARSAL_KEY): the last run, 7 days.

import { randomBytes } from "node:crypto";
import express, { type Express, type Request, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { validateBrief, type BriefDoc, type Gathered } from "./brief-v2.ts";
import { jobOf, type DryOutcome, type Followups, type Job, type Where } from "./followups.ts";
import { texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import type { RecentMail } from "./mail.ts";
import type { SlackAlert } from "./slack.ts";
import type { Inbound } from "./whatsapp.ts";
import { createLog } from "./log.ts";

const log = createLog("rehearsal");

export const REHEARSAL_KEY = "rehearsal";
const TTL_SECONDS = 7 * 24 * 3600;
/** Inbox ids of a rehearsal's jobs: rh:<hex10> an extraction, rb:<hex10> the brief. */
export const REHEARSAL_JOB = /^(rh|rb):([0-9a-f]{10})$/;
export const JOBS_MAX = 20;
const WINDOW_MS = 48 * 3600_000;
/** A job with no answer after this is given up (the computer off, a run that failed). */
const WAIT_MS = 30 * 60_000;
const CHANNEL = /^[CDG][A-Z0-9]{2,30}$/;
const TS = /^\d{1,12}(?:\.\d{1,8})?$/;

type Kind = "slack" | "mail" | "meeting" | "brief";
export interface RehearsalJob {
  id: string;
  kind: Kind;
  label: string;
  /** When what it reads was said (the conversation's last message, the email, the meeting); the brief: when it was gathered. */
  at: number;
  status: "waiting" | "done" | "unread" | "failed";
  job?: Job;
  outcome?: DryOutcome;
  gathered?: Gathered;
  doc?: BriefDoc;
  chat?: string;
}
export interface RehearsalRun {
  id: string;
  at: number;
  jobs: RehearsalJob[];
  /** What there was to read, before the cap. */
  found: { slack: number; mail: number; meeting: number };
}

const T = texts(
  {
    started: "Rehearsal under way: {n} dry read(s){capped} of what came in over the last 48 h{brief}. I won't send or change anything: see it in the panel (“Rehearsal”).",
    withBrief: " and today's brief",
    capped: " (the {n} most recent)",
    nothing: "Nothing to rehearse: no Slack messages, emails or meetings from the last 48 h, and no written brief.",
    running: "A rehearsal is already under way: see it in the panel (“Rehearsal”).",
    away: " The assistant's computer isn't connected: the rehearsal will start when it is back.",
    off: "The rehearsal needs follow-ups or the written brief, and both are off.",
    failed: "I couldn't start the rehearsal. Try again in a while.",
    mail: "email",
    brief: "Today's brief",
  },
);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const KINDS: readonly Kind[] = ["slack", "mail", "meeting", "brief"];
const STATUSES: readonly RehearsalJob["status"][] = ["waiting", "done", "unread", "failed"];

/** The stored run, its parts checked (what the bridge's answer and the model wrote were read field by field before they were kept). */
export function runOf(raw: unknown): RehearsalRun | null {
  if (!isObject(raw) || typeof raw.id !== "string" || typeof raw.at !== "number" || !Array.isArray(raw.jobs)) return null;
  const f = isObject(raw.found) ? raw.found : {};
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const jobs = raw.jobs.flatMap((j): RehearsalJob[] => {
    if (!isObject(j) || typeof j.id !== "string" || !/^[0-9a-f]{10}$/.test(j.id) || !KINDS.includes(j.kind as Kind)) return [];
    if (!STATUSES.includes(j.status as RehearsalJob["status"]) || typeof j.at !== "number") return [];
    const job = j.job === undefined ? null : jobOf(j.job);
    return [{
      id: j.id, kind: j.kind as Kind, label: typeof j.label === "string" ? j.label.slice(0, 120) : "", at: j.at, status: j.status as RehearsalJob["status"],
      ...(job ? { job } : {}),
      ...(isObject(j.outcome) ? { outcome: j.outcome as unknown as DryOutcome } : {}),
      ...(isObject(j.gathered) ? { gathered: j.gathered as unknown as Gathered } : {}),
      ...(isObject(j.doc) ? { doc: j.doc as unknown as BriefDoc } : {}),
      ...(typeof j.chat === "string" ? { chat: j.chat.slice(0, 4000) } : {}),
    }];
  });
  return { id: raw.id, at: raw.at, jobs: jobs.slice(0, JOBS_MAX), found: { slack: n(f.slack), mail: n(f.mail), meeting: n(f.meeting) } };
}

export interface RehearsalDeps {
  kv: Kv | null;
  timeZone: string;
  now?: () => number;
  lang?: () => Lang;
  /** The assistant inbox (src/whatsapp.ts inbox.add). */
  enqueue: (m: Inbound) => Promise<boolean>;
  /** Takes an older run's jobs back out of the inbox when a new one replaces it. */
  drop?: (ids: string[]) => Promise<void>;
  /** Whether the assistant's computer asked for messages lately. */
  bridgeAlive: () => boolean;
  /** The follow-ups engine's dry run; null when FOLLOWUPS=off. */
  followups: (() => Followups["rehearse"] | null) | null;
  /** The written brief's dry run; null when BRIEF_SMART=off. */
  brief: (() => { draft: (t: number) => Promise<{ gathered: Gathered; text: string }>; chat: (doc: BriefDoc) => string } | null) | null;
  slack?: () => Promise<SlackAlert[]>;
  mail?: () => Promise<RecentMail[]>;
  meetings?: () => Promise<{ id: string; topic: string; at: number; summary: string }[]>;
}

type Unit =
  | { kind: "slack"; at: number; label: string; channel: string; thread?: string; where: Where; msgs: { ts: string; at: number; who: string; text: string }[] }
  | { kind: "mail" | "meeting"; at: number; label: string; ref: string; text: string };

export function createRehearsal(d: RehearsalDeps) {
  const now = d.now ?? Date.now;
  const lang = d.lang ?? ((): Lang => "en");
  let memory: RehearsalRun | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const newId = (): string => randomBytes(5).toString("hex");

  const read = async (): Promise<RehearsalRun | null> => {
    if (!d.kv) return memory ? structuredClone(memory) : null;
    const raw = await d.kv.get(REHEARSAL_KEY);
    if (!raw) return null;
    try {
      return runOf(JSON.parse(raw));
    } catch {
      return null;
    }
  };
  const mutate = <R>(fn: (r: RehearsalRun | null) => { run: RehearsalRun | null; out: R }): Promise<R> => {
    const go = chain.then(async () => {
      const { run, out } = fn(await read());
      if (d.kv && run) await d.kv.set(REHEARSAL_KEY, JSON.stringify(run), TTL_SECONDS);
      memory = run;
      return out;
    });
    chain = go.catch(() => undefined);
    return go;
  };
  const running = (r: RehearsalRun | null): boolean => !!r && r.jobs.some((j) => j.status === "waiting" && now() - r.at < WAIT_MS);

  /** What there is to read: the last 48 hours of Slack (one unit per conversation), the mail told about, the meetings with a summary. */
  const units = async (): Promise<{ list: Unit[]; found: RehearsalRun["found"] }> => {
    const t = now();
    const recent = (at: number): boolean => t - at < WINDOW_MS && at <= t + 60_000;
    const alerts = d.slack ? (await d.slack().catch(() => [] as SlackAlert[])).filter((a) => recent(a.at)) : [];
    const groups = new Map<string, SlackAlert[]>();
    for (const a of alerts) {
      const key = a.channel && CHANNEL.test(a.channel) ? `${a.channel}|${a.thread ?? ""}` : `where|${a.where}`;
      groups.set(key, [...(groups.get(key) ?? []), a]);
    }
    const slack: Unit[] = [...groups.values()].map((list) => {
      const msgs = [...list].sort((a, b) => a.at - b.at).slice(-20);
      const last = msgs[msgs.length - 1]!;
      const channel = last.channel && CHANNEL.test(last.channel) ? last.channel : "";
      const thread = channel && last.thread && TS.test(last.thread) ? last.thread : undefined;
      const where: Where = {
        type: last.direct ? "slack_dm" : "slack_channel", label: last.where.slice(0, 120), ...(channel ? { channel } : {}), ...(thread ? { thread } : {}),
      };
      return {
        kind: "slack", at: last.at, label: last.where, channel, ...(thread ? { thread } : {}), where,
        msgs: msgs.map((m) => ({ ts: m.ts && TS.test(m.ts) ? m.ts : (m.at / 1000).toFixed(6), at: m.at, who: m.who ?? m.where, text: m.text })),
      };
    });
    const mails = d.mail ? (await d.mail().catch(() => [] as RecentMail[])) : [];
    const mail: Unit[] = mails
      .filter((m) => recent(m.at) && m.kind === "aviso" && m.scam !== true && !!m.summary?.trim())
      .map((m) => ({ kind: "mail", at: m.at, label: T(lang())("mail"), ref: m.id, text: m.summary! }));
    const meetings = d.meetings ? (await d.meetings().catch(() => [])) : [];
    const meeting: Unit[] = meetings
      .filter((m) => recent(m.at) && !!m.summary.trim())
      .map((m) => ({ kind: "meeting", at: m.at, label: m.topic || "Zoom", ref: m.id, text: m.summary }));
    return { list: [...slack, ...mail, ...meeting].sort((a, b) => b.at - a.at), found: { slack: slack.length, mail: mail.length, meeting: meeting.length } };
  };

  /** Starts a run; the words for the chat. A run under way is not started again; a finished one is replaced. */
  const start = async (): Promise<{ started: boolean; text: string }> => {
    const t = T(lang());
    const fu = d.followups?.() ?? null;
    const br = d.brief?.() ?? null;
    if (!fu && !br) return { started: false, text: t("off") };
    try {
      const before = await read();
      if (running(before)) return { started: false, text: t("running") };
      const { list, found } = fu ? await units() : { list: [], found: { slack: 0, mail: 0, meeting: 0 } };
      const room = JOBS_MAX - (br ? 1 : 0);
      const take = list.slice(0, room);
      const at = now();
      const drafts: { rj: RehearsalJob; m: Inbound }[] = [];
      for (const u of take) {
        const made = await fu!.draft(u.kind === "slack"
          ? { source: "slack", channel: u.channel, ...(u.thread ? { thread: u.thread } : {}), where: u.where, msgs: u.msgs }
          : { source: u.kind, ref: u.ref, label: u.label, text: u.text, at: u.at });
        drafts.push({
          rj: { id: made.job.id, kind: u.kind, label: u.label, at: u.at, status: "waiting", job: made.job },
          m: { id: `rh:${made.job.id}`, at, text: "", followup: { source: u.kind, label: made.job.label, text: made.text } },
        });
      }
      if (br) {
        const { gathered, text } = await br.draft(at);
        const id = newId();
        drafts.push({
          rj: { id, kind: "brief", label: t("brief"), at, status: "waiting", gathered },
          m: { id: `rb:${id}`, at, text: "", brief: { kind: "brief", label: "rehearsal", text } },
        });
      }
      if (!drafts.length) return { started: false, text: t("nothing") };
      // An older run's jobs still queued are taken back: their answers would belong to nothing.
      const stale = (before?.jobs ?? []).filter((j) => j.status === "waiting").map((j) => `${j.kind === "brief" ? "rb" : "rh"}:${j.id}`);
      if (stale.length) await d.drop?.(stale).catch(() => undefined);
      const run: RehearsalRun = { id: newId(), at, jobs: drafts.map((x) => x.rj), found };
      // Kept before the jobs go, so an answer that comes at once finds its job.
      await mutate(() => ({ run, out: undefined }));
      const refused: string[] = [];
      for (const x of drafts) if (!(await d.enqueue(x.m).catch(() => false))) refused.push(x.rj.id);
      if (refused.length) {
        await mutate((r) => {
          if (r?.id === run.id) for (const j of r.jobs) if (refused.includes(j.id)) j.status = "failed";
          return { run: r, out: undefined };
        });
      }
      const n = take.length;
      const said = t("started", { n, capped: list.length > n ? t("capped", { n }) : "", brief: br ? t("withBrief") : "" });
      return { started: true, text: `${said}${d.bridgeAlive() ? "" : t("away")}` };
    } catch (err) {
      log.error(`could not start: ${(err as Error).message}`);
      return { started: false, text: t("failed") };
    }
  };

  /** The bridge's answer to a rehearsal's job (an rh: or rb: inbox id): read as a real one is, kept for the page. */
  const answer = async (inboxId: string, raw: string): Promise<{ ok: boolean }> => {
    const m = REHEARSAL_JOB.exec(inboxId);
    if (!m) return { ok: false };
    const id = m[2]!;
    const r = await read();
    const j = r?.jobs.find((x) => x.id === id && x.status === "waiting");
    if (!r || !j) return { ok: false };
    let patch: Partial<RehearsalJob>;
    if (m[1] === "rb") {
      const br = d.brief?.() ?? null;
      const doc = br && j.gathered && raw.trim() ? validateBrief(raw, j.gathered, { now: j.at, timeZone: d.timeZone, lang: lang(), id }) : null;
      patch = doc ? { status: "done", doc, chat: br!.chat(doc) } : { status: "failed" };
    } else {
      const fu = d.followups?.() ?? null;
      const outcome = fu && j.job && raw.trim() ? await fu.dryAnswer(j.job, raw).catch(() => null) : null;
      patch = outcome ? { status: "done", outcome } : { status: "failed" };
    }
    await mutate((cur) => {
      const x = cur?.id === r.id ? cur.jobs.find((y) => y.id === id && y.status === "waiting") : undefined;
      if (x) Object.assign(x, patch);
      return { run: cur, out: undefined };
    });
    return { ok: patch.status === "done" };
  };

  /** Jobs acknowledged with no answer: an older bridge let them go unread. */
  const acked = async (ids: string[]): Promise<void> => {
    const mine = ids.map((x) => REHEARSAL_JOB.exec(x)?.[2]).filter((x): x is string => !!x);
    if (!mine.length) return;
    await mutate((r) => {
      for (const j of r?.jobs ?? []) if (mine.includes(j.id) && j.status === "waiting") j.status = "unread";
      return { run: r, out: undefined };
    });
  };

  /** What the page shows: the last run, each job as the owner reads it (no stored material), and whether the computer is here. */
  const view = async () => {
    const r = await read();
    const t = now();
    return {
      lang: lang(),
      timeZone: d.timeZone,
      available: { followups: !!d.followups?.(), brief: !!d.brief?.() },
      bridge: d.bridgeAlive(),
      running: running(r),
      run: r
        ? {
            at: r.at,
            found: r.found,
            jobs: r.jobs.map((j) => ({
              kind: j.kind, label: j.label, at: j.at,
              status: j.status === "waiting" && t - r.at >= WAIT_MS ? "failed" : j.status,
              ...(j.outcome ? { outcome: j.outcome } : {}),
              ...(j.doc ? { brief: { opening: j.doc.opening, focus: j.doc.focus, todos: j.doc.todos, updates: j.doc.updates, day: j.doc.dayItems } } : {}),
              ...(j.chat ? { chat: j.chat } : {}),
            })),
          }
        : null,
    };
  };

  return { start, answer, acked, view, read };
}

export type Rehearsal = ReturnType<typeof createRehearsal>;

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

/** GET /panel/api/rehearsal (the last run) and POST /panel/api/rehearsal (start one; the x-pako header). */
export function mountRehearsalPanel(app: Express, d: { signedIn: (req: Request) => boolean; rehearsal: Rehearsal | null }): void {
  const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });
  const auth = (change: boolean): RequestHandler => (req, res, next) => {
    res.set(HEADERS);
    if (!d.signedIn(req) || (change && req.get("x-pako") !== "1")) return void res.status(401).json({ error: "sign in" });
    if (!d.rehearsal) return void res.status(404).json({ error: "off" });
    next();
  };
  app.get("/panel/api/rehearsal", auth(false), limiter, async (_req, res) => {
    try {
      res.json(await d.rehearsal!.view());
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });
  app.post("/panel/api/rehearsal", auth(true), limiter, express.json({ limit: "1kb" }), async (_req, res) => {
    try {
      res.json(await d.rehearsal!.start());
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });
}
