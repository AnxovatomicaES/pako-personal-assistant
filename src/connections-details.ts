// What each connection IS, for the connections page: which account, which server, which calendars, and how it is doing, so the owner can
// see at a glance what Pako reads. Read only, and NEVER a secret: no password, token, key or private link leaves this file. A link is shown
// by its host and calendar name with the rest masked; a phone number by its last digits. The secrecy test (its "details:" test, in
// test/connections-dashboard.test.ts) seeds every secret Pako knows and checks none comes out.
//
//   GET  /panel/api/connections/details      -> { mail, calendar, slack, zoom, telegram, whatsapp, tables, phone, claude }
//   POST /panel/api/mail/check-now           -> { ok, mail }                 (one look at the IMAP mailbox now)
//   POST /panel/api/calendar/links/check     { url } -> IcsCheck + { message, help }   (the link read once, nothing kept)
//   POST /panel/api/calendar/links           { url, anyway? } -> { ok, restarting, check } | { ok: false, error, help? }
//   POST /panel/api/calendar/links/remove    { id } -> { ok, restarting } | { ok: false, error }
//
// A private calendar link is read once when it is added, and kept only when it works (or the owner says to keep it anyway): a pasted
// browser address used to be kept silently, and the calendar simply stayed empty.

import express, { type Express } from "express";
import { guard, isObject, limit, line, localOnly, type RouteAuth } from "./connect-routes.ts";
import type { ConnectionsSaver } from "./connections-panel.ts";
import { readStored } from "./connections.ts";
import { texts, type Lang } from "./i18n.ts";
import { checkIcsLink, icsId, icsProviderHelp, icsWhyText, loadIcsConfig, type IcsFeedStatus, wrongKind, icsProvider } from "./ics.ts";
import type { Resolver } from "./restaurants/website.ts";
import type { TeamsStatus } from "./teams.ts";

type Env = Record<string, string | undefined>;

const T = texts(
  {
    works: "Works: {name}, {n} events in the next 30 days.",
    already: "That calendar is already connected.",
    noSuch: "That calendar isn't connected any more.",
    noLinks: "Calendar links can't be changed here: they're set outside the panel.",
    mailOff: "No mailbox is connected.",
  },
);

export interface ImapInfo {
  address: string;
  host: string;
  port: number;
  folders: string[];
  pollMinutes: number;
  lastCheck: number | null;
  readToday: number;
  lastError: string | null;
}

export interface DetailsDeps extends RouteAuth {
  env: Env;
  lang: () => Lang;
  /** Pako's folder (the panel's stored settings). */
  dir: string;
  timeZone: string;
  imap?: (l: Lang) => ImapInfo | null;
  /** The second mailbox's (IMAP2_*), as the first's. */
  imap2?: (l: Lang) => ImapInfo | null;
  /** One look at the IMAP mailboxes now (Check now). */
  checkMail?: () => Promise<unknown>;
  ics?: () => IcsFeedStatus[];
  mac?: () => Promise<{ at: number; calendars: { id: string; title: string }[]; events: number } | null>;
  slack?: () => Promise<{ workspace: string; user: string; lastSeen: number | null } | null>;
  zoom?: () => Promise<{ topic: string; at: number } | null>;
  /** The Teams reader's card facts (src/teams.ts status): who, which organisation, what is granted. Never its token. */
  teams?: () => Promise<TeamsStatus | null>;
  telegram?: () => Promise<{ bot: string | null; owner: string | null; paired: boolean } | null>;
  /** The panel's own save (src/connections-panel.ts): adding and removing a link is a change of CALENDAR_ICS_URL like any other. */
  saver?: ConnectionsSaver | null;
  /** For the tests: the add check's requests and name lookups. */
  icsNet?: { fetch?: typeof fetch; resolve?: Resolver };
  now?: () => number;
}

/** A phone number as the panel may show it: its last four digits. */
export const maskNumber = (n: string): string => {
  const digits = n.replace(/\D/g, "");
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : digits ? "••••" : "";
};

const set = (env: Env, key: string): boolean => !!(env[key] ?? "").trim();
const plain = (env: Env, key: string, max = 120): string => line(env[key], max);
const ok = <V>(p: Promise<V>): Promise<V | null> => p.catch(() => null);

