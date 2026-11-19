// Meta's webhook: its check, the signature on every request, and the day's limit on the owner's messages.

import { createHmac } from "node:crypto";
import express, { type Request, type Response } from "express";
import { same, DAILY_MESSAGES, stampedNear, SIGNED_FRESH_MS } from "./shared.ts";
import type { Door } from "./door.ts";
import { createLog } from "../log.ts";

const log = createLog("whatsapp");

export function mountWebhook(door: Door): Pick<Door, "dailyLimitReached"> {
  const { app, d, config, now, dayStamps, handleStatus } = door;
  // ---------- Meta's webhook ----------

  const raw = express.json({
    limit: "256kb",
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = buf;
    },
  });

  app.get("/whatsapp/webhook", (req, res) => {
    const token = String(req.query["hub.verify_token"] ?? "");
    if (req.query["hub.mode"] === "subscribe" && token && same(token, config.verifyToken)) {
      res.status(200).type("text").send(String(req.query["hub.challenge"] ?? ""));
      return;
    }
    res.status(403).type("text").send("Forbidden");
  });

  const dailyLimitReached = (): boolean => {
    const t = now();
    while (dayStamps.length && t - dayStamps[0]! > 24 * 3600_000) dayStamps.shift();
    if (dayStamps.length >= DAILY_MESSAGES) return true;
    dayStamps.push(t);
    return false;
  };

  app.post("/whatsapp/webhook", raw, async (req: Request, res: Response) => {
    const body = (req as unknown as { rawBody?: Buffer }).rawBody;
    const given = String(req.get("x-hub-signature-256") ?? "");
    const expected = `sha256=${createHmac("sha256", config.appSecret).update(body ?? Buffer.alloc(0)).digest("hex")}`;
    if (!body || given.length !== expected.length || !same(given, expected)) {
      if (now() - door.lastBadSignatureLogAt > 60_000) {
        door.lastBadSignatureLogAt = now();
        log.error("a webhook was refused: its signature does not match WHATSAPP_APP_SECRET (is the secret copied exactly, from the same app?)");
      }
      res.status(401).type("text").send("Bad signature");
      return;
    }
    // Meta's, and stamped just now: only here may the request teach the server about itself (see onSigned). A mistake in what learns from it
    // must not stop the owner's messages, so it is only logged.
    if (d.onSigned && stampedNear(req.body, now(), SIGNED_FRESH_MS)) {
      try {
        d.onSigned(req);
      } catch (err) {
        log.error(`could not learn from a signed webhook: ${(err as Error).message}`);
      }
    }
    try {
      const doc = req.body as { object?: string; entry?: { changes?: { value?: Record<string, unknown> }[] }[] };
      if (doc.object !== "whatsapp_business_account") {
        res.status(200).type("text").send("ok");
        return;
      }
      const tally = new Map<string, number>();
      for (const entry of doc.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const v = change.value ?? {};
          if ((v.metadata as { phone_number_id?: string } | undefined)?.phone_number_id !== config.phoneNumberId) continue;
          for (const m of (Array.isArray(v.messages) ? v.messages : []) as Record<string, unknown>[]) {
            const outcome = await door.handleMessage(m);
            tally.set(outcome, (tally.get(outcome) ?? 0) + 1);
          }
          // Delivery news about the messages the assistant sent to friends (the ones about the owner's own chat are not worth a line).
          for (const st of (Array.isArray(v.statuses) ? v.statuses : []) as Record<string, unknown>[]) {
            const outcome = await handleStatus(st);
            if (outcome) tally.set(outcome, (tally.get(outcome) ?? 0) + 1);
          }
        }
      }
      if (tally.size) log.info(`webhook: ${[...tally].map(([what, n]) => `${n} ${what}`).join(", ")}`);
      res.status(200).type("text").send("ok");
    } catch (err) {
      // Not a 200: Meta delivers it again, and an id already seen is dropped then.
      log.error(`could not handle a webhook: ${(err as Error).message}`);
      res.status(500).type("text").send("Try again");
    }
  });

  return { dailyLimitReached };
}
