// The owner's panel: one page with everything Pako knows (agenda, mail, Slack, reminders, notes, calls, activity, the state of each part),
// at /panel. Read only, except the STOP switch and, on a computer, the person's own choices (name, the welcome).
//
// Access: the owner writes PANEL on WhatsApp and gets a one-time link (10 minutes); opening it sets a signed session cookie for 30 days, for
// /panel only. There is no password to steal, and a used or old link is worth nothing. The session key is derived from the bridge token, so
// changing that token signs every browser out. On a computer (local mode) the link is printed at the start, and `npm run panel` gives a new one.
//
// The page is static (src/panel/) with its libraries served from node_modules: GSAP for motion, Three.js for the orb, Lucide icons, Inter.
// Its words are English (src/panel/i18n.js), like all of Pako's fixed texts; dates follow the owner's country (src/region.ts).

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import express, { type Express, type Request, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { renderSVG } from "uqr";
import type { CalEvent } from "./calendar.ts";
import type { Control, PauseState, PauseWhy } from "./control.ts";
import { texts, type Lang } from "./i18n.ts";
import { regionAttr } from "./region.ts";
import type { RecentMail } from "./mail.ts";
import type { SlackAlert } from "./slack.ts";
import type { SavedBooking } from "./booking.ts";
import type { BridgeHealth, BridgeStatus, ChatMessage, LocalSettings } from "./local.ts";
import type { MemoryStore } from "./voice-memory.ts";
import { readBridgeReport, type BridgeUsage, type BridgeVersion } from "./watchdog.ts";
import { createLog } from "./log.ts";

const logPanel = createLog("panel");

const COOKIE = "pako_panel";
const SESSION_MS = 30 * 24 * 3600_000;
const LINK_MS = 10 * 60_000;

export interface Integration {
  key: string;
  name: string;
  on: boolean;
  detail: string;
}

/**
 * Local mode: what the person chooses in the panel (src/local.ts createSettings), changed by POST /panel/api/settings. `name` is the name they
 * gave ("" for none yet). `fixed` says which choice a setting makes instead (PAKO_NAME): the panel does not offer it. `changed`
 * runs after each save, before the answer (src/app.ts: the chat's first hello waits for one).
 */
export interface PanelSettings extends LocalSettings {
  fixed: { name: boolean };
  changed?: () => Promise<void> | void;
}

export interface PanelDeps {
  /** The secret the session key is derived from (the bridge token). */
  secret: string;
  /** The server's public address, for the sign-in link (a function: it may be learnt after start). */
  publicUrl: string | (() => string);
  ownerName: string;
  timeZone: string;
  control: Control;
  memory: MemoryStore;
  wa: { reminders: () => Promise<{ at: number; text: string; held: boolean }[]>; events: () => { at: number; text: string }[]; lastPoll: () => number };
  mail?: { address: string; items: () => Promise<RecentMail[]> };
  slack?: { alerts: () => Promise<SlackAlert[]> };
  /** Tables Pako asked a restaurant for, or handed a link for (src/booking.ts). */
  bookings?: { list: () => Promise<SavedBooking[]> };
  /**
   * Local mode (src/local.ts): the chat window. Absent on a hosted server, where the chat is WhatsApp. With it come the two routes only a
   * computer has: a fresh sign-in link for `npm run panel`, and the bridge's word on how Claude is doing (for the chat's banner).
   */
  chat?: {
    list: (since: number) => Promise<ChatMessage[]>;
    send: (text: string) => Promise<void>;
    press: (id: string) => Promise<void>;
    status: () => BridgeStatus;
    /** What the bridge found when it last ran Claude (POST /assistant/health). */
    report?: (claude: BridgeHealth) => void;
    /** The version the bridge runs (POST /assistant/health), for the watchdog's Salud card (src/watchdog.ts). */
    version?: (v: BridgeVersion) => void;
    /** The day's runs of Claude the bridge counts (POST /assistant/health), for the Salud card. */
    usage?: (u: BridgeUsage) => void;
    /** Looks again now for the claude command and how it is signed in (src/local.ts superviseBridge), then says the status. */
    refresh?: () => Promise<BridgeStatus>;
    /** What Pako wrote by itself after a time (ms), for the Mac app's notifications (GET /panel/api/notices). */
    notices?: (after: number) => Promise<ChatMessage[]>;
  };
  /** A new mailbox's catch-up (src/backfill.ts): how far it is, for "Catching up… 40%". */
  catchUp?: () => Promise<{ running: boolean; percent: number; total: number; notAnalysed: number; days: number } | null>;
  /** The follow-ups' open loops (src/followups.ts): the tiles "Things to do" and "Waiting on others", and the loops list. */
  loops?: () => Promise<{ id: string; kind: string; title: string; who: string; dueAt?: number; status: string }[]>;
  calendar?: {
    events: () => Promise<CalEvent[]>;
    /** Reads every source again now (the private links fetched, the Mac's events asked for): the dashboard's refresh. */
    refresh?: () => Promise<unknown>;
    /** Each source and when it was last read, for the line under the agenda. */
    sources?: () => Promise<CalendarFreshness[]>;
  };
  integrations: () => Integration[];
  /** The language of Pako's own texts (src/i18n.ts): always English; kept so the callers that pass it did not have to change. */
  lang?: () => Lang;
  /** Local mode: the person's own choices, and the route that changes them. Absent on a server (its settings are its environment). */
  settings?: PanelSettings;
  /** Local mode: whether the demo week runs (src/demo.ts), and whether Claude is signed in to run it live. Absent on a server. */
  demo?: { on: boolean; live: () => boolean };
  now?: () => number;
}

/** One calendar source under the agenda: "Mac · synced 2 min ago", "Google link · synced 3 h ago (Google updates private links slowly)". */
export interface CalendarFreshness {
  label: string;
  lastSync: number | null;
  /** Google's private links refresh slowly on Google's side (often hours): said so the owner does not blame Pako's sync. */
  slow?: boolean;
  /** Why it cannot be read now, in the owner's words. */
  error?: string | null;
}

/** What the page shows, in one answer. */
export interface Overview {
  now: number;
  timeZone: string;
  ownerName: string;
  paused: number | null;
  /** Why: the owner, the store came back empty, or the store cannot be read yet (src/control.ts). Null when running. */
  pauseWhy: PauseWhy | null;
  mac: { lastPoll: number; online: boolean };
  integrations: Integration[];
  events: (Omit<CalEvent, "calendar"> & { clash: boolean })[];
  calendarOk: boolean;
  /** Whether a calendar is connected at all (calendarOk false then means it could not be read). */
  calendarOn: boolean;
  /** The calendar sources and their last sync, for the freshness line under the agenda. */
  calendarSources: CalendarFreshness[];
  /** A new mailbox's catch-up, while it runs and after (null: none). */
  catchUp: { running: boolean; percent: number; total: number; notAnalysed: number; days: number } | null;
  /** The open loops (null: follow-ups off): what the owner owes and what others owe them. */
  loops: { id: string; kind: string; title: string; who: string; dueAt?: number; status: string }[] | null;
  mail: { address: string; items: RecentMail[] } | null;
  slack: SlackAlert[] | null;
  /** Whether the panel has its own chat window (local mode). */
  chat: boolean;
  /** Null when table booking is not connected. */
  bookings: Pick<SavedBooking, "id" | "name" | "slot" | "party" | "route" | "status">[] | null;
  reminders: { at: number; text: string; held: boolean }[];
  notes: { at: number; text: string }[];
  calls: { at: number; summary: string }[];
  happenings: { at: number; text: string }[];
  log: { at: number; kind: string; text: string }[];
  /** On a computer, until the welcome is done or skipped: the page shows it. */
  firstVisit: boolean;
  /** What Pako calls the owner: on a computer the name they gave ("" when none yet), on a server the owner's setting. */
  name: string;
  /** On a computer: what the person can choose in the panel (a setting decides the rest). Null on a server. */
  choose: { name: boolean } | null;
  /** On a computer: the demo week (on, and live with Claude); null on a server, where there is none. */
  demo: { on: boolean; live: boolean } | null;
}

const safe = <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);
/** The dashboard's refresh reads the calendars again at most this often. */
export const REFRESH_EVERY_MS = 30_000;

