// The relay to Pako's Mac helper (desktop/mac/helper, npm run mac-helper): for a Pako run from the Terminal, the panel in a browser asks
// the helper what it would ask the Mac app (src/panel/settings-model.js askApp: a look, the calendars chosen, the contacts imported,
// Reminders), and the helper's answer comes back as the app's would.
//   GET  /panel/api/helper          -> { here }                                  the panel: a helper asked for work in the last minute
//   POST /panel/api/helper/ask      { message, want? } -> { value }              the panel; waits for the answer called `want` (2 min at
//                                                                                most; none: { value: null }); no `want`: sent, not waited
//   POST /panel/api/helper/next     -> { asks: [{ id, message }] }               the helper; held up to 25 s while there is nothing to ask
//   POST /panel/api/helper/answer   { id, fn, value }                            the helper: one answer to one ask
// The helper's own calls carry the bridge token (src/connect-routes.ts fromApp), the panel's its session and the x-pako header. Everything
// else the helper sends goes to the routes the Mac app uses (discovery, calendar/local, calendar/writes, people/import, reminders/local).

import { randomBytes } from "node:crypto";
import express, { type Express } from "express";
import { fromApp, guard, HEADERS, limit, localOnly, type RouteAuth } from "./connect-routes.ts";

const PATHS = ["/panel/api/helper", "/panel/api/helper/ask", "/panel/api/helper/next", "/panel/api/helper/answer"];
/** A helper that has not asked for work in this long is gone (it asks again within 25 s while it runs). */
const HERE_MS = 60_000;
const ASK_MS = 120_000;

interface Ask {
  id: string;
  message: unknown;
  want: string;
  done: (value: unknown) => void;
}

export function mountMacHelper(app: Express, d: (RouteAuth & { now?: () => number; holdMs?: number }) | null): void {
  if (!d) return localOnly(app, PATHS);
  const now = d.now ?? Date.now;
  const queue: { id: string; message: unknown }[] = [];
  const waiting = new Map<string, Ask>();
  let seenAt = -Infinity;
  /** The helper's held request: answered at once when an ask comes. */
  let held: ((asks: { id: string; message: unknown }[]) => void) | null = null;
  const helperOnly: express.RequestHandler = (req, res, next) => {
    res.set(HEADERS);
    if (fromApp(req, d.appToken)) return next();
    res.status(401).json({ error: "helper only" });
  };

  app.get(PATHS[0]!, guard(d, false), limit(120), (_req, res) => void res.json({ here: now() - seenAt < HERE_MS }));

  app.post(PATHS[1]!, guard(d, true), limit(60), express.json({ limit: "16kb" }), (req, res) => {
    const { message, want } = (req.body ?? {}) as { message?: unknown; want?: unknown };
    if (!message || typeof message !== "object" || (want !== undefined && (typeof want !== "string" || !/^pako[A-Za-z]{1,30}$/.test(want)))) {
      return void res.status(400).json({ error: "bad" });
    }
    if (now() - seenAt >= HERE_MS) return void res.json({ value: null });
    const id = randomBytes(9).toString("base64url");
    queue.push({ id, message });
    if (typeof want === "string") {
      const timer = setTimeout(() => finish(null), ASK_MS);
      const finish = (value: unknown) => {
        clearTimeout(timer);
        waiting.delete(id);
        if (!res.headersSent) res.json({ value });
      };
      waiting.set(id, { id, message, want, done: finish });
      res.on("close", () => waiting.delete(id));
    } else res.json({ value: null });
    held?.(queue.splice(0));
  });

  app.post(PATHS[2]!, helperOnly, limit(30), (req, res) => {
    seenAt = now();
    held?.([]);
    if (queue.length) return void res.json({ asks: queue.splice(0) });
    const timer = setTimeout(() => send([]), d.holdMs ?? 25_000);
    const send = (asks: { id: string; message: unknown }[]) => {
      clearTimeout(timer);
      if (held === send) held = null;
      seenAt = now();
      if (!res.headersSent) res.json({ asks });
    };
    held = send;
    req.on("close", () => {
      if (held === send) held = null;
      clearTimeout(timer);
    });
  });

  app.post(PATHS[3]!, helperOnly, limit(120), express.json({ limit: "4mb" }), (req, res) => {
    const { id, fn, value } = (req.body ?? {}) as { id?: unknown; fn?: unknown; value?: unknown };
    const ask = typeof id === "string" ? waiting.get(id) : undefined;
    if (ask && fn === ask.want) ask.done(value ?? null);
    res.json({ ok: true });
  });
}
