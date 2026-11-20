// The People directory: everyone Pako can see in what the owner connected, computed each time it is asked for and never kept as the owner's
// facts. It merges the imported contacts of this Mac (src/contacts.ts), the identities Pako has already met in the mail, the calendar, Slack
// and Zoom (src/people-graph.ts), the attendees of the calendar's events, the senders of the stored mail (src/mail.ts), the open follow-ups
// (who owes what, src/followups.ts) and the owner's own records and facts (src/people.ts, src/memory-facts.ts).
//
// Why computed and not stored: what comes from other people's mail, invitations and Slack is third-party data. It is shown with where it
// came from and it never becomes something the owner said: only the owner's own words make a person record or a memory fact, as before. The
// directory reads only what Pako already holds on this computer, so nothing new leaves it. The one thing kept is the owner's own choice of
// whom to hide ("people-hidden": a short list of identities, in DATA_KEYS, the export and "delete everything").
//
// Merging, with care (a wrong merge would put one person's mail on another's card):
// - the same email address, phone number, Slack id or owner's record link is the same person, always;
// - a name alone joins two records only when nothing contradicts it and only one candidate fits: a record with no identity (a follow-up's
//   "who", the owner's record of someone) goes to the one person of that name; two records that each have an identity join by a full name
//   (two words or more) only when both come from the owner's contacts, the owner's records or a calendar invitation, never from a mail's
//   From line, and never when both have emails (or both phones) and none is shared. Two "Ana"s with different emails stay two people.
//
// Ranking: open loops in either direction first, then a meeting in the next 14 days, then anything in the last 30 days, then the rest (the
// owner's own records before plain contacts). Senders that are machines or bulk mail never make a person; someone seen once by mail long ago
// is found by the search but not listed.
//
//   GET  /panel/api/people/directory?q=&hidden=1  -> { people, total, more, hidden, sources, empty, edit, prep }
//   POST /panel/api/people/hide    { keys }       -> { ok }  (a computer only)
//   POST /panel/api/people/unhide  { keys }       -> { ok }
//   POST /panel/api/people/prep    { key }        -> { task }  (the brief's "Prepare me" run, given this person's facts)
//   GET  /panel/api/people/prep?id=               -> { task }

