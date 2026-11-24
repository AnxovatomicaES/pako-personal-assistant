// The inbox the assistant's computer reads: the owner's messages and the jobs for the bridge, kept in the store until acknowledged.

import type { Kv } from "../kv.ts";
import type { InboundReview } from "../meeting-review.ts";
import { createLog } from "../log.ts";
import { readJsonRecord } from "../json-record.ts";
import { cut } from "./shared.ts";

const log = createLog("whatsapp");

export interface Inbound {
  id: string;
  at: number;
  /** Empty for a voice note: the owner's computer listens to it (`audio`) and the words it hears become the text. */
  text: string;
  audio?: { id: string; mime: string };
  /** An email that arrived in the assistant's own inbox (src/mail.ts): the Mac summarizes it in a run with no tools and no tags. */
  email?: InboundEmail;
  /** A Zoom meeting's transcript (src/zoom.ts): the Mac summarizes it the same way. */
  meeting?: InboundMeeting;
  /** The owner forwarded it (someone else's words): a newer bridge reads it as outside text and marks its turn (src/quarantine.ts). */
  forwarded?: boolean;
  /**
   * One run of a routine the owner scheduled (src/routines.ts): `text` is its prompt, the owner's own words. A newer bridge says no "Un
   * momento…" for it (nobody is waiting); an older one ignores the field and answers the text like any message.
   */
  routine?: { id: string; text: string };
  /**
   * A photo or a PDF the owner sent (src/papers.ts), kept by the door under `id`: a newer bridge reads it in an isolated run. `text` stays empty,
   * so an older bridge lets it go without answering a caption it cannot see the paper of. `caption`: the words sent with it.
   */
  paper?: { id: string; mime: string; name: string; caption?: string };
  /**
   * A follow-ups extraction job (src/followups.ts): other people's words the bridge reads in an isolated run and answers with JSON on
   * /assistant/followups. `text` stays empty, so an older bridge lets it go: no loops, nothing else changes.
   */
  followup?: InboundFollowup;
  /**
   * A meeting's review (src/meeting-review.ts): a newer bridge reads it in an isolated run and answers with JSON on /assistant/meeting-review.
   * Alone (Zoom's summary), `text` stays empty and an older bridge lets it go: the summary is then told as before. Beside `meeting` (a
   * transcript), an older bridge summarizes the transcript as before.
   */
  review?: InboundReview;
  /**
   * A written-brief job (src/brief-v2.ts): the day's facts with their ids, which the bridge reads in an isolated run and answers on
   * /assistant/brief (the brief as JSON, or a document asked from the page). `text` stays empty, so an older bridge lets it go.
   */
  brief?: { kind: "brief" | "do" | "prep"; label: string; text: string; draft?: boolean };
  /**
   * A proactive check (src/proactive.ts): what Pako knows of the owner's day and life, which the bridge reads in an isolated run and answers
   * on /assistant/proactive with at most one suggestion. `text` stays empty, so an older bridge lets it go: nothing is said.
   */
  proactive?: { text: string };
  /**
   * A candidate contradiction between two dated facts (src/memory-facts.ts), which a newer bridge judges in an isolated run and answers with
   * strict JSON on /assistant/judge. `text` stays empty, so an older bridge lets it go: after JUDGE_MS the newest fact wins.
   */
  judge?: { text: string };
  /**
   * A first tiny step to write (gentle mode, src/gentle.ts): one stuck follow-up's own facts, which a newer bridge reads in an isolated run and
   * answers with strict JSON on /assistant/step. `text` stays empty, so an older bridge lets it go: the nudge simply has no step.
   */
  step?: { text: string };
  /**
   * A connector job (src/connector-intake.ts): a newer bridge reads the owner's Slack or Notion through their claude.ai connector in a
   * read-only run and answers on /assistant/connector. `text` stays empty, so an older bridge lets it go: nothing is read.
   */
  connector?: { source: "slack" | "notion"; since: number };
}

export interface InboundFollowup {
  source: "slack" | "mail" | "meeting";
  /** Who and where, as the owner reads it. */
  label: string;
  /** The material, prepared and neutralised by the server. */
  text: string;
}

export interface InboundMeeting {
  topic: string;
  /** When it started, as the owner reads it ("14/11 10:00"). */
  when: string;
  transcript: string;
}

export interface InboundEmail {
  from: string;
  subject: string;
  text: string;
  attachments: string[];
  /** Forwarded from the owner's work address, a personal one, or written straight to the assistant. */
  account?: "trabajo" | "personal" | "directo";
  /** A sender the owner always wants to hear about at once. */
  vip?: boolean;
  /**
   * Read when a mailbox was first connected (or a folder renumbered): mail that was already there. It is summarized and kept, and may feed the
   * follow-ups, but the owner is never told about it, VIP or not: connecting an inbox must not set the phone off.
   */
  quiet?: boolean;
  /** Read in a mailbox's catch-up, and the owner already replied to it in the same thread: its follow-ups are made closed. */
  replied?: boolean;
}

interface InboxState {
  msgs: Inbound[];
  seen: string[];
}

const KEY = "assistant-inbox";
const TTL_SECONDS = 2 * 24 * 3600;
export const MAX_MSGS = 50;
/** Follow-up extraction jobs kept waiting for the computer at once (the newest). */
const MAX_FOLLOWUP_JOBS = 10;
/** A rehearsal's jobs (src/rehearsal.ts JOBS_MAX): its own count. */
const MAX_REHEARSAL_JOBS = 20;
export const isRehearsal = (x: Inbound): boolean => /^r[hb]:/.test(x.id);
export const MAX_SEEN = 200;
const MSG_MAX = 4000;
const EMAIL_TEXT_MAX = 12_000;
const TRANSCRIPT_MAX = 60_000;
const FOLLOWUP_MAX = 16_000;
const BRIEF_JOB_MAX = 32_000;

