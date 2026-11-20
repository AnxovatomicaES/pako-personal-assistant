// Pako · the connections page's model (/panel/settings): what each connection's state is, what to suggest next, what the Mac app found said
// as friendly chips, the checks a field runs as the person types, and the talk with the Mac app. Plain functions with no page in them: the
// page (settings.js) imports this file, and so do the tests (test/settings-page.test.ts), which hand it a fake window.
//
// The talk with the Mac app (desktop/mac), through window.webkit.messageHandlers.pako.postMessage(...), only after a press on the page:
//   {type: "discover", what: [...], openMail?}  the app looks (macOS asks its own permissions), posts the result to POST /panel/api/discovery
//                                              and calls window.pakoDiscovered(result); Mail is only asked when it is running, or with
//                                              openMail: true (the person pressed the button that says it opens Mail)
//   {type: "use", what: "calendars", ids: [...]}  the app pushes those calendars' events to POST /panel/api/calendar/local from now on
//                                              (ids: [] stops it, and Pako forgets the events it had)
//   {type: "use", what: "contacts"}              the app reads the contacts and posts them to POST /panel/api/people/import
//   {type: "use", what: "zoomRecordings"}        the app hands Pako the Zoom recordings folder it found
//   {type: "openURL", url: "x-apple.systempreferences:…?Privacy_Contacts"}  the privacy pane of a permission the person refused
// For a "use" the app answers window.pakoUsed({what, ok, count?, error?}); for the contacts also {added, merged} as Pako's import counted
// them (count then is how many people Pako knows from this Mac). Nothing else is ever asked of it.

/** The cards, in the page's order. */
export const CARDS = ["claude", "calendar", "mail", "telegram", "whatsapp", "slack", "zoom", "contacts", "tables", "resend", "phone", "more"];
/**
 * What the ring counts: the essentials anyone can connect without a developer account (a calendar, a mailbox, Telegram by QR, this Mac's
 * contacts). Claude works from the start (the sign-in). WhatsApp, Slack and Zoom need an app of one's own on Meta, Slack or Zoom: they are
 * in the Advanced group (ADVANCED), never counted, never suggested, so nobody feels unfinished without a developer account.
 */
export const COUNTED = ["calendar", "mail", "telegram", "contacts"];
/** The cards of the Advanced group, in this order: each needs a developer app or an account somewhere else, or is a fine detail. */
export const ADVANCED = ["whatsapp", "slack", "zoom", "teams", "tables", "resend", "phone", "more"];
/** The cards that belong to a lab (src/labs.ts LABS cards): hidden while that lab is off. */
export const LAB_CARDS = { tables: "booking", phone: "calls", whatsapp: "whatsapp" };

/**
 * The cards hidden because their lab is off, from GET /panel/api/labs ({ labs: [{ id, on }] }). Null (an older Pako, a server): none hidden.
 */
export function labHiddenCards(labs) {
  const list = Array.isArray(labs?.labs) ? labs.labs : null;
  if (!list) return new Set();
  const off = new Set(list.filter((l) => l && l.on === false).map((l) => l.id));
  return new Set(Object.entries(LAB_CARDS).filter(([, lab]) => off.has(lab)).map(([card]) => card));
}

/** What helps most first, for "What would help you most next". */
const PRIORITY = ["calendar", "mail", "telegram", "contacts"];

const conn = (all, id) => (Array.isArray(all?.connections) ? all.connections.find((c) => c && c.id === id) : undefined);
const hasProblem = (c) => typeof c?.problem === "string" && c.problem.length > 0;

/**
 * Each card's state: "on", "partial" (begun, not finished), "problem" (set but not working) or "off". `s` holds the server's answers, each
 * null when that route did not answer: connections (GET /panel/api/connections), telegram, whatsapp (its setup), claude (GET
 * /panel/api/claude), discovery, localCalendar (whether the app pushes calendars: {calendars:[...]}) and people (the imported contacts,
 * GET /panel/api/people/imported: {count, people}). WhatsApp's setup is the computer's guided one ({step, done[], tunnel, problems[]}) or
 * the older {state}.
 */
