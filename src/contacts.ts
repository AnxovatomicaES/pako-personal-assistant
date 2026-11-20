// The contacts of this Mac, imported when the person confirms it: names, email addresses, phone numbers and the company, nothing else. They
// are Pako's address book, beside the people the owner tells it about (src/people.ts keeps those, a hundred at most, with what was said of
// each): who "Ana" is when a mail or a meeting names her. Kept in the store under "assistant-contacts", listed in the panel, forgotten in
// one click (and with the discovery's "forget everything").
//
// The Mac app reads them with the Contacts framework (macOS asks first) and sends them; the panel first asks for a preview (how many are
// new, how many add to one already here, how many change nothing), and only the person's confirmation writes them. The same person twice
// (by an email address or a phone number in common) is one entry, its addresses and numbers joined.
//
//   POST   /panel/api/people/import     { people: [{ name, emails[], phones[], org? }], confirm?: true }
//                                       -> { ok, preview, total, added, merged, same, skipped, count }
//   GET    /panel/api/people/imported   -> { count, at, people: [{ name, emails, phones, org? }] (the first 500), more }
//   DELETE /panel/api/people/imported   -> { ok }

import express, { type Express } from "express";
import { emailOf, guard, isObject, limit, line, localOnly, type RouteAuth } from "./connect-routes.ts";
import type { Control } from "./control.ts";
import { texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import { nationalNumber, phoneCountry, withoutTrunkZero } from "./region.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";

const log = createLog("contacts");

export const CONTACTS_KEY = "assistant-contacts";
const KEEP_SECONDS = 400 * 24 * 3600;
export const CONTACTS_MAX = 5000;
const EMAILS_MAX = 5;
const PHONES_MAX = 5;
const SHOWN = 500;

export interface Contact {
  name: string;
  emails: string[];
  phones: string[];
  org?: string;
}

/**
 * A phone number as compared: its digits, with the + kept; a national number of the owner's country is the same one with or without its
 * code (in Spain 612 34 56 78 is +34612345678, in the US (415) 555-0100 is +14155550100: src/region.ts). Null when too short.
 */
export function phoneOf(v: unknown, country: string = phoneCountry()): string | null {
  const raw = withoutTrunkZero(line(v, 40));
  const digits = raw.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  const plain = digits.replace(/^00/, "+");
  if (plain.replace(/\D/g, "").length < 6) return null;
  return plain.startsWith("+") ? plain : (nationalNumber(plain, country) ?? plain);
}

/** One contact as the app sent it; null when it has no name and nothing to reach them by. `stored`: one read back from the address book,
 *  which keeps twice as many emails and phones (an import completes a person up to that). */
export function contactOf(v: unknown, stored = false): Contact | null {
  if (!isObject(v)) return null;
  const k = stored ? 2 : 1;
  const emails = [...new Set((Array.isArray(v.emails) ? v.emails : []).map(emailOf).filter(Boolean))].slice(0, EMAILS_MAX * k);
  const phones = [...new Set((Array.isArray(v.phones) ? v.phones : []).map((p) => phoneOf(p)).filter((p): p is string => !!p))].slice(0, PHONES_MAX * k);
  const org = line(v.org, 100);
  const name = line(v.name, 100) || org || emails[0] || "";
  if (!name || (!emails.length && !phones.length)) return null;
  return { name, emails, phones, ...(org ? { org } : {}) };
}

export interface ImportCount {
  total: number;
  added: number;
  merged: number;
  same: number;
  skipped: number;
}

/** The address book after an import, and what the import did: dedup by any email or phone in common. */
export function merge(book: Contact[], incoming: unknown[]): { book: Contact[]; count: ImportCount } {
  const out = book.map((c) => ({ ...c, emails: [...c.emails], phones: [...c.phones] }));
  const byKey = new Map<string, Contact>();
  for (const c of out) for (const k of [...c.emails, ...c.phones]) byKey.set(k, c);
  const count: ImportCount = { total: incoming.length, added: 0, merged: 0, same: 0, skipped: 0 };
  for (const raw of incoming) {
    const c = contactOf(raw);
    if (!c) {
      count.skipped++;
      continue;
    }
    const keys = [...c.emails, ...c.phones];
    const there = keys.map((k) => byKey.get(k)).find(Boolean);
    if (!there) {
      if (out.length >= CONTACTS_MAX) {
        count.skipped++;
        continue;
      }
      out.push(c);
      for (const k of keys) byKey.set(k, c);
      count.added++;
      continue;
    }
    // Only what fits: an address that would be cut off is not counted as completing the person.
    const emails = c.emails.filter((e) => !there.emails.includes(e)).slice(0, Math.max(0, EMAILS_MAX * 2 - there.emails.length));
    const phones = c.phones.filter((p) => !there.phones.includes(p)).slice(0, Math.max(0, PHONES_MAX * 2 - there.phones.length));
    const org = !there.org && c.org ? c.org : undefined;
    if (!emails.length && !phones.length && !org) {
      count.same++;
      continue;
    }
    there.emails = [...there.emails, ...emails];
    there.phones = [...there.phones, ...phones];
    if (org) there.org = org;
    for (const k of [...emails, ...phones]) byKey.set(k, there);
    count.merged++;
  }
  return { book: out, count };
}

export interface ContactsStore {
  /** Throws when the store does not answer: an import never starts from an empty copy over the real one. */
  read(): Promise<{ at: number; people: Contact[] }>;
  write(people: Contact[], at: number): Promise<void>;
  forget(): Promise<void>;
}

export function createContactsStore(kv: Kv): ContactsStore {
  return {
    read: async () => {
      const raw = await readJsonRecord(kv, CONTACTS_KEY);
      if (!raw) return { at: 0, people: [] };
      try {
        const p = raw as { at?: unknown; people?: unknown };
        const people = (Array.isArray(p.people) ? p.people : []).map((c) => contactOf(c, true)).filter((c): c is Contact => !!c);
        return { at: typeof p.at === "number" ? p.at : 0, people };
      } catch {
        /* not JSON: no contacts, as a fresh install has */
        return { at: 0, people: [] };
      }
    },
    write: (people, at) => kv.set(CONTACTS_KEY, JSON.stringify({ at, people }), KEEP_SECONDS),
    forget: () => kv.set(CONTACTS_KEY, "", 1),
  };
}

const T = texts(
  {
    logImported: "Contacts imported from this Mac: {added} new, {merged} completed",
    logForgot: "Forgot the imported contacts",
  },
);

export interface ContactsPanelDeps extends RouteAuth {
  store: ContactsStore;
  lang: () => Lang;
  control?: Control;
  now?: () => number;
}

const PATHS = ["/panel/api/people/import", "/panel/api/people/imported"];

export function mountContactsPanel(app: Express, d: ContactsPanelDeps | null): void {
  if (!d) return localOnly(app, PATHS);
  const now = d.now ?? Date.now;
  /** One import at a time: two at once would each read the book and the second would undo the first. */
  let busy: Promise<unknown> = Promise.resolve();
  app.post(PATHS[0]!, guard(d, true), limit(20), express.json({ limit: "8mb" }), async (req, res) => {
    const b = isObject(req.body) ? req.body : {};
    if (!Array.isArray(b.people) || b.people.length > 20_000) {
      res.status(400).json({ ok: false, error: "bad" });
      return;
    }
    const people = b.people as unknown[];
    const job = busy.then(async () => {
      const { people: book } = await d.store.read();
      const out = merge(book, people);
      if (b.confirm === true && (out.count.added || out.count.merged)) {
        await d.store.write(out.book, now());
        d.control?.log("panel", T(d.lang())("logImported", { added: out.count.added, merged: out.count.merged }));
      }
      return { ok: true, preview: b.confirm !== true, ...out.count, count: b.confirm === true ? out.book.length : book.length };
    });
    busy = job.catch(() => undefined);
    try {
      res.json(await job);
    } catch (err) {
      log.error(`could not import: ${(err as Error).name}`);
      res.status(503).json({ ok: false, error: "store" });
    }
  });
  app.get(PATHS[1]!, guard(d, false), limit(60), async (_req, res) => {
    try {
      const { at, people } = await d.store.read();
      res.json({ count: people.length, at, people: people.slice(0, SHOWN), more: Math.max(0, people.length - SHOWN) });
    } catch (err) {
      log.warn(`the contacts could not be read: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });
  app.delete(PATHS[1]!, guard(d, true), limit(20), async (_req, res) => {
    try {
      await d.store.forget();
      d.control?.log("panel", T(d.lang())("logForgot"));
      res.json({ ok: true });
    } catch (err) {
      log.warn(`the contacts could not be forgotten: ${(err as Error).message}`);
      res.status(503).json({ ok: false, error: "store" });
    }
  });
}
