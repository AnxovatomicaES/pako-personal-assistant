// What the Mac app found on this computer, when the person said yes ("Can I look at what you have on this Mac?"): which apps are installed, the
// calendars' names, the mail accounts' addresses, how many contacts there are, the Zoom recordings folder, and which macOS permissions were
// given. Nothing is looked at before that yes, and macOS asks again for each permission (Calendars, Contacts, Automation for Mail): the app
// does the looking (desktop/mac), this server only keeps what it is given, so the connections page can offer each one in a click.
//
// Only names and addresses: never a mail's text, never an event's (those come later, for the calendars the person picks: src/calendar-local.ts).
// It stays on this computer, in the store under "discovery", with no expiry, and one click forgets it (DELETE; with ?all=1 the Mac's
// calendar events and the imported contacts go too).
//
//   GET    /panel/api/discovery          -> the stored discovery, or {}
//   POST   /panel/api/discovery          { at, apps, calendars, mailAccounts, contacts, zoomRecordings, permissions } -> { ok, discovery }
//   DELETE /panel/api/discovery[?all=1]  -> { ok }

import express, { type Express } from "express";
import { emailOf, guard, isObject, limit, line, localOnly, type RouteAuth } from "./connect-routes.ts";
import type { Control } from "./control.ts";
import { texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import { createLog } from "./log.ts";

const log = createLog("discovery");

export const DISCOVERY_KEY = "discovery";
/** No expiry in practice (ten years): it is forgotten by the person, not by time. */
const KEEP_SECONDS = 3650 * 24 * 3600;

export const APPS = ["zoom", "slack", "telegram", "whatsapp", "mail", "outlook", "teams"] as const;
export type AppName = (typeof APPS)[number];
export const PROVIDERS = ["icloud", "google", "microsoft", "yahoo", "other"] as const;
export type Provider = (typeof PROVIDERS)[number];
type Permission = "granted" | "denied" | "notAsked";

export interface Discovery {
  /** When the Mac looked (ms). */
  at: number;
  apps: Record<AppName, boolean>;
  calendars: { id: string; title: string; source: string; color: string; writable: boolean }[];
  /** Each address once, with the apps it was found in (Mail, Outlook, eM Client, Thunderbird, the iCloud account, the Contacts Me card)
   * and, for an Apple ID, whether its iCloud Mail is on. */
  mailAccounts: { address: string; name: string; provider: Provider; kind: "imap" | "exchange" | "other"; apps?: MailApp[]; icloudMail?: true }[];
  /** How the look at Mail went, said on the mail card: found, empty (Mail is not set up), closed, denied (Automation), failed; absent: not
   * looked at (an older app). */
  mailState?: MailState;
  contacts: { count: number };
  zoomRecordings: { folder: string; count: number } | null;
  permissions: { calendars: Permission; contacts: Permission; mail: Permission };
}

export const MAIL_APPS = ["mail", "outlook", "emclient", "thunderbird", "icloud", "contacts"] as const;
export type MailApp = (typeof MAIL_APPS)[number];
export const MAIL_STATES = ["found", "empty", "closed", "denied", "failed"] as const;
export type MailState = (typeof MAIL_STATES)[number];

const MAX_CALENDARS = 100;
const MAX_ACCOUNTS = 30;
const PERMISSIONS: Permission[] = ["granted", "denied", "notAsked"];

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 1_000_000) : 0);
const perm = (v: unknown): Permission => (PERMISSIONS.includes(v as Permission) ? (v as Permission) : "notAsked");