/** How many contacts Pako has from this Mac: {count} from /panel/api/people/imported, or a list of people. */
export function importedCount(p) {
  if (Number.isInteger(p?.count) && p.count >= 0) return p.count;
  return Array.isArray(p?.people) ? p.people.length : 0;
}

/** WhatsApp's card: the computer's guided setup ({step: "app"|"tunnel"|"test"|"done", done[], tunnel: {state}, problems[]}) or {state}. */
export function whatsappState(wa) {
  if (typeof wa?.step === "string") {
    if (wa.step === "done") return "on";
    if (wa.tunnel?.state === "error" || (Array.isArray(wa.problems) && wa.problems.length)) return "problem";
    return wa.step !== "app" || (Array.isArray(wa.done) && wa.done.length) ? "partial" : "off";
  }
  const st = wa?.state;
  return st === "on" || st === "partial" || st === "problem" ? st : "off";
}

export function cardStates(s = {}) {
  const out = {};
  const c = s.connections;
  const st = (id) => conn(c, id)?.state ?? "off";
  const claude = s.claude?.status?.claude;
  // What Claude itself says first: a saved key is checked for its shape only, so one Claude refuses (login) or no claude command is a problem.
  // A free plan cannot run Claude Code (src/claude-connect.ts): signed in, and still a problem.
  // The connect flow's own look is fresher than the bridge's (a sign-out just now): signed out there is a problem too, unless a key is set.
  // A sign-in past its expiry still says signed in, but Claude refuses its runs: a problem as well.
  const acc = s.claudeConnect?.account;
  const expired = acc?.loggedIn === true && typeof acc.expiresAt === "number" && acc.expiresAt <= Date.now();
  const signedOut = (acc?.loggedIn === false || expired) && st("claude") !== "on";
  out.claude = claude === "login" || claude === "limit" || claude === "missing" || signedOut || s.claudeConnect?.phase === "needs-plan" ? "problem"
    : st("claude") === "on" || claude === "ok" ? "on" : "off";
  const localCal = Array.isArray(s.localCalendar?.calendars) && s.localCalendar.calendars.length > 0;
  // A link and a Places key have no live check when saved: until their service has answered once (checked: false), they are only saved.
  const unchecked = (id) => conn(c, id)?.checked === false;
  // Google Calendar, connected with one button, is the calendar too.
  out.calendar = localCal || st("google") === "on" ? "on" : st("calendar") === "on" ? (unchecked("calendar") ? "saved" : "on") : st("calendar") === "partial" ? "partial" : "off";
  const imap = conn(c, "imap");
  const mailOn = st("imap") === "on" || st("mail") === "on";
  out.mail = hasProblem(imap) ? "problem" : mailOn ? "on" : st("imap") === "partial" || st("mail") === "partial" ? "partial" : "off";
  const tg = s.telegram?.state;
  out.telegram = tg === "paired" ? "on" : tg === "unpaired" ? "partial" : "off";
  out.whatsapp = whatsappState(s.whatsapp);
  out.slack = hasProblem(conn(c, "slack")) ? "problem" : st("slack");
  out.zoom = hasProblem(conn(c, "zoom")) ? "problem" : st("zoom");
  out.teams = hasProblem(conn(c, "teams")) ? "problem" : st("teams");
  out.contacts = importedCount(s.people) > 0 ? "on" : "off";
  out.tables = hasProblem(conn(c, "tables")) ? "problem" : st("tables") === "on" && unchecked("tables") ? "saved" : st("tables");
  out.resend = hasProblem(conn(c, "resend")) ? "problem" : st("resend");
  out.phone = "off";
  return out;
}

/** How many of the essentials are connected. */
export const connectedCount = (states) => COUNTED.filter((id) => states[id] === "on").length;

/**
 * The one to suggest: Claude when it does not work (nothing else helps without Pako's brain), then one that is half done or failing, then
 * the first by help that is not connected yet. Null when all are.
 */
export function nextSuggestion(states) {
  if (states.claude === "problem") return "claude";
  const half = PRIORITY.find((id) => states[id] === "partial" || states[id] === "problem");
  // Saved and waiting for its first answer: nothing for the owner to do there.
  return half ?? PRIORITY.find((id) => states[id] !== "on" && states[id] !== "saved") ?? null;
}