export async function overview(d: PanelDeps): Promise<Overview> {
  const t = (d.now ?? Date.now)();
  let calendarOk = !!d.calendar;
  const events = d.calendar
    ? await d.calendar.events().catch(() => {
        calendarOk = false;
        return [] as CalEvent[];
      })
    : [];
  const timed = events.filter((e) => !e.allDay).sort((a, b) => a.start - b.start);
  const clash = new Set<string>();
  for (let i = 0; i < timed.length; i++)
    for (let j = i + 1; j < timed.length && timed[j]!.start < timed[i]!.end; j++) clash.add(timed[i]!.id).add(timed[j]!.id);
  const memory = await safe(d.memory.read(), { notes: [], calls: [] });
  const lastPoll = d.wa.lastPoll();
  const pause = await safe(d.control.state(), { paused: null, why: null } as PauseState);
  return {
    now: t,
    timeZone: d.timeZone,
    ownerName: d.ownerName,
    paused: pause.paused,
    pauseWhy: pause.why,
    mac: { lastPoll, online: lastPoll > 0 && t - lastPoll < 90_000 },
    integrations: d.integrations(),
    events: events.filter((e) => e.end > t - 12 * 3600_000).slice(0, 80).map(({ calendar: _c, ...e }) => ({ ...e, clash: clash.has(e.id) })),
    calendarOk,
    calendarOn: !!d.calendar,
    calendarSources: d.calendar?.sources ? await safe(d.calendar.sources(), []) : [],
    catchUp: d.catchUp ? await safe(d.catchUp(), null) : null,
    loops: d.loops
      ? (await safe(d.loops(), [])).slice(0, 100).map((l) => ({ id: l.id, kind: l.kind, title: l.title, who: l.who, status: l.status, ...(l.dueAt ? { dueAt: l.dueAt } : {}) }))
      : null,
    mail: d.mail ? { address: d.mail.address, items: await safe(d.mail.items(), []) } : null,
    // What the card shows: when, who and where, the words (the ids kept for the rehearsal stay on the server).
    slack: d.slack ? (await safe(d.slack.alerts(), [])).map(({ at, where, text }) => ({ at, where, text })) : null,
    chat: !!d.chat,
    bookings: d.bookings
      ? (await safe(d.bookings.list(), [])).filter((b) => b.status !== "cancelada" && b.slot > t - 3 * 3600_000).sort((a, b) => a.slot - b.slot).slice(0, 12)
          .map(({ id, name, slot, party, route, status }) => ({ id, name, slot, party, route, status }))
      : null,
    reminders: await safe(d.wa.reminders(), []),
    notes: [...memory.notes].reverse(),
    calls: [...memory.calls].reverse(),
    happenings: [...d.wa.events()].reverse(),
    log: [...(await safe(d.control.recent(120), []))].reverse(),
    firstVisit: !!d.settings && !d.settings.welcomed(),
    name: d.settings ? d.settings.name() : d.ownerName,
    choose: d.settings ? { name: !d.settings.fixed.name } : null,
    demo: d.demo ? { on: d.demo.on, live: d.demo.on && d.demo.live() } : null,
  };
}