/** Every connection's identity and settings, secrets left out by construction: only the fields named here are ever read into it. */
export async function connectionDetails(d: DetailsDeps): Promise<Record<string, unknown>> {
  const { env } = d;
  const l = d.lang();
  const [mac, slack, zoom, telegram, teams] = await Promise.all([
    d.mac ? ok(d.mac()) : null,
    d.slack && set(env, "SLACK_USER_TOKEN") ? ok(d.slack()) : null,
    d.zoom && set(env, "ZOOM_CLIENT_ID") ? ok(d.zoom()) : null,
    d.telegram ? ok(d.telegram()) : null,
    d.teams && set(env, "TEAMS_REFRESH_TOKEN") ? ok(d.teams()) : null,
  ]);
  // A mailbox whose reader is not running (wrong values, or no store): what is set, with nothing read yet.
  const fromEnv = (p: string): ImapInfo | null => set(env, `${p}_USER`) ? {
    address: plain(env, `${p}_USER`, 320), host: plain(env, `${p}_HOST`, 253), port: Number(plain(env, `${p}_PORT`, 6)) || 993,
    folders: (plain(env, `${p}_FOLDERS`, 2000) || "INBOX").split(",").map((f) => f.trim()).filter(Boolean),
    pollMinutes: Number(plain(env, `${p}_POLL_MINUTES`, 6)) || 5, lastCheck: null, readToday: 0, lastError: null,
  } : null;
  const links = d.ics?.() ?? [];
  return {
    mail: {
      imap: d.imap?.(l) ?? fromEnv("IMAP"),
      imap2: d.imap2?.(l) ?? fromEnv("IMAP2"),
      agentmail: set(env, "AGENTMAIL_INBOX") ? { inbox: plain(env, "AGENTMAIL_INBOX", 320) } : null,
    },
    calendar: {
      mac: mac && mac.calendars.length ? { calendars: mac.calendars.map((c) => line(c.title, 100)), events: mac.events, lastSync: mac.at } : null,
      links: links.map((x) => ({ ...x, errorText: x.error ? icsWhyText(x.error, l) : null })),
    },
    slack: set(env, "SLACK_USER_TOKEN")
      ? {
          workspace: slack?.workspace ?? "", user: slack?.user ?? "", socketMode: set(env, "SLACK_APP_TOKEN"), lastSeen: slack?.lastSeen ?? null,
          // What the reader passes on (src/slack.ts handle): direct messages, group DMs and the channel messages that mention the owner.
          watches: "Direct messages, group DMs and mentions in channels",
        }
      : null,
    zoom: set(env, "ZOOM_CLIENT_ID") ? { account: plain(env, "ZOOM_USER", 320), lastMeeting: zoom } : null,
    teams: set(env, "TEAMS_REFRESH_TOKEN")
      ? {
          account: plain(env, "TEAMS_ACCOUNT", 320), name: plain(env, "TEAMS_NAME"), org: plain(env, "TEAMS_ORG", 160),
          granted: teams?.granted ?? null, lastRead: teams?.lastRead ?? null, lastError: teams?.lastError ?? null,
          // What the reader passes on (src/teams.ts): chats to or from you, and, when your admin granted them, mentions and transcripts.
          watches: "Your chats (1:1, group and meeting chats); channel mentions and meeting transcripts when your admin approved them",
        }
      : null,
    telegram: telegram ? { bot: telegram.bot ? `@${telegram.bot}` : null, owner: telegram.owner, paired: telegram.paired } : null,
    whatsapp: set(env, "WHATSAPP_PHONE_NUMBER_ID")
      ? { number: maskNumber(plain(env, "PERSONAL_OWNER_NUMBER", 30)), template: plain(env, "WHATSAPP_TEMPLATE_NAME", 100), language: plain(env, "WHATSAPP_TEMPLATE_LANG", 20) || "en" }
      : null,
    tables: set(env, "GOOGLE_PLACES_API_KEY") ? { service: "Google Places" } : null,
    phone: set(env, "PERSONAL_CALLER_TOKEN") ? { calls: maskNumber(plain(env, "PERSONAL_OWNER_NUMBER", 30)) } : null,
    claude: { way: set(env, "ANTHROPIC_API_KEY") ? "API key" : "Claude plan sign-in" },
  };
}