// ---------- what the Mac app found ----------

const APPS = ["zoom", "slack", "telegram", "whatsapp", "mail", "outlook", "teams"];
const PROVIDERS = ["icloud", "google", "microsoft", "yahoo", "other"];
const text = (v, max = 200) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");

/** The discovery as the page trusts it: only the contract's fields, each checked; anything else is dropped. Null when there is none. */
export function cleanDiscovery(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const apps = {};
  for (const a of APPS) apps[a] = raw.apps?.[a] === true;
  const calendars = (Array.isArray(raw.calendars) ? raw.calendars : []).slice(0, 100).filter((x) => x && text(x.id) && text(x.title))
    .map((x) => ({
      id: text(x.id, 300), title: text(x.title, 120), source: text(x.source, 120),
      color: /^#[0-9a-f]{6}$/i.test(String(x.color ?? "")) ? x.color : "#8b7bff", writable: x.writable === true,
    }));
  const mailAccounts = (Array.isArray(raw.mailAccounts) ? raw.mailAccounts : []).slice(0, 30).filter((x) => x && isEmail(text(x.address)))
    .map((x) => ({
      address: text(x.address).toLowerCase(), name: text(x.name, 120),
      provider: PROVIDERS.includes(x.provider) ? x.provider : providerOf(text(x.address)),
      kind: ["imap", "exchange", "other"].includes(x.kind) ? x.kind : "other",
      apps: (Array.isArray(x.apps) ? x.apps : ["mail"]).filter((a) => MAIL_APPS.includes(a)).slice(0, 6),
      icloudMail: x.icloudMail === true,
    }));
  const mailState = MAIL_STATES.includes(raw.mailState) ? raw.mailState : null;
  const count = Number.isInteger(raw.contacts?.count) && raw.contacts.count >= 0 ? raw.contacts.count : null;
  const zr = raw.zoomRecordings;
  const zoomRecordings = zr && typeof zr === "object" && text(zr.folder, 500) && Number.isInteger(zr.count) && zr.count >= 0
    ? { folder: text(zr.folder, 500), count: zr.count } : null;
  const perm = (v) => (v === "granted" || v === "denied" ? v : "notAsked");
  const permissions = { calendars: perm(raw.permissions?.calendars), contacts: perm(raw.permissions?.contacts), mail: perm(raw.permissions?.mail) };
  const at = typeof raw.at === "string" || typeof raw.at === "number" ? raw.at : null;
  if (!at && !calendars.length && !mailAccounts.length && count === null && !APPS.some((a) => apps[a])) return null;
  return { at, apps, calendars, mailAccounts, mailState, contacts: count === null ? null : { count }, zoomRecordings, permissions };
}

const MAIL_APPS = ["mail", "outlook", "emclient", "thunderbird", "icloud", "contacts"];
const MAIL_STATES = ["found", "empty", "closed", "denied", "failed"];

/**
 * What the mail card says about the last look on this Mac, as a word key and its values: the exact state of Mail (not set up, Automation
 * refused, closed, no answer) and how many addresses were found in all the places looked at. Null before any look.
 */
export function mailStatus(d) {
  if (!d || !d.mailState) return null;
  const n = d.mailAccounts.length;
  const found = n ? { key: n === 1 ? "mailst.found1" : "mailst.foundN", vars: { n } } : null;
  const mail = { empty: "mailst.empty", closed: "mailst.closed", denied: "mailst.denied", failed: "mailst.failed" }[d.mailState] ?? null;
  return { found, mail, denied: d.mailState === "denied" };
}

/**
 * The friendly chips for what was found: [{id, card, icon, text, use?}], `text` already in the page's words through `t(key, vars)`. `use`
 * names what "Usar este" does: a card to open, and for a mail account its address.
 */
