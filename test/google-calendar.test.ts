// Google Calendar as a calendar source (src/google-calendar.ts), against a fake Google token endpoint and Calendar API: the selected
// calendars' events two days back to fourteen ahead, all-day ones at their midnight, the owner's answer kept, cancelled ones left out,
// one calendar failing makes the look partial, and a refused sign-in is said. Nothing goes to Google.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createGoogleCalendarSource, loadGoogleCalendarConfig } from "../src/google-calendar.ts";

const G_ID = "1234567890-abcdefghij.apps.googleusercontent.com";

test("the config: off with nothing; a sign-in needs this Pako's Google client", () => {
  assert.deepEqual(loadGoogleCalendarConfig({}), { config: null, problems: [] });
  assert.match(loadGoogleCalendarConfig({ GOOGLE_REFRESH_TOKEN: "1//refresh-token-0123456789" }).problems.join(), /PAKO_GOOGLE_CLIENT_ID/);
  const ok = loadGoogleCalendarConfig({ GOOGLE_REFRESH_TOKEN: "1//refresh-token-0123456789", GOOGLE_ACCOUNT: "ana@gmail.example", PAKO_GOOGLE_CLIENT_ID: G_ID });
  assert.deepEqual(ok.config, { clientId: G_ID, refreshToken: "1//refresh-token-0123456789", account: "ana@gmail.example" });
});

test("the events: selected calendars, the window, all-day at midnight, the owner's answer, cancelled left out, one failing is partial", async () => {
  const now = Date.parse("2026-11-18T10:00:00Z");
  const asked: string[] = [];
  let tokens = 0;
  const fake = (async (url: string, init?: RequestInit) => {
    if (url === "https://token.example/token") {
      tokens++;
      assert.equal(new URLSearchParams(String(init?.body)).get("grant_type"), "refresh_token");
      return new Response(JSON.stringify({ access_token: "acc", expires_in: 3600 }));
    }
    asked.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith("/calendarList")) {
      return new Response(JSON.stringify({ items: [{ id: "primary", summary: "Ana", primary: true }, { id: "work@x", summary: "Work" }, { id: "hidden", summary: "H", selected: false }, { id: "broken", summary: "B" }] }));
    }
    if (u.pathname.includes("/broken/")) return new Response("{}", { status: 500 });
    if (u.pathname.includes("/primary/")) {
      assert.equal(u.searchParams.get("singleEvents"), "true");
      assert.equal(u.searchParams.get("timeMin"), new Date(now - 2 * 86400_000).toISOString());
      assert.equal(u.searchParams.get("timeMax"), new Date(now + 14 * 86400_000).toISOString());
      return new Response(JSON.stringify({ items: [
        { id: "e1", iCalUID: "u1@google.com", summary: "Budget review", start: { dateTime: "2026-11-19T09:00:00+01:00" }, end: { dateTime: "2026-11-19T10:00:00+01:00" },
          hangoutLink: "https://meet.google.com/abc-defg-hij", attendees: [{ self: true, responseStatus: "needsAction" }], organizer: { displayName: "Luis" } },
        { id: "e2", summary: "Holiday", start: { date: "2026-11-20" }, end: { date: "2026-11-21" } },
        { id: "e3", summary: "Gone", status: "cancelled", start: { dateTime: "2026-11-19T12:00:00Z" }, end: { dateTime: "2026-11-19T13:00:00Z" } },
        { id: "e4", summary: "No thanks", start: { dateTime: "2026-11-19T15:00:00Z" }, end: { dateTime: "2026-11-19T16:00:00Z" }, attendees: [{ self: true, responseStatus: "declined" }] },
      ] }));
    }
    return new Response(JSON.stringify({ items: [] }));
  }) as typeof fetch;
  const logged: string[] = [];
  const src = createGoogleCalendarSource({
    config: { clientId: G_ID, refreshToken: "1//r", account: "ana@gmail.example" }, timeZone: "Europe/Madrid", fetch: fake, now: () => now,
    log: (t) => void logged.push(t), tokenUrl: "https://token.example/token", api: "https://cal.example/v3",
  });
  assert.equal(src.label, "Google Calendar (ana@gmail.example)");
  const r = await src.events();
  assert.equal(r.partial, true, "one calendar failed");
  assert.equal(tokens, 1);
  assert.ok(!asked.some((u) => u.includes("/hidden/")), "a calendar hidden in Google Calendar is not read");
  assert.deepEqual(r.events.map((e) => e.title), ["Budget review", "Holiday", "No thanks"]);
  const [meet, holiday, declined] = r.events;
  assert.deepEqual(meet, { id: "google:e1", uid: "u1@google.com", title: "Budget review", start: Date.parse("2026-11-19T08:00:00Z"), end: Date.parse("2026-11-19T09:00:00Z"),
    allDay: false, calendar: "Ana", join: "https://meet.google.com/abc-defg-hij", response: "needs", organizer: "Luis" });
  assert.equal(holiday!.allDay, true);
  assert.equal(holiday!.start, Date.parse("2026-11-19T23:00:00Z"), "midnight in Madrid");
  assert.equal(holiday!.end, Date.parse("2026-11-20T23:00:00Z"));
  assert.equal(declined!.response, "declined");
  assert.match(logged.join(), /"B"/);

  const refused = createGoogleCalendarSource({
    config: { clientId: G_ID, refreshToken: "1//r", account: "" }, timeZone: "UTC", log: () => {}, tokenUrl: "https://token.example/token",
    fetch: (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch,
  });
  await assert.rejects(refused.events(), /connect the calendar again/);
});