/** The check's answer with the owner's words: what works, or why not and where the right link is. */
function said(c: Awaited<ReturnType<typeof checkIcsLink>>, url: string, l: Lang): Record<string, unknown> {
  if (c.ok) return { ...c, message: T(l)("works", { name: c.name, n: c.events }) };
  const p = c.provider ?? icsProvider(url);
  // A known service's wrong kind of link (its web page, a share page) gets the place of its secret iCal address.
  const help = p && (c.why === "notCalendar" || c.why === "notFound" || c.why === "forbidden" || wrongKind(url)) ? icsProviderHelp(p, l) : null;
  return { ...c, message: icsWhyText(c.why, l), ...(help ? { help } : {}) };
}

const PATHS = ["/panel/api/connections/details", "/panel/api/mail/check-now", "/panel/api/calendar/links/check", "/panel/api/calendar/links",
  "/panel/api/calendar/links/remove"];

export function mountConnectionDetails(app: Express, d: DetailsDeps | null): void {
  if (!d) return localOnly(app, PATHS);
  const now = d.now ?? Date.now;
  const body = express.json({ limit: "8kb" });
  const check = (url: string) => checkIcsLink(url, { timeZone: d.timeZone, lang: d.lang(), now, ...(d.icsNet ?? {}) });
  /** The links Pako reads now: the panel's stored ones (or the environment's, which the panel cannot change). */
  const links = (): string[] => {
    const stored = readStored(d.dir);
    const raw = stored?.CALENDAR_ICS_URL ?? d.env.CALENDAR_ICS_URL ?? "";
    return loadIcsConfig({ CALENDAR_ICS_URL: raw }).config?.urls ?? [];
  };
  const store = async (urls: string[], res: express.Response): Promise<void> => {
    if (!d.saver) {
      res.status(409).json({ ok: false, error: T(d.lang())("noLinks") });
      return;
    }
    const r = await d.saver.save("calendar", { CALENDAR_ICS_URL: urls.join(" ") });
    if (!r.ok) {
      res.status(r.status ?? 400).json({ ok: false, error: r.error });
      return;
    }
    res.json({ ok: true, restarting: d.saver.restartAfter(res) });
  };

  app.get(PATHS[0]!, guard(d, false), limit(60), async (_req, res) => {
    res.json(await connectionDetails(d));
  });

  app.post(PATHS[1]!, guard(d, true), limit(6), async (_req, res) => {
    if (!d.checkMail || !d.imap) {
      res.status(404).json({ ok: false, error: T(d.lang())("mailOff") });
      return;
    }
    await d.checkMail().catch(() => undefined);
    res.json({ ok: true, mail: d.imap(d.lang()), mail2: d.imap2?.(d.lang()) ?? null });
  });

  app.post(PATHS[2]!, guard(d, true), limit(20), body, async (req, res) => {
    const url = isObject(req.body) && typeof req.body.url === "string" ? req.body.url.trim().slice(0, 2000) : "";
    res.json(said(await check(url), url, d.lang()));
  });

  app.post(PATHS[3]!, guard(d, true), limit(10), body, async (req, res) => {
    const b = isObject(req.body) ? req.body : {};
    const url = typeof b.url === "string" ? b.url.trim().slice(0, 2000) : "";
    const c = await check(url);
    const answer = said(c, url, d.lang());
    // A link that is not even an address is never kept; one that fails to answer is kept only when the owner says so.
    if (!c.ok && (c.why === "badLink" || c.why === "refused" || b.anyway !== true)) {
      res.status(400).json({ ok: false, error: answer.message, ...(answer.help ? { help: answer.help } : {}), check: answer });
      return;
    }
    const normal = loadIcsConfig({ CALENDAR_ICS_URL: url }).config?.urls[0];
    const now = links();
    if (!normal) {
      res.status(400).json({ ok: false, error: answer.message });
      return;
    }
    if (now.includes(normal)) {
      res.status(400).json({ ok: false, error: T(d.lang())("already") });
      return;
    }
    await store([...now, normal], res);
  });

  app.post(PATHS[4]!, guard(d, true), limit(10), body, async (req, res) => {
    const id = isObject(req.body) ? line(req.body.id, 40) : "";
    const now = links();
    const left = now.filter((u) => icsId(u) !== id);
    if (!id || left.length === now.length) {
      res.status(404).json({ ok: false, error: T(d.lang())("noSuch") });
      return;
    }
    await store(left, res);
  });
}