export function discoveryChips(d, t) {
  if (!d) return [];
  const chips = [];
  const names = (list, n = 3) => list.slice(0, n).join(", ") + (list.length > n ? ` ${t("andMore", { n: list.length - n })}` : "");
  if (d.calendars.length) {
    chips.push({
      id: "calendars", card: "calendar", icon: "calendar",
      text: t(d.calendars.length === 1 ? "found.calendar1" : "found.calendars", { n: d.calendars.length, names: names(d.calendars.map((c) => c.title)) }),
      use: { card: "calendar" },
    });
  }
  for (const a of d.mailAccounts.slice(0, 4)) {
    chips.push({ id: `mail:${a.address}`, card: "mail", icon: "mail", text: t("found.mail", { address: a.address }), use: { card: "mail", address: a.address } });
  }
  if (d.contacts && d.contacts.count > 0) {
    chips.push({ id: "contacts", card: "contacts", icon: "users", text: t("found.contacts", { n: d.contacts.count }), use: { card: "contacts" } });
  }
  if (d.apps.zoom) {
    const rec = d.zoomRecordings?.count ? ` ${t("found.zoomRec", { n: d.zoomRecordings.count })}` : "";
    chips.push({ id: "zoom", card: "zoom", icon: "video", text: t("found.zoom") + rec, use: { card: "zoom" } });
  }
  for (const [app, card, icon] of [["slack", "slack", "hash"], ["telegram", "telegram", "send"], ["whatsapp", "whatsapp", "message-circle"]]) {
    if (d.apps[app]) chips.push({ id: app, card, icon, text: t(`found.${app}`), use: { card } });
  }
  return chips;
}

/** Whether the page runs inside the Mac app (its message handler is there). */
export const inApp = (win) => typeof win?.webkit?.messageHandlers?.pako?.postMessage === "function";

/** Tells the Mac app something; false when there is no app to tell. */
export function tellApp(win, message) {
  if (!inApp(win)) return false;
  try {
    win.webkit.messageHandlers.pako.postMessage(message);
    return true;
  } catch {
    /* the app's bridge is gone: not sent */
    return false;
  }
}

/**
 * Asks the app and waits for its answer through window[callback] (pakoDiscovered, pakoUsed). Null when there is no app, it did not answer
 * within `ms`, or `accept` refused every answer in that time. The callback is put back as it was afterwards.
 */
export function askApp(win, message, callback, ms = 60_000, accept = () => true) {
  if (!inApp(win)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const before = win[callback];
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      win[callback] = before;
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), ms);
    win[callback] = (v) => {
      if (typeof before === "function") {
        try {
          before(v);
        } catch {
          /* the other listener's trouble */
        }
      }
      if (accept(v)) finish(v);
    };
    if (!tellApp(win, message)) finish(null);
  });
}

// ---------- the checks a field runs as the person types ----------

