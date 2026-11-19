// Invitations caught from the owner's mail: a meeting someone invites them to shows on the dashboard as soon as the mail is read, without
// waiting for the calendar (a Google private link can lag by hours). Each invitation mail carries an iCalendar part (text/calendar, or an
// .ics attachment) with METHOD:REQUEST (a new or changed meeting) or METHOD:CANCEL (called off).
//
// - REQUEST: kept as "Invited (from email)" until a calendar source has the same event (its UID): then the calendar's copy wins and this one
//   is dropped from the view. Gone by itself once the meeting is over.
// - CANCEL: the invitation is removed, and any follow-up about that meeting is closed.
//
// The invitation is a stranger's text, like the rest of the mail: it is parsed by the same bounded iCalendar reader as the calendar links
// (src/ics.ts), its words are only shown (cut, one line each), and nothing in it ever acts. Kept in the store under "mail-invites".

import type { CalEvent } from "./calendar.ts";
import type { Kv } from "./kv.ts";
import { icsEvents, parseFeed } from "./ics.ts";

export const INVITES_KEY = "mail-invites";
const KEEP_S = 60 * 24 * 3600;
const MAX = 100;
const AHEAD_MS = 60 * 24 * 3600_000;
const MINUTE = 60_000;

export interface MailInvite {
  uid: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  organizer?: string;
  location?: string;
  join?: string;
  /** When the mail came. */
  at: number;
}

export type InviteMethod = "request" | "cancel" | "other";

/** The invitation in a mail's iCalendar part: its method and its events (the next 60 days); null when it is not one Pako can read. */
export function readInvite(ics: string, o: { now: number; timeZone: string; me?: string[] }): { method: InviteMethod; events: CalEvent[] } | null {
  try {
    const root = parseFeed(ics.slice(0, 256 * 1024));
    const m = String(root.getFirstPropertyValue("method") ?? "").toUpperCase();
    const method: InviteMethod = m === "CANCEL" ? "cancel" : m === "REQUEST" || m === "" || m === "PUBLISH" ? "request" : "other";
    // A cancel's event carries STATUS:CANCELLED, which the reader leaves out: read it as if it stood, to learn which meeting it was.
    const text = method === "cancel" ? ics.replace(/STATUS:CANCELLED/gi, "STATUS:CONFIRMED") : ics;
    const r = method === "cancel" ? parseFeed(text.slice(0, 256 * 1024)) : root;
    const events = icsEvents(r, { from: o.now - 24 * 3600_000, to: o.now + AHEAD_MS, timeZone: o.timeZone, lang: "en", ...(o.me ? { me: o.me } : {}) })
      .filter((e) => e.uid)
      .slice(0, 20);
    return { method, events };
  } catch {
    return null;
  }
}

export interface InviteStore {
  /** One mail's invitation taken in: kept, changed or removed. `closed` hears the UIDs a cancel removed (the follow-ups close on them). */
  take: (ics: string, at: number) => Promise<{ method: InviteMethod; uids: string[] } | null>;
  /** The invitations still ahead, oldest first. */
  list: () => Promise<MailInvite[]>;
  /**
   * The calendar's events with the mail's invitations not yet in it: each shown as invited from email, until a source has the same event
   * (its UID, or its title within a minute of its start).
   */
  overlay: (events: CalEvent[]) => Promise<CalEvent[]>;
}

export function createInviteStore(o: { kv: Kv | null; timeZone: string; now?: () => number; me?: () => string[]; closed?: (uids: string[]) => void }): InviteStore {
  const now = o.now ?? Date.now;
  let memory: MailInvite[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
  const read = async (): Promise<MailInvite[]> => {
    if (!o.kv) return memory;
    try {
      const raw = await o.kv.get(INVITES_KEY);
      const list = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(list) ? (list as MailInvite[]).filter((x) => x && typeof x.uid === "string" && Number.isFinite(x.start)) : [];
    } catch {
      return [];
    }
  };
  const write = async (list: MailInvite[]): Promise<void> => {
    memory = list;
    if (o.kv) await o.kv.set(INVITES_KEY, JSON.stringify(list), KEEP_S);
  };
  const ahead = (list: MailInvite[]): MailInvite[] => list.filter((x) => x.end > now()).sort((a, b) => a.start - b.start).slice(-MAX);

  return {
    take: (ics, at) =>
      locked(async () => {
        const got = readInvite(ics, { now: now(), timeZone: o.timeZone, ...(o.me ? { me: o.me() } : {}) });
        if (!got || got.method === "other") return null;
        const uids = [...new Set(got.events.map((e) => e.uid!))];
        const list = (await read()).filter((x) => !uids.includes(x.uid));
        if (got.method === "request") {
          for (const e of got.events) {
            list.push({
              uid: e.uid!, title: e.title.slice(0, 150), start: e.start, end: e.end, allDay: e.allDay, at,
              ...(e.organizer ? { organizer: e.organizer } : {}), ...(e.location ? { location: e.location } : {}), ...(e.join ? { join: e.join } : {}),
            });
          }
        }
        await write(ahead(list));
        if (got.method === "cancel" && uids.length) o.closed?.(uids);
        return { method: got.method, uids };
      }),
    list: async () => ahead(await read()),
    overlay: async (events) => {
      const invites = ahead(await read());
      if (!invites.length) return events;
      const uids = new Set(events.map((e) => e.uid).filter(Boolean));
      const extra: CalEvent[] = invites
        .filter((x) => !uids.has(x.uid) && !events.some((e) => e.title.trim().toLowerCase() === x.title.trim().toLowerCase() && Math.abs(e.start - x.start) <= MINUTE))
        .map((x) => ({
          id: `invite:${x.uid}@${x.start}`, uid: x.uid, title: x.title, start: x.start, end: x.end, allDay: x.allDay, calendar: "email",
          response: "needs" as const, invited: "email" as const,
          ...(x.organizer ? { organizer: x.organizer } : {}), ...(x.location ? { location: x.location } : {}), ...(x.join ? { join: x.join } : {}),
        }));
      return [...events, ...extra].sort((a, b) => a.start - b.start);
    },
  };
}
