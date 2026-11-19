// Google Calendar as one of the calendar's sources (src/calendar.ts), connected with one button: the project's own Google app
// (src/connect-clients.ts), a sign-in with PKCE (src/mail-oauth.ts), and the refresh token kept in the secret store (GOOGLE_REFRESH_TOKEN,
// GOOGLE_ACCOUNT).
//
// Each look reads the events of every calendar the person has selected in Google Calendar, from two days back to fourteen ahead. Each
// recurring event is expanded into its occurrences (singleEvents), as the other sources give them. Declined ones are marked as declined,
// and src/calendar.ts leaves them out. The access token lasts an hour and is asked for again from the refresh token. Google does not
// replace a desktop client's refresh token, but if it ever does, the new one is handed to `keep`. A refresh token Google no longer takes
// is said in the log, and the calendar card asks to connect again.

import type { CalEvent, CalendarSource } from "./calendar.ts";
import { builtInClients, type BuiltInDefaults } from "./connect-clients.ts";
import { dayStart } from "./ics.ts";

type Env = Record<string, string | undefined>;

export const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GoogleCalendarConfig {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  account: string;
}

/** Off (null) without a refresh token; a wrong value, or no Google client in this Pako, is named and keeps it off. */
export function loadGoogleCalendarConfig(env: Env, defaults?: BuiltInDefaults): { config: GoogleCalendarConfig | null; problems: string[] } {
  const refreshToken = (env.GOOGLE_REFRESH_TOKEN ?? "").trim();
  const account = (env.GOOGLE_ACCOUNT ?? "").trim();
  if (!refreshToken && !account) return { config: null, problems: [] };
  const problems: string[] = [];
  if (!/^[\w.~/+=*!-]{16,4000}$/.test(refreshToken)) problems.push("GOOGLE_REFRESH_TOKEN must be the sign-in kept by connecting Google Calendar in the panel");
  const client = builtInClients(env, defaults).google;
  if (!client) problems.push("GOOGLE_REFRESH_TOKEN is set, but this Pako has no Google client (PAKO_GOOGLE_CLIENT_ID)");
  if (problems.length || !client) return { config: null, problems };
  return { config: { clientId: client.id, ...(client.secret ? { clientSecret: client.secret } : {}), refreshToken, account }, problems };
}

interface GoogleEvent {
  id?: string;
  iCalUID?: string;
  status?: string;
  summary?: string;
  location?: string;
  hangoutLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: { self?: boolean; responseStatus?: string }[];
}

