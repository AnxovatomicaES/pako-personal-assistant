// Core and Labs: the one list of the parts of Pako that are experimental (docs/features.md, "Core and Labs").
//
// Core is what Pako promises: chat, memory and people, reminders, tasks and lists, the brief, follow-ups, mail, calendars, Slack, Zoom,
// Teams, Telegram, Gentle mode and the demo week. A lab depends on a service that can change under it without notice (a restaurant's web
// page, a phone provider, Meta's templates and a tunnel, a host of your own): it stays available, but is off for a new install and starts
// nothing while off (no timer, no port, no browser, no tunnel).
//
// Whether a lab is on, in this order:
//   1. PAKO_LABS names it (`PAKO_LABS=booking,calls`), or says `on` or `all`: on, and the panel cannot turn it off.
//   2. The panel's switch (Settings › Labs), kept in <PAKO_HOME>/config.json under "labs": on or off as chosen.
//   3. Grandfathered: an install that already set the lab up (its settings are there) keeps it on, with one line in the log. A lab's store
//      can only fill while its settings are there, so its settings say whether it was used.
//   4. Otherwise off.
// A switch takes effect at the next start: the panel restarts Pako (as the demo week does).

import { readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import express, { type Express, type Request, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { createLog } from "./log.ts";

const log = createLog("labs");

type Env = Record<string, string | undefined>;

export type LabId = "booking" | "calls" | "whatsapp" | "relay" | "companion";

export interface LabDef {
  id: LabId;
  name: string;
  /** One line: why it is in Labs. */
  why: string;
  /** The settings that say it was set up before Labs (any one, not empty). */
  settings: readonly string[];
  /** The settings page's cards that belong to it (src/panel/settings-model.js), hidden while it is off. */
  cards: readonly string[];
}

export const LABS: readonly LabDef[] = [
  {
    id: "booking",
    name: "Table booking",
    why: "Maître drives restaurant booking sites in a browser of its own, and breaks when a site changes its pages.",
    settings: ["GOOGLE_PLACES_API_KEY"],
    cards: ["tables"],
  },
  {
    id: "calls",
    name: "Phone calls",
    why: "Calls go through Retell or a LiveKit and Gemini voice worker: three providers, a SIP number and a server of your own.",
    settings: ["RETELL_API_KEY", "RETELL_FROM_NUMBER", "LIVEKIT_URL", "LIVEKIT_API_KEY", "VOICE_WORKER_URL"],
    cards: ["phone"],
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    why: "It needs a Meta developer app, approved templates and a public address (a tunnel or a server) for Meta's webhook.",
    settings: ["WHATSAPP_ACCESS_TOKEN"],
    cards: ["whatsapp"],
  },
  {
    id: "relay",
    name: "Pako Relay",
    why: "It needs a second, always-on host of your own that fires your reminders on Telegram while the computer sleeps.",
    settings: ["RELAY_URL", "RELAY_TOKEN"],
    cards: [],
  },
  {
    id: "companion",
    name: "Health diary, learning and weekly check-in",
    why: "The friend, health companion and teacher roles are new and the least tested parts of the assistant.",
    // Off by default before Labs had a list too (PAKO_LABS=on): nothing to grandfather.
    settings: [],
    cards: [],
  },
];

export const LAB_IDS: readonly LabId[] = LABS.map((l) => l.id);
const isLab = (v: string): v is LabId => (LAB_IDS as readonly string[]).includes(v);

/** The words the panel shows with every lab. */
export const LABS_NOTE = "Experimental: may break when the service changes.";

/** PAKO_LABS read: `on` or `all` is every lab; `off` or empty is none; otherwise the ids it names (an unknown one is said once). */
export function parseLabsSetting(raw: string | undefined): { ids: Set<LabId>; unknown: string[] } {
  const words = (raw ?? "").split(/[\s,]+/).map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (words.some((w) => w === "on" || w === "all" || w === "1")) return { ids: new Set(LAB_IDS), unknown: [] };
  const ids = new Set<LabId>();
  const unknown: string[] = [];
  for (const w of words) {
    if (w === "off" || w === "none" || w === "0") continue;
    if (isLab(w)) ids.add(w);
    else unknown.push(w);
  }
  return { ids, unknown };
}

export type LabSource = "env" | "panel" | "grandfathered" | "default";

export interface LabState {
  id: LabId;
  name: string;
  why: string;
  on: boolean;
  /** What decided it (see the top of this file). */
  source: LabSource;
}

export interface Labs {
  on(id: LabId): boolean;
  states(): LabState[];
  /** The ids that are on, for the assistant's context (src/door/context.ts labsOn). */
  enabled(): LabId[];
  /** The labs kept on only because they were set up before Labs. */
  grandfathered: LabId[];
}

export function resolveLabs(o: {
  env: Env;
  /** The panel's switches (readLabChoices); absent on a server, which has no panel for them. */
  choices?: Partial<Record<LabId, boolean>>;
  /** Set up somewhere other than the environment (a computer's WhatsApp is kept with the secrets, src/whatsapp-computer.ts). */
  setUp?: Partial<Record<LabId, boolean>>;
}): Labs {
  const fromEnv = parseLabsSetting(o.env.PAKO_LABS).ids;
  const states: LabState[] = LABS.map((l) => {
    const base = { id: l.id, name: l.name, why: l.why };
    if (fromEnv.has(l.id)) return { ...base, on: true, source: "env" as const };
    const chosen = o.choices?.[l.id];
    if (typeof chosen === "boolean") return { ...base, on: chosen, source: "panel" as const };
    const setUp = o.setUp?.[l.id] === true || l.settings.some((k) => (o.env[k] ?? "").trim() !== "");
    return setUp ? { ...base, on: true, source: "grandfathered" as const } : { ...base, on: false, source: "default" as const };
  });
  const byId = new Map(states.map((s) => [s.id, s]));
  return {
    on: (id) => byId.get(id)?.on === true,
    states: () => states.map((s) => ({ ...s })),
    enabled: () => states.filter((s) => s.on).map((s) => s.id),
    grandfathered: states.filter((s) => s.source === "grandfathered").map((s) => s.id),
  };
}

/** The one quiet line at start for the labs kept on because they were already set up; null when there is none. */
export function grandfatherNote(labs: Labs): string | null {
  return labs.grandfathered.length
    ? `kept on, set up before Labs: ${labs.grandfathered.join(", ")} (Settings › Labs turns each off)`
    : null;
}

// ---------- the panel's switches, in <PAKO_HOME>/config.json under "labs" ----------

const configPath = (dir: string): string => join(dir, "config.json");

function readConfig(dir: string): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(configPath(dir), "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    /* missing or not JSON: no switch set */
    return {};
  }
}

/** The switches set in the panel: only known ids with true or false. */
export function readLabChoices(dir: string): Partial<Record<LabId, boolean>> {
  const raw = readConfig(dir).labs;
  const out: Partial<Record<LabId, boolean>> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (isLab(k) && typeof v === "boolean") out[k] = v;
  }
  return out;
}