import express, { type Express, type Request, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import type { CalEvent } from "./calendar.ts";
import { phoneOf, type Contact } from "./contacts.ts";
import type { Loop } from "./followups.ts";
import type { Kv } from "./kv.ts";
import { fold } from "./lists.ts";
import type { RecentMail } from "./mail.ts";
import type { Fact as MemoryFact } from "./memory-facts.ts";
import { findIn, identityValue, splitAddress, type GraphPerson } from "./people-graph.ts";
import type { Person } from "./people.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";

const log = createLog("people");

const DAY = 24 * 3600_000;
/** A meeting this close counts as upcoming for the ranking. */
export const SOON_MS = 14 * DAY;
/** An interaction this recent counts as recent for the ranking. */
export const RECENT_MS = 30 * DAY;
/** How many people the list shows before a search. */
export const LIST_MAX = 60;
/** How many a search shows. */
export const SEARCH_MAX = 40;

// ---------- what goes in ----------

export interface DirectorySources {
  contacts?: Contact[] | null;
  graph?: GraphPerson[] | null;
  events?: CalEvent[] | null;
  mail?: RecentMail[] | null;
  loops?: Loop[] | null;
  people?: Person[] | null;
  facts?: MemoryFact[] | null;
  /** The owner's own addresses (Pako's inbox, the mailbox read by IMAP): never a person in the directory. */
  self?: string[];
}

// ---------- what comes out ----------

export type LoopDirection = "you_owe" | "they_owe" | "agreed";

export interface DirLoop {
  id: string;
  title: string;
  dir: LoopDirection;
  due?: number;
  /** Where it was said, as the owner reads it ("Slack · Rohan (DM)", "Mail"). */
  source: string;
  at: number;
}

export interface DirMoment {
  at: number;
  kind: "mail" | "meeting" | "slack" | "zoom";
  /** A mail's subject, a meeting's title, a Slack conversation's label: other people's words, shown as text with their source. */
  label: string;
  source: string;
}

export interface DirTold {
  text: string;
  at: number;
}

export interface DirEntry {
  /** The person's stable handle in the panel: their first identity ("e:ana@x.com", "p:+34…", "s:U123", "o:<record id>", "n:<name>"). */
  key: string;
  /** Every identity key, so a hide holds whichever one shows up next time. */
  keys: string[];
  name: string;
  emails: string[];
  phones: string[];
  org?: string;
  birthday?: string;
  known: { contacts: boolean; told: boolean; meetings: number; mails: number; slack: number; zoom: number; loops: number };
  /** "in your contacts · 3 meetings · 12 mails". */
  knownText: string;
  loops: DirLoop[];
  next?: DirMoment;
  last?: DirMoment;
  /** The owner's own words about them, dated: never anything derived. */
  told: DirTold[];
  /** The owner's record (src/people.ts), for correcting it in the panel. */
  own?: Omit<Person, "reminder">;
  tier: "loops" | "soon" | "recent" | "other";
  /** Listed before a search (a one-off sender seen once long ago is not). */
  listed: boolean;
}

export interface Directory {
  people: DirEntry[];
  /** How many there are, hidden ones aside. */
  total: number;
  hiddenCount: number;
  /** What each source brought (how many of each), for the empty state and the card's footer. */
  sources: { contacts: number; calendar: number; mail: number; slack: number; loops: number; told: number };
  /** No source holds anyone at all: the owner has connected nothing yet. */
  empty: boolean;
}

// ---------- building it ----------

/** Local parts of addresses that are machines or bulk senders, not people (identityValue already drops no-reply and the bounces). */
const BULK_WORDS = [
  "no-?reply", "do-?not-?reply", "notifications?", "notify", "news(?:letters?)?", "marketing", "promo(?:tions?)?", "offers?", "deals", "mailer",
  "updates?", "digest", "alerts?", "info", "hello", "team", "support", "billing", "receipts?", "invoices?", "orders?", "shop", "store", "sales",
  "accounts?", "security", "feedback", "survey", "events?", "community",
];
const BULK_LOCAL = new RegExp(`^(?:${BULK_WORDS.join("|")})(?:[-+._].*)?@`);

/** An address worth a person: a real address, not a machine's, not a bulk sender's. */
export function personEmail(raw: string): string {
  const e = identityValue("email", raw);
  return e && !BULK_LOCAL.test(e) ? e : "";
}

/** A graph phone is digits only (the + was dropped): with enough digits it is read as international. */
const graphPhone = (digits: string): string | null => phoneOf(digits.length >= 11 ? `+${digits}` : digits);

type RecKind = "contact" | "graph" | "attendee" | "mail" | "owner" | "loop" | "fact";

interface Rec {
  kind: RecKind;
  /** The names that may decide a merge (contacts, the owner's, a graph record's trusted ones, an invitation's), folded. */
  trusted: string[];
  /** Name candidates for showing, the best first by `rank`. */
  names: { name: string; rank: number }[];
  ids: string[];
  emails: string[];
  phones: string[];
  contact?: Contact;
  graph?: GraphPerson;
  person?: Person;
  events: CalEvent[];
  mails: RecentMail[];
  loops: Loop[];
  facts: MemoryFact[];
}

const rec = (kind: RecKind, o: Partial<Rec> = {}): Rec => ({
  kind, trusted: [], names: [], ids: [], emails: [], phones: [], events: [], mails: [], loops: [], facts: [], ...o,
});

const RANK = { owner: 0, contact: 1, graphTrusted: 2, attendee: 3, graph: 4, mail: 5, loop: 6, email: 9 } as const;

/** One word of a name, folded. */
const words = (n: string): string[] => fold(n).split(" ").filter(Boolean);

const dirOf = (k: Loop["kind"]): LoopDirection => (k === "other_promise" ? "they_owe" : k === "agreed_meeting" ? "agreed" : "you_owe");

const VIA: Record<string, DirMoment["kind"]> = { correo: "mail", calendario: "meeting", slack: "slack", zoom: "zoom" };
const SOURCE: Record<DirMoment["kind"], string> = { mail: "Mail", meeting: "Calendar", slack: "Slack", zoom: "Zoom" };

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** A third-party text as the card shows it: one line, cut. The panel puts it on the page as text, never as HTML. */
const shown = (s: unknown, max = 120): string => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

/**
 * Everything merged, ranked and filtered. `hidden`: the identity keys the owner hid. `now` decides upcoming and recent. Pure: the tests
 * give it fixtures, the route gives it what the stores hold.
 */
export function buildDirectory(src: DirectorySources, o: { now: number; hidden?: Iterable<string> }): Directory {
  const now = o.now;
  const recs: Rec[] = [];
  const self = new Set((src.self ?? []).map((e) => identityValue("email", e)).filter(Boolean));

  // The owner is on every invitation they get: an address on nearly all of the meetings (four or more) is theirs, not a person to list.
  const withPeople = (src.events ?? []).filter((e) => e.attendees?.length);
  if (withPeople.length >= 4) {
    const seen = new Map<string, number>();
    for (const e of withPeople) for (const a of e.attendees ?? []) seen.set(a.email, (seen.get(a.email) ?? 0) + 1);
    for (const [email, n] of seen) if (n >= 4 && n >= 0.8 * withPeople.length) self.add(email);
  }
  const ok = (email: string): string => {
    const e = personEmail(email);
    return e && !self.has(e) ? e : "";
  };

  for (const c of src.contacts ?? []) {
    const emails = c.emails.map(ok).filter(Boolean);
    const phones = c.phones.map((p) => phoneOf(p)).filter((p): p is string => !!p);
    if (!emails.length && !phones.length) continue;
    recs.push(rec("contact", {
      contact: c, trusted: [fold(c.name)], names: [{ name: c.name, rank: RANK.contact }],
      emails, phones, ids: [...emails.map((e) => `e:${e}`), ...phones.map((p) => `p:${p}`)],
    }));
  }

  for (const g of src.graph ?? []) {
    const emails: string[] = [];
    const phones: string[] = [];
    const ids: string[] = [];
    for (const i of g.identities) {
      if (i.kind === "email") {
        const e = ok(i.value);
        if (e) emails.push(e);
      } else if (i.kind === "phone" || i.kind === "whatsapp") {
        const p = graphPhone(i.value);
        if (p) phones.push(p);
      } else if (i.kind === "slack") ids.push(`s:${i.value}`);
      else if (i.kind === "zoom") ids.push(`z:${fold(i.value)}`);
    }
    // A record whose only identity was the owner's own address, or a bulk sender's, is nobody to list (unless it is the owner's own record).
    if (!emails.length && !phones.length && !ids.length && !g.personId) continue;
    const trustedNames = g.personId ? [g.name, ...g.aliases] : g.aliases;
    recs.push(rec("graph", {
      graph: g, emails, phones,
      ids: [...emails.map((e) => `e:${e}`), ...phones.map((p) => `p:${p}`), ...ids, ...(g.personId ? [`o:${g.personId}`] : [])],
      trusted: trustedNames.map(fold),
      names: [
        ...trustedNames.map((name) => ({ name, rank: RANK.graphTrusted })),
        { name: g.name, rank: RANK.graph },
      ],
    }));
  }

  // One record per attendee address: every meeting of theirs is on it.
  const attendees = new Map<string, Rec>();
  for (const e of src.events ?? []) {
    for (const a of e.attendees ?? []) {
      const email = ok(a.email);
      if (!email) continue;
      let r = attendees.get(email);
      if (!r) {
        r = rec("attendee", { emails: [email], ids: [`e:${email}`] });
        attendees.set(email, r);
        recs.push(r);
      }
      if (!r.events.some((x) => x.id === e.id && x.start === e.start)) r.events.push(e);
      if (a.name && !r.trusted.includes(fold(a.name))) {
        r.trusted.push(fold(a.name));
        r.names.push({ name: a.name, rank: RANK.attendee });
      }
    }
  }

  // One record per sender address, bulk mail aside (the mail's own pre-classification: "masivo").
  const senders = new Map<string, Rec>();
  for (const m of src.mail ?? []) {
    if (m.kind === "masivo" || m.scam) continue;
    const { name, email: raw } = splitAddress(m.from);
    const email = ok(raw);
    if (!email) continue;
    let r = senders.get(email);
    if (!r) {
      r = rec("mail", { emails: [email], ids: [`e:${email}`] });
      senders.set(email, r);
      recs.push(r);
    }
    r.mails.push(m);
    if (name && !r.names.some((n) => n.name === name)) r.names.push({ name, rank: RANK.mail });
  }

  for (const p of src.people ?? []) {
    recs.push(rec("owner", { person: p, trusted: [fold(p.name)], names: [{ name: p.name, rank: RANK.owner }], ids: [`o:${p.id}`] }));
  }

  // A follow-up's "who" is a name or an address (src/people-graph.ts canon): an address or a graph record is an identity; a bare name waits
  // for the name pass below.
  const graph = src.graph ?? [];
  const nameOnly = (kind: "loop" | "fact", word: string, extra: Partial<Rec>): void => {
    const email = ok(word);
    if (email) {
      recs.push(rec(kind, { ...extra, emails: [email], ids: [`e:${email}`], names: [{ name: email, rank: RANK.email }] }));
      return;
    }
    const g = findIn(graph, word);
    const ids = g ? [`g:${g.id}`] : [];
    recs.push(rec(kind, { ...extra, ids, trusted: [fold(word)], names: [{ name: word, rank: RANK.loop }] }));
  };
  for (const l of src.loops ?? []) if (l.status === "open" || l.status === "snoozed") if (l.who.trim()) nameOnly("loop", l.who.trim(), { loops: [l] });
  // The owner's own told facts about someone (never the derived ones from the records, which come with the record itself).
  for (const f of src.facts ?? []) {
    if (!f.subject || f.source.who !== "owner" || f.validTo !== undefined || f.closedAt !== undefined || f.pending) continue;
    if (f.origin) continue;
    nameOnly("fact", f.subject, { facts: [f] });
  }
  // A graph record answers for its own id too, so a follow-up resolved to it lands on its record.
  for (const r of recs) if (r.graph) r.ids.push(`g:${r.graph.id}`);

  // ---------- identities: the same one is the same person ----------
  const parent = recs.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const union = (a: number, b: number): void => {
    const x = find(a);
    const y = find(b);
    if (x !== y) parent[Math.max(x, y)] = Math.min(x, y);
  };
  const byId = new Map<string, number>();
  recs.forEach((r, i) => {
    for (const k of r.ids) {
      const j = byId.get(k);
      if (j === undefined) byId.set(k, i);
      else union(i, j);
    }
  });

  // ---------- names, with care ----------
  interface Group { emails: Set<string>; phones: Set<string>; trusted: Set<string>; shown: Set<string>; vouched: boolean; identified: boolean }
  const groups = (): Map<number, Group> => {
    const out = new Map<number, Group>();
    recs.forEach((r, i) => {
      const root = find(i);
      let g = out.get(root);
      if (!g) out.set(root, (g = { emails: new Set(), phones: new Set(), trusted: new Set(), shown: new Set(), vouched: false, identified: false }));
      for (const e of r.emails) g.emails.add(e);
      for (const p of r.phones) g.phones.add(p);
      for (const n of r.trusted) if (n) g.trusted.add(n);
      for (const n of r.names) g.shown.add(fold(n.name));
      if (r.kind === "contact" || r.kind === "owner" || r.kind === "attendee" || (r.kind === "graph" && !!r.graph?.personId)) g.vouched = true;
      if (r.ids.some((k) => !k.startsWith("g:") && !k.startsWith("n:"))) g.identified = true;
    });
    return out;
  };
  const clash = (a: Group, b: Group): boolean =>
    (a.emails.size > 0 && b.emails.size > 0 && ![...a.emails].some((e) => b.emails.has(e)))
    || (a.phones.size > 0 && b.phones.size > 0 && ![...a.phones].some((p) => b.phones.has(p)));

  // Two identified records by the same full name: one from the contacts with a phone, the same person in an invitation with an address.
  {
    const gs = groups();
    const byName = new Map<string, number[]>();
    for (const [root, g] of gs) {
      if (!g.identified || !g.vouched) continue;
      for (const n of g.trusted) if (words(n).length >= 2) byName.set(n, [...(byName.get(n) ?? []), root]);
    }
    for (const roots of byName.values()) {
      const live = [...new Set(roots.map(find))];
      if (live.length !== 2) continue;
      const [a, b] = live as [number, number];
      if (!clash(gs.get(a)!, gs.get(b)!)) union(a, b);
    }
  }
  // A record with no identity (the owner's record, a follow-up, a told fact) goes to the one person it names; with none, the ones that name
  // the same person join each other; with several, it stays apart rather than guess.
  {
    const gs = groups();
    const identified = [...gs].filter(([, g]) => g.identified);
    const loose = [...gs].filter(([, g]) => !g.identified);
    for (const [root, g] of loose) {
      const name = [...g.trusted][0];
      if (!name) continue;
      let hits = identified.filter(([, x]) => x.trusted.has(name));
      // No trusted name fits: the one person shown by that full name (a mail sender, a Slack name) is the next best, and only when alone.
      if (!hits.length && words(name).length >= 2) hits = identified.filter(([, x]) => x.shown.has(name));
      if (!hits.length && words(name).length === 1) hits = identified.filter(([, x]) => [...x.trusted].some((n) => words(n)[0] === name));
      if (hits.length === 1) {
        union(root, hits[0]![0]);
        continue;
      }
      if (hits.length) continue;
      const same = loose.filter(([r, x]) => r !== root && x.trusted.has(name));
      for (const [r] of same) union(root, r);
    }
  }

  // ---------- one entry per person ----------
  const members = new Map<number, Rec[]>();
  recs.forEach((r, i) => {
    const root = find(i);
    members.set(root, [...(members.get(root) ?? []), r]);
  });

  const hidden = new Set(o.hidden ?? []);
  const entries: DirEntry[] = [];
  let hiddenCount = 0;
  for (const rs of members.values()) {
    const entry = entryOf(rs, now);
    if (!entry) continue;
    if (entry.keys.some((k) => hidden.has(k))) {
      hiddenCount++;
      continue;
    }
    entries.push(entry);
  }
  entries.sort(compare);

  const sources = {
    contacts: (src.contacts ?? []).length,
    calendar: withPeople.length,
    mail: (src.mail ?? []).filter((m) => m.kind !== "masivo").length,
    slack: graph.filter((g) => g.identities.some((i) => i.kind === "slack")).length,
    loops: (src.loops ?? []).filter((l) => l.status === "open" || l.status === "snoozed").length,
    told: (src.people ?? []).length,
  };
  return {
    people: entries,
    total: entries.length,
    hiddenCount,
    sources,
    empty: entries.length === 0 && hiddenCount === 0 && Object.values(sources).every((n) => n === 0),
  };
}

const TIER = { loops: 0, soon: 1, recent: 2, other: 3 } as const;

/** The order of the list: the tier, then within it what is most pressing. */
function compare(a: DirEntry, b: DirEntry): number {
  if (a.tier !== b.tier) return TIER[a.tier] - TIER[b.tier];
  if (a.tier === "loops") {
    const due = (e: DirEntry): number => Math.min(...e.loops.map((l) => l.due ?? Number.MAX_SAFE_INTEGER));
    return due(a) - due(b) || b.loops.length - a.loops.length || a.name.localeCompare(b.name);
  }
  if (a.tier === "soon") return (a.next?.at ?? 0) - (b.next?.at ?? 0) || a.name.localeCompare(b.name);
  if (a.tier === "recent") return (b.last?.at ?? 0) - (a.last?.at ?? 0) || a.name.localeCompare(b.name);
  return Number(!!b.own) - Number(!!a.own) || Number(b.known.contacts) - Number(a.known.contacts) || (b.last?.at ?? 0) - (a.last?.at ?? 0)
    || a.name.localeCompare(b.name);
}

function entryOf(rs: Rec[], now: number): DirEntry | null {
  const name = [...rs.flatMap((r) => r.names)].filter((n) => n.name.trim()).sort((a, b) => a.rank - b.rank)[0]?.name
    ?? rs.flatMap((r) => r.emails)[0];
  if (!name) return null;
  const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
  const emails = uniq(rs.flatMap((r) => r.emails)).sort();
  const phones = uniq(rs.flatMap((r) => r.phones));
  const person = rs.find((r) => r.person)?.person;
  const contact = rs.find((r) => r.contact)?.contact;
  const ownerLinked = rs.some((r) => r.graph?.personId);

  // Every moment Pako saw them, each once: the stored mail and the calendar's events, then the graph's last contacts for what those no longer
  // hold (older mail, past meetings, Slack and Zoom).
  const moments: DirMoment[] = [];
  const add = (m: DirMoment): void => {
    if (!moments.some((x) => x.kind === m.kind && Math.abs(x.at - m.at) < 60_000)) moments.push(m);
  };
  const mails = uniq(rs.flatMap((r) => r.mails));
  for (const m of mails) add({ at: m.at, kind: "mail", label: shown(m.subject) || "(no subject)", source: "Mail" });
  const events = new Map<string, CalEvent>();
  for (const e of rs.flatMap((r) => r.events)) events.set(`${e.id}@${e.start}`, e);
  for (const e of events.values()) add({ at: e.start, kind: "meeting", label: shown(e.title) || "(untitled meeting)", source: "Calendar" });
  for (const c of rs.flatMap((r) => r.graph?.contacts ?? [])) {
    const kind = VIA[c.via];
    if (!kind) continue;
    const label = kind === "slack" ? shown(c.where) || "a Slack message" : kind === "zoom" ? "a Zoom call" : kind === "mail" ? "a mail" : "a meeting";
    add({ at: c.at, kind, label, source: SOURCE[kind] });
  }
  const count = (k: DirMoment["kind"]): number => moments.filter((m) => m.kind === k).length;

  const loops: DirLoop[] = uniq(rs.flatMap((r) => r.loops)).map((l) => {
    const s = l.sources[0];
    const via = s?.kind === "slack" ? "Slack" : s?.kind === "mail" ? "Mail" : s?.kind === "meeting" ? "Meeting" : "";
    const where = shown(s?.label ?? l.where.label, 80);
    return {
      id: l.id, title: shown(l.title, 200), dir: dirOf(l.kind), ...(l.dueAt ? { due: l.dueAt } : {}),
      // The source's label usually names its kind already ("Slack · Rohan (DM)"): the kind is said once.
      source: `Follow-ups · ${(where.startsWith(via) ? [where] : [via, where]).filter(Boolean).join(" · ") || "a conversation"}`, at: s?.at ?? l.whenSaid,
    };
  }).sort((a, b) => (a.due ?? Number.MAX_SAFE_INTEGER) - (b.due ?? Number.MAX_SAFE_INTEGER));

  const future = moments.filter((m) => m.kind === "meeting" && m.at > now).sort((a, b) => a.at - b.at);
  const past = moments.filter((m) => m.at <= now).sort((a, b) => b.at - a.at);
  const next = future[0];
  const last = past[0];

  // The owner's own words: the record's parts and the told facts, each dated. The derived facts that mirror the record are the record.
  const told: DirTold[] = [];
  if (person) {
    if (person.relation) told.push({ text: `Relation: ${person.relation}`, at: person.updated });
    if (person.birthday) told.push({ text: `Birthday: ${person.birthday}`, at: person.updated });
    for (const x of person.likes) told.push({ text: `Likes: ${x}`, at: person.updated });
    for (const x of person.notes) told.push({ text: x, at: person.updated });
  }
  for (const f of uniq(rs.flatMap((r) => r.facts))) told.push({ text: `${f.attribute}: ${f.value}`, at: f.validFrom || f.learnedAt });

  const known = {
    contacts: !!contact, told: !!person || ownerLinked || told.length > 0,
    meetings: count("meeting"), mails: count("mail"), slack: count("slack"), zoom: count("zoom"), loops: loops.length,
  };
  const knownText = [
    ...(known.contacts ? ["in your contacts"] : []),
    ...(person ? ["you told me about them"] : told.length ? ["you mentioned them"] : []),
    ...(known.loops ? [plural(known.loops, "open loop", "open loops")] : []),
    ...(known.meetings ? [plural(known.meetings, "meeting", "meetings")] : []),
    ...(known.mails ? [plural(known.mails, "mail", "mails")] : []),
    ...(known.slack ? [plural(known.slack, "Slack message", "Slack messages")] : []),
    ...(known.zoom ? [plural(known.zoom, "Zoom call", "Zoom calls")] : []),
  ].join(" · ");

  const tier: DirEntry["tier"] = loops.length ? "loops"
    : next && next.at - now <= SOON_MS ? "soon"
    : last && now - last.at <= RECENT_MS ? "recent"
    : "other";
  // Someone only ever seen by mail, once, a month ago or more: a one-off sender. The search finds them; the list leaves them out.
  const mailOnly = rs.every((r) => r.kind === "mail" || (r.kind === "graph" && !r.graph?.personId && (r.graph?.contacts ?? []).every((c) => c.via === "correo")));
  const listed = !(mailOnly && known.mails <= 1 && tier === "other");

  const keys = uniq([
    ...emails.map((e) => `e:${e}`),
    ...phones.map((p) => `p:${p}`),
    ...rs.flatMap((r) => r.ids.filter((k) => k.startsWith("s:") || k.startsWith("o:") || k.startsWith("z:"))),
    ...(person ? [`o:${person.id}`] : []),
  ]);
  if (!keys.length) keys.push(`n:${fold(name)}`);
  const { reminder: _r, ...own } = person ?? ({} as Person);
  const birthday = person?.birthday;
  return {
    key: keys[0]!, keys: keys.slice(0, 20), name: shown(name, 80), emails: emails.slice(0, 5), phones: phones.slice(0, 3),
    ...(contact?.org ? { org: shown(contact.org, 80) } : {}), ...(birthday ? { birthday } : {}),
    known, knownText, loops, ...(next ? { next } : {}), ...(last ? { last } : {}),
    told: told.sort((a, b) => b.at - a.at).slice(0, 20), ...(person ? { own: own as Omit<Person, "reminder"> } : {}), tier, listed,
  };
}

/** The search: a name's words, an address or a number, accents and case aside. */
export function matches(e: DirEntry, q: string): boolean {
  const want = fold(q);
  if (!want) return true;
  const digits = q.replace(/\D/g, "");
  return fold(e.name).includes(want) || e.emails.some((x) => x.includes(want))
    || (digits.length >= 4 && e.phones.some((p) => p.replace(/\D/g, "").includes(digits))) || (!!e.org && fold(e.org).includes(want));
}

/** What a person's "Prep" gives the brief's run: who they are, the loops both ways, the next meeting, the last moments and the owner's words. */
export function prepFacts(e: DirEntry, timeZone: string): { label: string; text: string; at?: number }[] {
  const when = (t: number): string =>
    new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(t);
  const out: { label: string; text: string; at?: number }[] = [
    { label: "People", text: `person: ${e.name}${e.emails[0] ? ` <${e.emails[0]}>` : ""}${e.org ? ` (${e.org})` : ""} · known from: ${e.knownText || "nothing yet"}` },
  ];
  const DIR = { you_owe: "the owner owes them", they_owe: "they owe the owner", agreed: "agreed meeting" } as const;
  for (const l of e.loops.slice(0, 8)) {
    out.push({ label: l.source, text: `open loop · ${DIR[l.dir]} · ${l.title}${l.due ? ` · due ${when(l.due)}` : ""} · said ${when(l.at)}`, ...(l.due ? { at: l.due } : {}) });
  }
  if (e.next) out.push({ label: e.next.source, text: `next meeting: ${e.next.label} · ${when(e.next.at)}`, at: e.next.at });
  if (e.last) out.push({ label: e.last.source, text: `last contact: ${e.last.kind} · ${e.last.label} · ${when(e.last.at)}`, at: e.last.at });
  for (const t of e.told.slice(0, 8)) out.push({ label: "The owner's own words", text: `the owner told Pako: ${t.text}` });
  return out;
}

// ---------- the hidden list: the owner's own choice, the one thing kept ----------

export const HIDDEN_KEY = "people-hidden";
const HIDDEN_TTL_SECONDS = 400 * 24 * 3600;
const HIDDEN_MAX = 2000;
const KEY_RE = /^[epszogn]:[^\r\n]{1,200}$/;

export interface HiddenPeople {
  /** Throws when the store does not answer: a hide never starts from an empty copy over the real one. */
  read(): Promise<string[]>;
  hide(keys: string[]): Promise<void>;
  unhide(keys: string[]): Promise<void>;
}

export function createHiddenPeople(kv: Kv | null): HiddenPeople {
  let local: string[] = [];
  const read = async (): Promise<string[]> => {
    if (!kv) return [...local];
    const raw = await readJsonRecord(kv, HIDDEN_KEY);
    if (!raw) return [];
    try {
      const p = raw as { keys?: unknown };
      return (Array.isArray(p.keys) ? p.keys : []).filter((k): k is string => typeof k === "string" && KEY_RE.test(k)).slice(-HIDDEN_MAX);
    } catch {
      /* not JSON: nothing hidden */
      return [];
    }
  };
  const write = async (keys: string[]): Promise<void> => {
    const list = [...new Set(keys)].slice(-HIDDEN_MAX);
    if (kv) await kv.set(HIDDEN_KEY, JSON.stringify({ v: 1, keys: list }), HIDDEN_TTL_SECONDS);
    local = list;
  };
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
  const clean = (keys: string[]): string[] => keys.filter((k) => KEY_RE.test(k)).slice(0, 20);
  return {
    read,
    hide: (keys) => locked(async () => write([...(await read()), ...clean(keys)])),
    unhide: (keys) => locked(async () => {
      const gone = new Set(clean(keys));
      await write((await read()).filter((k) => !gone.has(k)));
    }),
  };
}

// ---------- the routes ----------

export interface PrepTask {
  id: string;
  title: string;
  status: "pending" | "done" | "failed" | "old";
  text: string;
}

export interface PeopleDirectoryDeps {
  signedIn: (req: Request) => boolean;
  /** A computer (local mode): hiding and Prep work here. A server's panel only shows the list. */
  local: boolean;
  timeZone: string;
  hidden: HiddenPeople;
  /** Each source, as connected (absent: not connected; a failed read leaves it out of this answer only). */
  sources: { [K in keyof Omit<DirectorySources, "self">]?: () => Promise<NonNullable<DirectorySources[K]>> } & { self?: () => string[] };
  /** The brief's prep run (src/brief-v2.ts prepPerson); absent when the written brief is off. */
  prep?: (o: { name: string; facts: { label: string; text: string; at?: number }[] }) => Promise<PrepTask | null>;
  prepTask?: (id: string) => Promise<PrepTask | null>;
  now?: () => number;
}

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" };

/** Every source read at once; one that fails is left out of this answer (and logged), never guessed. */
export async function readSources(d: Pick<PeopleDirectoryDeps, "sources">): Promise<DirectorySources> {
  const out: DirectorySources = {};
  const take = async <K extends keyof Omit<DirectorySources, "self">>(k: K): Promise<void> => {
    const fn = d.sources[k];
    if (!fn) return;
    try {
      out[k] = (await fn()) as DirectorySources[K];
    } catch (err) {
      log.error(`the directory could not read ${k}: ${(err as Error).message}`);
    }
  };
  await Promise.all((["contacts", "graph", "events", "mail", "loops", "people", "facts"] as const).map(take));
  out.self = d.sources.self?.() ?? [];
  return out;
}

export function mountPeopleDirectory(app: Express, d: PeopleDirectoryDeps): void {
  const now = d.now ?? Date.now;
  const reads = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false });
  const writes = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });
  // As the people's other routes: the strict session cookie, and for a change the x-pako header another site cannot send.
  const auth = (change: boolean): RequestHandler => (req, res, next) => {
    res.set(HEADERS);
    if (change && !d.local) return void res.status(404).json({ error: "read only here" });
    if (!d.signedIn(req) || (change && req.get("x-pako") !== "1")) return void res.status(401).json({ error: "sign in" });
    next();
  };
  const build = async (): Promise<Directory> => buildDirectory(await readSources(d), { now: now(), hidden: await d.hidden.read() });

  app.get("/panel/api/people/directory", auth(false), reads, async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 80) : "";
    const wantHidden = req.query.hidden === "1";
    try {
      let dir: Directory;
      if (wantHidden) {
        // The hidden ones, to show again: the same build without the hidden list, keeping only those it holds.
        const hidden = new Set(await d.hidden.read());
        const all = buildDirectory(await readSources(d), { now: now() });
        dir = { ...all, people: all.people.filter((e) => e.keys.some((k) => hidden.has(k))) };
      } else dir = await build();
      const list = q.trim() ? dir.people.filter((e) => matches(e, q)) : dir.people.filter((e) => e.listed);
      const max = q.trim() ? SEARCH_MAX : LIST_MAX;
      res.json({
        people: list.slice(0, max), total: dir.total, more: Math.max(0, list.length - max), hidden: dir.hiddenCount,
        sources: dir.sources, empty: dir.empty, edit: d.local, prep: d.local && !!d.prep,
      });
    } catch (err) {
      log.error(`the directory could not be read: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });

  const body = express.json({ limit: "8kb" });
  const keysOf = (b: unknown): string[] | null => {
    const k = (b as { keys?: unknown } | null)?.keys;
    if (!Array.isArray(k)) return null;
    const keys = k.filter((x): x is string => typeof x === "string" && KEY_RE.test(x)).slice(0, 20);
    return keys.length ? keys : null;
  };
  for (const [path, act] of [["/panel/api/people/hide", "hide"], ["/panel/api/people/unhide", "unhide"]] as const) {
    app.post(path, auth(true), writes, body, async (req, res) => {
      const keys = keysOf(req.body);
      if (!keys) return void res.status(400).json({ error: "bad" });
      try {
        await d.hidden[act](keys);
        res.json({ ok: true });
      } catch (err) {
        log.error(`could not ${act}: ${(err as Error).message}`);
        res.status(503).json({ error: "store" });
      }
    });
  }

  const taskOut = (t: PrepTask): PrepTask => ({ id: t.id, title: t.title, status: t.status, text: t.text });
  app.post("/panel/api/people/prep", auth(true), writes, body, async (req, res) => {
    const key = (req.body as { key?: unknown } | null)?.key;
    if (typeof key !== "string" || !KEY_RE.test(key)) return void res.status(400).json({ error: "bad" });
    if (!d.prep) return void res.status(404).json({ error: "off" });
    try {
      const dir = await build();
      const e = dir.people.find((x) => x.keys.includes(key));
      if (!e) return void res.status(404).json({ error: "gone" });
      const task = await d.prep({ name: e.name, facts: prepFacts(e, d.timeZone) });
      if (!task) return void res.status(404).json({ error: "off" });
      res.json({ task: taskOut(task) });
    } catch (err) {
      log.error(`the prep could not start: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });
  app.get("/panel/api/people/prep", auth(false), reads, async (req, res) => {
    const id = typeof req.query.id === "string" ? req.query.id : "";
    if (!/^[0-9a-f]{10}$/.test(id) || !d.prepTask) return void res.status(404).json({ error: "gone" });
    try {
      const t = await d.prepTask(id);
      if (!t) return void res.status(404).json({ error: "gone" });
      res.json({ task: taskOut(t) });
    } catch (err) {
      log.warn(`a prep task could not be read: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });
}
