// The owner's Zoom, read only, through one of two kinds of Zoom app, both with read scopes only (developers.zoom.us):
//
// - The person's own General app, connected from the panel (src/connect-setup.ts). It uses Zoom's public-client OAuth with PKCE, so there
//   is no secret anywhere: only the app's Client ID and the refresh token Zoom gave at the person's Allow (ZOOM_CLIENT_ID, ZOOM_REFRESH_TOKEN).
//   Zoom replaces the refresh token at every refresh and the old one stops working, so each new one is kept at once (`keepRefresh`).
// - A Server-to-Server OAuth app on the company account (ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, ZOOM_USER). This is what a
//   server, or an admin who prefers it, set up before; it keeps working as it did.
//
// - Coming meetings: listed for the owner's ZOOM command and the assistant's context.
// - After a meeting: if Zoom's AI Companion wrote a summary, it is reviewed (src/meeting-review.ts): the Mac reads it in an isolated run and
//   the owner hears only their own to-dos. Without the review (ZOOM_REVIEW=off, an older bridge, no answer in time) the owner gets the summary
//   as it is, as before. If there is only a cloud recording transcript, it goes to the Mac, which reviews it the same way (a newer bridge) or
//   summarizes it (assistant/bridge.ts, MEETING_PROMPT) and tells the owner (an older one).
// - Polled every few minutes (ZOOM_POLL_MINUTES, 10 by default): no webhook is needed, so a computer at home with no public address finds
//   the summaries and recordings as a server does. Each listing reaches back to the last good one (at least two days, at most fourteen), so a
//   computer that was off or asleep over a weekend still finds Friday's meetings; what was already told is never told again (`seen`).
//   The first listing only marks what is already there. What people said is information, never instructions.

import type { Control } from "./control.ts";
import { locale, texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import type { InboundReview } from "./meeting-review.ts";
import type { Inbound } from "./whatsapp.ts";
import type { HealthReport } from "./watchdog.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";
import { waitLeft } from "./clock.ts";

const log = createLog("zoom");

type Env = Record<string, string | undefined>;

/** What the owner reads about their meetings (ZOOM, Zoom's own summary, the log) and the lines the assistant gets. */
const T = texts(
  {
    noTitle: "(no title)",
    topic: "“{topic}”",
    noText: "(Zoom gave no text in the summary)",
    logSummary: "Summary of the meeting “{topic}”",
    logTranscript: "Transcript of “{topic}” sent to be summarized",
    logReview: "Summary of “{topic}” sent to be reviewed",
  },
);

export interface ZoomConfig {
  /** "user": the person's own app, connected with their Allow (PKCE, no secret). "s2s" (or absent): a Server-to-Server app. */
  mode?: "user" | "s2s";
  accountId: string;
  clientId: string;
  clientSecret: string;
  /** The refresh token of the person's own app ("user" mode); "" for a Server-to-Server app. */
  refreshToken?: string;
  /** The owner's Zoom user (their email). A Server-to-Server app cannot use "me"; the person's own app reads "me", and this is only shown. */
  user: string;
  pollMinutes: number;
}

/**
 * The read scopes the person's own app asks for at the Allow, in Zoom's granular user-level names. They cover their meetings, their AI
 * Companion summaries, their cloud recordings and transcripts, and who they are (for "Connected as"). Kept here so the manifest, the docs
 * and the code agree.
 */
export const ZOOM_USER_SCOPES = [
  "meeting:read:list_meetings",
  "meeting:read:summary",
  "meeting:read:list_summaries",
  "cloud_recording:read:list_user_recordings",
  "cloud_recording:read:list_recording_files",
  "user:read:user",
];

/** The read scopes a Server-to-Server app needs, in Zoom's granular account-level names. */
export const ZOOM_SCOPES = [
  "meeting:read:list_meetings:admin",
  "meeting:read:summary:admin",
  "meeting:read:list_summaries:admin",
  "cloud_recording:read:list_user_recordings:admin",
  "cloud_recording:read:list_recording_files:admin",
];

const API = "https://api.zoom.us/v2";
const STATE_KEY = "zoom-state";
// Up to fourteen days of meetings, two ids each (summary and recording): kept generously, so none still in the window is forgotten and told again.
const SEEN_KEEP = 1000;
const SUMMARIES_KEEP = 20;
/** A transcript waits this long after the recording ends, in case Zoom's own summary comes (it is preferred). */
const TRANSCRIPT_WAIT_MS = 30 * 60_000;
/** How far back a listing reaches: at least two days, back to the last good listing (an hour more), never more than fourteen. */
const LOOK_MIN_MS = 2 * 24 * 3600_000;
const LOOK_MAX_MS = 14 * 24 * 3600_000;
export const lookBack = (t: number, polledAt: number | undefined): number =>
  Math.max(t - LOOK_MAX_MS, Math.min(t - LOOK_MIN_MS, (polledAt ?? t) - 3600_000));

export function loadZoomConfig(env: Env): { config: ZoomConfig | null; problems: string[] } {
  const accountId = (env.ZOOM_ACCOUNT_ID ?? "").trim();
  const clientId = (env.ZOOM_CLIENT_ID ?? "").trim();
  const clientSecret = (env.ZOOM_CLIENT_SECRET ?? "").trim();
  const refreshToken = (env.ZOOM_REFRESH_TOKEN ?? "").trim();
  const user = (env.ZOOM_USER ?? "").trim();
  if (!accountId && !clientId && !clientSecret && !refreshToken && !user) return { config: null, problems: [] };
  const problems: string[] = [];
  // A refresh token means the person's own app, connected from the panel: no account, no secret, and the user is "me".
  const mode = refreshToken ? "user" : "s2s";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) problems.push("ZOOM_CLIENT_ID must be the app's Client ID");
  if (mode === "user") {
    if (!/^[A-Za-z0-9._-]{16,2000}$/.test(refreshToken)) problems.push("ZOOM_REFRESH_TOKEN must be the refresh token from connecting Zoom in the panel");
    if (user && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) problems.push("ZOOM_USER must be the owner's Zoom email");
  } else {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(accountId)) problems.push("ZOOM_ACCOUNT_ID must be the app's Account ID");
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(clientSecret)) problems.push("ZOOM_CLIENT_SECRET must be the app's Client Secret");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) problems.push("ZOOM_USER must be the owner's Zoom email");
  }
  const raw = (env.ZOOM_POLL_MINUTES ?? "").trim();
  const pollMinutes = raw === "" ? 10 : Number(raw);
  if (!Number.isInteger(pollMinutes) || pollMinutes < 2 || pollMinutes > 1440) problems.push("ZOOM_POLL_MINUTES must be a whole number from 2 to 1440");
  return problems.length
    ? { config: null, problems }
    : { config: { mode, accountId, clientId, clientSecret, refreshToken, user: user || "me", pollMinutes }, problems };
}

