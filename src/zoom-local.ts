// The Zoom meetings recorded on this Mac, for the meeting review (src/meeting-review.ts), with no Zoom app to create: Zoom keeps each local
// recording in a folder of its own ("2026-11-16 10.00.00 Weekly sync 123456789") in the recordings folder the Mac app found (Documents/Zoom
// by default), with the captions when they were on (closed_caption.txt, meeting_saved_closed_caption.txt) or a transcript (.vtt).
//
// Only after the person said yes to the discovery (the folder comes from it, src/discovery.ts), only inside their home folder, only the
// caption and transcript files (never the audio or the video), only meetings of the last two days, each once. The text goes to the assistant's
// inbox exactly as a cloud transcript does (src/zoom.ts): the Mac reviews it in an isolated run and the owner hears only their own to-dos.
// Which folders were already read is kept under "zoom-local" (their names' hashes only), 60 days.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { Control } from "./control.ts";
import type { DiscoveryStore } from "./discovery.ts";
import { locale, texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import type { InboundReview } from "./meeting-review.ts";
import type { Inbound } from "./whatsapp.ts";
import { localToEpoch } from "./whatsapp.ts";
import { vttToText } from "./zoom.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";

const log = createLog("zoom");

export const ZOOM_LOCAL_KEY = "zoom-local";
const KEEP_SECONDS = 60 * 24 * 3600;
const WINDOW_MS = 2 * 24 * 3600_000;
/** A meeting still being recorded (its folder changed in the last ten minutes) waits for the next look. */
const SETTLE_MS = 10 * 60_000;
const FILE_MAX = 2 * 1024 * 1024;
const SEEN_MAX = 300;

const T = texts({
  noTitle: "(no title)",
  logRead: "Zoom recording on this Mac sent to be reviewed: “{topic}”",
});

/** Zoom's caption file as plain lines: "[Ana Garcia] 10:00:03" then what she said becomes "Ana Garcia: ...". */
export function captionsToText(raw: string): string {
  const out: string[] = [];
  let who = "";
  for (const l of raw.split(/\r?\n/)) {
    const head = /^\s*\[([^\]]{1,80})\]\s+\d{1,2}:\d{2}(:\d{2})?\s*$/.exec(l) ?? /^\s*\d{1,2}:\d{2}:\d{2}\s+From\s+(.{1,80}?)\s*:\s*$/i.exec(l);
    if (head) {
      who = head[1]!.trim();
      continue;
    }
    const text = l.trim();
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && who && last.startsWith(`${who}: `)) out[out.length - 1] = `${last} ${text}`;
    else out.push(who ? `${who}: ${text}` : text);
  }
  return out.join("\n");
}

/** "2026-11-16 10.00.00 Weekly sync 123456789": the start in the owner's zone and the topic (the meeting number dropped). */
export function folderMeeting(name: string, timeZone: string): { at: number; topic: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2})\.(\d{2})\.(\d{2})\s*(.*?)(?:\s+\d{9,12})?$/.exec(name);
  if (!m) return null;
  const at = localToEpoch(`${m[1]} ${m[2]}:${m[3]}`, timeZone);
  return at === null ? null : { at, topic: m[5]!.replace(/\s+/g, " ").trim().slice(0, 120) };
}

/**
 * The meeting's words from the files in its folder: a transcript first, then the captions. "" when there are none. `settledBefore`: a file
 * written to after this time is still being written (Zoom adds to the captions file as people speak, which leaves the folder's own time
 * alone): "" too, so it waits for the next look instead of a half meeting being read and marked done.
 */
export function folderText(dir: string, files: string[], settledBefore = Infinity): string {
  const pick = files.find((f) => /\.vtt$/i.test(f)) ?? files.find((f) => /closed_caption.*\.txt$/i.test(f)) ?? files.find((f) => /transcript.*\.txt$/i.test(f));
  if (!pick) return "";
  const path = join(dir, pick);
  const st = statSync(path);
  if (!st.isFile() || st.size > FILE_MAX || st.mtimeMs > settledBefore) return "";
  const raw = readFileSync(path, "utf8");
  return /\.vtt$/i.test(pick) ? vttToText(raw) : captionsToText(raw);
}