const VENDOR: Record<string, { file: string; type: string }> = {
  "gsap.min.js": { file: "gsap/dist/gsap.min.js", type: "text/javascript" },
  "lucide.min.js": { file: "lucide/dist/umd/lucide.min.js", type: "text/javascript" },
  "three.module.js": { file: "three/build/three.module.js", type: "text/javascript" },
  "three.core.js": { file: "three/build/three.core.js", type: "text/javascript" },
  "inter.woff2": { file: "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2", type: "font/woff2" },
};
const PAGES: Record<string, string> = { "app.js": "text/javascript", "app.css": "text/css", "orb.js": "text/javascript", "i18n.js": "text/javascript" };
PAGES["connections.js"] = "text/javascript";
PAGES["pako-figure.js"] = "text/javascript"; // Pako's figure: its states and the page's events (the orb and its twins read it)
PAGES["figure-twin.js"] = "text/javascript"; // the figure without WebGL, for every other place of a page
PAGES["figure.css"] = "text/css";
PAGES["brief.js"] = "text/javascript"; // the daily brief's button (src/brief.ts)
PAGES["brief-page.js"] = "text/javascript"; // the written brief's page, /panel/brief (src/brief-v2.ts)
PAGES["brief-page.css"] = "text/css";
// The connections page, /panel/settings (src/settings-page.ts): its script, styles, words and the model the tests read too.
PAGES["settings.js"] = "text/javascript";
PAGES["settings.css"] = "text/css";
PAGES["settings-words.js"] = "text/javascript";
PAGES["settings-model.js"] = "text/javascript";
PAGES["dashboard-model.js"] = "text/javascript"; // the dashboard's rules: empty sections, the tiles, channels, health (src/panel/dashboard-model.js)
PAGES["memory.js"] = "text/javascript";
PAGES["mail.js"] = "text/javascript"; // the mail: the "Needs you" preview, the category tabs, the reader, the mail settings (src/mail-panel.ts)
PAGES["tasks.js"] = "text/javascript";
PAGES["people.js"] = "text/javascript"; // the people in the owner's life (src/people.ts)
PAGES["routines.js"] = "text/javascript"; // routines and watches (src/routines.ts)
PAGES["autostart.js"] = "text/javascript"; // the "start with this computer" switch (src/autostart-panel.ts)
PAGES["demo.js"] = "text/javascript"; // the demo week's Settings card and banner (src/demo.ts)
PAGES["privacy.js"] = "text/javascript"; // what Pako keeps, the export, deleting everything (src/data-panel.ts)
PAGES["papers.js"] = "text/javascript"; // a photo or a PDF put in the chat (src/papers-panel.ts)
PAGES["meetings.js"] = "text/javascript"; // the meetings reviewed (src/meeting-review.ts)
PAGES["acts.js"] = "text/javascript"; // "How Pako acts": autonomy (src/autonomy.ts) and the topics on its own (src/proactive.ts)
PAGES["quality.js"] = "text/javascript"; // "Calidad" and "Ensayo" (src/quality.ts, src/rehearsal.ts)
PAGES["health.js"] = "text/javascript"; // the health of every part (src/watchdog.ts)
PAGES["move.js"] = "text/javascript"; // moving from a server to a computer: the export there, the import here (src/move.ts)
PAGES["whatsapp.js"] = "text/javascript"; // WhatsApp on a computer, set up in five steps (src/whatsapp-computer.ts)
PAGES["whatsapp.css"] = "text/css";
/** Made here rather than kept as files: the QR that opens @BotFather in Telegram (the first of the Telegram card's three steps). */
const MADE: Record<string, { type: string; make: () => string }> = {
  "botfather.svg": { type: "image/svg+xml", make: () => renderSVG("https://t.me/BotFather", { border: 2 }) },
};

