// One look at every connection, for the connections page and the Health card: is it connected, does it need something from the person, is it
// not set up, or is it failing, since when, and the one thing to do next. It reads what is already known, and asks no service anything:
// - the settings (src/connections.ts: every required value set, or some, or none) and what a running connection says is wrong (IMAP's login);
// - the watchdog (src/watchdog.ts), which already follows each part's rounds: a part "down" is an error, "failing" needs a look;
// - Telegram's pairing, this Mac's calendars (src/calendar-local.ts) and imported contacts (src/contacts.ts);
// - what the Mac found (src/discovery.ts), for the suggestion: "You have 3 calendars on this Mac: pick which ones...".
//
//   GET /panel/api/connections/status -> { connections: [{ id, name, state, detail, lastCheck, suggestion }], discovered }
// state: "connected" | "needsAction" | "notSet" | "error"; lastCheck: ms or null; detail and suggestion in English ("" when none).

import type { Express } from "express";
import { guard, limit, localOnly, type RouteAuth } from "./connect-routes.ts";
import { appliedAtStart, type ConnectionId, connectionStates, readStored } from "./connections.ts";
import type { Discovery, DiscoveryStore } from "./discovery.ts";
import { texts, type Lang } from "./i18n.ts";
import type { HealthState, PartKey, PartState } from "./watchdog.ts";

type Env = Record<string, string | undefined>;

export type StatusId = ConnectionId | "macCalendar" | "contacts";
export type State = "connected" | "needsAction" | "notSet" | "error";

export interface ConnectionStatus {
  id: StatusId;
  name: string;
  state: State;
  detail: string;
  lastCheck: number | null;
  suggestion: string;
}

const T = texts(
  {
    macCalendar: "This Mac's calendars",
    contacts: "This Mac's contacts",
    look: "Let Pako look at what's on this Mac and connect it in one click.",
    calendars: "You have {n} calendars on this Mac: pick which ones and Pako reads them by itself.",
    mail: "Use {address}? Only an app password is missing.",
    zoomLocal: "Zoom is on this Mac: Pako can review the meetings you record here.",
    zoomApp: "Zoom is on this Mac: connect your account in three steps for the cloud's summaries.",
    slack: "Slack is on this Mac: create Pako's app in one click and paste two keys.",
    telegram: "Telegram is on this Mac: make your bot in a minute and pair your phone with one tap.",
    contactsFound: "You have {n} contacts on this Mac: import them and Pako will know who's who.",
    pair: "Your phone isn't paired yet: tap the link, then “Start”.",
    partial: "Some values are missing: fill them in to make it work.",
    stale: "The Mac hasn't sent your events for a while: open the Pako app.",
    failing: "Something is failing: see the detail and try again.",
    down: "It isn't working: check the connection's values.",
    events: "{n} events from {c} calendars",
    people: "{n} contacts",
    paired: "Paired",
  },
);

/** The watchdog's part (or parts) for each connection. */
const PARTS: Partial<Record<StatusId, PartKey[]>> = {
  claude: ["claude"], calendar: ["calendar"], macCalendar: ["calendar"], mail: ["mail"], imap: ["imap"], slack: ["slack", "slackEvents"],
  zoom: ["zoom"], teams: ["teams"], telegram: ["telegram"],
};

export interface StatusInputs {
  env: Env;
  stored: Record<string, string> | null;
  fromStore: ReadonlySet<string>;
  lang: Lang;
  problems?: Partial<Record<ConnectionId, string | null>>;
  health?: HealthState | null;
  discovery?: Discovery | null;
  telegram?: "paired" | "unpaired" | "no-token" | null;
  macCalendar?: { at: number; calendars: number; events: number } | null;
  contacts?: number;
  /** Claude's own line from the connect flow (src/claude-connect.ts claudeStatusLine): who is signed in, on which plan, or what is missing. */
  claude?: { state: "connected" | "needsAction"; detail: string } | null;
  now: number;
}

const STALE_MS = 30 * 60_000;