/** Keeps one switch, read again first so the other fields of config.json (the name, the welcome) stay. False when it could not write. */
export function writeLabChoice(dir: string, id: LabId, on: boolean): boolean {
  const c = readConfig(dir);
  const labs = c.labs && typeof c.labs === "object" && !Array.isArray(c.labs) ? { ...(c.labs as Record<string, unknown>) } : {};
  labs[id] = on;
  const tmp = `${configPath(dir)}.${process.pid}.labs.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ ...c, labs }, null, 2), { mode: 0o600 });
    renameSync(tmp, configPath(dir));
    try {
      chmodSync(configPath(dir), 0o600);
    } catch {
      /* a file system without modes */
    }
    return true;
  } catch (err) {
    log.error(`could not save the Labs switch (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    return false;
  }
}

// ---------- the panel's routes, on a person's computer ----------
//
//   GET  /panel/api/labs              -> { note, labs: [{ id, name, why, on, source, locked }] }
//   POST /panel/api/labs  { id, on }  -> { ok, restarting } | { error }
//
// Signed in, and on a POST the x-pako header another site cannot send. `locked`: PAKO_LABS decides it, and the switch cannot change it.

export interface LabsPanelDeps {
  signedIn: (req: Request) => boolean;
  labs: Labs;
  /** Where config.json is (PAKO_HOME; the demo week's own folder while it runs). */
  dir: string;
  /** Restarts Pako (src/server.ts app.locals.restart); absent: the switch applies at the next start. */
  restart?: () => boolean | void;
}

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

export function mountLabsPanel(app: Express, d: LabsPanelDeps): void {
  const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });
  const auth = (change: boolean): RequestHandler => (req, res, next) => {
    res.set(HEADERS);
    if (!d.signedIn(req) || (change && req.get("x-pako") !== "1")) return void res.status(401).json({ error: "sign in" });
    next();
  };
  app.get("/panel/api/labs", auth(false), limiter, (_req, res) => {
    res.json({ note: LABS_NOTE, labs: d.labs.states().map((s) => ({ ...s, locked: s.source === "env" })) });
  });
  app.post("/panel/api/labs", auth(true), limiter, express.json({ limit: "1kb" }), (req, res) => {
    const body = (req.body ?? {}) as { id?: unknown; on?: unknown };
    const id = typeof body.id === "string" && isLab(body.id) ? body.id : null;
    if (!id || typeof body.on !== "boolean") return void res.status(400).json({ error: "Which lab, and on or off?" });
    const now = d.labs.states().find((s) => s.id === id)!;
    if (now.source === "env") return void res.status(409).json({ error: "PAKO_LABS turns this one on; remove it there to change it here." });
    if (!writeLabChoice(d.dir, id, body.on)) return void res.status(500).json({ error: "I couldn't save that. Try again." });
    log.info(`${id} turned ${body.on ? "on" : "off"} in the panel`);
    const r = d.restart ?? (app.locals.restart as (() => boolean | void) | undefined);
    const restarting = body.on !== now.on && typeof r === "function";
    if (restarting) {
      res.on("finish", () => setTimeout(() => {
        if (r() === false) log.error("Pako could not start again by itself: stop it and start it again");
      }, 200).unref?.());
    }
    res.json({ ok: true, restarting });
  });
}
