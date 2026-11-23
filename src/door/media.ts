// The voice notes and papers the bridge fetches from the door, and the summaries of papers it hands back.

import { hidePaperCodes, paperName, PAPER_ID } from "../papers.ts";
import { TELEGRAM_MEDIA_ID } from "./deps.ts";
import { MEDIA_HOST, MEDIA_MAX, cut } from "./shared.ts";
import type { Door } from "./door.ts";
import { createLog } from "../log.ts";

const logWhatsapp = createLog("whatsapp");
const logPapers = createLog("papers");

export function mountMedia(door: Door): Pick<Door, "downloadMedia"> {
  const { app, d, config, f, now, lang, inbox, papers, paperSummaries, failed, bridge, json } = door;
  /**
   * A file the owner sent (a voice note, a photo, a PDF), fetched from Telegram or from WhatsApp with the token that only this server holds,
   * no bigger than `max`. Why not, as the status the bridge's media route answers with.
   */
  const downloadMedia = async (id: string, max: number): Promise<{ ok: true; bytes: Buffer; mime: string } | { ok: false; status: number; why: string }> => {
    if (TELEGRAM_MEDIA_ID.test(id)) {
      const file = d.telegram ? await d.telegram.media(id) : null;
      if (!file) return { ok: false, status: 502, why: "Telegram did not give the file" };
      if (file.bytes.length > max) return { ok: false, status: 413, why: "Too big" };
      return { ok: true, ...file };
    }
    try {
      const auth = { authorization: `Bearer ${config.accessToken}` };
      const info = await f(`https://graph.facebook.com/${config.graphVersion}/${id}`, { headers: auth, signal: AbortSignal.timeout(10_000) });
      const doc = info.ok ? ((await info.json().catch(() => ({}))) as { url?: string; mime_type?: string; file_size?: number }) : {};
      let host = "";
      try {
        const u = new URL(doc.url ?? "");
        host = u.protocol === "https:" ? u.hostname : "";
      } catch {
        /* not a URL: no host */
        host = "";
      }
      if (!doc.url || !MEDIA_HOST.test(host)) return { ok: false, status: 502, why: "WhatsApp did not give the file" };
      if (typeof doc.file_size === "number" && doc.file_size > max) return { ok: false, status: 413, why: "Too big" };
      const file = await f(doc.url, { headers: auth, signal: AbortSignal.timeout(30_000) });
      const bytes = file.ok ? Buffer.from(await file.arrayBuffer()) : null;
      if (!bytes) return { ok: false, status: 502, why: "WhatsApp did not give the file" };
      if (bytes.length > max) return { ok: false, status: 413, why: "Too big" };
      const mime = typeof doc.mime_type === "string" && /^[a-z]+\/[a-z0-9.+-]+/i.test(doc.mime_type) ? doc.mime_type.split(";")[0]! : "application/octet-stream";
      return { ok: true, bytes, mime };
    } catch (err) {
      logWhatsapp.error(`could not fetch a file the owner sent: ${(err as Error).message}`);
      return { ok: false, status: 502, why: "Could not fetch it" };
    }
  };

  /** The audio of a voice note the owner sent (still waiting in the inbox), fetched from WhatsApp with the token that only this server holds. */
  app.get("/assistant/media/:id", failed, bridge, async (req, res) => {
    const id = String(req.params.id ?? "");
    try {
      if (!(await inbox.peek()).some((m) => m.audio?.id === id)) {
        res.status(404).type("text").send("Not found");
        return;
      }
      const got = await downloadMedia(id, MEDIA_MAX);
      if (!got.ok) {
        res.status(got.status).type("text").send(got.why);
        return;
      }
      res.type(got.mime).send(got.bytes);
    } catch (err) {
      logWhatsapp.error(`could not fetch a voice note: ${(err as Error).message}`);
      res.status(502).type("text").send("Could not fetch it");
    }
  });

  /**
   * A paper the owner sent (src/papers.ts), still waiting in the inbox, for the bridge's isolated read: the bytes as they were checked, their
   * type as the bytes say. 404 when it is not kept here (a server restarted: the bridge asks the owner to send it again).
   */
  app.get("/assistant/paper/:id", failed, bridge, async (req, res) => {
    const id = String(req.params.id ?? "");
    try {
      const p = PAPER_ID.test(id) && (await inbox.peek()).some((m) => m.paper?.id === id) ? papers.get(id) : null;
      if (!p) {
        res.status(404).type("text").send("Not found");
        return;
      }
      res.set("X-Content-Type-Options", "nosniff").type(p.mime).send(p.bytes);
    } catch (err) {
      logPapers.error(`could not give one to the bridge: ${(err as Error).message}`);
      res.status(503).type("text").send("Try again");
    }
  });

  /**
   * What the bridge's isolated read made of a paper, kept a day for the assistant's context (the owner's "remind me of it" next). Its codes are
   * hidden here too, whatever the bridge did; Claude sees it later only as other people's text (assistant/bridge.ts contextBlock).
   */
  app.post("/assistant/paper-summary", failed, bridge, json, async (req, res) => {
    const b = (req.body ?? {}) as { name?: unknown; summary?: unknown };
    const summary = typeof b.summary === "string" ? cut(hidePaperCodes(b.summary.replace(/\s+/g, " ").trim(), lang()), 600) : "";
    if (!summary) {
      res.status(400).json({ error: "No summary." });
      return;
    }
    paperSummaries.push({ at: now(), name: paperName(b.name), summary });
    while (paperSummaries.length > 3) paperSummaries.shift();
    res.json({ ok: true });
  });

  return { downloadMedia };
}
