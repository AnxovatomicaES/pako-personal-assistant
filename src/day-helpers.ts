// "Around your day" in the panel's How Pako acts: the switches for what Pako says on its own around the owner's working day, for people
// who set Pako up from the Mac app and never see an environment variable. Each starts from its setting (SHUTDOWN, AFTER_MEETING,
// CALENDAR_ALERTS); a switch pressed in the panel is kept in the store and wins from then on.
//   - wrapUp: the evening wrap-up (src/shutdown.ts)
//   - afterMeeting: "did you promise anything?" after a meeting (src/after-meeting.ts)
//   - alerts: a meeting that moved or was called off, told at once (src/calendar-alerts.ts)
// GET and POST /panel/api/day-helpers ({ wrapUp?, afterMeeting?, alerts? } booleans), with the session and the x-pako header, like STOP.

import express, { type Express, type Request, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { readJsonRecord } from "./json-record.ts";
import type { Kv } from "./kv.ts";
import { createLog } from "./log.ts";

const log = createLog("day-helpers");

export const DAY_HELPERS_KEY = "day-helpers";
export const HELPERS = ["wrapUp", "afterMeeting", "alerts"] as const;
export type Helper = (typeof HELPERS)[number];
export type HelperState = Record<Helper, boolean>;

/** The words the panel shows for each switch (src/panel/acts.js asks for them with the state). */
export const HELPER_WORDS: Record<Helper, { label: string; description: string }> = {
  wrapUp: {
    label: "Evening wrap-up",
    description: "At the end of your working day: what's due next, whether it fits your calendar, double bookings and invitations to "
      + "answer. On the last working day of the week, the week too.",
  },
  afterMeeting: {
    label: "After a meeting, ask what you promised",
    description: "About ten minutes after a meeting with other people (not a Zoom call Pako reviews): one question, so promises made out "
      + "loud aren't lost. Two a day at most.",
  },
  alerts: {
    label: "Tell me when a meeting moves",
    description: "When a meeting in the next three days moves or is called off and you owe something at it, you hear it then, not only "
      + "in the next brief.",
  },
};

const stateOf = (v: unknown): Partial<HelperState> => {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const out: Partial<HelperState> = {};
  for (const k of HELPERS) if (typeof o[k] === "boolean") out[k] = o[k] as boolean;
  return out;
};

export function createDayHelpers(kv: Kv | null, defaults: HelperState) {
  let memory: Partial<HelperState> = {};
  const load = async (): Promise<Partial<HelperState>> => (kv ? stateOf((await readJsonRecord(kv, DAY_HELPERS_KEY)) ?? {}) : { ...memory });
  /** Each switch as it stands: the panel's choice, else its setting. */
  const view = async (): Promise<HelperState> => {
    const s = await load();
    return { wrapUp: s.wrapUp ?? defaults.wrapUp, afterMeeting: s.afterMeeting ?? defaults.afterMeeting, alerts: s.alerts ?? defaults.alerts };
  };
  /** Whether one is on now. A store that does not answer: its setting, so a hiccup neither silences nor wakes anything. */
  const on = async (k: Helper): Promise<boolean> => {
    try {
      return (await view())[k];
    } catch (err) {
      log.warn(`could not be read, its setting is used: ${(err as Error).message}`);
      return defaults[k];
    }
  };
  /** Keeps the switches given; the others stay as they are. */
  const set = async (change: Partial<HelperState>): Promise<HelperState> => {
    const s = { ...(await load()), ...stateOf(change) };
    memory = s;
    if (kv) await kv.set(DAY_HELPERS_KEY, JSON.stringify(s), 400 * 24 * 3600);
    return view();
  };
  return { view, on, set };
}
export type DayHelpers = ReturnType<typeof createDayHelpers>;

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" };

/** GET and POST /panel/api/day-helpers: the switches, with their words. */
export function mountDayHelpersPanel(app: Express, d: { signedIn: (req: Request) => boolean; helpers: () => DayHelpers | null }): void {
  const limit = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false });
  const auth = (change: boolean): RequestHandler => (req, res, next) => {
    res.set(HEADERS);
    if (!d.signedIn(req) || (change && req.get("x-pako") !== "1")) return void res.status(401).json({ error: "sign in" });
    if (!d.helpers()) return void res.status(404).json({ error: "off" });
    next();
  };
  const answer = (s: HelperState) => ({ ...s, words: HELPER_WORDS });
  app.get("/panel/api/day-helpers", auth(false), limit, async (_req, res) => {
    try {
      res.json(answer(await d.helpers()!.view()));
    } catch (err) {
      log.warn(`the store did not answer: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });
  app.post("/panel/api/day-helpers", auth(true), limit, express.json({ limit: "1kb" }), async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const change = stateOf(body);
    if (!Object.keys(change).length || Object.keys(body).some((k) => !(HELPERS as readonly string[]).includes(k) || typeof body[k] !== "boolean")) {
      return void res.status(400).json({ error: "send { wrapUp?, afterMeeting?, alerts? } as true or false" });
    }
    try {
      res.json(answer(await d.helpers()!.set(change)));
    } catch (err) {
      log.warn(`the store did not answer: ${(err as Error).message}`);
      res.status(503).json({ error: "store" });
    }
  });
}