/**
 * Messages waiting for the assistant. One server process owns them: they are read from the store once and kept in memory, and every change
 * is written through (so a restart of the free web service keeps them); a change that cannot be written is an error, so Meta retries.
 */
export function createInbox(kv: Kv | null) {
  let state: InboxState | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const waiters = new Set<() => void>();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
  const load = async (): Promise<InboxState> => {
    if (state) return state;
    let s: InboxState = { msgs: [], seen: [] };
    const raw = kv ? await readJsonRecord(kv, KEY) : null;
    if (state) return state; // another call loaded (and maybe changed) it meanwhile: keep that one
    if (raw) {
      try {
        const p = raw as Partial<InboxState>;
        s = {
          msgs: (Array.isArray(p.msgs) ? p.msgs : []).filter((m): m is Inbound => !!m && typeof m.id === "string" && typeof m.text === "string"),
          seen: (Array.isArray(p.seen) ? p.seen : []).filter((x): x is string => typeof x === "string"),
        };
      } catch {
        log.error("the stored inbox could not be used: starting a new one");
      }
    }
    state = s;
    return s;
  };
  const save = async (s: InboxState): Promise<void> => {
    if (kv) await kv.set(KEY, JSON.stringify(s), TTL_SECONDS);
  };
  return {
    /** False when this message id was already seen (Meta delivers at least once). */
    add: (m: Inbound): Promise<boolean> =>
      locked(async () => {
        const s = await load();
        if (s.seen.includes(m.id)) return false;
        const kept: Inbound = {
          id: m.id,
          at: m.at,
          text: cut(m.text, MSG_MAX),
          ...(m.audio ? { audio: m.audio } : {}),
          ...(m.forwarded === true ? { forwarded: true } : {}),
          ...(m.routine ? { routine: { id: m.routine.id, text: cut(m.routine.text, MSG_MAX) } } : {}),
          ...(m.paper ? { paper: { ...m.paper, name: cut(m.paper.name, 80), ...(m.paper.caption ? { caption: cut(m.paper.caption, MSG_MAX) } : {}) } } : {}),
          ...(m.email ? { email: { ...m.email, text: cut(m.email.text, EMAIL_TEXT_MAX) } } : {}),
          ...(m.meeting ? { meeting: { ...m.meeting, transcript: cut(m.meeting.transcript, TRANSCRIPT_MAX) } } : {}),
          ...(m.followup ? { followup: { ...m.followup, label: cut(m.followup.label, 120), text: cut(m.followup.text, FOLLOWUP_MAX) } } : {}),
          ...(m.review
            ? { review: { ...m.review, topic: cut(m.review.topic, 200), ...(m.review.text ? { text: cut(m.review.text, FOLLOWUP_MAX) } : {}) } }
            : {}),
          ...(m.brief ? { brief: { kind: m.brief.kind, label: cut(m.brief.label, 160), text: cut(m.brief.text, BRIEF_JOB_MAX) } } : {}),
          ...(m.proactive ? { proactive: { text: cut(m.proactive.text, FOLLOWUP_MAX) } } : {}),
          ...(m.judge ? { judge: { text: cut(m.judge.text, FOLLOWUP_MAX) } } : {}),
          ...(m.step ? { step: { text: cut(m.step.text, FOLLOWUP_MAX) } } : {}),
          ...(m.connector ? { connector: { source: m.connector.source, since: m.connector.since } } : {}),
        };
        const msgs = [...s.msgs, kept];
        // Follow-up jobs (one per Slack conversation every few minutes) are capped, the oldest dropped: a night of Slack with the computer
        // asleep must not push out a meeting's transcript or an email (src/followups.ts forgets a job never answered). A rehearsal's jobs
        // (src/rehearsal.ts) are counted apart, so they never push out a real one.
        const real = (x: Inbound): boolean => !!(x.followup || x.proactive || x.judge || x.step || x.connector) && !isRehearsal(x);
        while (msgs.filter(real).length > MAX_FOLLOWUP_JOBS) msgs.splice(msgs.findIndex(real), 1);
        while (msgs.filter(isRehearsal).length > MAX_REHEARSAL_JOBS) msgs.splice(msgs.findIndex(isRehearsal), 1);
        // Full: a rehearsal's job goes first, then a follow-up job, then an email, then a review, a brief or a transcript, so the owner's own
        // messages go last.
        while (msgs.length > MAX_MSGS) {
          const job = (x: Inbound): boolean => !!(x.followup || x.proactive || x.judge || x.step || x.connector);
          const order = [isRehearsal, job, (x: Inbound) => !!x.email, (x: Inbound) => !!(x.review || x.brief || x.meeting)];
          const i = order.map((f) => msgs.findIndex(f)).find((n) => n >= 0) ?? -1;
          msgs.splice(i >= 0 ? i : 0, 1);
        }
        const next: InboxState = {
          msgs,
          seen: [...s.seen, m.id].slice(-MAX_SEEN),
        };
        await save(next);
        state = next;
        for (const w of [...waiters]) w();
        return true;
      }),
    peek: async (): Promise<Inbound[]> => [...(await load()).msgs],
    ack: (ids: string[]): Promise<void> =>
      locked(async () => {
        const s = await load();
        const gone = new Set(ids);
        if (!s.msgs.some((m) => gone.has(m.id))) return;
        const next = { ...s, msgs: s.msgs.filter((m) => !gone.has(m.id)) };
        await save(next);
        state = next;
      }),
    /** Resolves when a message is added, or after `ms`. */
    wait: (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        waiters.add(done);
      }),
  };
}
