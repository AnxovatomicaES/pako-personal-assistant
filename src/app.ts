// The owner's personal assistant server: one HTTP app with the phone line (src/personal-caller.ts: the Caller connector,
// the LiveKit voice routes, the admin voice tools) and the WhatsApp door (src/whatsapp.ts: Meta's webhook and the Mac
// bridge routes). Nothing else is served. The restaurant connector that used to live here is at the git tag
// `connector-final`.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { loadCountry } from "./health.ts";
import { english, texts, type Lang } from "./i18n.ts";
import { ownerTimeZone, setOwnerRegion } from "./region.ts";
import { loadKv, type Kv } from "./kv.ts";
import { LOCAL_OWNER_NUMBER, pakoHome, STAND_IN_NAME, type LocalSettings, type LocalChannel, type BridgeHealth, type BridgeStatus } from "./local.ts";
import { createPaperStore } from "./papers.ts";
import { mountPaperUpload } from "./papers-panel.ts";
import { createControl, type Control } from "./control.ts";
import { localGuard } from "./guard-http.ts";
import { createStoreGuard, watchStore, type StoreLost } from "./store-guard.ts";
import { mountDashboard } from "./dashboard.ts";
import { calendarLog, createCalendarCore, createZohoSource, loadCalendarConfig, loadCalendarTiming, type CalendarReader } from "./calendar.ts";
import { createIcsSource, icsHosts, icsWhyText, loadIcsConfig } from "./ics.ts";
import { createInviteStore } from "./invites.ts";
import { createBackfill, loadBackfillConfig, type Backfill } from "./backfill.ts";
import type { CalendarFreshness } from "./dashboard.ts";
import { mountConnectionDetails } from "./connections-details.ts";
import { createBrief, loadBriefConfig, mountBriefPanel, type Brief } from "./brief.ts";
import { createBriefV2, loadBriefV2Config, mountBriefPage, type BriefV2 } from "./brief-v2.ts";
import { createZoom, loadZoomConfig, type ZoomReader } from "./zoom.ts";
import { briefMeetings, createMeetingReview, loadReviewConfig, mountMeetingsPanel, type MeetingReviewer, type ReviewDoor } from "./meeting-review.ts";
import { createCalendarChanges, type CalendarChanges } from "./calendar-changes.ts";
import { createMeetingPrep, loadMeetingPrepConfig } from "./meeting-prep.ts";
import { currentAbout, factLine } from "./memory-facts.ts";
import { createFollowups, followupsProxy, loadFollowupsConfig, type Followups, type FollowupsDoor } from "./followups.ts";
import { createQuality, mountQualityPanel, type Quality } from "./quality.ts";
import { createProactive, loadProactiveConfig, mountProactivePanel, type LifeDoor, type Proactive } from "./proactive.ts";
import { createRehearsal, mountRehearsalPanel, type Rehearsal } from "./rehearsal.ts";
import { loadSlackConfig, mountSlack, mountSlackCheckOnly, type SlackReader } from "./slack.ts";
import { createImapReader, loadImapConfig, type ImapReader } from "./imap.ts";
import { createMailbox, loadMailConfig, loadMailFilters, mountMail, sendEmail } from "./mail.ts";
import { chooseSender, loadResendConfig } from "./resend.ts";
import { createBooking, registerBookingTools, type Booking, type BookingReply, type BookingRequest } from "./booking.ts";
import { loadMaitre } from "./maitre/index.ts";
import { GooglePlaces } from "./restaurants/places.ts";
import { RestaurantEngine } from "./restaurants/engine.ts";
import { PublicPageFetcher } from "./restaurants/website.ts";
import { loadPersonalConfigSafely, mountPersonalCaller, type PersonalConfig } from "./personal-caller.ts";
import { loadWhatsappConfig, mountWhatsapp, type AskResult, type OwnerAsk, type OwnerChannel } from "./whatsapp.ts";
import { createTelegram, loadTelegramConfig, type TelegramChannel, type TelegramConfig } from "./telegram.ts";
import { mountTelegramPanel } from "./telegram-panel.ts";
import { createTunnel, installCloudflared } from "./tunnel.ts";
import { createComputerWhatsapp, mountWhatsappSetupAbsent, type ComputerWhatsapp } from "./whatsapp-computer.ts";
import { mountConnectionsPanel } from "./connections-panel.ts";
import { appliedAtStart, writeStored } from "./connections.ts";
import { builtInClients, SLACK_MARKETPLACE_LISTED } from "./connect-clients.ts";
import { createTokenSource, mountMailOAuth } from "./mail-oauth.ts";
import { createGoogleCalendarSource, loadGoogleCalendarConfig } from "./google-calendar.ts";
import { createLocalCalendar, findLocalEvent, hasLocalCalendar, mountLocalCalendarPanel } from "./calendar-local.ts";
import { createCalendarWrites, mountCalendarWrites, type CalendarWrite } from "./calendar-writes.ts";
import { mountConnectSetup } from "./connect-setup.ts";
import { claudeNotice, claudeStatusLine, createClaudeConnect, createClaudeKeeper, pressSignIn } from "./claude-connect.ts";
import { emailOf } from "./connect-routes.ts";
import { mountConnectionsStatus } from "./connections-status.ts";
import { createContactsStore, mountContactsPanel } from "./contacts.ts";
import { createDiscoveryStore, mountDiscoveryPanel } from "./discovery.ts";
import { mountMailConnect } from "./mail-autoconfig.ts";
import type { Verdict } from "./mail-categories.ts";
import { mountMailPanel } from "./mail-panel.ts";
import { createZoomLocal } from "./zoom-local.ts";
import { createTeams, isTeamsChannel, loadTeamsConfig, type TeamsReader } from "./teams.ts";
import { mountTeamsConnect } from "./teams-connect.ts";
import type { BackfillChat } from "./backfill.ts";
import { mountSettingsPage } from "./settings-page.ts";
import { mountAutostartPanel } from "./autostart-panel.ts";
import { mountDataPanel } from "./data-panel.ts";
import { mountMovePanel } from "./move.ts";
import { mountMemoryPanel } from "./memory-panel.ts";
import { mountTasksPanel } from "./lists.ts";
import { mountPeoplePanel } from "./people.ts";
import { createHiddenPeople, mountPeopleDirectory } from "./people-directory.ts";
import { eventSightings, mailSightings, slackSightings, zoomSightings, type Sighting } from "./people-graph.ts";
import { createAutonomySettings, loadAutonomyConfig, mountAutonomyPanel, parseContactEmails } from "./autonomy.ts";
import { mountRoutinesPanel } from "./routines.ts";
import { createJobs } from "./jobs.ts";
import {
  createWatchdog, loadWatchdogConfig, mountBridgeHealth, mountHealthPanel, readServerVersion, reportingKv, type BridgeUsage, type BridgeVersion, type HealthReport, type ClaudeState, type Version,
} from "./watchdog.ts";
import { createLog } from "./log.ts";

const logTeams = createLog("teams");

const logTime = createLog("time");
const logHealth = createLog("health");
const logWatchdog = createLog("watchdog");
const logWhatsapp = createLog("whatsapp");
const logMail = createLog("mail");
const logImap = createLog("imap");
const logSlack = createLog("slack");
const logZoom = createLog("zoom");
const logReview = createLog("review");
const logCalendar = createLog("calendar");
const logBackfill = createLog("backfill");
const logBrief = createLog("brief");
const logFollowups = createLog("followups");
const logProactive = createLog("proactive");
const logBooking = createLog("booking");
const logChat = createLog("chat");
const logTelegram = createLog("telegram");
const logLanguage = createLog("language");
const logAutonomy = createLog("autonomy");
const logPanel = createLog("panel");
const logPeopleGraph = createLog("people-graph");
const logApp = createLog("app");

type Env = Record<string, string | undefined>;

/** What the server itself says about Telegram: the owner's notice of a new pairing, and the panel's line for it. */
const TG = texts(
  {
    paired: "Telegram connected: the account {who} now talks to me. If that wasn't you, type TELEGRAM OFF here.",
    on: "Connected",
    pairChat: "Type TELEGRAM in the chat",
    pairQr: "Not connected: scan the QR code",
    none: "Not set up",
  },
);

/** The panel's list of what is connected: each part's name and its one line, in the language of Pako's own texts. */
const PARTS = texts(
  {
    chat: "Chat",
    chatHere: "In this panel",
    brain: "Brain",
    brainMac: "Brain (Mac)",
    brainHere: "Claude on this computer",
    brainOnMac: "Claude on your Mac",
    phone: "Phone",
    none: "Not set up",
    live: "Live",
    dry: "Simulated",
    mail: "Mail",
    calendar: "Calendar",
    readOnly: "Read only",
    off: "Off",
    panelNotReady: "(the panel is not ready)",
  },
);

export interface AppConfig {
  port: number;
  /** Opens the /admin routes (Basic or Bearer auth, or an X-Admin-Key header). Empty: they answer 401. */
  adminKey: string;
  /** Proxies in front of the app whose X-Forwarded-For is trusted (default 3 on Render, as measured). 0 = the socket address. */
  trustProxyHops: number;
  retell: { apiKey: string; fromNumber: string };
  /** Null when PERSONAL_CALLER_TOKEN is unset or a personal setting is wrong: the server still starts, without the line. */
  personalCaller: PersonalConfig | null;
}