/** Every connection's status, from what is known now. */
export function connectionsStatus(i: StatusInputs): ConnectionStatus[] {
  const say = T(i.lang);
  const found = i.discovery ?? null;
  const parts = new Map((i.health?.parts ?? []).map((p) => [p.key, p] as [PartKey, PartState]));
  const watched = (id: StatusId): PartState[] => (PARTS[id] ?? []).map((k) => parts.get(k)).filter((p): p is PartState => !!p);
  const lastCheck = (ps: PartState[]): number | null => {
    const times = ps.flatMap((p) => [p.okAt, p.failSince]).filter((t): t is number => typeof t === "number");
    return times.length ? Math.max(...times) : null;
  };
  /** The watchdog's word on a part that is set up: an incident is an error, failures not yet one need a look. */
  const byHealth = (ps: PartState[]): { state: State; detail: string } | null => {
    const down = ps.find((p) => p.status === "down");
    if (down) return { state: "error", detail: down.detail };
    const bad = ps.find((p) => p.status === "failing" || p.status === "warn");
    return bad ? { state: "needsAction", detail: bad.detail } : null;
  };
  const offer = (id: StatusId): string => {
    if (!found) return id === "claude" || id === "mail" || id === "tables" || id === "resend" ? "" : say("look");
    if (id === "calendar" || id === "macCalendar") return found.calendars.length ? say("calendars", { n: found.calendars.length }) : "";
    if (id === "imap") return found.mailAccounts[0] ? say("mail", { address: found.mailAccounts[0].address }) : "";
    if (id === "zoom") return found.zoomRecordings ? say("zoomLocal") : found.apps.zoom ? say("zoomApp") : "";
    if (id === "slack") return found.apps.slack ? say("slack") : "";
    if (id === "telegram") return found.apps.telegram ? say("telegram") : "";
    if (id === "contacts") return found.contacts.count ? say("contactsFound", { n: found.contacts.count }) : "";
    return "";
  };

  const out: ConnectionStatus[] = connectionStates({
    env: i.env, stored: i.stored, fromStore: i.fromStore, lang: i.lang, ...(i.problems ? { problems: i.problems } : {}),
  }).map((c) => {
    const ps = watched(c.id);
    const base = { id: c.id as StatusId, name: c.name, lastCheck: lastCheck(ps) };
    if (c.id === "telegram") {
      const tg = i.telegram ?? "no-token";
      if (tg === "no-token") return { ...base, state: "notSet", detail: "", suggestion: offer("telegram") };
      if (tg === "unpaired") return { ...base, state: "needsAction", detail: "", suggestion: say("pair") };
      const h = byHealth(ps);
      return { ...base, state: h?.state ?? "connected", detail: h?.detail ?? say("paired"), suggestion: h ? say(h.state === "error" ? "down" : "failing") : "" };
    }
    if (c.problem) return { ...base, state: "error", detail: c.problem, suggestion: say("down") };
    // Claude's sign-in as the connect flow last saw it, unless an API key is set (then the key's state below says it).
    if (c.id === "claude" && i.claude && c.state === "off") {
      const h = byHealth(ps);
      if (i.claude.state === "connected" && h) return { ...base, state: h.state, detail: h.detail, suggestion: say(h.state === "error" ? "down" : "failing") };
      return { ...base, state: i.claude.state, detail: i.claude.detail, suggestion: "" };
    }
    // Claude needs nothing set (the plan's sign-in is the default): its part says how it is.
    if (c.state === "off" && c.id !== "claude") return { ...base, state: "notSet", detail: "", suggestion: offer(c.id) };
    if (c.state === "partial") return { ...base, state: "needsAction", detail: "", suggestion: say("partial") };
    const h = byHealth(ps);
    return { ...base, state: h?.state ?? "connected", detail: h?.detail ?? "", suggestion: h ? say(h.state === "error" ? "down" : "failing") : "" };
  });

  const mac = i.macCalendar ?? null;
  const macParts = watched("macCalendar");
  if (!mac || !mac.calendars) {
    out.push({ id: "macCalendar", name: say("macCalendar"), state: "notSet", detail: "", lastCheck: null, suggestion: offer("macCalendar") });
  } else {
    const stale = i.now - mac.at > STALE_MS;
    out.push({
      id: "macCalendar",
      name: say("macCalendar"),
      state: stale ? "needsAction" : "connected",
      detail: say("events", { n: mac.events, c: mac.calendars }),
      lastCheck: Math.max(mac.at, lastCheck(macParts) ?? 0),
      suggestion: stale ? say("stale") : "",
    });
  }
  const n = i.contacts ?? 0;
  out.push({
    id: "contacts",
    name: say("contacts"),
    state: n ? "connected" : "notSet",
    detail: n ? say("people", { n }) : "",
    lastCheck: null,
    suggestion: n ? "" : offer("contacts"),
  });
  return out;
}

export interface StatusPanelDeps extends RouteAuth {
  env: Env;
  lang: () => Lang;
  dir: string;
  fromStore?: () => ReadonlySet<string>;
  problems?: (l: Lang) => Partial<Record<ConnectionId, string | null>>;
  health?: () => HealthState;
  discovery?: DiscoveryStore;
  telegram?: () => Promise<"paired" | "unpaired" | "no-token">;
  macCalendar?: () => Promise<{ at: number; calendars: number; events: number } | null>;
  contacts?: () => Promise<number>;
  claude?: (l: Lang) => { state: "connected" | "needsAction"; detail: string } | null;
  now?: () => number;
}

const PATHS = ["/panel/api/connections/status"];

export function mountConnectionsStatus(app: Express, d: StatusPanelDeps | null): void {
  if (!d) return localOnly(app, PATHS);
  const now = d.now ?? Date.now;
  app.get(PATHS[0]!, guard(d, false), limit(120), async (_req, res) => {
    const l = d.lang();
    // Each piece is best effort: a store that does not answer leaves that line as "not set", the page still shows the rest.
    const [discovery, telegram, macCalendar, contacts] = await Promise.all([
      d.discovery ? d.discovery.read().catch(() => null) : Promise.resolve(null),
      d.telegram ? d.telegram().catch(() => null) : Promise.resolve(null),
      d.macCalendar ? d.macCalendar().catch(() => null) : Promise.resolve(null),
      d.contacts ? d.contacts().catch(() => 0) : Promise.resolve(0),
    ]);
    const connections = connectionsStatus({
      env: d.env,
      stored: readStored(d.dir),
      fromStore: (d.fromStore ?? appliedAtStart)(),
      lang: l,
      ...(d.problems ? { problems: d.problems(l) } : {}),
      health: d.health?.() ?? null,
      discovery,
      telegram,
      macCalendar,
      contacts,
      ...(d.claude ? { claude: d.claude(l) } : {}),
      now: now(),
    });
    res.json({ connections, discovered: !!discovery });
  });
}