export function createGoogleCalendarSource(d: {
  config: GoogleCalendarConfig; timeZone: string; fetch?: typeof fetch; now?: () => number; log: (text: string) => void;
  keep?: (refreshToken: string) => void;
  /** Google's token endpoint and Calendar API (the tests give fakes). */
  tokenUrl?: string; api?: string;
}): CalendarSource {
  const f = d.fetch ?? fetch;
  const now = d.now ?? Date.now;
  const api = d.api ?? GOOGLE_CALENDAR_API;
  const tokenUrl = d.tokenUrl ?? GOOGLE_TOKEN_URL;
  let refresh = d.config.refreshToken;
  let access: { value: string; until: number } | null = null;

  const bearer = async (): Promise<string> => {
    if (access && access.until > now()) return access.value;
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: d.config.clientId });
    if (d.config.clientSecret) body.set("client_secret", d.config.clientSecret);
    const r = await f(tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(), signal: AbortSignal.timeout(15_000) });
    const j = (await r.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown; error?: unknown };
    if (typeof j.access_token !== "string") {
      throw new Error(j.error === "invalid_grant" ? "Google wants you to connect the calendar again" : `Google token: ${typeof j.error === "string" ? j.error : `HTTP ${r.status}`}`);
    }
    if (typeof j.refresh_token === "string" && j.refresh_token && j.refresh_token !== refresh) {
      refresh = j.refresh_token;
      d.keep?.(refresh);
    }
    access = { value: j.access_token, until: now() + (Number(j.expires_in) || 3600) * 1000 - 120_000 };
    return access.value;
  };
  const get = async (path: string): Promise<Record<string, unknown>> => {
    const r = await f(`${api}${path}`, { headers: { authorization: `Bearer ${await bearer()}` }, signal: AbortSignal.timeout(15_000) });
    if (r.status === 401) access = null;
    if (!r.ok) throw new Error(`Google Calendar ${path.split("?")[0]}: HTTP ${r.status}`);
    return (await r.json()) as Record<string, unknown>;
  };

  const timeOf = (t: { dateTime?: string; date?: string } | undefined): { at: number; allDay: boolean } | null => {
    if (t?.dateTime) {
      const at = Date.parse(t.dateTime);
      return Number.isFinite(at) ? { at, allDay: false } : null;
    }
    // An all-day event's date, at its midnight in the owner's zone, as the calendar link's (src/ics.ts) are.
    if (t?.date && /^\d{4}-\d{2}-\d{2}$/.test(t.date)) return { at: dayStart(t.date, d.timeZone), allDay: true };
    return null;
  };

  return {
    label: `Google Calendar${d.config.account ? ` (${d.config.account})` : ""}`,
    events: async () => {
      const t = now();
      const list = await get("/users/me/calendarList?minAccessRole=reader&maxResults=50");
      const cals = ((Array.isArray(list.items) ? list.items : []) as { id?: string; summary?: string; selected?: boolean; primary?: boolean }[])
        .filter((c) => typeof c.id === "string" && (c.selected !== false || c.primary));
      const out: CalEvent[] = [];
      let partial = false;
      // The same meeting in two selected calendars (the owner's and a shared team calendar) has one event id: said once, the primary's copy
      // first (it has the owner's own answer).
      const seen = new Set<string>();
      for (const c of [...cals].sort((a, b) => Number(!!b.primary) - Number(!!a.primary)).slice(0, 20)) {
        const q = new URLSearchParams({
          singleEvents: "true", orderBy: "startTime", maxResults: "250", timeMin: new Date(t - 2 * 86400_000).toISOString(),
          timeMax: new Date(t + 14 * 86400_000).toISOString(),
        });
        // A busy calendar gives its events in pages of 250: every page is read (at most ten).
        const items: GoogleEvent[] = [];
        try {
          for (let page = 0; page < 10; page++) {
            const j = await get(`/calendars/${encodeURIComponent(c.id!)}/events?${q}`);
            items.push(...((Array.isArray(j.items) ? j.items : []) as GoogleEvent[]));
            if (typeof j.nextPageToken !== "string" || !j.nextPageToken) break;
            q.set("pageToken", j.nextPageToken);
          }
        } catch (err) {
          partial = true;
          d.log(`Google Calendar "${(c.summary ?? "").slice(0, 60)}": ${(err as Error).message}`);
          if (!items.length) continue;
        }
        for (const e of items) {
          if (e.status === "cancelled" || !e.id || seen.has(e.id)) continue;
          seen.add(e.id);
          const start = timeOf(e.start);
          const end = timeOf(e.end);
          if (!start || !end) continue;
          const me = e.attendees?.find((a) => a.self);
          const response = me?.responseStatus === "declined" ? "declined" : me?.responseStatus === "tentative" ? "tentative"
            : me?.responseStatus === "needsAction" && !e.organizer?.self ? "needs" : undefined;
          out.push({
            id: `google:${e.id}`, ...(e.iCalUID ? { uid: e.iCalUID } : {}),
            // Google leaves the summary out of an event with no title.
            title: (e.summary ?? "").trim().slice(0, 200) || "(no title)", start: start.at, end: end.at,
            allDay: start.allDay, calendar: (c.summary ?? "Google").slice(0, 100), ...(e.location ? { location: e.location.slice(0, 200) } : {}),
            ...(e.hangoutLink && /^https:\/\//.test(e.hangoutLink) ? { join: e.hangoutLink } : {}), ...(response ? { response } : {}),
            ...(response === "needs" && (e.organizer?.displayName || e.organizer?.email) ? { organizer: (e.organizer.displayName || e.organizer.email)!.slice(0, 100) } : {}),
          });
        }
      }
      return { events: out, partial };
    },
  };
}
