// The catch-up of a newly connected mailbox: its last days (PAKO_BACKFILL_DAYS, 14 by default) read QUIETLY, so the dashboard and the
// follow-ups know what is still open from before Pako watched, without a single notice for any of it.
//
// What the first look finds is handed here, not straight to the assistant's inbox. From here it goes out at most one item a minute (the owner's
// own messages stay fast), up to its own one-time allowance of Claude runs (PAKO_BACKFILL_RUNS, 60 by default), apart from the day's
// background cap (assistant/budget.ts "backfill"). What is left when the allowance is spent is listed (the mail is kept, its first lines
// shown) but not analysed, and the dashboard says so. The cheap filters run before anything is handed here (src/mail.ts cheapSkip): mail
// sent to many, no-reply senders and receipts never reach Claude.
//
// - Inbox mail: summarized in the isolated email run (assistant/bridge.ts, kind "backfill"), never told; worth telling means the follow-ups
//   look at it, made closed when the owner already replied in the same thread (`replied`).
// - Sent mail: the owner's own words, where their promises live ("I'll send it Friday"): read whole by the follow-ups with its thread
//   (src/mail-followups.ts), as loops the owner owes and replies that close what was asked.
//
// The owner hears two calm lines in all: when it starts ("Catching up on the last 14 days…", src/imap.ts) and when it is done ("Caught up: 3
// things need you, 2 people are waiting on a reply from you."). Kept in the store under "mail-backfill".
//
// This file is the boundary the mail triage meets: it hands each item to the same intake as any email (the inbox's `enqueue`) and hears the
// verdict back (`answered`), whatever the verdicts are called; a change to the triage's categories needs nothing here but `worth`.

import { texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import type { Inbound } from "./whatsapp.ts";
import type { SentMail } from "./mail-followups.ts";
import { readJsonRecord } from "./json-record.ts";

type Env = Record<string, string | undefined>;

export const BACKFILL_KEY = "mail-backfill";
const KEEP_S = 30 * 24 * 3600;
const QUEUE_MAX = 400;
/** An item handed out and never answered (the assistant's computer asleep) stops holding the summary back after this long. */
const ANSWER_WAIT_MS = 30 * 60_000;

const T = texts(
  {
    start: "Connected to {address}. Catching up on the last {days} days (about {n} items) quietly; I'll show what needs you on the dashboard.",
    done: "Caught up: {needs} {needsWord} you, {waiting} {waitingWord} on a reply from you.",
    thing: "thing needs",
    things: "things need",
    person: "person is waiting",
    people: "people are waiting",
    brief: "From the last {days} days (mail): {needs} {needsWord} you, {waiting} {waitingWord} on a reply from you.",
    notAnalysed: "Not analysed: the catch-up allowance was used. Its first lines are kept.",
    doneChats: "Caught up on Teams: read {chats} {chatsWord} from the last {days} days. What still needs you is on the dashboard.",
    chat: "conversation",
    chats: "conversations",
  },
);

export interface BackfillConfig {
  days: number;
  /** Claude runs the catch-up may use, once. */
  allowance: number;
  /** At most one item handed out this often. */
  everyMs: number;
}

/** PAKO_BACKFILL_DAYS (1 to 60, 14 by default) and PAKO_BACKFILL_RUNS (0 to 500, 60 by default); a wrong value is named and its default used. */
export function loadBackfillConfig(env: Env): { config: BackfillConfig; problems: string[] } {
  const problems: string[] = [];
  const num = (key: string, def: number, min: number, max: number): number => {
    const raw = (env[key] ?? "").trim();
    if (!raw) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${key} must be a whole number from ${min} to ${max}; using ${def}`);
      return def;
    }
    return n;
  };
  return { config: { days: num("PAKO_BACKFILL_DAYS", 14, 1, 60), allowance: num("PAKO_BACKFILL_RUNS", 60, 0, 500), everyMs: 60_000 }, problems };
}

type Item =
  | { type: "mail"; m: Inbound; from: string; replied?: boolean }
  | { type: "sent"; ref: string; label: string; text: string; at: number; mail?: SentMail }
  | { type: "chat"; chat: BackfillChat };

/** A chat conversation's last days (src/teams.ts): its messages, handed to the follow-ups as one conversation. */
export interface BackfillChat {
  channel: string;
  where: string;
  direct: boolean;
  msgs: { ts: string; at: number; who: string; text: string }[];
}

interface State {
  queue: Item[];
  total: number;
  /** Runs handed out. */
  runs: number;
  done: number;
  /** Handed out and not answered yet: id and when. */
  pending: { id: string; at: number }[];
  needs: number;
  /** Senders of mail worth telling the owner has not replied to. */
  waiting: string[];
  notAnalysed: number;
  /** Chat conversations handed out (Teams): counted apart, since the mail's summary does not speak of them. */
  chats: number;
  startedAt: number;
  lastAt: number;
  /** The "Caught up" line was said; the brief's line was given. */
  reported: boolean;
  briefed: boolean;
}

const fresh = (): State => ({
  queue: [], total: 0, runs: 0, done: 0, pending: [], needs: 0, waiting: [], notAnalysed: 0, chats: 0, startedAt: 0, lastAt: 0, reported: false, briefed: false,
});

export interface BackfillDeps {
  kv: Kv | null;
  config: BackfillConfig;
  /** The assistant's inbox (src/whatsapp.ts): the same intake as any email. */
  enqueue: (m: Inbound) => Promise<boolean>;
  /** The follow-ups' offer (src/followups.ts): a sent email's words, as loops the owner owes (an item queued before `sent` existed). */
  offer?: (o: { source: "mail"; ref: string; label: string; text: string; at: number }) => Promise<boolean>;
  /** A sent email read whole by the follow-ups, with its thread (src/mail-followups.ts sent). */
  sent?: (m: SentMail) => Promise<boolean>;
  /** A chat conversation of the catch-up, handed to the follow-ups (src/followups.ts observeSlack, each message). */
  chat?: (c: BackfillChat) => Promise<unknown>;
  /** An email the allowance did not reach: kept with its first lines, marked not analysed (src/mail.ts annotate). */
  keepUnread?: (id: string, note: string) => Promise<unknown>;
  notify?: (text: string) => Promise<unknown>;
  lang?: () => Lang;
  now?: () => number;
}

export function createBackfill(d: BackfillDeps) {
  const now = d.now ?? Date.now;
  const lang = d.lang ?? ((): Lang => "en");
  let memory: State = fresh();
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <V>(fn: (s: State) => Promise<V>): Promise<V> => {
    const run = chain.then(async () => {
      const s = await read();
      const out = await fn(s);
      await write(s);
      return out;
    });
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
  const read = async (): Promise<State> => {
    if (!d.kv) return memory;
    try {
      const raw = await readJsonRecord(d.kv, BACKFILL_KEY);
      return raw ? { ...fresh(), ...(raw as Partial<State>) } : fresh();
    } catch {
      /* not JSON, or the store did not answer: started from nothing */
      return fresh();
    }
  };
  const write = async (s: State): Promise<void> => {
    memory = s;
    if (d.kv) await d.kv.set(BACKFILL_KEY, JSON.stringify(s), KEEP_S);
  };
  const plural = (n: number, one: "thing" | "person" | "chat", many: "things" | "people" | "chats") => T(lang())(n === 1 ? one : many);
  const words = (s: State) => ({
    days: d.config.days, needs: s.needs, needsWord: plural(s.needs, "thing", "things"), waiting: s.waiting.length,
    waitingWord: plural(s.waiting.length, "person", "people"),
  });

  /** False when the queue is full: the item is counted, but not queued. */
  const push = (s: State, item: Item): boolean => {
    if (!s.startedAt) s.startedAt = now();
    s.total++;
    if (s.queue.length >= QUEUE_MAX) {
      s.done++;
      return false;
    }
    s.queue.push(item);
    return true;
  };

  /** One item handed out, if a minute has passed; the rest kept unread once the allowance is spent; the summary once all is answered. */
  const tick = (): Promise<"sent" | "waiting" | "idle" | "reported"> =>
    locked(async (s) => {
      const t = now();
      s.pending = s.pending.filter((p) => t - p.at < ANSWER_WAIT_MS);
      if (!s.queue.length) {
        if (!s.startedAt || s.reported || s.pending.length) return "idle";
        s.reported = true;
        // One summary: the mail's line when mail was caught up, the chats' line when chats were, both in one message when both.
        const chats = s.chats ?? 0;
        const lines = [
          ...(s.total - chats > 0 ? [T(lang())("done", words(s))] : []),
          ...(chats > 0 ? [T(lang())("doneChats", { chats, chatsWord: plural(chats, "chat", "chats"), days: d.config.days })] : []),
        ];
        if (d.notify && lines.length) await d.notify(lines.join("\n")).catch(() => undefined);
        return "reported";
      }
      if (s.runs >= d.config.allowance) {
        // The allowance is spent: what is left is listed (its first lines kept) but not analysed, and the dashboard says how many.
        for (const item of s.queue.splice(0)) {
          s.notAnalysed++;
          s.done++;
          if (item.type === "chat") s.chats = (s.chats ?? 0) + 1;
          if (item.type === "mail") await d.keepUnread?.(item.m.id.replace(/^mail:/, ""), T(lang())("notAnalysed")).catch(() => undefined);
        }
        return "idle";
      }
      if (t - s.lastAt < d.config.everyMs) return "waiting";
      const item = s.queue.shift()!;
      s.lastAt = t;
      s.runs++;
      if (item.type === "mail") {
        s.pending.push({ id: item.m.id, at: t });
        if (!(await d.enqueue(item.m).catch(() => false))) {
          s.pending = s.pending.filter((p) => p.id !== item.m.id);
          s.done++;
        }
      } else if (item.type === "chat") {
        await d.chat?.(item.chat).catch(() => false);
        s.chats = (s.chats ?? 0) + 1;
        s.done++;
      } else {
        // Read whole with its thread when the follow-ups take it; otherwise (or an item from before) its words as one text.
        const whole = item.mail && d.sent ? await d.sent(item.mail).catch(() => false) : false;
        if (!whole) await d.offer?.({ source: "mail", ref: item.ref, label: item.label, text: item.text, at: item.at }).catch(() => false);
        s.done++;
      }
      return "sent";
    });

  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    /** An inbox email of the catch-up: handed out later, paced. `replied`: the owner answered it in the same thread since. */
    add: (m: Inbound, o: { from?: string; replied?: boolean } = {}): Promise<boolean> =>
      locked(async (s) => {
        const item = { type: "mail" as const, m: o.replied && m.email ? { ...m, email: { ...m.email, replied: true } } : m, from: o.from ?? m.email?.from ?? "" };
        if (!push(s, { ...item, ...(o.replied ? { replied: true } : {}) })) {
          // No room left (the Sent folder came first): kept with its first lines and counted as not analysed, never left waiting for a
          // summary that cannot come.
          s.notAnalysed++;
          await d.keepUnread?.(m.id.replace(/^mail:/, ""), T(lang())("notAnalysed")).catch(() => undefined);
        }
        return true;
      }),
    /** A sent email of the catch-up: the owner's own words, offered to the follow-ups later, paced. */
    addSent: (o: { ref: string; label: string; text: string; at: number; mail?: SentMail }): Promise<void> =>
      locked(async (s) => {
        const { mail, ...rest } = o;
        push(s, { type: "sent", ...rest, text: rest.text.slice(0, 4000), ...(mail ? { mail: { ...mail, text: mail.text.slice(0, 4000) } } : {}) });
      }),
    /**
     * A chat conversation of a new connection's catch-up (Teams), handed out later, paced, in the same allowance. A catch-up already
     * reported starts afresh: this is a new connection's, with its own summary.
     */
    addChat: (c: BackfillChat): Promise<void> =>
      locked(async (s) => {
        if (s.reported && !s.queue.length && !s.pending.length) Object.assign(s, fresh());
        push(s, { type: "chat", chat: { ...c, msgs: c.msgs.slice(-25).map((m) => ({ ...m, text: m.text.slice(0, 600) })) } });
      }),
    /** The assistant's verdict on a catch-up email (POST /assistant/mail-summary): worth telling counts for the summary. */
    answered: (id: string, o: { worth: boolean; replied?: boolean; from?: string }): Promise<boolean> =>
      locked(async (s) => {
        const was = s.pending.some((p) => p.id === id || p.id === `mail:${id}`);
        if (!was) return false;
        s.pending = s.pending.filter((p) => p.id !== id && p.id !== `mail:${id}`);
        s.done++;
        if (o.worth) {
          s.needs++;
          const who = (o.from ?? "").trim().toLowerCase();
          if (!o.replied && who && !s.waiting.includes(who)) s.waiting.push(who);
        }
        return true;
      }),
    tick,
    /** The line the first look says ("Catching up on the last 14 days, about N items"). */
    startLine: (address: string, n: number): string => T(lang())("start", { address, days: d.config.days, n }),
    /** For the dashboard: how far it is (null when there was none). */
    progress: async (): Promise<{ running: boolean; percent: number; total: number; notAnalysed: number; days: number } | null> => {
      const s = await read();
      if (!s.total) return null;
      return { running: !s.reported, percent: Math.round((100 * s.done) / s.total), total: s.total, notAnalysed: s.notAnalysed, days: d.config.days };
    },
    /** The next brief's line, once, after the catch-up is done ("From the last 14 days (mail): …"). */
    briefLine: (): Promise<string | null> =>
      locked(async (s) => {
        if (!s.reported || s.briefed || s.total - (s.chats ?? 0) <= 0) return null;
        s.briefed = true;
        return T(lang())("brief", words(s));
      }),
    start: (): void => {
      if (timer) return;
      timer = setInterval(() => void tick().catch(() => undefined), Math.max(5_000, Math.floor(d.config.everyMs / 4)));
      timer.unref?.();
    },
    stop: (): void => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export type Backfill = ReturnType<typeof createBackfill>;