/** Zoom asks for a meeting UUID that starts with "/" or holds "//" to be encoded twice. */
export const encodeUuid = (uuid: string): string => (uuid.startsWith("/") || uuid.includes("//") ? encodeURIComponent(encodeURIComponent(uuid)) : encodeURIComponent(uuid));

/** A WebVTT transcript as plain lines, "Speaker: words", one speaker's consecutive cues joined. */
export function vttToText(vtt: string): string {
  const out: { who: string; text: string }[] = [];
  for (const line of vtt.replace(/\r/g, "").split("\n")) {
    const l = line.trim();
    if (!l || l === "WEBVTT" || /^\d+$/.test(l) || /-->/.test(l) || /^NOTE\b/.test(l)) continue;
    const m = /^([^:]{1,60}):\s+(.*)$/.exec(l);
    const who = m ? m[1]!.trim() : "";
    const text = (m ? m[2]! : l).trim();
    const last = out.at(-1);
    if (last && last.who === who) last.text += ` ${text}`;
    else out.push({ who, text });
  }
  return out.map((o) => (o.who ? `${o.who}: ${o.text}` : o.text)).join("\n");
}

/** Zoom's markdown summary made plain for WhatsApp: no headings or bold, list items as "• ". */
export function plainSummary(md: string): string {
  return md
    .replace(/\r/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/^[ \t]*[-*][ \t]+/gm, "• ")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1: $2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface DoneMeeting {
  id: string;
  at: number;
  topic: string;
  summary: string;
}

interface ZoomState {
  seen: string[];
  /** What older versions saved when both sources had had their first listing. */
  primed: boolean;
  /** Each source's own first good listing (the meetings already there were marked seen, not announced). */
  primedSummaries?: boolean;
  primedTranscripts?: boolean;
  done: DoneMeeting[];
  /** When the last listing in which both sources answered began: the next one reaches back to it (a computer that was off). */
  polledAt?: number;
}

export interface ZoomDeps {
  config: ZoomConfig;
  kv: Kv | null;
  timeZone: string;
  /** Tells the owner (src/whatsapp.ts notifyOwner). */
  notify: (text: string) => Promise<unknown>;
  /** The owner's assistant inbox: a transcript goes there for the Mac to summarize. */
  enqueue: (m: Inbound) => Promise<boolean>;
  control?: Control;
  fetch?: typeof fetch;
  now?: () => number;
  /** The language of what it writes (src/i18n.ts), asked each time; always English now, kept as a function so callers need not change. */
  lang?: () => Lang;
  /** Zoom's own summary of a meeting, as it is told (src/followups.ts looks for what it leaves the owner to do). */
  onSummary?: (m: { id: string; topic: string; at: number; summary: string }) => void;
  /**
   * The meeting review (src/meeting-review.ts). `summary`: Zoom's summary queued for review instead of told (false: told as before, with
   * onSummary). `transcript`: what to add to a transcript's inbox item so a newer bridge reviews it (null: as before).
   */
  review?: {
    summary: (m: { id: string; topic: string; at: number; text: string; notice: string }) => Promise<boolean>;
    transcript: (m: { id: string; topic: string; at: number }) => Promise<InboundReview | null>;
  };
  /** The watchdog (src/watchdog.ts): whether each look at Zoom (its summaries and its recordings) could be made. */
  health?: HealthReport;
  /** The display names that spoke in a transcript, and when the meeting started: the people's identities (src/people-graph.ts). */
  speakers?: (names: string[], at: number) => void;
  /**
   * The person's own app ("user" mode). Zoom gives a new refresh token at every refresh and the old one stops working, so each one is handed
   * here to be kept (src/app.ts: the panel's store). Without it, a restart would start from a token Zoom no longer takes.
   */
  keepRefresh?: (token: string) => void;
}

/** The display names that spoke in a transcript made by vttToText (one per line before its colon), each once, at most 30. */
export function speakersOf(transcript: string): string[] {
  const out: string[] = [];
  for (const l of transcript.split("\n")) {
    const who = /^([^:]{1,60}):\s/.exec(l)?.[1]?.trim();
    if (who && !out.includes(who)) out.push(who);
    if (out.length >= 30) break;
  }
  return out;
}

export function createZoom(d: ZoomDeps) {
  const { config } = d;
  const f = d.fetch ?? fetch;
  const now = d.now ?? Date.now;
  const lang = d.lang ?? ((): Lang => "en");
  const when = (at: number, l: Lang = lang()) =>
    new Intl.DateTimeFormat(locale(l), { timeZone: d.timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(at);

  let token: { value: string; until: number } | null = null;
  let refresh = config.refreshToken ?? "";
  // One refresh at a time: Zoom's refresh token works once, so two at the same moment would leave one of them holding a dead token.
  let asking: Promise<string> | null = null;
  const ask = async (): Promise<string> => {
    const own = config.mode === "user";
    const r = await f("https://zoom.us/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // A public client has no secret: its Client ID goes in the body and no Authorization header is sent (Zoom's PKCE page).
        ...(own ? {} : { authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}` }),
      },
      body: new URLSearchParams(
        own ? { grant_type: "refresh_token", refresh_token: refresh, client_id: config.clientId } : { grant_type: "account_credentials", account_id: config.accountId },
      ).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await r.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown; reason?: unknown; error?: unknown };
    if (!r.ok || typeof j.access_token !== "string") {
      const why = typeof j.reason === "string" ? j.reason : typeof j.error === "string" ? j.error : `HTTP ${r.status}`;
      throw new Error(`Zoom token: ${why}${own && j.error === "invalid_grant" ? " (connect Zoom again in the panel)" : ""}`);
    }
    if (own && typeof j.refresh_token === "string" && j.refresh_token && j.refresh_token !== refresh) {
      refresh = j.refresh_token;
      try {
        d.keepRefresh?.(refresh);
      } catch (err) {
        log.error(`could not keep Zoom's new refresh token: ${(err as Error).name}`);
      }
    }
    token = { value: j.access_token, until: now() + (Number(j.expires_in) || 3600) * 1000 - 120_000 };
    return token.value;
  };
  const bearer = async (): Promise<string> => {
    if (token && token.until > now()) return token.value;
    asking ??= ask().finally(() => {
      asking = null;
    });
    return asking;
  };
  /** Whose meetings are read: "me" for the person's own app, the owner's email for a Server-to-Server app. */
  const who = config.mode === "user" ? "me" : encodeURIComponent(config.user);
  const get = async (path: string): Promise<Record<string, unknown>> => {
    const r = await f(`${API}${path}`, { headers: { authorization: `Bearer ${await bearer()}` }, signal: AbortSignal.timeout(10_000) });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.status === 401) token = null; // a refused token is not used again
    if (!r.ok) throw Object.assign(new Error(`Zoom ${path.split("?")[0]}: ${typeof j.message === "string" ? j.message : `HTTP ${r.status}`}`), { status: r.status });
    return j;
  };

  /** A listing followed through its pages (at most 5), whatever the key holding the items. */
  const getAll = async (path: string, key: string): Promise<Record<string, unknown>[]> => {
    const items: Record<string, unknown>[] = [];
    let next = "";
    for (let page = 0; page < 5; page++) {
      const j = await get(`${path}${next ? `&next_page_token=${encodeURIComponent(next)}` : ""}`);
      if (Array.isArray(j[key])) items.push(...(j[key] as Record<string, unknown>[]));
      next = typeof j.next_page_token === "string" ? j.next_page_token : "";
      if (!next) break;
    }
    return items;
  };

  let state: ZoomState | null = null;
  const load = async (): Promise<ZoomState> => {
    if (state) return state;
    let s: ZoomState = { seen: [], primed: false, done: [] };
    const raw = d.kv ? await readJsonRecord(d.kv, STATE_KEY) : null; // a failed read throws: an empty state must not be saved over the real one
    if (state) return state;
    try {
      if (raw) {
        const p = raw as Partial<ZoomState>;
        s = {
          seen: (Array.isArray(p.seen) ? p.seen : []).filter((x): x is string => typeof x === "string"),
          primed: p.primed === true,
          ...(p.primedSummaries === true ? { primedSummaries: true } : {}),
          ...(p.primedTranscripts === true ? { primedTranscripts: true } : {}),
          done: (Array.isArray(p.done) ? p.done : []).filter((x): x is DoneMeeting => !!x && typeof x.id === "string"),
          ...(typeof p.polledAt === "number" && Number.isFinite(p.polledAt) ? { polledAt: p.polledAt } : {}),
        };
      }
    } catch {
      log.error("the stored state could not be used: starting again");
    }
    state = s;
    return s;
  };
  const save = async (s: ZoomState): Promise<void> => {
    state = { ...s, seen: s.seen.slice(-SEEN_KEEP), done: s.done.slice(-SUMMARIES_KEEP) };
    if (d.kv) await d.kv.set(STATE_KEY, JSON.stringify(state), 60 * 24 * 3600).catch((err: Error) => log.error(`could not keep the state: ${err.message}`));
  };
  const markSeen = async (ids: string[]) => {
    const s = await load();
    await save({ ...s, seen: [...s.seen, ...ids.filter((id) => !s.seen.includes(id))] });
  };
  const keepDone = async (m: DoneMeeting) => {
    const s = await load();
    await save({ ...s, done: [...s.done.filter((x) => x.id !== m.id), m].sort((a, b) => a.at - b.at) });
  };

  // A follow-up's check looks as far ahead as a loop's time may be (90 days); ZOOM and the context show the next week only.
  const UPCOMING_CHECK_MS = 90 * 24 * 3600_000;
  // The meetings are kept for five minutes, not their lines: a language changed meanwhile applies to the next listing.
  type Upcoming = { at: number; topic?: string; duration?: number; createdAt?: number; recurring?: boolean };
  let upcomingCache: { at: number; meetings: Upcoming[] } | null = null;
  const listUpcoming = async (maxAgeMs: number): Promise<Upcoming[]> => {
    const t = now();
    if (!upcomingCache || t - upcomingCache.at >= maxAgeMs) {
      const meetings = await getAll(`/users/${who}/meetings?type=upcoming&page_size=50`, "meetings");
      type M = { topic?: string; start_time?: string; duration?: number; created_at?: string; type?: number };
      const list = (meetings as M[])
        .map((m) => {
          const createdAt = Date.parse(m.created_at ?? "");
          return {
            ...(typeof m.topic === "string" ? { topic: m.topic } : {}), ...(m.duration ? { duration: m.duration } : {}), at: Date.parse(m.start_time ?? ""),
            // When it was set up, and whether it repeats (Zoom's types 3 and 8): a follow-up's check tells a new meeting from a standing one.
            ...(Number.isFinite(createdAt) ? { createdAt } : {}), ...(m.type === 3 || m.type === 8 ? { recurring: true } : {}),
          };
        })
        .filter((m) => Number.isFinite(m.at) && m.at > t - 3 * 3600_000 && m.at < t + UPCOMING_CHECK_MS)
        .sort((a, b) => a.at - b.at);
      upcomingCache = { at: t, meetings: list };
    }
    return upcomingCache.meetings;
  };
  const upcoming = async (): Promise<string[]> => {
    const meetings = (await listUpcoming(5 * 60_000)).filter((m) => m.at < now() + 7 * 24 * 3600_000);
    const l = lang();
    const say = T(l);
    return meetings.map(
      (m) => `${when(m.at, l)} ${say("topic", { topic: (m.topic ?? say("noTitle")).replace(/\s+/g, " ").slice(0, 120) })}${m.duration ? ` (${m.duration} min)` : ""}`,
    );
  };

  // Zoom answers 400/403 when the account shares no AI Companion summaries: looked at again in an hour (an admin may switch them on), not never.
  let summariesOffUntil = 0;
  const giveUp = new Map<string, number>();
  /** Zoom's own summaries of the last two days that are new: told to the owner as they are. */
  const pollSummaries = async (first: boolean): Promise<number> => {
    if (waitLeft(summariesOffUntil, 3600_000, now())) return 0;
    const t = now();
    const from = new Date(lookBack(t, (await load()).polledAt)).toISOString().replace(/\.\d{3}Z$/, "Z");
    const to = new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
    let list: Record<string, unknown>[];
    try {
      list = await getAll(`/users/${who}/meeting_summaries?page_size=30&from=${from}&to=${to}`, "summaries");
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 400 || status === 403) {
        summariesOffUntil = now() + 3600_000; // the account does not share AI Companion summaries: transcripts only, for now
        log.info(`AI Companion summaries are not available (${(err as Error).message}); transcripts only, looked at again in an hour`);
        return 0;
      }
      throw err;
    }
    type S = { meeting_uuid?: string; meeting_topic?: string; meeting_start_time?: string };
    const items = (list as S[]).filter((s) => typeof s.meeting_uuid === "string");
    const s = await load();
    if (first) {
      await markSeen(items.map((i) => `sum:${i.meeting_uuid}`));
      await save({ ...(await load()), primedSummaries: true });
      return 0;
    }
    let told = 0;
    for (const i of items) {
      const id = `sum:${i.meeting_uuid}`;
      if (s.seen.includes(id)) continue;
      // One summary that cannot be fetched must not starve the ones behind it: it is tried three times over three polls, then given up.
      let doc: Record<string, unknown>;
      try {
        doc = await get(`/meetings/${encodeUuid(i.meeting_uuid!)}/meeting_summary`);
      } catch (err) {
        const n = (giveUp.get(id) ?? 0) + 1;
        giveUp.set(id, n);
        log.error(`summary of ${i.meeting_uuid}: ${(err as Error).message} (try ${n})`);
        if (n >= 3) await markSeen([id]);
        continue;
      }
      const content = typeof doc.summary_content === "string" && doc.summary_content.trim()
        ? doc.summary_content
        : [doc.summary_overview, ...(Array.isArray(doc.next_steps) ? doc.next_steps.map((x) => `- ${String(x)}`) : [])].filter((x) => typeof x === "string" && x).join("\n");
      const l = lang();
      const say = T(l);
      const text = plainSummary(String(content || "")).slice(0, 1500) || say("noText");
      const topic = String(doc.meeting_topic ?? i.meeting_topic ?? say("noTitle")).replace(/\s+/g, " ").slice(0, 120);
      const at = Date.parse(String(doc.meeting_start_time ?? i.meeting_start_time ?? "")) || t;
      await markSeen([id, `rec:${i.meeting_uuid}`]); // the transcript of the same meeting is not summarized again
      await keepDone({ id: i.meeting_uuid!, at, topic, summary: text });
      const notice = `🎥 Zoom · ${say("topic", { topic })} (${when(at, l)})\n${text}`;
      // Reviewed: the owner hears their to-dos only, once the Mac answers (or this very notice, if it never does).
      if (d.review && (await d.review.summary({ id: i.meeting_uuid!, topic, at, text, notice }))) {
        d.control?.log("zoom", say("logReview", { topic }));
        told++;
        continue;
      }
      await d.notify(notice);
      d.onSummary?.({ id: i.meeting_uuid!, topic, at, summary: text });
      d.control?.log("zoom", say("logSummary", { topic }));
      told++;
    }
    return told;
  };

  /** Cloud recording transcripts of meetings without Zoom's own summary: to the Mac, to be summarized. */
  const pollTranscripts = async (first: boolean): Promise<number> => {
    const t = now();
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const since = lookBack(t, (await load()).polledAt);
    const all = await getAll(`/users/${who}/recordings?page_size=30&from=${day(since)}&to=${day(t)}`, "meetings");
    type F = { file_type?: string; status?: string; recording_end?: string };
    type R = { uuid?: string; topic?: string; start_time?: string; recording_files?: F[] };
    const withTranscript = (all as R[]).filter(
      (m) => typeof m.uuid === "string" && (m.recording_files ?? []).some((x) => x.file_type === "TRANSCRIPT" && (x.status ?? "completed") === "completed"),
    );
    if (first) {
      await markSeen(withTranscript.map((m) => `rec:${m.uuid}`));
      await save({ ...(await load()), primedTranscripts: true });
      return 0;
    }
    let queued = 0;
    for (const m of withTranscript) {
      const id = `rec:${m.uuid}`;
      if ((await load()).seen.includes(id)) continue;
      const file = (m.recording_files ?? []).find((x) => x.file_type === "TRANSCRIPT")!;
      // Zoom's own summary may still come: wait after the recording ended (or, when Zoom gives no end, after the meeting started plus two hours).
      const ended = Date.parse(file.recording_end ?? "");
      const since = Number.isFinite(ended) ? ended : Date.parse(m.start_time ?? "") + 2 * 3600_000;
      if (!Number.isFinite(since) || t - since < TRANSCRIPT_WAIT_MS) continue;
      // One recording that cannot be fetched (deleted since the listing, a download Zoom refuses) must not starve the ones behind it, nor keep
      // every look failing: it is tried three times over three looks, then given up, as a summary is.
      let transcript: string;
      try {
        const detail = await get(`/meetings/${encodeUuid(m.uuid!)}/recordings?include_fields=download_access_token`);
        const files = (Array.isArray(detail.recording_files) ? detail.recording_files : []) as { file_type?: string; download_url?: string }[];
        const url = files.find((x) => x.file_type === "TRANSCRIPT")?.download_url;
        const access = typeof detail.download_access_token === "string" ? detail.download_access_token : await bearer();
        if (!url || !/^https:\/\//.test(url)) continue;
        const r = await f(url, { headers: { authorization: `Bearer ${access}` }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
        if (!r.ok) throw new Error(`Zoom transcript download: HTTP ${r.status}`);
        transcript = vttToText(await r.text());
      } catch (err) {
        const n = (giveUp.get(id) ?? 0) + 1;
        giveUp.set(id, n);
        log.error(`transcript of ${m.uuid}: ${(err as Error).message} (try ${n})`);
        if (n >= 3) await markSeen([id]);
        continue;
      }
      const l = lang();
      const say = T(l);
      const topic = (m.topic ?? say("noTitle")).replace(/\s+/g, " ").slice(0, 120);
      const at = Date.parse(m.start_time ?? "") || t;
      if (!transcript.trim()) {
        await markSeen([id]);
        continue;
      }
      await keepDone({ id: m.uuid!, at, topic, summary: "" });
      d.speakers?.(speakersOf(transcript), at);
      // Seen only once it is queued: a failed enqueue (the store down) must leave it to be tried again, not lose the meeting for good. The
      // time goes as the owner reads it: the Mac puts it in the notice's head as it is.
      // A newer bridge reviews it (the `review` field); an older one summarizes and tells it, as before.
      const review = d.review ? await d.review.transcript({ id: m.uuid!, topic, at }) : null;
      await d.enqueue({ id: `zoom:${m.uuid}`, at, text: "", meeting: { topic, when: when(at, l), transcript }, ...(review ? { review } : {}) });
      // Zoom's own summary of the same meeting, if it comes after all, is not told or reviewed a second time.
      await markSeen([id, `sum:${m.uuid}`]);
      d.control?.log("zoom", say("logTranscript", { topic }));
      queued++;
    }
    return queued;
  };

  let polling = false;
  const poll = async (): Promise<{ summaries: number; transcripts: number }> => {
    if (polling) return { summaries: 0, transcripts: 0 };
    polling = true;
    try {
      // Each source is primed by its own first good listing (the meetings already there are not announced); one that keeps failing does not make
      // the other treat what arrives meanwhile as already seen. `primed` is what older versions saved for both.
      const s0 = await load();
      const began = now();
      const firstSummaries = !(s0.primed || s0.primedSummaries);
      const firstTranscripts = !(s0.primed || s0.primedTranscripts);
      let failed = "";
      const fail = (what: string) => (err: unknown): number => {
        failed ||= (err as Error).message;
        log.error(`${what}: ${(err as Error).message}`);
        return 0;
      };
      const summaries = await pollSummaries(firstSummaries).catch(fail("summaries"));
      const transcripts = await pollTranscripts(firstTranscripts).catch(fail("transcripts"));
      d.health?.(!failed, failed);
      // Only a listing where both answered moves the mark: after an outage the next one still reaches back to the last good one.
      if (!failed) await save({ ...(await load()), polledAt: began });
      if ((firstSummaries || firstTranscripts) && (await load()).primedSummaries && (await load()).primedTranscripts) log.info("first listing: the meetings already there are not announced");
      return { summaries, transcripts };
    } catch (err) {
      log.error(`${(err as Error).message}`);
      d.health?.(false, (err as Error).message);
      return { summaries: 0, transcripts: 0 };
    } finally {
      polling = false;
    }
  };

  return {
    poll,
    upcoming,
    /**
     * Who this Zoom is ("Connected as" on the panel), with this reader's own token. A separate token request would spend the person's
     * refresh token behind this reader's back. Null when Zoom cannot be asked.
     */
    account: async (): Promise<{ name: string; email: string } | null> => {
      try {
        const u = await get(`/users/${who}`);
        const name = [u.first_name, u.last_name].filter((x) => typeof x === "string" && x).join(" ") || (typeof u.display_name === "string" ? u.display_name : "");
        return { name: name.slice(0, 100), email: typeof u.email === "string" ? u.email.slice(0, 200) : "" };
      } catch {
        /* best effort: a user Zoom will not describe is left out */
        return null;
      }
    },
    /** The owner's scheduled meetings (from three hours ago to 90 days ahead), read again when a minute old: a follow-up's check. Throws when unread. */
    scheduled: async (): Promise<{ topic: string; at: number; createdAt?: number; recurring?: boolean }[]> =>
      (await listUpcoming(60_000)).map((m) => ({
        topic: m.topic ?? "", at: m.at, ...(m.createdAt ? { createdAt: m.createdAt } : {}), ...(m.recurring ? { recurring: true } : {}),
      })),
    /** The latest summaries, newest first, one line each (cut), for ZOOM and the assistant's context. */
    summaries: async (): Promise<string[]> => {
      const l = lang();
      const say = T(l);
      return [...(await load()).done].reverse().filter((m) => m.summary)
        .map((m) => `${when(m.at, l)} ${say("topic", { topic: m.topic })}: ${m.summary.replace(/\s+/g, " ").slice(0, 220)}`);
    },
    /** The meetings that ended in the last `days` days with a summary, newest first, as data (src/brief-v2.ts gathers them). */
    recent: async (days = 7): Promise<{ id: string; topic: string; at: number; summary: string }[]> => {
      const since = now() - days * 24 * 3600_000;
      return [...(await load()).done].reverse().filter((m) => m.summary && m.at >= since).map((m) => ({ ...m }));
    },
    /** The Mac's summary of a transcript it was given. */
    annotate: async (uuid: string, summary: string): Promise<boolean> => {
      const s = await load();
      const m = s.done.find((x) => x.id === uuid);
      if (!m) return false;
      await keepDone({ ...m, summary: summary.slice(0, 1500) });
      return true;
    },
    start: () => {
      setTimeout(() => void poll(), 45_000).unref?.();
      setInterval(() => void poll(), config.pollMinutes * 60_000).unref?.();
    },
  };
}

export type ZoomReader = ReturnType<typeof createZoom>;
