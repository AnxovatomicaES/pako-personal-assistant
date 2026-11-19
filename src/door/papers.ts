// A photo or a PDF from the owner (src/papers.ts): fetched, checked, kept and queued for the bridge's isolated read.

import { checkPaper, paperName, paperText, refuseEarly, PAPER_ID, PAPER_MAX, PaperStoreFull, type PaperKey } from "../papers.ts";
import { OFFLINE_AFTER_MS, OFFLINE_NOTICE_EVERY_MS } from "./shared.ts";
import type { Door } from "./door.ts";
import { createLog } from "../log.ts";

const log = createLog("papers");

export function mountPapers(door: Door): Pick<Door, "takePaper"> {
  const { lang, tx, inbox, papers, hearLanguage, sendText, dailyLimitReached } = door;
  /**
   * A photo or a PDF the owner sent: downloaded now (the token that fetches it stays here), looked at by what its bytes are and how big, kept
   * (src/papers.ts), and queued for the bridge, which reads it in an isolated run. A refusal is said at once in Pako's words, and nothing of
   * the file goes further. `text` stays empty in the inbox: an older bridge lets the item go (and is told to update, see /assistant/ack).
   */
  const takePaper = async (m: Record<string, unknown>, id: string, at: number): Promise<string> => {
    const refuse = async (key: PaperKey, outcome: string): Promise<string> => {
      await sendText(paperText(key, lang()));
      return outcome;
    };
    if (dailyLimitReached()) {
      await sendText(tx("tooMuchToday"));
      return "over the daily limit";
    }
    let kept: { id: string; mime: string; name: string };
    let caption = "";
    if (m.type === "paper") {
      // Put in the panel's chat: checked and kept by the upload already (mountPaperUpload); only an id this store holds is taken.
      const pid = String((m.paper as { id?: unknown } | undefined)?.id ?? "");
      const p = PAPER_ID.test(pid) ? papers.get(pid) : null;
      if (!p) return "paper not found";
      kept = { id: pid, mime: p.mime, name: p.name };
    } else {
      const f = (m[m.type as "image" | "document"] ?? {}) as { id?: unknown; mime_type?: unknown; filename?: unknown; caption?: unknown; file_size?: unknown };
      const mediaId = typeof f.id === "string" && /^[0-9A-Za-z_-]{5,64}$/.test(f.id) ? f.id : "";
      if (!mediaId) return "no media id";
      const early = refuseEarly(f.mime_type, f.file_size);
      if (early) return refuse(early, `paper refused (${early})`);
      const got = await door.downloadMedia(mediaId, PAPER_MAX);
      if (!got.ok) return refuse(got.status === 413 ? "big" : "fetch", "paper not fetched");
      const checked = checkPaper(got.bytes);
      if (!checked.ok) return refuse(checked.why, `paper refused (${checked.why})`);
      const name = paperName(f.filename);
      try {
        kept = { id: papers.put(got.bytes, checked.mime, name), mime: checked.mime, name };
      } catch (err) {
        log.error(`could not keep one: ${(err as Error).message}`);
        return err instanceof PaperStoreFull ? refuse("full", "paper not kept (too many waiting)") : refuse("unkept", "paper not kept");
      }
      caption = typeof f.caption === "string" ? f.caption.trim() : "";
    }
    // The words sent with it are the owner's (a forwarded file's are not: its own flag says so, and its language is not taken as theirs).
    if (caption) hearLanguage(caption, m);
    const fwd = m.context as { forwarded?: unknown; frequently_forwarded?: unknown } | undefined;
    const forwarded = fwd?.forwarded === true || fwd?.frequently_forwarded === true;
    const paper = { ...kept, ...(caption ? { caption } : {}) };
    if (!(await inbox.add({ id, at, text: "", paper, ...(forwarded ? { forwarded: true } : {}) }))) {
      if (m.type !== "paper") papers.done(kept.id);
      return "repeated";
    }
    if (at - door.lastPollAt > OFFLINE_AFTER_MS && at - door.lastOfflineNoticeAt > OFFLINE_NOTICE_EVERY_MS) {
      door.lastOfflineNoticeAt = at;
      await sendText(tx("offline"));
    }
    return "paper queued";
  };

  return { takePaper };
}
