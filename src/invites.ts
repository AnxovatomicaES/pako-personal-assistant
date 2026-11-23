// Invitations caught from the owner's mail: a meeting someone invites them to shows on the dashboard as soon as the mail is read, without
// waiting for the calendar (a Google private link can lag by hours). Each invitation mail carries an iCalendar part (text/calendar, or an
// .ics attachment) with METHOD:REQUEST (a new or changed meeting) or METHOD:CANCEL (called off).
//
// - REQUEST: kept as "Invited (from email)" until a calendar source has the same event (its UID): then the calendar's copy wins and this one
//   is dropped from the view. Gone by itself once the meeting is over.
// - CANCEL: the invitation is removed, and any follow-up about that meeting is closed.
// - Anyone who learnt a meeting's UID (a forwarded invitation) could write a cancel or a change for it. Once an invitation is kept, a cancel
//   or a new REQUEST for its UID counts only from its organizer's address (or the address the first invitation came from), and only when the
//   owner's mail server vouched for that sender (DKIM or DMARC aligned, src/mail-categories.ts authenticated). Anything else is logged and
//   the invitation stays as it was.
// - A new REQUEST for a kept UID replaces it, whether the new time is inside the next 60 days or not (moved far ahead or into the past, the
//   old time is gone, not left on the dashboard); one with a lower SEQUENCE than the kept one is an older copy (the same mail read twice, or
//   delivered out of order) and changes nothing.
//
// The invitation is a stranger's text, like the rest of the mail: it is parsed by the same bounded iCalendar reader as the calendar links
// (src/ics.ts), its words are only shown (cut, one line each), and nothing in it ever acts. Kept in the store under "mail-invites".

import type { CalEvent } from "./calendar.ts";
import type { Kv } from "./kv.ts";
import { icsEvents, parseFeed } from "./ics.ts";
import { readJsonRecord } from "./json-record.ts";
import { createLog } from "./log.ts";

const log = createLog("invites");

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
  /** The organizer's address (ORGANIZER's mailto), and the address the invitation's mail came from: who may change or cancel it. */
  organizerAddress?: string;
  from?: string;
  location?: string;
  join?: string;
  /** The invitation's SEQUENCE (its version; absent: 0): an older copy of the mail does not change a newer one. */
  sequence?: number;
  /** When the mail came. */
  at: number;
}

/** Who sent the mail an invitation came in: the From address, and whether the owner's mail server vouched for it. */
export interface InviteSender {
  address: string;
  vouched: boolean;
}

/**
 * What the file says of each event it names, by UID, inside the next 60 days or not: its organizer's address (its mailto) and its highest
 * SEQUENCE. An event outside the window is still named: a kept invitation moved out of it is replaced, not left standing.
 */
function eventFacts(ics: string): Map<string, { organizer?: string; sequence: number }> {
  const out = new Map<string, { organizer?: string; sequence: number }>();
  try {
    for (const v of parseFeed(ics.slice(0, 256 * 1024)).getAllSubcomponents("vevent").slice(0, 50)) {
      const uid = String(v.getFirstPropertyValue("uid") ?? "");
      if (!uid) continue;
      const org = String(v.getFirstProperty("organizer")?.getFirstValue() ?? "").replace(/^mailto:/i, "").trim().toLowerCase();
      const sequence = Math.max(0, Math.trunc(Number(v.getFirstPropertyValue("sequence") ?? 0)) || 0);
      const was = out.get(uid);
      const organizer = was?.organizer ?? (org.includes("@") ? org.slice(0, 200) : undefined);
      out.set(uid, { ...(organizer ? { organizer } : {}), sequence: Math.max(sequence, was?.sequence ?? 0) });
    }
  } catch {
    /* not a calendar file: nothing named */
  }
  return out;
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
    /* not a calendar file: no invite */
    return null;
  }
}

export interface InviteStore {
  /** One mail's invitation taken in: kept, changed or removed. `closed` hears the UIDs a cancel removed (the follow-ups close on them). */
  take: (ics: string, at: number, sender?: InviteSender) => Promise<{ method: InviteMethod; uids: string[] } | null>;
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
      const raw = await readJsonRecord(o.kv, INVITES_KEY);
      const list = raw ? (raw as unknown) : [];
      return Array.isArray(list) ? (list as MailInvite[]).filter((x) => x && typeof x.uid === "string" && Number.isFinite(x.start)) : [];
    } catch {
      /* not JSON, or the store did not answer: no invites */
      return [];
    }
  };
  const write = async (list: MailInvite[]): Promise<void> => {
    memory = list;
    if (o.kv) await o.kv.set(INVITES_KEY, JSON.stringify(list), KEEP_S);
  };
  // Over MAX, the furthest ahead give way: the meeting tomorrow matters more than one in two months.
  const ahead = (list: MailInvite[]): MailInvite[] => list.filter((x) => x.end > now()).sort((a, b) => a.start - b.start).slice(0, MAX);

  return {
    take: (ics, at, sender) =>
      locked(async () => {
        const got = readInvite(ics, { now: now(), timeZone: o.timeZone, ...(o.me ? { me: o.me() } : {}) });
        if (!got || got.method === "other") return null;
        const kept = await read();
        const from = sender?.address.trim().toLowerCase() ?? "";
        // A kept invitation changes or goes only by its organizer's (or first sender's) own mail, as their server vouched.
        const may = (uid: string): boolean => {
          const was = kept.filter((x) => x.uid === uid);
          if (!was.length) return true;
          if (!sender?.vouched || !from.includes("@")) return false;
          return was.every((x) => x.organizerAddress === from || x.from === from);
        };
        const facts = eventFacts(ics);
        // The events named in the mail, inside the window or not: a kept one moved out of it must still be found and replaced.
        const all = [...new Set([...got.events.map((e) => e.uid!), ...facts.keys()])];
        const allowed = all.filter(may);
        if (allowed.length < all.length) log.warn(`a ${got.method} for ${all.length - allowed.length} kept invitation(s) not from its organizer: ignored`);
        // A REQUEST with a lower SEQUENCE than the kept invitation's is an older copy of it: nothing changes.
        const older = (uid: string): boolean => got.method === "request" && kept.some((x) => x.uid === uid && (facts.get(uid)?.sequence ?? 0) < (x.sequence ?? 0));
        const uids = allowed.filter((u) => !older(u));
        const list = kept.filter((x) => !uids.includes(x.uid));
        if (got.method === "request") {
          for (const e of got.events.filter((x) => uids.includes(x.uid!))) {
            const organizerAddress = facts.get(e.uid!)?.organizer;
            const sequence = facts.get(e.uid!)?.sequence ?? 0;
            list.push({
              uid: e.uid!, title: e.title.slice(0, 150), start: e.start, end: e.end, allDay: e.allDay, at, ...(sequence ? { sequence } : {}),
              ...(e.organizer ? { organizer: e.organizer } : {}), ...(organizerAddress ? { organizerAddress } : {}),
              ...(from.includes("@") ? { from: from.slice(0, 200) } : {}),
              ...(e.location ? { location: e.location } : {}), ...(e.join ? { join: e.join } : {}),
            });
          }
        }
        await write(ahead(list));
        // What followed a meeting closes only for one kept here (its sender checked above): a cancel for a UID never seen proves nothing.
        const gone = uids.filter((u) => kept.some((x) => x.uid === u));
        if (got.method === "cancel" && gone.length) o.closed?.(gone);
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