/** A time as the app may send it: ms, seconds, or an ISO text. Null when it is none. */
export function timeOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v.trim());
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** What the app sent, read field by field: anything unknown is dropped, anything missing is its empty value. Null when it is not an object. */
export function discoveryOf(raw: unknown, now: number): Discovery | null {
  if (!isObject(raw)) return null;
  const apps = Object.fromEntries(APPS.map((a) => [a, isObject(raw.apps) && raw.apps[a] === true])) as Record<AppName, boolean>;
  const calendars: Discovery["calendars"] = [];
  for (const c of Array.isArray(raw.calendars) ? raw.calendars : []) {
    if (!isObject(c)) continue;
    const id = line(c.id, 200);
    if (!id || calendars.some((x) => x.id === id)) continue;
    const color = line(c.color, 9);
    calendars.push({ id, title: line(c.title, 100) || id.slice(0, 40), source: line(c.source, 100), color: /^#[0-9a-f]{3,8}$/i.test(color) ? color : "", writable: c.writable === true });
    if (calendars.length >= MAX_CALENDARS) break;
  }
  const mailAccounts: Discovery["mailAccounts"] = [];
  for (const m of Array.isArray(raw.mailAccounts) ? raw.mailAccounts : []) {
    if (!isObject(m)) continue;
    const address = emailOf(m.address);
    if (!address || mailAccounts.some((x) => x.address === address)) continue;
    const provider = PROVIDERS.includes(m.provider as Provider) ? (m.provider as Provider) : "other";
    const kind = m.kind === "imap" || m.kind === "exchange" ? m.kind : "other";
    // An older app sends no list of apps: its addresses came from Mail.
    const apps = (Array.isArray(m.apps) ? m.apps : ["mail"]).filter((a, i, all): a is MailApp => MAIL_APPS.includes(a as MailApp) && all.indexOf(a) === i);
    mailAccounts.push({ address, name: line(m.name, 100), provider, kind, apps: apps.length ? apps : ["mail"], ...(m.icloudMail === true ? { icloudMail: true as const } : {}) });
    if (mailAccounts.length >= MAX_ACCOUNTS) break;
  }
  const z = raw.zoomRecordings;
  const folder = isObject(z) ? line(z.folder, 1000) : "";
  const p = isObject(raw.permissions) ? raw.permissions : {};
  return {
    at: Math.min(timeOf(raw.at) ?? now, now),
    apps,
    calendars,
    mailAccounts,
    ...(MAIL_STATES.includes(raw.mailState as MailState) ? { mailState: raw.mailState as MailState } : {}),
    contacts: { count: count(isObject(raw.contacts) ? raw.contacts.count : 0) },
    zoomRecordings: folder.startsWith("/") ? { folder, count: count(isObject(z) ? z.count : 0) } : null,
    permissions: { calendars: perm(p.calendars), contacts: perm(p.contacts), mail: perm(p.mail) },
  };
}

export interface DiscoveryStore {
  /** Null when nothing was found yet (or it was forgotten); throws when the store does not answer. */
  read(): Promise<Discovery | null>;
  write(d: Discovery): Promise<void>;
  forget(): Promise<void>;
}

export function createDiscoveryStore(kv: Kv, now: () => number = Date.now): DiscoveryStore {
  return {
    read: async () => {
      const raw = await kv.get(DISCOVERY_KEY);
      if (!raw) return null;
      try {
        return discoveryOf(JSON.parse(raw), now());
      } catch {
        return null;
      }
    },
    write: (d) => kv.set(DISCOVERY_KEY, JSON.stringify(d), KEEP_SECONDS),
    // Written empty with a one-second life: the store then drops it (the Kv interface has no delete).
    forget: () => kv.set(DISCOVERY_KEY, "", 1),
  };
}

const T = texts(
  {
    logFound: "What is on this Mac, kept: {calendars} calendars, {accounts} mail accounts, {contacts} contacts",
    logForgot: "Forgot what was found on this Mac",
    logForgotAll: "Forgot what was found on this Mac, with its events and imported contacts",
  },
);

export interface DiscoveryPanelDeps extends RouteAuth {
  store: DiscoveryStore;
  lang: () => Lang;
  control?: Control;
  now?: () => number;
  /** What else goes with ?all=1: the Mac's calendar events, the imported contacts. */
  forgetAlso?: (() => Promise<void>)[];
  /** Told after each new discovery (the connections page's status is asked again). */
  changed?: (d: Discovery | null) => void;
}

const PATHS = ["/panel/api/discovery"];

export function mountDiscoveryPanel(app: Express, d: DiscoveryPanelDeps | null): void {
  if (!d) return localOnly(app, PATHS);
  const now = d.now ?? Date.now;
  app.get(PATHS[0]!, guard(d, false), limit(120), async (_req, res) => {
    try {
      res.json((await d.store.read()) ?? {});
    } catch (err) {
      log.error(`could not read it: ${(err as Error).name}`);
      res.status(503).json({ error: "store" });
    }
  });
  app.post(PATHS[0]!, guard(d, true), limit(30), express.json({ limit: "256kb" }), async (req, res) => {
    const found = discoveryOf(req.body, now());
    if (!found) {
      res.status(400).json({ ok: false, error: "bad" });
      return;
    }
    try {
      await d.store.write(found);
    } catch (err) {
      log.error(`could not keep it: ${(err as Error).name}`);
      res.status(503).json({ ok: false, error: "store" });
      return;
    }
    d.control?.log("panel", T(d.lang())("logFound", { calendars: found.calendars.length, accounts: found.mailAccounts.length, contacts: found.contacts.count }));
    d.changed?.(found);
    res.json({ ok: true, discovery: found });
  });
  app.delete(PATHS[0]!, guard(d, true), limit(30), async (req, res) => {
    const all = req.query.all === "1";
    try {
      await d.store.forget();
      if (all) for (const f of d.forgetAlso ?? []) await f();
    } catch (err) {
      log.error(`could not forget it: ${(err as Error).name}`);
      res.status(503).json({ ok: false, error: "store" });
      return;
    }
    d.control?.log("panel", T(d.lang())(all ? "logForgotAll" : "logForgot"));
    d.changed?.(null);
    res.json({ ok: true });
  });
}