/** The panel's own lines in the activity log. */
const LOG = texts(
  { opened: "Panel opened in a new browser", stop: "STOP from the panel: everything stopped", resume: "RESUME from the panel: running again" },
);

/** The page a used link answers with: it goes on to /panel from this origin (a same-site navigation). */
const entering = (): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0;url=/panel"><title>Pako · Opening</title><link rel="stylesheet" href="/panel/assets/app.css"></head>
<body class="signin"><main class="signin-card"><span class="orb-fallback big"></span><h1>Opening…</h1>
<p><a href="/panel">Open the panel</a></p></main></body></html>`;

const HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  // Another site may neither load these answers into its own page nor keep a hold on a panel window it opened (and steer it on, again and again).
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/** A connection from this same computer (127.0.0.0/8 or ::1, also as an IPv4-mapped IPv6 address): the socket's own address, never a header. */
export function isLoopback(address: string | undefined): boolean {
  const a = (address ?? "").toLowerCase().replace(/^::ffff:/, "");
  return a === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** Two secrets compared in constant time, whatever their lengths. */
const sameSecret = (a: string, b: string): boolean => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

export function mountDashboard(app: Express, d: PanelDeps) {
  const now = d.now ?? Date.now;
  const lang = d.lang ?? ((): Lang => "en");
  const made = new Map<string, string>();
  const base = (): string => (typeof d.publicUrl === "function" ? d.publicUrl() : d.publicUrl).replace(/\/$/, "");
  const key = createHmac("sha256", d.secret).update("pako-panel-session").digest();
  const sign = (exp: number) => createHmac("sha256", key).update(String(exp)).digest("base64url");
  const links = new Map<string, number>();
  const root = new URL("../node_modules/", import.meta.url);
  const pages = new URL("./panel/", import.meta.url);
  const cache = new Map<string, Buffer>();
  const file = (u: URL): Buffer => {
    const k = u.href;
    if (!cache.has(k)) cache.set(k, readFileSync(u));
    return cache.get(k)!;
  };

  // Cookies are shared by every port of "localhost": two Pakos (or Pako and another app) on one computer would sign each other out. The port is in the name.
  const cookieName = (): string => {
    try {
      const u = new URL(base());
      return `${COOKIE}_${u.port || (u.protocol === "https:" ? "443" : "80")}`;
    } catch {
      return COOKIE;
    }
  };
  /** The page for a browser that is not signed in: a computer's own (it says to run npm run panel), or a server's. */
  const signin = (): Buffer => file(new URL(d.chat ? "signin-local.html" : "signin.html", pages));
  /** A new value at every start: a tab that kept the ids of an earlier history (a lost chat file) starts again from the top. */
  const epoch = String(now());

  /** A one-time sign-in link, valid for 10 minutes. */
  const newLink = (): string => {
    const t = now();
    for (const [k, until] of links) if (until < t) links.delete(k);
    const token = randomBytes(24).toString("base64url");
    links.set(token, t + LINK_MS);
    return `${base()}/panel/login/${token}`;
  };

  const signedIn = (req: Request): boolean => {
    const raw = String(req.headers.cookie ?? "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${cookieName()}=`))
      ?.slice(cookieName().length + 1);
    const [exp, mac] = (raw ?? "").split(".");
    if (!exp || !mac || !/^\d{10,16}$/.test(exp) || Number(exp) < now()) return false;
    const a = Buffer.from(mac);
    const b = Buffer.from(sign(Number(exp)));
    return a.length === b.length && timingSafeEqual(a, b);
  };

  // Any web page can send requests to this address from the browser; thirty wrong links must not lock the owner out of the sign-in (a link lives ten minutes).
  const failed = rateLimit({ windowMs: 15 * 60_000, limit: 300, skipSuccessfulRequests: true, standardHeaders: "draft-8", legacyHeaders: false });

  app.get("/", (_req, res) => res.redirect(302, "/panel"));
  app.get("/panel", (req, res) => {
    res.set({ ...HEADERS, "Cache-Control": "no-store" });
    if (!signedIn(req)) {
      res.type("html").send(signin());
      return;
    }
    // Whether the chat is in this panel (a computer) goes on <html>, for the few texts that name the place to write; and so does the owner's
    // country (src/region.ts), so the page writes dates and times the way the server does (3:05 PM in the US).
    const page = file(new URL("index.html", pages));
    const attrs = `${d.chat ? " data-chat" : ""}${regionAttr()}`;
    res.type("html").send(!attrs ? page : page.toString("utf8").replace('<html lang="en">', `<html lang="en"${attrs}>`));
  });
  app.get("/panel/login/:token", failed, (req, res) => {
    res.set({ ...HEADERS, "Cache-Control": "no-store" });
    const token = String(req.params.token ?? "");
    const until = links.get(token);
    links.delete(token); // one use, whatever happens
    if (!until || until < now()) {
      res.status(401).type("html").send(signin());
      return;
    }
    const exp = now() + SESSION_MS;
    res.cookie(cookieName(), `${exp}.${sign(exp)}`, { httpOnly: true, secure: base().startsWith("https://"), sameSite: "strict", path: "/panel", maxAge: SESSION_MS });
    d.control.log("panel", LOG(lang())("opened"));
    // Not an HTTP redirect: a browser coming from another site (the WhatsApp link) treats a redirect chain as cross-site and holds back the
    // SameSite=Strict cookie just set. This page moves on by itself, from our own origin, so the cookie goes with it.
    res.type("html").send(entering());
  });
  // The refresh button (and coming back to the page after a while) reads the calendars again for real, at most once every 30 seconds: a new
  // invitation then shows without waiting for the next ten-minute read.
  let refreshedAt = 0;
  app.get("/panel/api/overview", async (req, res) => {
    res.set({ ...HEADERS, "Cache-Control": "no-store" });
    if (!signedIn(req)) {
      res.status(401).json({ error: "sign in" });
      return;
    }
    try {
      const t = (d.now ?? Date.now)();
      if (req.query.fresh === "1" && d.calendar?.refresh && t - refreshedAt >= REFRESH_EVERY_MS) {
        refreshedAt = t;
        await d.calendar.refresh().catch((err: unknown) => logPanel.error(`the calendar refresh failed: ${(err as Error)?.message}`));
      }
      res.json(await overview(d));
    } catch (err) {
      logPanel.error(`${(err as Error).message}`);
      res.status(500).json({ error: "could not read" });
    }
  });
  // The STOP switch. A custom header and the strict cookie keep another site from pressing it.
  app.post("/panel/api/pause", express.json({ limit: "1kb" }), async (req, res) => {
    res.set({ ...HEADERS, "Cache-Control": "no-store" });
    if (!signedIn(req) || req.get("x-pako") !== "1") {
      res.status(401).json({ error: "sign in" });
      return;
    }
    const on = (req.body as { on?: unknown })?.on === true;
    const kept = await d.control.setPaused(on, now());
    d.control.log("pause", LOG(lang())(on ? "stop" : "resume"));
    res.json({ paused: on ? now() : null, why: on ? "owner" : null, kept });
  });
  // The person's own choices on a computer (src/local.ts): the name Pako calls them by, the welcome done. Same
  // protection as STOP: the strict cookie and a custom header. A server's settings are its environment: there this answers 404.
  const settingsLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });
  const settingsAuth: RequestHandler = (req, res, next) => {
    res.set({ ...HEADERS, "Cache-Control": "no-store" });
    if (!d.settings) {
      res.status(404).json({ error: "no settings here" });
      return;
    }
    if (!signedIn(req) || req.get("x-pako") !== "1") {
      res.status(401).json({ error: "sign in" });
      return;
    }
    next();
  };
  app.post("/panel/api/settings", settingsAuth, settingsLimiter, express.json({ limit: "1kb" }), async (req, res) => {
    const s = d.settings!;
    const body: unknown = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({ error: "send a JSON object: { name?, welcomed? }" });
      return;
    }
    // A `lang` field (a page from before Pako's texts were English only) is accepted and ignored.
    const { name, welcomed } = body as Record<string, unknown>;
    const problem =
      name !== undefined && (typeof name !== "string" || name.trim().length > 40) ? "name must be text of 40 characters at most"
      : welcomed !== undefined && welcomed !== true ? "welcomed can only be true"
      : "";
    if (problem) {
      res.status(400).json({ error: problem });
      return;
    }
    // Saved as asked even when a setting decides instead (PAKO_NAME): the answer says what holds now.
    if (typeof name === "string") s.setName(name);
    if (welcomed === true) s.setWelcomed();
    try {
      await s.changed?.();
    } catch (err) {
      logPanel.error(`after a change of settings: ${(err as Error).message}`);
    }
    res.json({ ok: true, name: s.name() });
  });
  // The chat window (local mode). Same protection as the STOP switch: the strict cookie and a custom header, so another site cannot type for you.
  const chatLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false });
  /** Not signed in (or no chat here) is answered before anything is counted: only the owner's own requests use up the allowance. */
  const chatAuth = (needHeader: boolean): RequestHandler => (req, res, next) => {
    res.set({ ...HEADERS, "Cache-Control": "no-store" });
    if (!d.chat) {
      res.status(404).json({ error: "no chat" });
      return;
    }
    if (!signedIn(req) || (needHeader && req.get("x-pako") !== "1")) {
      res.status(401).json({ error: "sign in" });
      return;
    }
    next();
  };
  app.get("/panel/api/chat", chatAuth(false), async (req, res) => {
    const since = Math.max(0, Number.parseInt(String(req.query.since ?? "0"), 10) || 0);
    res.json({ messages: await d.chat!.list(since), status: d.chat!.status(), name: d.ownerName, epoch });
  });
  // How Claude is doing on this computer, for the Mac app's Connect Claude window (desktop/mac): the chat's status, read only. With ?fresh=1 the
  // command and its sign-in are looked at again first (at most once every three seconds, src/local.ts), while the person installs or signs in.
  const claudeLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false });
  app.get("/panel/api/claude", chatAuth(false), claudeLimiter, async (req, res) => {
    const fresh = req.query.fresh === "1" && d.chat!.refresh;
    res.json({ status: fresh ? await d.chat!.refresh!() : d.chat!.status() });
  });
  app.post("/panel/api/chat", chatAuth(true), chatLimiter, express.json({ limit: "16kb" }), async (req, res) => {
    const text = typeof (req.body as { text?: unknown })?.text === "string" ? (req.body as { text: string }).text.trim().slice(0, 4000) : "";
    if (!text) {
      res.status(400).json({ error: "empty" });
      return;
    }
    await d.chat!.send(text);
    res.status(202).json({ ok: true });
  });
  app.post("/panel/api/chat/press", chatAuth(true), chatLimiter, express.json({ limit: "1kb" }), async (req, res) => {
    const id = (req.body as { id?: unknown })?.id;
    if (typeof id !== "string" || !/^[a-z0-9]{1,3}:[0-9a-f]{10}$/.test(id)) {
      res.status(400).json({ error: "bad id" });
      return;
    }
    await d.chat!.press(id);
    res.status(202).json({ ok: true });
  });
  app.get("/panel/assets/:name", (req, res) => {
    const name = String(req.params.name ?? "");
    // Own keys only: "constructor" and "toString" are properties of every object.
    const vendor = Object.hasOwn(VENDOR, name) ? VENDOR[name] : undefined;
    const page = Object.hasOwn(PAGES, name) ? PAGES[name] : undefined;
    const making = Object.hasOwn(MADE, name) ? MADE[name] : undefined;
    if (making) {
      if (!made.has(name)) made.set(name, making.make());
      res.set({ ...HEADERS, "Cache-Control": "public, max-age=86400" });
      res.type(making.type).send(made.get(name));
      return;
    }
    if (!vendor && !page) {
      res.status(404).type("text").send("Not found");
      return;
    }
    res.set({ ...HEADERS, "Cache-Control": vendor ? "public, max-age=604800, immutable" : "no-cache" });
    res.type(vendor ? vendor.type : page!).send(file(vendor ? new URL(vendor.file, root) : new URL(name, pages)));
  });

  // ---------- only on a computer: the terminal and the bridge next to the server ----------
  if (d.chat) {
    const chat = d.chat;
    // Answered on this computer's own address only, whatever address the server listens on (PAKO_HOST); and only for the bridge token, which
    // only this user can read (~/.pako/secrets.json).
    // A web page can send these requests too (any site open in a browser on this Mac reaches 127.0.0.1): it gets no answer it can read, but
    // each one would use up the limit and lock the app and `npm run panel` out. Browsers always mark such requests (Origin or Sec-Fetch-Site);
    // the app's URLSession, bin/panel.cjs and the bridge send neither, so a marked request is refused before it is counted.
    const here: RequestHandler = (req, res, next) => {
      res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      if (!isLoopback(req.socket.remoteAddress) || req.get("origin") !== undefined || req.get("sec-fetch-site") !== undefined) {
        res.status(403).json({ error: "only from this computer" });
        return;
      }
      next();
    };
    const withToken: RequestHandler = (req, res, next) => {
      const m = /^Bearer (.+)$/.exec(req.get("authorization") ?? "");
      if (!m || !sameSecret(m[1]!, d.secret)) {
        res.status(401).json({ error: "wrong token" });
        return;
      }
      next();
    };
    // `npm run panel` (bin/panel.cjs) and the Mac app: a link that is used or old is worth nothing, and they ask for a new one instead of a
    // restart. Only a refused token counts: the owner's own requests never lock them out, a guesser is still stopped after thirty tries.
    const tokenLimiter = () => rateLimit({
      windowMs: 15 * 60_000,
      limit: 30,
      skipSuccessfulRequests: true,
      requestWasSuccessful: (_req, res) => res.statusCode !== 401,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    });
    app.post("/panel/api/link", here, tokenLimiter(), withToken, (_req, res) => {
      res.json({ link: newLink() });
    });
    // The Mac app (desktop/mac) asks every few seconds what Pako wrote by itself since a time (?after=<ms>), to show a notification and a
    // Dock badge while the panel is hidden: read only, the bridge token's, newest 50 at most. A secret message (a one-time code) is said to
    // be there, never quoted: a notification can show on a locked screen.
    app.get("/panel/api/notices", here, tokenLimiter(), withToken, async (req, res) => {
      const after = Math.max(0, Number.parseInt(String(req.query.after ?? "0"), 10) || 0);
      const list = chat.notices ? await chat.notices(after) : [];
      res.json({
        now: now(),
        notices: list.map((m) => ({ n: m.n, at: m.at, text: m.secret ? "" : m.text.slice(0, 300), ...(m.secret ? { secret: true } : {}) })),
      });
    });
    // The bridge says how Claude is doing when that changes (signed in, not signed in, out of its limit), so the chat's banner can say what to do
    // instead of leaving a message waiting with no word. Only a refused token counts towards the limit.
    const healthLimiter = rateLimit({
      windowMs: 15 * 60_000,
      limit: 30,
      skipSuccessfulRequests: true,
      requestWasSuccessful: (_req, res) => res.statusCode !== 401,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    });
    // It also says which version it runs (assistant/update.ts), at its start: for the Salud card.
    app.post("/assistant/health", here, healthLimiter, withToken, express.json({ limit: "2kb" }), (req, res) => {
      const r = readBridgeReport(req.body);
      if (!r) {
        res.status(400).json({ error: "claude must be ok, login or limit (and version, when sent, {sha, committedAt})" });
        return;
      }
      if (r.claude) chat.report?.(r.claude);
      if (r.version) chat.version?.(r.version);
      if (r.usage) chat.usage?.(r.usage);
      res.json({ ok: true });
    });
  }

  return {
    /** A one-time sign-in link, valid for 10 minutes. */
    link: newLink,
    /** Whether a request carries a valid panel session, for routes mounted elsewhere (src/telegram-panel.ts). */
    signedIn,
  };
}