export function isEmail(v) {
  return typeof v === "string" && v.length <= 254 && /^[^\s@<>()",;:]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(v.trim());
}

/** "ok", "empty", or the word key of what is wrong (the page says it in plain words). */
export function checkField(kind, raw) {
  const v = String(raw ?? "").trim();
  if (!v) return "empty";
  switch (kind) {
    case "email": return isEmail(v) ? "ok" : "bad.email";
    case "telegramToken": return /^\d{5,12}:[A-Za-z0-9_-]{30,60}$/.test(v) ? "ok" : /\s/.test(v) ? "bad.spaces" : "bad.telegram";
    case "slackUser": return /^xoxp-[A-Za-z0-9-]{20,}$/.test(v) ? "ok" : /^xoxb-/.test(v) ? "bad.slackBot" : /^xapp-/.test(v) ? "bad.slackSwap" : "bad.slackUser";
    case "slackApp": return /^xapp-[A-Za-z0-9-]{20,}$/.test(v) ? "ok" : /^xox[pb]-/.test(v) ? "bad.slackSwap" : "bad.slackApp";
    case "ics": return /^(https|webcals?):\/\/[^\s]+$/i.test(v) ? "ok" : /^http:\/\//i.test(v) ? "bad.icsHttp" : "bad.ics";
    case "anthropic": return /^sk-ant-[A-Za-z0-9_-]{20,300}$/.test(v) ? "ok" : "bad.anthropic";
    case "appPassword": return v.replace(/[\s-]/g, "").length >= 8 ? "ok" : "bad.appPassword";
    case "zoomId": return /^[A-Za-z0-9_-]{6,100}$/.test(v) ? "ok" : "bad.zoomId";
    case "zoomSecret": return /^[A-Za-z0-9_-]{10,200}$/.test(v) ? "ok" : "bad.zoomSecret";
    case "slackClientId": return /^\d{5,20}\.\d{5,20}$/.test(v) ? "ok" : /^xox[pba]-|^xapp-/.test(v) ? "bad.slackClientToken" : "bad.slackClientId";
    case "zoomClientId": return /^[A-Za-z0-9_-]{10,64}$/.test(v) ? "ok" : "bad.zoomClientId";
    case "places": return /^AIza[0-9A-Za-z_-]{35}$/.test(v) ? "ok" : "bad.places";
    case "resendKey": return /^re_[A-Za-z0-9_-]{8,200}$/.test(v.trim()) ? "ok" : "bad.resendKey";
    case "agentmailKey": return v.length >= 10 && !/\s/.test(v) ? "ok" : "bad.agentmailKey";
    default: return "ok";
  }
}

/** The provider of an address, by its domain (the built-in table of the mail wizard). */
export function providerOf(address) {
  const domain = String(address ?? "").toLowerCase().split("@")[1] ?? "";
  if (/^(icloud|me|mac)\.com$/.test(domain)) return "icloud";
  if (/^(gmail|googlemail)\.com$/.test(domain)) return "google";
  if (/^(outlook|hotmail|live|msn)\.[a-z.]+$/.test(domain)) return "microsoft";
  if (/^(yahoo|ymail)\.[a-z.]+$/.test(domain)) return "yahoo";
  return "other";
}

/** An app password as the services show it ("abcd efgh ijkl mnop"): the spaces are not part of it. */
export const cleanAppPassword = (v) => String(v ?? "").replace(/\s+/g, "");

// ---------- Slack and Zoom: the person's own app, connected with one Allow ----------

/**
 * The read scopes the Zoom app asks for at the Allow (the same list as src/zoom.ts ZOOM_USER_SCOPES; a test checks). Slack's app, its
 * manifest and its Create link are written by the server (GET /panel/api/slack/setup), since the redirect carries this Pako's port.
 */
export const ZOOM_SCOPES = ["meeting:read:list_meetings", "meeting:read:summary", "meeting:read:list_summaries",
  "cloud_recording:read:list_user_recordings", "cloud_recording:read:list_recording_files", "user:read:user"];

/** Which connections are one button in this Pako (GET /panel/api/connect/clients): only true counts; nothing from an older Pako. */
export function cleanClients(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return { slack: r.slack === true, zoom: r.zoom === true, microsoft: r.microsoft === true, google: r.google === true, gmail: r.gmail === true };
}

/** "Connected as …" from an account answer (GET /panel/api/slack/account, /panel/api/zoom/account), or "" when it says no one. */
export function accountLine(a) {
  if (!a || typeof a !== "object") return "";
  const text = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
  const user = text(a.user, 100);
  const team = text(a.team, 100);
  const email = text(a.email, 200);
  if (!user) return "";
  return team ? `${user} in ${team}` : email && email !== user ? `${user} (${email})` : user;
}

// ---------- leaving a wizard and coming back ----------

/** What a wizard keeps to be resumed: its step and the choices made (never a secret). */
export function resumable(state) {
  const out = {};
  for (const [id, w] of Object.entries(state ?? {})) {
    if (!CARDS.includes(id) || !w || typeof w !== "object") continue;
    const keep = { step: Number.isInteger(w.step) && w.step >= 0 && w.step < 10 ? w.step : 0 };
    if (typeof w.path === "string" && /^[a-z]{1,20}$/.test(w.path)) keep.path = w.path;
    if (typeof w.address === "string" && isEmail(w.address)) keep.address = w.address;
    if (typeof w.provider === "string" && /^[a-z]{1,20}$/.test(w.provider)) keep.provider = w.provider;
    out[id] = keep;
  }
  return out;
}