const intFrom = (env: Env, name: string, fallback: number): number => {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${name} must be a whole number`);
  return n;
};

export function loadAppConfig(env: Env = process.env): AppConfig {
  const port = intFrom(env, "PORT", 8787);
  if (port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535");
  const adminKey = env.ADMIN_KEY ?? "";
  if (adminKey && adminKey.length < 24) throw new Error("ADMIN_KEY must be at least 24 characters");
  return {
    port,
    adminKey,
    // Render was measured at 3 proxies (Cloudflare, its balancer, a local proxy): with fewer, every visitor shares one address in the rate limits.
    trustProxyHops: intFrom(env, "TRUST_PROXY_HOPS", env.RENDER ? 3 : 0),
    retell: { apiKey: env.RETELL_API_KEY ?? "", fromNumber: env.RETELL_FROM_NUMBER ?? "" },
    personalCaller: loadPersonalConfigSafely(env),
  };
}

/** Headers for the admin answers: nothing cached, no referrer, no framing. */
const ADMIN_HEADERS: Record<string, string> = {
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

/** The admin key from Basic auth (any username), Bearer, or X-Admin-Key. Constant-time compare, of hashes: no early answer for a wrong length. */
export function adminRequest(req: Request, adminKey: string): boolean {
  const own = req.get("x-admin-key");
  const header = own !== undefined ? `Bearer ${own}` : req.headers.authorization;
  if (!header || !adminKey) return false;
  let supplied = "";
  if (header.toLowerCase().startsWith("bearer ")) supplied = header.slice(7).trim();
  else if (header.toLowerCase().startsWith("basic ")) {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    supplied = decoded.slice(decoded.indexOf(":") + 1);
  }
  return timingSafeEqual(createHash("sha256").update(supplied).digest(), createHash("sha256").update(adminKey).digest());
}

/** Local mode (src/local.ts): what the server needs to run for one person on this computer, with no WhatsApp. */
export interface LocalContext {
  /** The file store at home (src/sqlite-kv.ts): `onSave` tells the watchdog how each save went. */
  kv: Kv & { onSave?: (report: (ok: boolean, detail?: string) => void) => void };
  channel: LocalChannel;
  bridgeToken: string;
  /** The secret that signs the panel's sessions, kept between starts so the browser stays signed in. */
  panelSecret: string;
  /** The supervised bridge (src/local.ts): its status for the chat's banner, and what it reports about Claude. */
  bridge: { status: () => BridgeStatus; report?: (claude: BridgeHealth) => void; refresh?: () => Promise<BridgeStatus> };
  /**
   * For the store guard (src/store-guard.ts): whether this is the person's first run, and why the file store started empty, if it did.
   * Absent: nothing is ever paused for it.
   */
  storeStart?: { firstRun: boolean; lost: StoreLost | null };
  /** What the person chose in the panel: their name, the welcome (src/local.ts). */
  settings?: LocalSettings;
  /**
   * Tests only: the fetch and the name lookup the ICS feeds are read through (src/ics.ts). Absent: the guarded fetch of
   * src/restaurants/website.ts, each hop's host checked to be public.
   */
  icsNet?: { fetch: typeof fetch; resolve: (host: string) => Promise<string[]> };
}

/** The store key that says this Places key has answered once (a hash of the key): src/data.ts "places-ok". */
const PLACES_OK_KEY = "places-ok";

/**
 * PAKO_LANGUAGE once chose the language of Pako's own texts (Spanish or English). Those are English only now, and Claude answers in the
 * language each message is written in, so the setting does nothing: a server that still has it starts as usual and says so once in its log.
 */
export const languageIgnoredNote = (env: Env): string | null =>
  (env.PAKO_LANGUAGE ?? "").trim()
    ? "PAKO_LANGUAGE is ignored: Pako's own texts are English; Claude replies in the language you write in"
    : null;

export { STAND_IN_NAME };

/** The first message in the panel's chat on a computer: who Pako is, what to try, and where to see the rest. */
const HELLO = texts(
  {
    named: "Hi, {name}. I'm Pako, your assistant. Ask me anything in your own words: “what do I have today?”, “what am I forgetting?”, "
      + "“remind me to call Ana tomorrow”.\n\nNo commands to learn; if you'd like shortcuts, type HELP.",
    plain: "Hi, I'm Pako, your assistant. Ask me anything in your own words: “what do I have today?”, “what am I forgetting?”, "
      + "“remind me to call Ana tomorrow”.\n\nNo commands to learn; if you'd like shortcuts, type HELP.",
  },
);

export function createApp(config: AppConfig, env: Env = process.env, local?: LocalContext): Express {
  const app = express();
  app.disable("x-powered-by");
  // Every module that writes a fixed text still takes the language as a function (src/i18n.ts): always English.
  const uiLang = english;
  const languageNote = languageIgnoredNote(env);
  if (languageNote) logLanguage.warn(languageNote);
  app.locals.uiLang = uiLang;
  // Where the owner is (src/region.ts): their time zone, with or without the phone line's settings, and their country, which sets the
  // emergency numbers and how every date and time is written ("en-US": 3:05 PM; "en-GB": 15:05). Said once when it is only a guess.
  const ownerZone = config.personalCaller?.timeZone ?? ownerTimeZone(env.PERSONAL_TIMEZONE).timeZone;
  const zoneNote = config.personalCaller ? config.personalCaller.timeZoneNote : ownerTimeZone(env.PERSONAL_TIMEZONE).note;
  if (zoneNote) logTime.error(`${zoneNote}`);
  const country = loadCountry(env);
  if (country.problem) logHealth.error(`${country.problem}`);
  setOwnerRegion(country.country);
  app.set("trust proxy", config.trustProxyHops > 0 ? config.trustProxyHops : false);
  // The owner's WhatsApp on a computer (src/whatsapp-computer.ts), set up in the panel: first of all, what came through its tunnel reaches
  // the webhook paths only. Then, on a computer, before every route: only this computer's own names for Pako, and nothing another website's
  // page sends (src/guard-http.ts). Its webhook comes before the door's (which on a computer has stand-in settings only).
  /** The watchdog's WhatsApp part for the computer's webhook, set once the watchdog is made (below). */
  const waHealth: { report: HealthReport | null } = { report: null };
  const waComputer: ComputerWhatsapp | null = local
    ? createComputerWhatsapp({
        health: (ok, detail) => waHealth.report?.(ok, detail),
        store: {
          read: () => local.settings?.whatsapp?.() ?? null,
          write: (v) => (local.settings?.setWhatsapp ? local.settings.setWhatsapp(v as Record<string, unknown> | null) : false),
        },
        kv: local.kv,
        env,
        lang: uiLang,
        tunnel: (onUrl) => createTunnel({ port: () => config.port, install: () => installCloudflared({ dir: join(pakoHome(env), "bin") }), onUrl }),
        phoneOn: () => !!((env.LIVEKIT_URL ?? "").trim() && (env.LIVEKIT_API_KEY ?? "").trim() && (env.LIVEKIT_API_SECRET ?? "").trim()),
      })
    : null;
  if (waComputer) app.use(waComputer.gate);
  if (local) app.use(localGuard({ host: env.PAKO_HOST, lang: uiLang }));
  if (waComputer) {
    waComputer.mountWebhook(app);
    // server.ts starts it once the server listens (the tunnel again, if it was on), and stops it on shutdown.
    app.locals.whatsappComputer = { start: waComputer.start, stop: waComputer.stop };
  }

  // Public, so it says only that the server is up.
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  const adminLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, skipSuccessfulRequests: true, standardHeaders: "draft-8", legacyHeaders: false });
  const adminOnly = (req: Request, res: Response): boolean => {
    res.set(ADMIN_HEADERS);
    if (config.adminKey && adminRequest(req, config.adminKey)) return true;
    res.status(401).set("WWW-Authenticate", 'Basic realm="assistant admin", charset="UTF-8"').type("text").send("Admin key required.");
    return false;
  };

  // The watchdog (src/watchdog.ts): each part says how its rounds go, and the owner hears once when one stays broken. Built first, as the
  // store reports to it; what it needs from the door (the chat to tell, the computer's last request) is looked up once that exists.
  const dogCfg = loadWatchdogConfig(env);
  if (dogCfg.problems.length) logWatchdog.error(`${dogCfg.problems.join("; ")}`);
  const dogRef: {
    tell: ((text: string) => Promise<unknown>) | null;
    lastPoll: (() => number) | null;
  } = { tell: null, lastPoll: null };
  // This server's version, read once when first asked (git, or Render's RENDER_GIT_COMMIT): only a server compares it with its computer's.
  let ownVersion: Version | null | undefined;
  const rawKv = local ? local.kv : loadKv(env.VOICE_RESULTS_URL);
  const dog = createWatchdog({
    config: dogCfg.config,
    local: !!local,
    timeZone: ownerZone,
    lang: uiLang,
    kv: rawKv,
    notify: () => dogRef.tell,
    ...(local
      ? {
          claude: (): ClaudeState | null => {
            const s = local.bridge.status();
            // Signed in but not running for a quarter of an hour: the bridge keeps stopping (src/local.ts restarts it).
            return s.claude === "starting" ? null : s.claude === "ok" && !s.running ? "stopped" : s.claude;
          },
        }
      : {
          lastPoll: () => (dogRef.lastPoll ? dogRef.lastPoll() : null),
          serverVersion: () => (ownVersion === undefined ? (ownVersion = readServerVersion(env, fileURLToPath(new URL("..", import.meta.url)))) : ownVersion),
        }),
  });
  app.locals.watchdog = dog;
  // On a computer only: a server's WhatsApp part comes from its sends (src/whatsapp.ts health), a computer's from registering its webhook.
  if (waComputer) waHealth.report = dog.reporter("whatsapp");
  if (rawKv) dog.watch("store");
  local?.kv.onSave?.(dog.reporter("store"));
  // The kill switch and the action log, shared by the phone line, WhatsApp and the mail (src/control.ts). The store notes which of the keys
  // the store guard looks at this process writes itself, so the guard (below) never takes them for an older Pako's. A server's store says
  // how each write went (a computer's file store says it on each save, above).
  const store = watchStore(local ? local.kv : rawKv ? reportingKv(rawKv, dog.reporter("store")) : null);
  const kv = store.kv;
  const control: Control = createControl(kv);
  // The durable jobs (src/jobs.ts): the one clock for the brief, reminders, routines and follow-up checks, kept in the store. A computer
  // sleeps, so its late runs follow each kind's rule; a server is always on and behaves as before.
  const jobs = createJobs({ kv, sleeps: !!local });
  // The owner's chat for the store guard's notice, the line it leaves in the assistant's context, and what else this server keeps in the
  // store: set once the door is built.
  let tellOwner: ((text: string) => Promise<unknown>) | null = null;
  let tellAssistant: ((text: string) => void) | null = null;
  let parts = { mail: false, telegram: false, calendar: false };
  app.get("/admin/log", adminLimiter, async (req, res) => {
    if (!adminOnly(req, res)) return;
    res.json({ paused: await control.paused(), log: await control.recent(300) });
  });

  // The owner's phone line: off unless PERSONAL_CALLER_TOKEN is set (docs/personal-caller.md).
  if (config.personalCaller) {
    // The connector's table-booking tools use the booking service and the WhatsApp door, which are built below: looked up when a request comes.
    const bookingRef: { booking: Booking | null; start: ((r: BookingRequest) => void) | null } = { booking: null, start: null };
    // The connector's friend calls wait for the owner's press on a card, which the WhatsApp door (built below) sends: looked up when a request comes.
    const askRef: { ask: ((a: OwnerAsk) => Promise<AskResult>) | null } = { ask: null };
    const personal = mountPersonalCaller(app, {
      config: config.personalCaller,
      retell: config.retell,
      adminOnly,
      adminLimiter,
      control,
      kv,
      lang: uiLang,
      quiet: !!local,
      askOwner: (a) => (askRef.ask ? askRef.ask(a) : Promise.resolve({ ok: false, why: "This server has no WhatsApp set up to send the card to." })),
      extraTools: (server) => {
        if (bookingRef.booking && bookingRef.start) registerBookingTools(server, bookingRef.booking, bookingRef.start, ownerZone);
      },
    });
    // The owner's WhatsApp door: off unless the three Meta values are set (assistant/README.md).
    // Local mode has no WhatsApp: the door runs with stand-in settings (nothing is ever sent to Meta) and the chat window of the panel is its screen.
    const wa = local
      ? {
          config: {
            accessToken: "local", phoneNumberId: "0", appSecret: local.panelSecret, verifyToken: local.panelSecret, bridgeToken: local.bridgeToken,
            ownerDigits: LOCAL_OWNER_NUMBER.replace(/\D/g, ""), ownerBsuid: "", graphVersion: "v23.0", templateName: "", templateLang: "en", friendMessages: false, reminderTemplate: "",
          },
          problems: [] as string[],
        }
      : loadWhatsappConfig(env, config.personalCaller.ownerNumber);
    if (wa.problems.length) logWhatsapp.error(`off, because: ${wa.problems.join("; ")}`);
    if (wa.config) {
      const friends = config.personalCaller.contacts;
      const plain = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
      const timeZone = config.personalCaller.timeZone;
      // The owner's name, read each time: on a computer the one given in the panel applies at once (src/local.ts settings, where PAKO_NAME
      // wins); without one, the name the server started with, unless that was only the stand-in.
      const startName = config.personalCaller.ownerName;
      const startedNameless = !!local && startName === STAND_IN_NAME;
      const givenName = (): string => local?.settings?.name() || (startedNameless ? "" : startName);
      const ownerName = (): string => givenName() || STAND_IN_NAME;
      // The assistant's own email inbox (src/mail.ts): off unless the three AgentMail values are set.
      const mail = loadMailConfig(env);
      if (mail.problems.length) logMail.error(`off, because: ${mail.problems.join("; ")}`);
      // Sending from Pako's own domain (src/resend.ts): when set, the emails the owner asks for go out through Resend instead of the
      // AgentMail inbox; inbound mail stays with AgentMail or IMAP.
      const resend = loadResendConfig(env);
      if (resend.problems.length) logMail.error(`Resend off, because: ${resend.problems.join("; ")}`);
      const outgoing = chooseSender({ resend: resend.config, agentmail: mail.config });
      if (outgoing) logMail.info(`emails the owner asks for go out through ${outgoing.via === "resend" ? "Resend" : "AgentMail"}`);
      // The owner's own mailbox, read only by IMAP (src/imap.ts): off unless IMAP_HOST, IMAP_USER and IMAP_PASSWORD are set. Its mail joins the
      // same mailbox state as the inbox's (MAIL, the brief, the panel, the codes), so either one turns that on.
      const imap = loadImapConfig(env);
      if (imap.problems.length) logImap.error(`off, because: ${imap.problems.join("; ")}`);
      if (imap.config && mail.config) {
        logImap.info("Pako's inbox is on too: if that mailbox is forwarded there, stop forwarding it (an email whose forward changes it could come twice)");
      }
      const imapRef: { reader: ImapReader | null } = { reader: null };
      // A reply of the owner's found in their Sent mail closes the loops of the mail it answers (the follow-ups are built later: looked up then).
      const repliedRef: { close: (ids: string[]) => void } = { close: () => undefined };
      const box = mail.config || imap.config
        ? createMailbox(kv, { showCodes: loadMailFilters(env).showCodes, lang: uiLang, onReplied: (ids) => repliedRef.close(ids) })
        : null;
      // Both addresses when both are read: the assistant's context and the panel say which mail it is.
      const mailAddress = [mail.config?.inbox, imap.config?.user].filter(Boolean).join(", ");
      // The owner's Slack, read only (src/slack.ts): off unless the app's user token and signing secret are set.
      const slack = loadSlackConfig(env);
      if (slack.problems.length) logSlack.error(`off, because: ${slack.problems.join("; ")}`);
      const slackRef: { reader: SlackReader | null } = { reader: null };
      // The owner's Zoom, read only (src/zoom.ts): off unless the Server-to-Server app's values and the owner's Zoom email are set.
      const zoom = loadZoomConfig(env);
      if (zoom.problems.length) logZoom.error(`off, because: ${zoom.problems.join("; ")}`);
      const zoomRef: { reader: ZoomReader | null } = { reader: null };
      // The owner's Microsoft Teams, read only (src/teams.ts): off unless connected from the panel's Teams card (src/teams-connect.ts).
      const teamsCfg = loadTeamsConfig(env);
      if (teamsCfg.problems.length) logTeams.error(`off, because: ${teamsCfg.problems.join("; ")}`);
      const teamsRef: { reader: TeamsReader | null } = { reader: null };
      // Every meeting reviewed (src/meeting-review.ts): with Zoom, unless ZOOM_REVIEW=off. Built once the door is; the door reaches it here.
      const reviewCfg = zoom.config ? loadReviewConfig(env) : { config: null, problems: [] };
      if (reviewCfg.problems.length) logReview.error(`${reviewCfg.problems.join("; ")}`);
      const reviewRef: { reviewer: MeetingReviewer | null } = { reviewer: null };
      const reviewsDoor: ReviewDoor = {
        result: (id, raw) => (reviewRef.reviewer ? reviewRef.reviewer.result(id, raw) : Promise.resolve({ ok: false, todos: 0, loops: 0 })),
        acked: (ids) => (reviewRef.reviewer ? reviewRef.reviewer.acked(ids) : Promise.resolve()),
        settle: (id, text) => (reviewRef.reviewer ? reviewRef.reviewer.settle(id, text) : Promise.resolve()),
        command: () => (reviewRef.reviewer ? reviewRef.reviewer.command() : Promise.resolve("")),
        context: () => (reviewRef.reviewer ? reviewRef.reviewer.context() : Promise.resolve([])),
      };
      // The owner's calendar, read only (src/calendar.ts): Zoho when the Self Client's values are set, any calendar by its secret ICS link
      // (src/ics.ts, CALENDAR_ICS_URL), or both together. Off with neither.
      const zoho = loadCalendarConfig(env);
      const icsLinks = loadIcsConfig(env);
      if (zoho.problems.length) logCalendar.error(`${icsLinks.config ? "Zoho " : ""}off, because: ${zoho.problems.join("; ")}`);
      if (icsLinks.problems.length) logCalendar.error(`the ICS link is off, because: ${icsLinks.problems.join("; ")}`);
      const timing = loadCalendarTiming(env);
      // A wrong CALENDAR_REMIND_MINUTES turns the ICS links off too: said for them, as Zoho's line says it for Zoho.
      if (icsLinks.config && !timing.timing) logCalendar.error(`the ICS link is off, because: ${timing.problems.join("; ")}`);
      // On a computer, this Mac's calendars too (src/calendar-local.ts), once the Mac app has pushed them: a first push restarts Pako to add them.
      const macCal = local ? createLocalCalendar({ kv: local.kv }) : null;
      // This Mac's calendar written by its app (src/calendar-writes.ts): the queue the owner's yes on a card goes into; the door tells the result.
      const calDoorRef: { result: ((w: CalendarWrite) => Promise<void>) | null } = { result: null };
      const calWrites = macCal && local ? createCalendarWrites({ kv: local.kv, onResult: (w) => (calDoorRef.result ? calDoorRef.result(w) : Promise.resolve()) }) : null;
      // Google Calendar, connected with one button (src/google-calendar.ts): one more source of the same calendar.
      const googleCal = loadGoogleCalendarConfig(env);
      if (googleCal.problems.length) logCalendar.error(`Google Calendar is off, because: ${googleCal.problems.join("; ")}`);
      const cal = {
        zoho: zoho.config, ics: timing.timing ? icsLinks.config : null, mac: macCal && timing.timing && hasLocalCalendar(local!.kv) ? macCal : null,
        google: timing.timing ? googleCal.config : null,
      };
      const calOn = !!(cal.zoho || cal.ics || cal.mac || cal.google);
      // What the panel says is connected: the ICS links by their host only (the rest of a link is its secret).
      const calLabel = [cal.zoho ? `Zoho (${cal.zoho.dc})` : "", cal.ics ? `ICS: ${icsHosts(cal.ics.urls).join(", ")}` : "", cal.mac ? "Mac" : "", cal.google ? "Google" : ""]
        .filter(Boolean).join(" + ");
      const calRef: { reader: CalendarReader | null } = { reader: null };
      const calChangesRef: { c: CalendarChanges | null } = { c: null };
      // The private links' source, once built: its rows on the connections page and a broken link's line in the brief.
      const icsRef: { source: ReturnType<typeof createIcsSource> | null } = { source: null };
      // The owner's own addresses: their answer to an invitation is read from their attendee line.
      const myAddresses = (): string[] => [env.IMAP_USER, env.ZOOM_USER].map((x) => (x ?? "").trim().toLowerCase()).filter((x) => x.includes("@"));
      // Invitations caught from the owner's mail (src/invites.ts): on the dashboard before the calendar has them.
      const invites = imap.config ? createInviteStore({ kv, timeZone, me: myAddresses }) : null;
      // A new mailbox's catch-up (src/backfill.ts): its last days, quiet and paced; built with the reader, below.
      const backfillCfg = loadBackfillConfig(env);
      if (backfillCfg.problems.length) logBackfill.error(`${backfillCfg.problems.join("; ")}`);
      const backfillRef: { b: Backfill | null } = { b: null };
      // The daily brief (src/brief.ts), for everyone: built once the door is (it sends through it); BRIEF and the panel's button look it up then.
      const briefCfg = loadBriefConfig(env);
      if (briefCfg.problems.length) logBrief.error(`${briefCfg.problems.join("; ")}`);
      const briefRef: { reader: Brief | null } = { reader: null };
      const briefNow = (): Promise<string> => (briefRef.reader ? briefRef.reader.now() : Promise.resolve(""));
      // The written brief (src/brief-v2.ts): on unless BRIEF_SMART=off; it needs the assistant's computer (an older bridge: the brief as before).
      const smartCfg = loadBriefV2Config(env);
      if (smartCfg.problems.length) logBrief.error(`${smartCfg.problems.join("; ")}`);
      const smartRef: { brief: BriefV2 | null } = { brief: null };
      // Follow-ups (src/followups.ts): on unless FOLLOWUPS=off. Built once the door is (it sends cards through it); the door reaches it here.
      const followupsCfg = loadFollowupsConfig(env);
      if (followupsCfg.problems.length) logFollowups.error(`${followupsCfg.problems.join("; ")}`);
      const followupsRef: { engine: Followups | null } = { engine: null };
      // Every method of the door the engine has, reached through the engine once it is built (src/followups/door-proxy.ts).
      const followupsDoor: FollowupsDoor = followupsProxy(() => followupsRef.engine);
      repliedRef.close = (ids) => {
        const engine = followupsRef.engine;
        if (!engine) return;
        for (const id of ids) void engine.doneFor(id, "You replied to the email.").catch(() => undefined);
      };
      // Proactive Pako (src/proactive.ts): on unless PROACTIVE=off. Built once the door is (it sends cards through it); the door reaches it here.
      const proactiveCfg = loadProactiveConfig(env);
      if (proactiveCfg.problems.length) logProactive.error(`${proactiveCfg.problems.join("; ")}`);
      const lifeRef: { engine: Proactive | null } = { engine: null };
      const lifeDoor: LifeDoor = {
        learn: (f, o) => (lifeRef.engine ? lifeRef.engine.learn(f, o) : Promise.resolve(0)),
        press: (b, id) => (lifeRef.engine ? lifeRef.engine.press(b, id) : Promise.resolve("")),
        words: (text) => (lifeRef.engine ? lifeRef.engine.words(text) : Promise.resolve(null)),
        context: () => (lifeRef.engine ? lifeRef.engine.context() : Promise.resolve({ life: [], emergency: "" })),
        result: (id, raw) => (lifeRef.engine ? lifeRef.engine.result(id, raw) : Promise.resolve({ ok: false })),
        forgetHealth: () => (lifeRef.engine ? lifeRef.engine.forgetHealth() : Promise.resolve()),
        health: () => (lifeRef.engine ? lifeRef.engine.health() : Promise.resolve([])),
      };
      // Quality (src/quality.ts): the 👍/👎 on the nudges and the brief, the panel's "Calidad" card, the Monday line. With either of them on.
      const quality: Quality | null = followupsCfg.config || smartCfg.config || proactiveCfg.config ? createQuality({ kv, timeZone, lang: uiLang }) : null;
      // The rehearsal (src/rehearsal.ts): REHEARSAL and the panel's button; built once the door is (its jobs go through its inbox).
      const rehearsalRef: { r: Rehearsal | null } = { r: null };
      /** What a 👍/👎 button is about: the nudge's loop, or today's written brief. */
      const judged = async (kind: "nudge" | "brief", ref: string): Promise<string | null> => {
        if (kind === "nudge") {
          const loop = (await followupsRef.engine?.read())?.loops.find((l) => l.id === ref)?.title;
          return loop ?? (await lifeRef.engine?.judged(ref)) ?? null;
        }
        const doc = await smartRef.brief?.todayDoc();
        return doc && doc.id === ref ? `brief ${doc.day}` : null;
      };
      const panelRef: { link: (() => string | null) | null } = { link: null };
      const placesRef = { ok: false };
      // Booking a table (src/booking.ts, the original connector's restaurant engine): off unless GOOGLE_PLACES_API_KEY is set. It can write to a
      // restaurant only when the assistant's inbox is on, and only after the owner presses the card.
      // BOOKING=off turns it off while keeping the key (back on by removing it or setting on).
      const bookingOff = (env.BOOKING ?? "").trim().toLowerCase() === "off";
      const placesKey = bookingOff ? "" : (env.GOOGLE_PLACES_API_KEY ?? "").trim();
      // Whether this Places key has answered once (the settings page says "saved, not tried yet" until then): a mark in the store, by the key's
      // hash, so a new key starts unchecked again.
      const placesMark = placesKey ? createHash("sha256").update(placesKey).digest("hex").slice(0, 16) : "";
      if (placesKey && kv) void kv.get(PLACES_OK_KEY).then((v) => void (placesRef.ok = v === placesMark)).catch(() => undefined);
      const places = placesKey ? new GooglePlaces(placesKey) : null;
      if (places) {
        const search = places.searchText.bind(places);
        places.searchText = async (...a) => {
          const found = await search(...a);
          if (!placesRef.ok) {
            placesRef.ok = true;
            await kv?.set(PLACES_OK_KEY, placesMark, 400 * 24 * 3600).catch(() => undefined);
          }
          return found;
        };
      }
      // Maître (src/maitre/): on a computer with Chrome, Edge, Brave or Chromium, a restaurant on CoverManager, TheFork or OpenTable is booked on
      // its own page, with proof. Its later news (a Handoff that ended by itself) and the reminders go through the door, built below.
      const maitreRef: {
        deliver: ((r: BookingReply) => Promise<void>) | null;
        remind: ((when: string, text: string) => Promise<string | null>) | null;
        unremind: ((id: string) => Promise<void>) | null;
        booking: Booking | null;
      } = { deliver: null, remind: null, unremind: null, booking: null };
      const maitreSetup = places
        ? loadMaitre(env, {
            local: !!local,
            home: pakoHome(env),
            kv,
            ...(box ? { recentMail: () => box.items(60) } : {}),
            onHandoffEnd: async (end) => {
              const b = maitreRef.booking;
              if (b && maitreRef.deliver) await maitreRef.deliver(await b.handoffEnded(end)).catch((err: Error) => logBooking.error(`${err.message}`));
            },
          })
        : null;
      const booking: Booking | null = places
        ? createBooking({
            engine: Object.assign(new RestaurantEngine(places, new PublicPageFetcher()), { timeZone }),
            ...(mail.config ? { mail: { address: mail.config.inbox, send: (m: { to: string; subject: string; text: string }) => sendEmail(mail.config!, m) } } : {}),
            kv,
            control,
            get ownerName() {
              return ownerName();
            },
            // Local mode's stand-in number must never reach a restaurant: without a real one, the email gives no phone.
            ownerPhone: config.personalCaller.ownerNumber === LOCAL_OWNER_NUMBER ? "" : config.personalCaller.ownerNumber.replace(/\D/g, ""),
            timeZone,
            lang: uiLang,
            ...(maitreSetup?.maitre
              ? {
                  maitre: maitreSetup.maitre,
                  confirmFirst: maitreSetup.confirmFirst,
                  // The engines' confirmations go to a mailbox Pako reads (the owner's, else its own inbox), so the ledger can find them.
                  ...(imap.config?.user || mail.config?.inbox ? { guestEmail: (imap.config?.user || mail.config?.inbox)! } : {}),
                  remind: (when: string, text: string) => maitreRef.remind?.(when, text) ?? Promise.resolve(null),
                  unremind: (id: string) => maitreRef.unremind?.(id) ?? Promise.resolve(),
                }
              : {}),
          })
        : null;
      maitreRef.booking = booking;
      if (booking && maitreSetup) {
        const state = maitreSetup.maitre ? (booking.usesMaitre ? "ON" : "ready, but needs your full name, phone and a mailbox") : `off (${maitreSetup.why})`;
        logBooking.info(`Maître ${state}`);
      }
      if (bookingOff && (env.GOOGLE_PLACES_API_KEY ?? "").trim()) logBooking.info("OFF (BOOKING=off)");
      if (booking) logBooking.info(`ON: Google Places, ${mail.config ? "email requests from the assistant's inbox" : "links only (no inbox to write from)"}`);
      // Local mode: what the owner types or presses in the panel's window arrives as a message from them, like one from WhatsApp.
      const doorRef: {
        ingest: ((m: Record<string, unknown>, channel?: OwnerChannel) => Promise<string>) | null;
        from: string;
        tell: ((text: string) => Promise<void>) | null;
      } = { ingest: null, from: "", tell: null };
      const fromWindow = (m: Record<string, unknown>): void => {
        const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        void doorRef.ingest?.({ from: doorRef.from, id, ...m }).catch((err: Error) => logChat.error(`${err.message}`));
      };
      // Telegram, a second chat beside this one (src/telegram.ts): off until there is a bot token. TELEGRAM_BOT_TOKEN wins; on a computer the
      // token can also be set in the panel (src/telegram-panel.ts), which keeps it in ~/.pako/secrets.json for the next start. Its messages
      // reach the door built below. The channel can appear while Pako runs (set in the panel): what needs it reads tgRef.channel at that moment.
      const envToken = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
      const savedToken = local && !envToken ? (local.settings?.telegramToken?.() ?? "") : "";
      const tg = loadTelegramConfig(savedToken ? { ...env, TELEGRAM_BOT_TOKEN: savedToken } : env);
      if (tg.problems.length) {
        logTelegram.error(`off, because: ${tg.problems.join("; ")}${savedToken ? " (the bot token was set in the panel: set it there again)" : ""}`);
      }
      const makeTelegram = (cfg: TelegramConfig): TelegramChannel =>
        createTelegram({
          config: cfg,
          kv,
          lang: uiLang,
          ingest: (m) => (doorRef.ingest ? doorRef.ingest({ from: doorRef.from, ...m }, "telegram") : Promise.reject(new Error("the door is not ready yet"))),
          onPaired: (who) => void doorRef.tell?.(TG(uiLang())("paired", { who })),
          health: dog.reporter("telegram"),
        });
      const tgRef: { channel: TelegramChannel | null } = { channel: tg.config ? makeTelegram(tg.config) : null };
      void tgRef.channel?.paired(); // read the paired account now, for the panel
      // The panel's sign-in link needs the server's public https address: PUBLIC_URL, else Render's own variables, else the host that Meta's
      // webhook reached. That last one is learnt only from a request Meta signed (src/whatsapp.ts, onSigned), never before the signature is
      // checked: anyone can send an unsigned request with any Host header, and every later link would then hand the owner's one-time sign-in to
      // that host. A localhost or http value is never used on a server.
      const usable = (u: string | undefined) => {
        const v = (u ?? "").trim().replace(/\/$/, "");
        return /^https:\/\/[^/\s]+$/.test(v) && !/\/\/(localhost|127\.0\.0\.1)\b/.test(v) ? v : "";
      };
      const fromEnv = usable(env.PUBLIC_URL) || usable(env.RENDER_EXTERNAL_URL) || usable(env.RENDER_EXTERNAL_HOSTNAME ? `https://${env.RENDER_EXTERNAL_HOSTNAME}` : "");
      let learnt = "";
      // Once, from the first such request (signed, and stamped by Meta minutes ago at most) that came over https: its Host header (never
      // X-Forwarded-Host), when it is a plain host name.
      const learn = (req: Request): void => {
        const host = (req.get("host") ?? "").toLowerCase();
        if (!learnt && req.secure && /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/.test(host)) learnt = usable(`https://${host}`);
      };
      // Local mode is opened on this computer, at its loopback address. A server on the internet with no known address has none: it gives no
      // link at all (a localhost link on the owner's phone leads nowhere). The address it listens on by default, 127.0.0.1, and not the name
      // "localhost": browsers try ::1 for that name first, where another program (another account on this Mac) could listen on the same port
      // and receive the sign-in link and the cookie. Told to listen elsewhere (PAKO_HOST), the name it was given.
      const loopback = (env.PAKO_HOST ?? "").trim() === "" || (env.PAKO_HOST ?? "").trim() === "127.0.0.1" ? "127.0.0.1" : "localhost";
      const publicUrl = (): string => fromEnv || learnt || (local ? `http://${loopback}:${config.port}` : "");
      // Autonomy (src/autonomy.ts): what the owner asks in their own words goes after a window to undo; the panel can set each type to ask.
      const autonomyProblems: string[] = [];
      const autonomyConfig = loadAutonomyConfig(env, autonomyProblems);
      const contactEmails = parseContactEmails(env.PERSONAL_CONTACT_EMAILS, autonomyProblems);
      if (autonomyProblems.length) logAutonomy.error(`${autonomyProblems.join("; ")} (the default is used)`);
      const autonomySettings = createAutonomySettings(kv, autonomyConfig);
      // Claude in one button (src/claude-connect.ts), on a computer only: the panel's connect flow, and the keeper that asks the owner, once,
      // to sign in again when the sign-in is about to expire, has expired, or a run was refused for it. The notice goes through the door
      // (the panel's chat, and Telegram when paired), which is made just below.
      const claudeDoor: { card: ((body: string, buttons: { id: string; title: string }[]) => Promise<boolean>) | null; tell: ((text: string) => Promise<unknown>) | null } = { card: null, tell: null };
      const claudeConnect = local
        ? createClaudeConnect({
            env,
            email: () => emailOf(env.IMAP_USER),
            changed: (_a, why) => {
              void local.bridge.refresh?.();
              if (why === "signed-out") void claudeKeeper?.signedOut();
              else if (why === "connected") void claudeKeeper?.connected();
            },
          })
        : null;
      const claudeKeeper = claudeConnect
        ? createClaudeKeeper({
            check: () => claudeConnect.check(0),
            notify: async () => {
              const t = claudeNotice(uiLang());
              const id = `cl:${randomBytes(5).toString("hex")}`;
              if (claudeDoor.card && (await claudeDoor.card(t("again"), [{ id, title: t("button") }]))) return true;
              if (!claudeDoor.tell) return false;
              await claudeDoor.tell(t("again"));
              return true;
            },
            ...(kv ? { kv } : {}),
          })
        : null;
      const door = mountWhatsapp(app, {
        ...(claudeConnect ? { claudeSignIn: () => pressSignIn(claudeConnect, uiLang(), { refused: claudeKeeper?.refused() ?? false }) } : {}),
        jobs,
        autonomy: { config: autonomyConfig, settings: autonomySettings },
        contactEmails: () => contactEmails,
        // The emails the owner asks for: through Resend when it is set (src/resend.ts), else Pako's own AgentMail inbox (the API key needs
        // AgentMail's message_send permission).
        ...(outgoing ? { sendEmail: outgoing.send } : {}),
        // The owner's country (read above): the emergency number and the crisis line a red flag gets (src/health.ts).
        country: country.country,
        // Health data local only: a server on the internet keeps the diary in memory (src/health.ts).
        healthOnDisk: !!local,
        // Labs (PAKO_LABS=on): the health diary, learning and the weekly check-in. Off by default while Pako is in beta (src/companion.ts).
        labs: (env.PAKO_LABS ?? "").trim().toLowerCase() === "on",
        lang: uiLang,
        ...(booking ? { booking } : {}),
        ...(waComputer ? { whatsapp: waComputer.line } : {}),
        // A getter, read by the door each time it needs Telegram: a channel set in the panel later is used at once, and until there is one the
        // door works exactly as with no Telegram set up (TELEGRAM is then words for the assistant, as before).
        get telegram() {
          return tgRef.channel ?? undefined;
        },
        // The photos and PDFs the owner sends (src/papers.ts): in ~/.pako/papers on a computer; a server on the internet keeps them in memory only.
        ...(local ? { local: local.channel, papers: createPaperStore({ dir: join(pakoHome(env), "papers") }) } : {}),
        config: wa.config,
        tools: personal.tools,
        memory: personal.memory,
        kv,
        control,
        panelLink: () => (panelRef.link ? panelRef.link() : PARTS(uiLang())("panelNotReady")),
        // Only a server on the internet that was given no address learns it, and only from what Meta signed.
        ...(!local && !fromEnv ? { onSigned: learn } : {}),
        ...(calOn
          ? {
              calendar: {
                day: (n: number) => (calRef.reader ? calRef.reader.day(n) : Promise.resolve("")),
                context: () => (calRef.reader ? calRef.reader.context() : Promise.resolve([])),
              },
            }
          : {}),
        brief: { now: briefNow, daily: briefCfg.at !== null },
        ...(followupsCfg.config ? { followups: followupsDoor } : {}),
        ...(macCal && calWrites
          ? {
              calendarWrites: {
                // A push in the last half hour from an app that writes: otherwise the change is a line for the owner to make.
                canWrite: async () => {
                  const k = await macCal.read();
                  return !!k?.writes && Date.now() - k.at < 30 * 60_000;
                },
                find: async (title: string, start: number) => {
                  const k = await macCal.read();
                  return k ? findLocalEvent(k, title, start) : null;
                },
                enqueue: (w: Parameters<typeof calWrites.enqueue>[0]) => calWrites.enqueue(w),
                get: (id: string) => calWrites.get(id),
              },
            }
          : {}),
        ...(followupsCfg.config && smartCfg.config
          ? { draftFor: (o: Parameters<BriefV2["draftFor"]>[0]) => (smartRef.brief ? smartRef.brief.draftFor(o) : Promise.resolve(null)) }
          : {}),
        backfillAnswered: (id, o) => (backfillRef.b ? backfillRef.b.answered(id, o) : Promise.resolve(false)),
        ...(proactiveCfg.config ? { life: lifeDoor } : {}),
        ...(reviewCfg.config ? { reviews: reviewsDoor } : {}),
        // HEALTH / "how is Pako doing?": the Health card in words, and the Quality card's week when quality is on.
        status: { summary: async () => [dog.summary(), ...(quality ? [await quality.weekText(uiLang()).catch(() => "")] : [])] },
        ...(quality
          ? {
              quality: { press: (id: string) => quality.press(id, judged), answerText: (text: string) => quality.answerText(text), clearAsk: quality.clearAsk },
              rehearsal: {
                start: () => (rehearsalRef.r ? rehearsalRef.r.start() : Promise.resolve({ text: "" })),
                answer: (id: string, raw: string) => (rehearsalRef.r ? rehearsalRef.r.answer(id, raw) : Promise.resolve({ ok: false })),
                acked: (ids: string[]) => (rehearsalRef.r ? rehearsalRef.r.acked(ids) : Promise.resolve()),
              },
            }
          : {}),
        ...(smartCfg.config
          ? {
              briefTodos: () => (smartRef.brief ? smartRef.brief.openTodos() : Promise.resolve([])),
              briefJobs: {
                result: (id: string, raw: string) => (smartRef.brief ? smartRef.brief.result(id, raw) : Promise.resolve({ ok: false })),
                acked: (ids: string[], capable: boolean) => (smartRef.brief ? smartRef.brief.acked(ids, capable) : Promise.resolve()),
              },
            }
          : {}),
        ...(zoom.config
          ? {
              zoom: {
                upcoming: () => (zoomRef.reader ? zoomRef.reader.upcoming() : Promise.resolve([])),
                summaries: () => (zoomRef.reader ? zoomRef.reader.summaries() : Promise.resolve([])),
                annotate: (id: string, summary: string) => (zoomRef.reader ? zoomRef.reader.annotate(id, summary) : Promise.resolve(false)),
              },
            }
          : {}),
        ...(slack.config
          ? {
              slack: {
                search: (q: string) => (slackRef.reader ? slackRef.reader.search(q) : Promise.resolve([])),
                recent: () => (slackRef.reader ? slackRef.reader.recent() : Promise.resolve([])),
              },
            }
          : {}),
        // Each send to Meta, for the watchdog (a computer has no WhatsApp).
        ...(!local ? { health: dog.reporter("whatsapp") } : {}),
        // What the watches look at (src/routines.ts): only what this server already has, read when they look (a part set up later counts).
        watchSources: () => ({
          ...(box ? { mail: () => box.items(60) } : {}),
          ...(calRef.reader ? { calendar: () => calRef.reader!.load() } : {}),
          ...(slackRef.reader ? { slack: () => slackRef.reader!.alerts() } : {}),
        }),
        get ownerName() {
          return ownerName();
        },
        timeZone,
        contacts: () => [...friends.values()].map((c) => c.name),
        contactByName: (name) => [...friends.values()].find((c) => plain(c.name) === plain(name)) ?? null,
        ...(box ? {
              mail: {
                address: mailAddress,
                recent: () => box.recent(timeZone),
                annotate: (id: string, kind: "aviso" | "guardado", summary: string, scam?: boolean, verdict?: Verdict) =>
                  box.annotate(id, kind, summary, Date.now(), { ...(scam === undefined ? {} : { scam }), ...(verdict ? { verdict } : {}) }),
                notifies: (id: string) => box.notifies(id),
                replied: (id: string) => box.repliedById(id),
                get: (id: string) => box.get(id),
                digest: () => box.digest(timeZone),
              },
              // The one-time codes taken out of the mail (src/codes.ts), for the owner's CODE.
              codes: { recent: () => box.codes() },
            } : {}),
      });
      calDoorRef.result = (w) => door.calendarResult(w);
      tellOwner = (text) => door.notifyOwner(text, { urgent: true });
      tellAssistant = door.note;
      // The watchdog's notices: on Telegram first when it can reach the owner there (a server's WhatsApp may be the part that is down), else
      // as any urgent notice (a computer: Telegram when paired, with a copy in the panel's chat, which the Mac app notifies about).
      dogRef.tell = async (text) => {
        const tgUp = !local && !!tgRef.channel && (await tgRef.channel.reachable().catch(() => false));
        if (tgUp && (await door.tellOwner(text, "telegram"))) return;
        await door.notifyOwner(text, { urgent: true });
      };
      if (!local) {
        dogRef.lastPoll = () => door.lastPoll();
        dog.watch("whatsapp");
        // The assistant's computer says how Claude is doing and which version it runs (on a computer the panel's own route takes it).
        mountBridgeHealth(app, { token: wa.config.bridgeToken, watchdog: dog });
      }
      // The store keeps Zoho's access (an ICS link keeps nothing there): only Zoho's can be lost with it.
      parts = { mail: !!box, telegram: !!tgRef.channel, calendar: !!cal.zoho };
      // Local mode's terminal shows only its own banner (src/server.ts): these lines describe a server on the internet.
      if (!local) logWhatsapp.info("ON: the owner's messages are served at /whatsapp/webhook and /assistant/*");
      if (!local) {
        logPanel.info(`ON: sign-in links use ${fromEnv || "no address yet (the host of the first fresh webhook Meta signs, or set PUBLIC_URL)"}`);
        // PANEL tells the owner to set PUBLIC_URL: a value that is set but cannot be used must say why here.
        if ((env.PUBLIC_URL ?? "").trim() && !usable(env.PUBLIC_URL)) {
          logPanel.error("PUBLIC_URL is ignored: it must be this server's https address, like https://pako.example.com (no path, not localhost)");
        }
      }
      // The owner's panel (src/dashboard.ts): PANEL on WhatsApp gives a one-time sign-in link.
      const telegramLine = () => {
        // On a computer, a bot that cannot be used here (Telegram refuses its token, or its news go to a server or another Pako) is as good
        // as none, as in the panel's Telegram card (src/telegram-panel.ts): never "connected", and no QR code to scan for nothing.
        const ch = local && tgRef.channel && (tgRef.channel.tokenRefused() || tgRef.channel.pollStopped()) ? null : tgRef.channel;
        const t = TG(uiLang());
        const on = !!ch && ch.pairedNow();
        return { key: "telegram", name: "Telegram", on, detail: !ch ? t("none") : on ? t("on") : t(local ? "pairQr" : "pairChat") };
      };
      const integrations = () => {
        const t = PARTS(uiLang());
        const brainOn = door.lastPoll() > 0 && Date.now() - door.lastPoll() < 90_000;
        return [
          local
            ? { key: "whatsapp", name: t("chat"), on: true, detail: t("chatHere") }
            : { key: "whatsapp", name: "WhatsApp", on: true, detail: "Meta Cloud API" },
          { key: "mac", name: t(local ? "brain" : "brainMac"), on: brainOn, detail: t(local ? "brainHere" : "brainOnMac") },
          local
            ? { key: "phone", name: t("phone"), on: false, detail: t("none") }
            : { key: "phone", name: t("phone"), on: true, detail: t(config.personalCaller?.live ? "live" : "dry") },
          { key: "mail", name: t("mail"), on: !!box, detail: box ? mailAddress : t("none") },
          { key: "calendar", name: t("calendar"), on: calOn, detail: calOn ? calLabel : t("none") },
          { key: "slack", name: "Slack", on: !!slack.config, detail: t(slack.config ? "readOnly" : "none") },
          { key: "zoom", name: "Zoom", on: !!zoom.config, detail: t(zoom.config ? "readOnly" : "off") },
          // On a computer Telegram is always listed: it is set up from the panel.
          ...(tgRef.channel || local ? [telegramLine()] : []),
        ];
      };
      // Local mode: the chat's first message, once, with the name given. On a first visit the panel's welcome asks for the name before
      // anything is tried, so the hello waits for its first save (the settings route calls it then).
      // One at a time, in order: two saves at once must not say it twice, nor the first one's early return lose the second.
      let saying: Promise<void> | null = null;
      const hello = (): Promise<void> => {
        // Each call after the one before (never joined to it): a run that waited for the name must not swallow the save that brings it.
        const run = (saying ?? Promise.resolve()).then(async () => {
          if (!local || (await local.channel.list(0)).length) return;
          const name = givenName();
          // The welcome is still asking for the name: a save without one (a second tab, an older page) does not say the hello before it.
          if (!name && local.settings && !local.settings.welcomed()) return;
          await local.channel.push("pako", HELLO(uiLang())(name ? "named" : "plain", { name }));
        }).catch((err: Error) => logChat.error(`the hello: ${err.message}`));
        saying = run;
        return run;
      };
      const panel = mountDashboard(app, {
        secret: wa.config.bridgeToken,
        publicUrl,
        get ownerName() {
          return ownerName();
        },
        lang: uiLang,
        ...(local?.settings
          ? {
              settings: {
                ...local.settings,
                name: givenName,
                // A setting decides these instead, and the panel does not ask for them.
                fixed: { name: /[^\s\u0000-\u001f\u007f]/.test(env.PAKO_NAME ?? "") },
                changed: hello,
              },
            }
          : {}),
        timeZone,
        control,
        memory: personal.memory,
        wa: { reminders: () => door.reminders(), events: () => door.events(), lastPoll: () => door.lastPoll() },
        ...(box ? { mail: { address: mailAddress, items: () => box.items() } } : {}),
        ...(booking ? { bookings: { list: () => booking.bookings() } } : {}),
        ...(local
          ? {
              chat: {
                list: (since: number) => local.channel.list(since),
                notices: (after: number) => local.channel.notices(after),
                status: () => local.bridge.status(),
                report: (claude: BridgeHealth) => {
                  local.bridge.report?.(claude);
                  void claudeKeeper?.reported(claude);
                },
                version: (v: BridgeVersion) => dog.bridgeReport({ version: v }),
                usage: (u: BridgeUsage) => dog.bridgeReport({ usage: u }),
                ...(local.bridge.refresh ? { refresh: local.bridge.refresh } : {}),
                // What is typed in the window is a message from the owner, handled exactly like one that came by WhatsApp.
                send: async (text: string) => {
                  await local.channel.push("you", text);
                  fromWindow({ type: "text", text: { body: text } });
                },
                press: async (id: string) => fromWindow({ type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: "" } } }),
              },
            }
          : {}),
        ...(slack.config ? { slack: { alerts: () => (slackRef.reader ? slackRef.reader.alerts() : Promise.resolve([])) } } : {}),
        ...(followupsCfg.config ? { loops: async () => (followupsRef.engine ? followupsRef.engine.open() : []) } : {}),
        catchUp: async () => (backfillRef.b ? backfillRef.b.progress() : null),
        ...(calOn
          ? {
              calendar: {
                // The mail's invitations not yet on the calendar are shown too, tagged (src/invites.ts).
                events: async () => {
                  const evs = calRef.reader ? await calRef.reader.load() : [];
                  return invites ? invites.overlay(evs) : evs;
                },
                refresh: async () => {
                  icsRef.source?.stale();
                  if (calRef.reader) await calRef.reader.load(true);
                },
                sources: async () => {
                  const out: CalendarFreshness[] = [];
                  const mac = macCal && cal.mac ? await macCal.read().catch(() => null) : null;
                  if (mac) out.push({ label: "Mac", lastSync: mac.at });
                  for (const s of icsRef.source?.status() ?? []) {
                    const google = /(^|\.)google\.com$/i.test(s.host);
                    out.push({
                      label: google ? `Google link (${s.name})` : `${s.name} link`, lastSync: s.lastSync, ...(google ? { slow: true } : {}),
                      error: s.error ? icsWhyText(s.error, uiLang()) : null,
                    });
                  }
                  return out;
                },
              },
            }
          : {}),
        integrations,
      });
      if (claudeKeeper) {
        claudeDoor.card = (body, buttons) => door.sendCard(body, buttons);
        claudeDoor.tell = (text) => door.notifyOwner(text, { urgent: true });
        // A look a minute after the start (the bridge settles first), then every three hours: the sign-in lasts weeks, so that is plenty to
        // catch one about to expire a day ahead.
        setTimeout(() => void claudeKeeper.tick(), 60_000).unref?.();
        setInterval(() => void claudeKeeper.tick(), 3 * 3600_000).unref?.();
      }
      // Lists and tasks in the panel: shown everywhere, ticked and removed only on a computer (a server's panel stays read only but STOP).
      mountTasksPanel(app, { signedIn: panel.signedIn, lists: door.lists, local: !!local, timeZone });
      // The meetings reviewed, with their summaries (a card only when Zoom is connected).
      mountMeetingsPanel(app, { signedIn: panel.signedIn, recent: reviewCfg.config ? () => (reviewRef.reviewer ? reviewRef.reviewer.recent() : Promise.resolve([])) : null });
      // The people in the owner's life: shown everywhere, corrected and forgotten only on a computer (with the chat's receipt and Deshacer).
      mountPeoplePanel(app, { signedIn: panel.signedIn, people: door.people, local: !!local });
      // Settings: whether messages, emails and calls go at once (with a window to undo) or ask first, and the window's seconds.
      mountAutonomyPanel(app, { signedIn: panel.signedIn, settings: autonomySettings, config: autonomyConfig });
      // Routines and watches the same way: listed everywhere, removed only on a computer.
      mountRoutinesPanel(app, { signedIn: panel.signedIn, routines: door.routines, local: !!local, timeZone });
      // A photo or a PDF put in the panel's chat (a computer only: a server's chat is WhatsApp, where the door takes them itself).
      if (local) mountPaperUpload(app, { signedIn: panel.signedIn, papers: door.papers, push: (t) => local.channel.push("you", t), ingest: fromWindow });
      // No address known yet: no link at all, and no one-time token made for nothing (PANEL says how to set PUBLIC_URL instead).
      const panelLink = (): string | null => (publicUrl() ? panel.link() : null);
      panelRef.link = panelLink;
      mountMemoryPanel(app, { signedIn: panel.signedIn, memory: personal.memory, editable: !!local, lang: uiLang, control });
      // The dashboard's "Needs you" preview, the Mail section's reader, Move to…, Done and the Mail settings (src/mail-panel.ts).
      mountMailPanel(app, {
        signedIn: panel.signedIn,
        box,
        timeZone,
        loops: () => {
          const engine = followupsRef.engine;
          return engine ? { all: async () => (await engine.read()).loops, doneFor: (ref) => engine.doneFor(ref), reopen: (ids) => engine.reopen(ids) } : null;
        },
      });
      // The health of every part (src/watchdog.ts), for the Salud card.
      mountHealthPanel(app, { signedIn: panel.signedIn, state: dog.state });
      const telegram = tgRef.channel;
      if (telegram && !local) {
        // On a server with a public address Telegram brings the news (one webhook: Render runs two copies for a moment during a deploy, and
        // two copies polling the same bot would clash); on a server with none, Pako asks for them.
        const webhook = fromEnv ? `${fromEnv}/telegram/webhook` : "";
        if (webhook) telegram.mountWebhook(app, "/telegram/webhook");
        let poller: { stop(): void } | null = null;
        let stopped = false;
        const setHook = async (n: number): Promise<void> => {
          if (stopped) return;
          if (await telegram.setWebhook(webhook)) logTelegram.info("webhook set");
          else if (n < 5) setTimeout(() => void setHook(n + 1), 30_000 * n).unref?.();
        };
        // server.ts starts it once the server listens, and stops it on shutdown.
        app.locals.telegram = {
          start: (): void => {
            if (webhook) void setHook(1);
            else poller = telegram.poll();
          },
          stop: (): void => {
            stopped = true;
            poller?.stop();
          },
        };
        logTelegram.info(`ON: ${webhook ? "news by webhook" : "long polling"}; ${telegram.pairedNow() ? "paired" : "write TELEGRAM in the chat to pair your account"}`);
      }
      if (local) {
        // On a computer Pako asks Telegram for its news (long polling): for a bot whose token was there at the start, once the server listens
        // (server.ts calls start); for one set in the panel, at once (a request to the panel means it listens). One poller at a time.
        let poller: { stop(): void } | null = null;
        let stopped = false;
        const pollNow = (): void => {
          poller?.stop();
          poller = !stopped && tgRef.channel ? tgRef.channel.poll() : null;
        };
        app.locals.telegram = {
          start: (): void => {
            if (!poller) pollNow();
          },
          stop: (): void => {
            stopped = true;
            poller?.stop();
            poller = null;
          },
        };
        const keep = local.settings?.setTelegramToken;
        mountTelegramPanel(app, {
          signedIn: panel.signedIn,
          env,
          lang: uiLang,
          control,
          current: () => tgRef.channel,
          create: makeTelegram,
          ...(keep ? { keep } : {}),
          use: (channel) => {
            tgRef.channel = channel;
            void channel.paired(); // read the paired account now, for the panel (a pairing made with this bot before is still good)
            pollNow();
            logTelegram.info("ON: long polling, with the bot token set in the panel");
          },
        });
        if (telegram) logTelegram.info(`ON: long polling; ${telegram.pairedNow() ? "paired" : "pair your phone in the panel, or write TELEGRAM in the chat"}`);
      } else {
        mountTelegramPanel(app, null);
      }
      if (waComputer) {
        waComputer.mountPanel(app, panel.signedIn);
        waComputer.attach((m, channel) => door.ingest(m, channel), () => door.ownerFrom);
      } else {
        mountWhatsappSetupAbsent(app);
      }
      const imapProblem = (l: Lang) => ({ imap: imapRef.reader?.problem(l) ?? null });
      // A calendar link and a Places key have no live check when saved: "connected" only once they have answered (the calendar's health part
      // read once; a Places search worked).
      const checked = () => ({
        calendar: (dog.state().parts.find((p) => p.key === "calendar")?.okAt ?? null) !== null,
        tables: placesRef.ok,
      });
      const saver = mountConnectionsPanel(app, local ? { signedIn: panel.signedIn, env, lang: uiLang, control, problems: imapProblem, checked } : null);
      // What the Mac found when the person said yes, and the guided connections built on it (src/discovery.ts and the modules it names).
      // The Mac app's own requests carry the bridge token it already has; the panel's carry its session.
      const discovery = local ? createDiscoveryStore(local.kv) : null;
      const contacts = local ? createContactsStore(local.kv) : null;
      const zoomLocal = local && discovery
        ? createZoomLocal({
            discovery, kv: local.kv, timeZone, control, lang: uiLang, enqueue: (m) => door.inbox.add(m),
            review: (m) => (reviewRef.reviewer ? reviewRef.reviewer.transcript(m) : Promise.resolve(null)),
          })
        : null;
      zoomLocal?.start();
      const appAuth = local ? { signedIn: panel.signedIn, appToken: local.bridgeToken } : null;
      mountDiscoveryPanel(app, appAuth && discovery && contacts && macCal
        ? {
            ...appAuth, store: discovery, lang: uiLang, control,
            forgetAlso: [() => macCal.forget(), () => contacts.forget(), () => zoomLocal?.forget() ?? Promise.resolve()],
          }
        : null);
      mountCalendarWrites(app, appAuth && calWrites ? { ...appAuth, writes: calWrites } : null);
      mountLocalCalendarPanel(app, appAuth && macCal && discovery
        ? {
            ...appAuth, calendar: macCal, timeZone, lang: uiLang, control, discovery,
            inUse: () => !!cal.mac,
            restart: () => (typeof app.locals.restart === "function" ? (app.locals.restart as () => boolean)() !== false : false),
            changed: () => void calRef.reader?.load(true).catch(() => undefined),
          }
        : null);
      mountContactsPanel(app, appAuth && contacts ? { ...appAuth, store: contacts, lang: uiLang, control } : null);
      // The People directory (src/people-directory.ts): computed from what Pako already holds here (the imported contacts, the identities met
      // in the mail, calendar, Slack and Zoom, the calendar's attendees, the stored mail, the open loops, the owner's own records and facts).
      mountPeopleDirectory(app, {
        signedIn: panel.signedIn, local: !!local, timeZone, hidden: createHiddenPeople(kv),
        sources: {
          ...(contacts ? { contacts: async () => (await contacts.read()).people } : {}),
          graph: async () => (await door.peopleGraph.read()).persons,
          ...(calOn ? { events: () => (calRef.reader ? calRef.reader.load() : Promise.resolve([])) } : {}),
          ...(box ? { mail: () => box.items(150) } : {}),
          ...(followupsCfg.config ? { loops: () => (followupsRef.engine ? followupsRef.engine.open() : Promise.resolve([])) } : {}),
          people: () => door.people.store.read(true),
          facts: () => door.facts.read(),
          self: () => [mail.config?.inbox, imap.config?.user].filter((x): x is string => !!x),
        },
        ...(smartCfg.config
          ? {
              prep: (o) => (smartRef.brief ? smartRef.brief.prepPerson(o) : Promise.resolve(null)),
              prepTask: (id) => (smartRef.brief ? smartRef.brief.task(id) : Promise.resolve(null)),
            }
          : {}),
      });
      mountMailConnect(app, appAuth ? { ...appAuth, lang: uiLang, saver } : null);
      // Microsoft and Google mail by signing in with the provider (OAuth with PKCE, the browser back to this computer).
      mountMailOAuth(app, appAuth ? { ...appAuth, env, saver } : null);
      // Teams with the same Microsoft app: one button, Teams' permissions added to the Microsoft sign-in (src/teams-connect.ts).
      mountTeamsConnect(app, appAuth ? { ...appAuth, env, saver, status: async () => (teamsRef.reader ? teamsRef.reader.status() : null) } : null);
      // "Connected as …" on the Slack and Zoom cards comes from the running readers (looked up when asked: they are built further down).
      mountConnectSetup(app, appAuth
        ? {
            ...appAuth, lang: uiLang, saver, env, claude: claudeConnect, ...(discovery ? { discovery } : {}),
            slackAccount: () => slackRef.reader?.account() ?? null,
            zoomAccount: () => zoomRef.reader?.account() ?? null,
          }
        : null);
      mountConnectionsStatus(app, appAuth
        ? {
            ...appAuth, env, lang: uiLang, dir: pakoHome(env), problems: imapProblem, health: dog.state,
            ...(claudeConnect ? { claude: (l: Lang) => claudeStatusLine(claudeConnect.view(), l) } : {}),
            ...(discovery ? { discovery } : {}),
            telegram: async () => {
              const ch = tgRef.channel;
              if (!ch || ch.tokenRefused() || ch.pollStopped()) return "no-token";
              return (await ch.paired().catch(() => false)) ? "paired" : "unpaired";
            },
            ...(macCal
              ? { macCalendar: async () => {
                  const k = await macCal.read();
                  return k ? { at: k.at, calendars: k.calendars.length, events: k.events.length } : null;
                } }
              : {}),
            ...(contacts ? { contacts: async () => (await contacts.read()).people.length } : {}),
          }
        : null);
      // Which account, server and calendars each connection is, never a secret (src/connections-details.ts).
      mountConnectionDetails(app, appAuth
        ? {
            ...appAuth, env, lang: uiLang, dir: pakoHome(env), timeZone, saver, ...(local?.icsNet ? { icsNet: local.icsNet } : {}),
            imap: (l) => imapRef.reader?.info(l) ?? null,
            checkMail: () => (imapRef.reader ? imapRef.reader.poll() : Promise.resolve(null)),
            ics: () => icsRef.source?.status() ?? [],
            ...(macCal
              ? { mac: async () => {
                  const k = await macCal.read();
                  return k ? { at: k.at, calendars: k.calendars, events: k.events.length } : null;
                } }
              : {}),
            slack: async () => (slackRef.reader ? slackRef.reader.identity() : null),
            teams: async () => (teamsRef.reader ? teamsRef.reader.status() : null),
            zoom: async () => {
              const last = zoomRef.reader ? (await zoomRef.reader.recent(30))[0] : undefined;
              return last ? { topic: last.topic, at: last.at } : null;
            },
            telegram: async () => {
              const ch = tgRef.channel;
              if (!ch) return null;
              const [bot, owner] = await Promise.all([ch.username().catch(() => null), ch.account().catch(() => null)]);
              return { bot, owner, paired: ch.pairedNow() };
            },
          }
        : null);
      // The connections page the gear opens (src/panel/settings.*): a computer only.
      mountSettingsPage(app, { signedIn: panel.signedIn, lang: uiLang, local: !!local });
      mountAutostartPanel(app, local ? { signedIn: panel.signedIn, env, lang: uiLang, control } : null);
      mountDataPanel(app, local ? { signedIn: panel.signedIn, env, lang: uiLang, control, store: local.kv, chat: local.channel } : null);
      // Moving from a server to a computer (src/move.ts): a server's panel gives the file, a computer's panel takes it in.
      mountMovePanel(app, {
        signedIn: panel.signedIn, env, lang: uiLang, control, dir: pakoHome(env),
        ...(local
          ? {
              mode: "computer" as const, store: local.kv,
              ...(local.settings ? { settings: { name: givenName, setName: local.settings.setName } } : {}),
            }
          // A server with no store (VOICE_RESULTS_URL unset) keeps everything in memory only: its file then has nothing to carry.
          : { mode: "server" as const, store: kv ?? { get: async () => null, set: async () => undefined }, server: { ownerName: startName, timeZone } }),
      });
      doorRef.ingest = door.ingest;
      doorRef.tell = door.tellBase;
      maitreRef.deliver = door.deliverBooking;
      maitreRef.remind = door.remindBooking;
      maitreRef.unremind = door.unremindBooking;
      doorRef.from = door.ownerFrom;
      app.locals.panelLink = panelLink;
      // The hello right away, unless the panel's welcome is still to come (it asks for the name first).
      if (local && (!local.settings || local.settings.welcomed())) void hello();
      bookingRef.booking = booking;
      bookingRef.start = (r) => door.startBooking(r);
      askRef.ask = (a) => door.askCall(a);
      const calTiming = cal.zoho ?? timing.timing;
      if (calOn && calTiming) {
        // A meeting about to start is urgent: it always reaches the phone.
        // Zoho and the ICS links are sources of one calendar: the same agenda, reminders and brief lines, whichever is connected.
        const log = calendarLog();
        const sources = [
          ...(cal.zoho ? [createZohoSource({ config: cal.zoho, kv, timeZone, lang: uiLang, log })] : []),
          ...(cal.ics ? [(icsRef.source = createIcsSource({ config: cal.ics, timeZone, lang: uiLang, control, log, me: myAddresses, ...(local?.icsNet ?? {}) }))] : []),
          ...(cal.mac ? [cal.mac.source] : []),
          ...(cal.google ? [createGoogleCalendarSource({ config: cal.google, timeZone, log })] : []),
        ];
        const notify = (text: string) => door.notifyOwner(text, { urgent: true });
        calRef.reader = createCalendarCore({ sources, timing: calTiming, kv, timeZone, control, lang: uiLang, log, notify, health: dog.reporter("calendar") });
        dog.watch("calendar");
        calRef.reader.start();
        // What changed on the calendar (src/calendar-changes.ts), every ten minutes: the follow-ups follow a meeting that moved or was called off,
        // and the brief says what changed since the last one.
        const reader = calRef.reader;
        calChangesRef.c = createCalendarChanges({ kv, read: () => reader.load(), onChange: (c) => followupsDoor.calendarChanged?.(c) ?? Promise.resolve(0) });
        const cc = calChangesRef.c;
        setTimeout(() => void cc.tick(), 60_000).unref?.();
        setInterval(() => void cc.tick(), 10 * 60_000).unref?.();
        logCalendar.info(`ON: ${calLabel}, reminders ${calTiming.remindMinutes || "off"} min before`);
      }
      // The people's identities (src/people-graph.ts): who wrote, who was invited, who spoke, from what Pako already reads (names and identities
      // only, never what anyone wrote). Slack and Zoom as they come; the mail and the calendar looked at every quarter of an hour.
      const feedPeople = (list: Sighting[]): void => {
        if (list.length) void door.peopleGraph.observe(list).catch((err: Error) => logPeopleGraph.error(`${err.message}`));
      };
      const harvestPeople = async (): Promise<void> => {
        const mails = box ? await box.items(60).catch(() => []) : [];
        const events = calRef.reader ? await calRef.reader.load().catch(() => []) : [];
        feedPeople([...mailSightings(mails), ...eventSightings(events)]);
      };
      setTimeout(() => void harvestPeople(), 60_000).unref?.();
      setInterval(() => void harvestPeople(), 15 * 60_000).unref?.();
      // The morning brief, then one waiting "is this the same person?" question with its buttons (at most one a day).
      const briefSent = async (text: string): Promise<void> => {
        await door.notifyOwner(text, { urgent: true });
        await door.askSamePerson().catch(() => false);
      };
      // The daily brief says whatever is connected: each calendar's today, the door's reminders and tasks, and one line from the mail and Slack
      // (each writes its own, in the language of the brief). Urgent, like a meeting about to start: it is the one message a day that must arrive.
      briefRef.reader = createBrief({
        at: briefCfg.at,
        kv,
        timeZone,
        control,
        lang: uiLang,
        name: givenName,
        calendars: calOn ? [() => (calRef.reader ? calRef.reader.todayRead() : Promise.resolve([]))] : [],
        // A birthday's reminder is said once, on the birthdays line below, not again among the reminders.
        reminders: async () => (await door.reminders()).filter((r) => !r.birthday),
        // The tasks due today or overdue (src/lists.ts): its own line, only when there is one.
        extras: [
          () => (box ? box.brief() : Promise.resolve(null)),
          () => (slackRef.reader ? slackRef.reader.brief() : Promise.resolve(null)),
          // A new mailbox's catch-up, once it is done: "From the last 14 days (mail): …", once.
          async () => (backfillRef.b ? backfillRef.b.briefLine() : null),
          // A private calendar link that stopped working: said once here (its row on the connections page says it for as long as it lasts).
          async () => icsRef.source?.brokenNews(uiLang()) ?? null,
          () => door.tasksBrief(),
          // Today's birthdays (src/people.ts): their own line, only when there is one.
          () => door.birthdaysBrief(),
          // What changed since yesterday (src/memory-facts.ts): a meeting moved, a new value told; only when something did.
          (o) => door.changesBrief(o.since),
          // Monday only, and only when the week's nudges did poorly: one line (src/quality.ts).
          () => (quality ? quality.monday() : Promise.resolve(null)),
        ],
        notify: briefSent,
        notifyNote: (text) => door.notifyOwner(text, { urgent: true }),
        ...(smartCfg.config
          ? {
              smart: {
                begin: (t: number, o?: { since: number }) => (smartRef.brief ? smartRef.brief.begin(t, false, o?.since) : Promise.resolve(false)),
                short: () => (smartRef.brief ? smartRef.brief.short() : Promise.resolve(null)),
              },
            }
          : {}),
      });
      if (smartCfg.config) {
        // What the written brief reads: each part looked up when the brief is gathered, so a connection made later counts.
        smartRef.brief = createBriefV2({
          config: smartCfg.config,
          kv,
          timeZone,
          control,
          lang: uiLang,
          ownerLanguage: () => door.language(),
          name: givenName,
          sources: {
            ...(followupsCfg.config ? { loops: () => (followupsRef.engine ? followupsRef.engine.open() : Promise.resolve([])) } : {}),
            ...(zoom.config
              ? {
                  // Zoom's summaries with the review's outcomes; its to-dos only when no engine keeps them as loops (one source of truth).
                  meetings: async () => {
                    if (!zoomRef.reader) throw new Error("Zoom is not ready");
                    const list = await zoomRef.reader.recent(7);
                    const reviews = reviewRef.reviewer ? await reviewRef.reviewer.read() : [];
                    return briefMeetings(list, reviews, { now: Date.now(), days: 7, ownItems: !followupsCfg.config });
                  },
                  zoom: () => (zoomRef.reader ? zoomRef.reader.scheduled() : Promise.reject(new Error("Zoom is not ready"))),
                }
              : {}),
            ...(slack.config ? { slack: () => (slackRef.reader ? slackRef.reader.alerts() : Promise.reject(new Error("Slack is not ready"))) } : {}),
            ...(calOn ? { events: () => (calRef.reader ? calRef.reader.load() : Promise.reject(new Error("the calendar is not ready"))) } : {}),
            tasks: async () => (await door.lists.read(true)).tasks,
            ...(box ? { mail: () => box.items(60) } : {}),
            birthdays: () => door.birthdaysBrief(),
            reminders: async () => (await door.reminders()).filter((r) => !r.birthday),
            ...(calOn ? { calendarChanges: (since: number) => (calChangesRef.c ? calChangesRef.c.since(since) : Promise.resolve([])) } : {}),
          },
          enqueue: (m) => door.inbox.add(m),
          // The computer asked for messages in the last three minutes: otherwise the old brief goes at once rather than after the wait.
          bridgeAlive: () => Date.now() - door.lastPoll() < 3 * 60_000,
          plain: () => (briefRef.reader ? briefRef.reader.plain() : Promise.resolve()),
          // What changed since the last brief (src/memory-facts.ts): its line under the written brief, as under the old one.
          changes: (since) => door.changesBrief(since),
          notify: briefSent,
          tell: (text) => door.notifyOwner(text),
          // A draft answering an email comes back as a reply on the email card: the email's sender and subject from the mailbox.
          ...(box
            ? {
                offerSend: async (o: { mailRef: string; title: string; text: string }) => {
                  const m = await box.get(o.mailRef);
                  if (m) await door.offerDraftSend({ from: m.from, subject: m.subject, title: o.title, text: o.text });
                },
              }
            : {}),
          url: () => publicUrl() || null,
          ...(followupsCfg.config ? { closeLoop: (id: string) => followupsDoor.press("1", id) } : {}),
          tickTask: (id: string, done: boolean) => door.lists.tickTask(id, done, Date.now()),
          ...(quality ? { quality: { monday: () => quality.monday(), line: (l: Lang) => quality.briefLine(l), asked: quality.briefAsked } } : {}),
        });
        smartRef.brief.start();
        // A meeting's prep by itself, about 40 minutes before it (src/meeting-prep.ts): the meeting, what is open with its people, what
        // Pako knows of them. MEETING_PREP=off turns it off.
        if (calOn && loadMeetingPrepConfig(env).on) {
          const brief = smartRef.brief;
          const prep = createMeetingPrep({
            kv, timeZone,
            events: () => (calRef.reader ? calRef.reader.load() : Promise.reject(new Error("the calendar is not ready"))),
            ...(followupsCfg.config ? { loops: () => (followupsRef.engine ? followupsRef.engine.open() : Promise.resolve([])) } : {}),
            about: async (names) => {
              const all = await door.facts.read();
              return names.flatMap((n) => currentAbout(all, [n]).slice(0, 4).map((f) => ({ label: n, text: factLine(f, uiLang(), timeZone) })));
            },
            self: () => [mail.config?.inbox, imap.config?.user].filter((x): x is string => !!x),
            prep: (o) => brief.prepMeeting(o),
            clock: (t) => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t),
          });
          setInterval(() => void prep.tick().catch((err: Error) => logCalendar.error(`meeting prep: ${err.message}`)), 5 * 60_000).unref?.();
        }
      }
      // On the jobs' clock: due reminders, then routines and watches (one look each, as before), and the brief's daily slot.
      jobs.define({ kind: "reminders", sweep: () => door.runReminders() });
      jobs.define({ kind: "routines", sweep: () => door.routines.tick() });
      briefRef.reader.start(jobs);
      jobs.start();
      mountBriefPanel(app, { signedIn: panel.signedIn, brief: briefNow });
      mountBriefPage(app, { signedIn: panel.signedIn, brief: () => smartRef.brief, lang: uiLang });
      if (!local) logBrief.info(`${briefCfg.at === null ? "only on demand (BRIEF)" : `ON: every day at ${env.MORNING_BRIEF?.trim() || "08:00"} (${timeZone})`}`);
      if (zoom.config && reviewCfg.config) {
        reviewRef.reviewer = createMeetingReview({
          config: reviewCfg.config, kv, timeZone, control, lang: uiLang, ownerName: givenName,
          enqueue: (m) => door.inbox.add(m), notify: (text) => door.notifyOwner(text),
          annotate: (id, summary) => (zoomRef.reader ? zoomRef.reader.annotate(id, summary) : Promise.resolve(false)),
          // The computer asked for messages in the last three minutes: otherwise Zoom's summary is told at once, as before.
          bridgeAlive: () => Date.now() - door.lastPoll() < 3 * 60_000,
          ...(followupsCfg.config
            ? {
                loops: {
                  ingest: (o) => (followupsRef.engine ? followupsRef.engine.ingest(o) : Promise.resolve(0)),
                  open: () => (followupsRef.engine ? followupsRef.engine.open() : Promise.resolve([])),
                  offer: (o) => followupsDoor.offer(o),
                },
              }
            : {}),
        });
        reviewRef.reviewer.start();
      }
      if (zoom.config) {
        const reviewer = reviewRef.reviewer;
        zoomRef.reader = createZoom({
          config: zoom.config, kv, timeZone, control, lang: uiLang, notify: (text) => door.notifyOwner(text), enqueue: (m) => door.inbox.add(m),
          onSummary: (m) => void followupsDoor.offer({ source: "meeting", ref: m.id, label: m.topic, text: m.summary, at: m.at }),
          ...(reviewer ? { review: { summary: (m) => reviewer.summary(m), transcript: (m) => reviewer.transcript(m) } } : {}),
          health: dog.reporter("zoom"),
          speakers: (names, at) => feedPeople(zoomSightings(names, at)),
          // Zoom's refresh token works once: each new one goes where the panel keeps it, so the next start uses it. One set in a file
          // cannot be changed from here, so that setup stops working at the next restart: said plainly.
          ...(zoom.config.mode === "user"
            ? {
                keepRefresh: (t: string) => {
                  if (!local || ((env.ZOOM_REFRESH_TOKEN ?? "").trim() && !appliedAtStart().has("ZOOM_REFRESH_TOKEN"))) {
                    logZoom.error("Zoom gave a new refresh token, but ZOOM_REFRESH_TOKEN is set outside the panel: connect Zoom from the panel instead");
                    return;
                  }
                  if (!writeStored(pakoHome(env), { ZOOM_REFRESH_TOKEN: t })) logZoom.error("could not keep Zoom's new refresh token");
                },
              }
            : {}),
        });
        zoomRef.reader.start();
        dog.watch("zoom");
        logZoom.info(`ON: ${zoom.config.mode === "user" ? "your own app" : zoom.config.user}, listed every ${zoom.config.pollMinutes} min`);
      }
      if (slack.config) {
        slackRef.reader = mountSlack(app, {
          config: slack.config, kv, timeZone, control, lang: uiLang, notify: (text) => door.notifyOwner(text),
          observe: (m) => {
            void followupsRef.engine?.observeSlack(m);
            // The owner's own message is not a sighting of someone else.
            if (!m.mine) feedPeople(slackSightings(m));
          },
          health: dog.reporter("slack"),
          eventsHealth: dog.reporter("slackEvents"),
          // Connected with the project's own app, not yet in the Slack Marketplace: one DM a look (Slack's limit for such apps).
          ...(!SLACK_MARKETPLACE_LISTED && (env.SLACK_CLIENT_ID ?? "").trim() && (env.SLACK_CLIENT_ID ?? "").trim() === builtInClients(env).slack ? { pollPerRound: 1 } : {}),
        });
        dog.watch("slack");
        if (slack.config.appToken) dog.watch("slackEvents");
        // Slack brings its news by itself: a token revoked on a quiet day is found by a look every half hour.
        const slackReader = slackRef.reader;
        dog.probe(30 * 60_000, () => slackReader.check());
        // Socket Mode (SLACK_APP_TOKEN): opened by server.ts once it listens, closed on shutdown; the events address works beside it when the
        // signing secret is set too (each event is handled once, by its id).
        if (slackRef.reader.socket) app.locals.slackSocket = slackRef.reader.socket;
        // Neither live way set up (what connecting from the panel gives): Pako looks every minute (src/slack-poll.ts).
        slackRef.reader.poll?.start();
        const ways = [slack.config.appToken ? "Socket Mode" : "", slack.config.signingSecret ? "events at /slack/events" : ""].filter(Boolean).join(" + ")
          || "a look every minute";
        logSlack.info(`ON: ${ways}, quiet ${slack.config.quiet ? env.SLACK_QUIET_HOURS ?? "23:00-08:00" : "off"}`);
      } else {
        mountSlackCheckOnly(app);
      }
      if (followupsCfg.config) {
        // Looks only at what this server already reads (each part looked up when a check runs, so one set up later counts).
        followupsRef.engine = createFollowups({
          config: followupsCfg.config,
          drafts: !!smartCfg.config,
          ownerName: givenName,
          kv,
          timeZone,
          control,
          lang: uiLang,
          ownerLanguage: () => door.language(),
          enqueue: (m) => door.inbox.add(m),
          card: (body, buttons) => door.sendCard(body, buttons),
          notify: (text) => door.notifyOwner(text),
          ...(quality ? { quality: quality.followups } : {}),
          // The day's budget is shared with proactive Pako's suggestions.
          ...(proactiveCfg.config ? { othersToday: () => (lifeRef.engine ? lifeRef.engine.spentToday() : Promise.resolve(0)) } : {}),
          ...(zoom.config ? { zoom: () => (zoomRef.reader ? zoomRef.reader.scheduled() : Promise.reject(new Error("Zoom is not ready"))) } : {}),
          ...(calOn && !teamsCfg.config ? { calendar: () => (calRef.reader ? calRef.reader.load() : Promise.reject(new Error("the calendar is not ready"))) } : {}),
          // With Teams, its calendar's Teams meetings count as "it happened" too (src/teams.ts events).
          ...(teamsCfg.config
            ? {
                calendar: async () => {
                  const own = calOn ? (calRef.reader ? await calRef.reader.load() : Promise.reject(new Error("the calendar is not ready"))) : [];
                  return [...(await own), ...(teamsRef.reader ? await teamsRef.reader.events().catch(() => []) : [])];
                },
              }
            : {}),
          // A Teams conversation has a Slack-shaped id of its own (src/teams.ts teamsChannel): its history comes from Teams.
          ...(slack.config || teamsCfg.config
            ? {
                slackHistory: (ch, o) =>
                  isTeamsChannel(ch)
                    ? teamsRef.reader ? teamsRef.reader.history(ch, o) : Promise.reject(new Error("Teams is not ready"))
                    : slackRef.reader ? slackRef.reader.history(ch, o) : Promise.reject(new Error("Slack is not ready")),
              }
            : {}),
          // One name per person across Slack, the mail and meetings (src/people-graph.ts).
          who: (name: string) => door.peopleGraph.canon(name),
        });
        followupsRef.engine.start(jobs);
        const fc = followupsCfg.config;
        if (!local) logFollowups.info(`ON: checked ${fc.delayMs / 60_000} min after, at most ${fc.maxPerDay} reminders a day`);
      }
      if (proactiveCfg.config) {
        const pc = proactiveCfg.config;
        lifeRef.engine = createProactive({
          config: pc,
          kv,
          timeZone,
          local: !!local,
          control,
          lang: uiLang,
          ownerLanguage: () => door.language(),
          enqueue: (m) => door.inbox.add(m),
          card: (body, buttons, feedback) => door.sendCard(body, buttons, feedback),
          ...(quality ? { quality: quality.followups } : {}),
          lastOwner: () => door.lastOwner(),
          bridgeAlive: () => Date.now() - door.lastPoll() < 3 * 60_000,
          ...(calOn ? { calendar: () => (calRef.reader ? calRef.reader.load() : Promise.resolve([])) } : {}),
          ...(box ? { mail: () => box.items(40) } : {}),
          people: async () => (await door.people.store.read()).map((p) => p.name),
          fetch: globalThis.fetch,
          ...(followupsCfg.config ? { othersToday: async () => (await followupsRef.engine?.spentToday?.()) ?? 0 } : {}),
          addToList: async (name, item) => {
            const r = await door.lists.add(name, [item], Date.now());
            return r.added.length ? { ok: true, list: r.list } : { ok: false, list: r.list, why: r.full.length ? "full" : "already there" };
          },
          remind: (when, text) => door.remindAt(when, text),
          // The friend, health companion and teacher's candidates: the same check, budget, hours and topics (src/companion.ts).
          offers: () => door.companion.offers(),
        });
        lifeRef.engine.start();
        const where = pc.place ? "with the weather" : "no weather (PAKO_PLACE)";
        logProactive.info(`ON: every ${pc.everyMs / 60_000} min in its hours, at most ${pc.maxPerDay} a day, ${where}`);
      }
      mountProactivePanel(app, { signedIn: panel.signedIn, life: () => lifeRef.engine });
      if (quality) {
        rehearsalRef.r = createRehearsal({
          kv,
          timeZone,
          lang: uiLang,
          enqueue: (m) => door.inbox.add(m),
          drop: (ids) => door.inbox.ack(ids),
          bridgeAlive: () => Date.now() - door.lastPoll() < 3 * 60_000,
          followups: followupsCfg.config ? () => followupsRef.engine?.rehearse ?? null : null,
          brief: smartCfg.config ? () => smartRef.brief : null,
          ...(slack.config ? { slack: () => (slackRef.reader ? slackRef.reader.alerts() : Promise.resolve([])) } : {}),
          ...(box ? { mail: () => box.items(60) } : {}),
          ...(zoom.config ? { meetings: () => (zoomRef.reader ? zoomRef.reader.recent(2) : Promise.resolve([])) } : {}),
        });
      }
      mountRehearsalPanel(app, { signedIn: panel.signedIn, rehearsal: rehearsalRef.r });
      mountQualityPanel(app, {
        signedIn: panel.signedIn,
        quality,
        briefItem: async (doc, kind, i) => {
          const today = await smartRef.brief?.todayDoc();
          if (!today || today.id !== doc) return null;
          return (kind === "todo" ? today.todos[i]?.title : today.updates[i]?.title) ?? null;
        },
      });
      if (mail.config && box) {
        mountMail(app, { config: mail.config, box, control, lang: uiLang, enqueue: (m) => door.inbox.add(m), health: dog.reporter("mail") });
        if (mail.config.pollMinutes > 0) dog.watch("mail");
        const every = mail.config.pollMinutes ? `listed every ${mail.config.pollMinutes} min` : "no listing";
        logMail.info(`ON: ${mail.config.inbox}, webhook at /email/webhook, ${every}`);
      }
      // A Teams catch-up's conversation goes to the follow-ups message by message, as Teams' live ones do.
      const backfillChat = async (c: BackfillChat): Promise<void> => {
        for (const m of c.msgs) await followupsRef.engine?.observeSlack({ channel: c.channel, ts: m.ts, at: m.at, who: m.who, where: c.where, direct: c.direct, text: m.text });
      };
      if (imap.config && box) {
        backfillRef.b = createBackfill({
          kv, config: backfillCfg.config, enqueue: (m) => door.inbox.add(m), lang: uiLang, notify: (text) => door.notifyOwner(text), chat: backfillChat,
          ...(followupsCfg.config ? { offer: (o) => (followupsRef.engine ? followupsRef.engine.offer(o) : Promise.resolve(false)) } : {}),
          keepUnread: (id, note) => box.annotate(id, "guardado", note),
        });
        backfillRef.b.start();
        const bf = backfillRef.b;
        // Signed in with Microsoft or Google (src/mail-oauth.ts): a fresh access token before each look; a refresh token the provider
        // replaces is kept where the panel keeps it, unless it was set in a file (then it is said, as for Zoom).
        const o = imap.config.oauth;
        const tokens = o
          ? createTokenSource({
              provider: o.provider, clientId: o.clientId, ...(o.clientSecret ? { clientSecret: o.clientSecret } : {}), refreshToken: o.refreshToken,
              keep: (t) => {
                if (!local || ((env.IMAP_REFRESH_TOKEN ?? "").trim() && !appliedAtStart().has("IMAP_REFRESH_TOKEN"))) {
                  logImap.error("the provider gave a new refresh token, but IMAP_REFRESH_TOKEN is set outside the panel: sign in from the panel instead");
                  return;
                }
                if (!writeStored(pakoHome(env), { IMAP_REFRESH_TOKEN: t })) logImap.error("could not keep the new refresh token");
              },
            })
          : null;
        imapRef.reader = createImapReader({
          backfill: { add: bf.add, addSent: bf.addSent, startLine: bf.startLine, days: backfillCfg.config.days },
          config: imap.config, kv, box, control, lang: uiLang, enqueue: (m) => door.inbox.add(m), health: dog.reporter("imap"),
          notify: (text) => door.notifyOwner(text),
          ...(invites ? { invites } : {}),
          ...(tokens ? { tokens: () => tokens.access(), forgetToken: () => tokens.forget() } : {}),
        });
        dog.watch("imap");
        imapRef.reader.start();
        logImap.info(`ON: ${imap.config.host}, read only, ${imap.config.folders.join(", ")}, every ${imap.config.pollMinutes} min`);
      }
      if (teamsCfg.config) {
        // The catch-up shares the mailbox's when there is one (one allowance, one pace); otherwise Teams gets its own.
        if (!backfillRef.b) {
          backfillRef.b = createBackfill({
            kv, config: backfillCfg.config, enqueue: (m) => door.inbox.add(m), lang: uiLang, notify: (text) => door.notifyOwner(text), chat: backfillChat,
          });
          backfillRef.b.start();
        }
        const bf = backfillRef.b;
        teamsRef.reader = createTeams({
          config: teamsCfg.config, kv, health: dog.reporter("teams"), notify: (text) => door.notifyOwner(text),
          observe: (m) => {
            void followupsRef.engine?.observeSlack({ channel: m.channel, ts: m.ts, at: m.at, who: m.who, where: m.where, direct: m.direct, text: m.text });
          },
          ...(followupsCfg.config ? { offer: (o) => followupsDoor.offer(o) } : {}),
          catchUp: { days: backfillCfg.config.days, add: (c) => bf.addChat(c) },
          // Microsoft's new refresh token goes where the panel keeps it, unless it was set in a file (then it is said, as for Zoom).
          keep: (t) => {
            if (!local || ((env.TEAMS_REFRESH_TOKEN ?? "").trim() && !appliedAtStart().has("TEAMS_REFRESH_TOKEN"))) {
              logTeams.error("Microsoft gave a new refresh token, but TEAMS_REFRESH_TOKEN is set outside the panel: connect Teams from the panel instead");
              return;
            }
            if (!writeStored(pakoHome(env), { TEAMS_REFRESH_TOKEN: t })) logTeams.error("could not keep the new refresh token");
          },
        });
        dog.watch("teams");
        const teamsReader = teamsRef.reader;
        dog.probe(30 * 60_000, () => teamsReader.check());
        teamsReader.start();
        logTeams.info(`ON: ${teamsCfg.config.account || "connected"}, read only, every ${teamsCfg.config.pollMinutes} min`);
      }
    }
  } else if ((env.WHATSAPP_ACCESS_TOKEN ?? "").trim()) {
    // Everything (WhatsApp, mail, Slack, the calendar, the panel) hangs from the owner's settings: one wrong or missing one turns it all off, and the log must say so.
    logWhatsapp.error(
      "off, because the personal caller is off: PERSONAL_CALLER_TOKEN, PERSONAL_OWNER_NAME and PERSONAL_OWNER_NUMBER must all be set and valid "
      + "(see the [personal-caller] line above).",
    );
  }

  // A store that came back empty (wiped, or a first start) pauses everything and tells the owner (src/store-guard.ts). server.ts starts it
  // once listening: an app that is only built (as in most tests) keeps no watch.
  app.locals.storeGuard = createStoreGuard({
    store,
    control,
    notify: tellOwner,
    ...(tellAssistant ? { note: tellAssistant } : {}),
    parts,
    lang: uiLang,
    ...(local ? { local: local.storeStart ?? { firstRun: true, lost: null } } : {}),
  });

  // Last: body-parser and unexpected errors become clean answers. Never a stack trace.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { status?: number };
    const status = typeof e.status === "number" && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (status === 500) logApp.error("Unhandled error:", err);
    if (res.headersSent) return;
    res.status(status).type("text").send(status === 500 ? "Something went wrong." : "Bad request.");
  });
  return app;
}