export interface ZoomLocalDeps {
  discovery: DiscoveryStore;
  kv: Kv;
  timeZone: string;
  /** The assistant's inbox (src/whatsapp.ts): the transcript goes there as a cloud one does. */
  enqueue: (m: Inbound) => Promise<boolean>;
  /** The meeting review's head for a transcript (src/meeting-review.ts transcript), when the review is on. */
  review?: (m: { id: string; topic: string; at: number }) => Promise<InboundReview | null>;
  control?: Control;
  lang?: () => Lang;
  now?: () => number;
  /** The person's home folder: the recordings folder must be inside it. */
  home?: string;
}

export function createZoomLocal(d: ZoomLocalDeps) {
  const now = d.now ?? Date.now;
  const lang = d.lang ?? ((): Lang => "en");
  const home = d.home ?? homedir();
  const hash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 24);
  const seenRead = async (): Promise<string[]> => {
    const raw = await readJsonRecord(d.kv, ZOOM_LOCAL_KEY);
    try {
      const p = raw ? (raw as { seen?: unknown }) : {};
      return Array.isArray(p.seen) ? p.seen.filter((x): x is string => typeof x === "string") : [];
    } catch {
      /* not JSON: none seen */
      return [];
    }
  };
  const when = (at: number, l: Lang) =>
    new Intl.DateTimeFormat(locale(l), { timeZone: d.timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(at);

  /** The recordings folder, if the person shared one and it is a real folder inside their home (a link out of it is not followed). */
  const folder = async (): Promise<string | null> => {
    const found = await d.discovery.read().catch(() => null);
    const raw = found?.zoomRecordings?.folder;
    if (!raw) return null;
    try {
      const real = realpathSync(raw);
      const root = realpathSync(home);
      return real.startsWith(root + sep) && statSync(real).isDirectory() ? real : null;
    } catch {
      /* not there, or outside home: none */
      return null;
    }
  };

  let polling = false;
  const poll = async (): Promise<number> => {
    if (polling) return 0;
    polling = true;
    try {
      const dir = await folder();
      if (!dir) return 0;
      const t = now();
      const seen = await seenRead();
      let queued = 0;
      for (const name of readdirSync(dir).sort()) {
        const meeting = folderMeeting(name, d.timeZone);
        if (!meeting || t - meeting.at > WINDOW_MS || meeting.at > t) continue;
        const id = hash(name);
        if (seen.includes(id)) continue;
        const path = join(dir, name);
        // One folder that cannot be read (its permissions, a file gone between the listing and the read) is left for the next look: it must
        // not stop the meetings after it from ever being read.
        let transcript: string;
        try {
          const st = statSync(path);
          if (!st.isDirectory() || t - st.mtimeMs < SETTLE_MS) continue;
          transcript = folderText(path, readdirSync(path), t - SETTLE_MS);
        } catch (err) {
          log.error(`a recording folder could not be read: ${(err as NodeJS.ErrnoException).code ?? (err as Error).name}`);
          continue;
        }
        if (!transcript.trim()) continue;
        const l = lang();
        const topic = meeting.topic || T(l)("noTitle");
        const review = d.review ? await d.review({ id: `local-${id}`, topic, at: meeting.at }) : null;
        const ok = await d.enqueue({ id: `zoom:local-${id}`, at: meeting.at, text: "", meeting: { topic, when: when(meeting.at, l), transcript }, ...(review ? { review } : {}) });
        if (!ok) continue;
        seen.push(id);
        await d.kv.set(ZOOM_LOCAL_KEY, JSON.stringify({ seen: seen.slice(-SEEN_MAX) }), KEEP_SECONDS);
        d.control?.log("zoom", T(l)("logRead", { topic }));
        queued++;
      }
      return queued;
    } finally {
      polling = false;
    }
  };

  return {
    poll,
    forget: () => d.kv.set(ZOOM_LOCAL_KEY, "", 1),
    start: () => {
      setInterval(() => void poll().catch((err) => log.error(`this Mac's recordings: ${(err as Error).name}`)), 10 * 60_000).unref?.();
    },
  };
}
