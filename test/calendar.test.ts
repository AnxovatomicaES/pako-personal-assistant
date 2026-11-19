import assert from "node:assert/strict";
import test from "node:test";
import { createControl } from "../src/control.ts";
import { createCalendar, joinLink, loadCalendarConfig, overlaps, parseZohoTime, type CalendarConfig, type CalEvent } from "../src/calendar.ts";
import type { Kv } from "../src/kv.ts";

const ENV = { ZOHO_CLIENT_ID: "1000.ABCDEFGHIJ1234567890", ZOHO_CLIENT_SECRET: "0123456789abcdef0123456789abcdef01234567", ZOHO_GRANT_CODE: "1000.grant.code" };

test("loadCalendarConfig: off with nothing; EU by default; each wrong value named; reminders 10 min by default; the brief is not its business", () => {
  assert.deepEqual(loadCalendarConfig({}), { config: null, problems: [] });
  const ok = loadCalendarConfig(ENV).config!;
  assert.equal(ok.dc, "eu");
  assert.equal(ok.remindMinutes, 10);
  // A wrong MORNING_BRIEF used to turn the whole calendar off: the brief has its own module now (src/brief.ts).
  assert.deepEqual(loadCalendarConfig({ ...ENV, MORNING_BRIEF: "8am" }).problems, []);
  assert.equal(loadCalendarConfig({ ...ENV, ZOHO_DC: "mars" }).config, null);
  assert.equal(loadCalendarConfig({ ZOHO_CLIENT_ID: "x", ZOHO_CLIENT_SECRET: "y" }).problems.length, 2);
});

test("parseZohoTime: UTC, an offset, a local time in the event's zone, an all-day date", () => {
  assert.deepEqual(parseZohoTime("20261115T090000Z", "Europe/Madrid"), { at: Date.parse("2026-11-15T09:00:00Z"), allDay: false });
  assert.deepEqual(parseZohoTime("20261115T100000+0100", "Europe/Madrid"), { at: Date.parse("2026-11-15T09:00:00Z"), allDay: false });
  assert.deepEqual(parseZohoTime("20261115T100000", "Europe/Madrid"), { at: Date.parse("2026-11-15T09:00:00Z"), allDay: false });
  assert.deepEqual(parseZohoTime("20261115", "Europe/Madrid"), { at: Date.parse("2026-11-14T23:00:00Z"), allDay: true });
  assert.equal(parseZohoTime("mañana", "Europe/Madrid"), null);
});

test("overlaps: timed events that cross; all-day ones never", () => {
  const e = (id: string, h1: number, h2: number, allDay = false): CalEvent => ({ id, title: id, start: h1 * 3600_000, end: h2 * 3600_000, allDay, calendar: "" });
  assert.deepEqual([...overlaps([e("a", 9, 10), e("b", 9.5, 11), e("c", 11, 12), e("d", 0, 24, true)])].sort(), ["a", "b"]);
});

function fakeKv() {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  return { kv, m };
}

function rig(o: { config?: Partial<CalendarConfig>; kv?: Kv | null; cal1Fails?: boolean; cal2Fails?: boolean; extraEvents?: unknown[]; slowNotify?: number; unauthorizedOnce?: boolean; startAt?: string } = {}) {
  const told: string[] = [];
  let unauthorized = o.unauthorizedOnce === true;
  const asked: { url: string; auth: string }[] = [];
  const clock = { now: Date.parse(o.startAt ?? "2026-11-15T07:30:00Z") }; // 08:30 in Madrid
  let codes = 0;
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push({ url, auth: String((init?.headers as Record<string, string> | undefined)?.authorization ?? "") });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url.startsWith("https://accounts.zoho.eu/oauth/v2/token?")) {
      const q = new URL(url).searchParams;
      if (q.get("grant_type") === "authorization_code") {
        codes++;
        return q.get("code") === "1000.grant.code" ? json({ access_token: "acc1", refresh_token: "ref1", expires_in: 3600 }) : json({ error: "invalid_code" });
      }
      return json({ access_token: "acc2", expires_in: 3600 });
    }
    if (url === "https://calendar.zoho.eu/api/v1/calendars") return json({ calendars: [{ uid: "cal1", name: "Trabajo" }, { uid: "cal2", name: "Cumpleaños" }] });
    if (url.startsWith("https://calendar.zoho.eu/api/v1/calendars/cal1/events?") && unauthorized) {
      unauthorized = false;
      return json({}, 401);
    }
    if (url.startsWith("https://calendar.zoho.eu/api/v1/calendars/cal1/events?") && o.cal1Fails) return json({}, 500);
    if (url.startsWith("https://calendar.zoho.eu/api/v1/calendars/cal1/events?")) {
      assert.match(url, /byinstance=true/);
      assert.equal((init?.headers as Record<string, string>).accept, "application/json+large", "so the description (and its Zoom link) comes");
      return json({
        events: [
          { uid: "e1", title: "Comité", dateandtime: { start: "20261115T100000+0100", end: "20261115T110000+0100", timezone: "Europe/Madrid" }, location: "Sala 2" },
          { uid: "e2", title: "Llamada con Ana", description: "Únete a la reunión de Zoom\nhttps://us06web.zoom.us/j/81234567890?pwd=abc123\nID: 812 3456 7890", dateandtime: { start: "20261115T103000+0100", end: "20261115T113000+0100", timezone: "Europe/Madrid" } },
          { uid: "e3", title: "Viaje", isallday: true, dateandtime: { start: "20261116", end: "20261117", timezone: "Europe/Madrid" } },
          ...(o.extraEvents ?? []),
        ],
      });
    }
    if (url.startsWith("https://calendar.zoho.eu/api/v1/calendars/cal2/events?")) return o.cal2Fails ? json({}, 500) : json({ events: [] });
    return json({}, 404);
  }) as typeof fetch;
  const cal = createCalendar({
    config: { ...loadCalendarConfig(ENV).config!, ...(o.config ?? {}) },
    kv: o.kv === undefined ? null : o.kv,
    timeZone: "Europe/Madrid",
    control: createControl(null),
    notify: async (t) => {
      if (o.slowNotify) await new Promise((r) => setTimeout(r, o.slowNotify));
      told.push(t);
    },
    fetch: fake,
    now: () => clock.now,
  });
  return { cal, told, asked, clock, codes: () => codes };
}

test("access: the grant code is exchanged once and the refresh token kept; later starts use it; calls carry Zoho's header", async () => {
  const { kv, m } = fakeKv();
  const r = rig({ kv });
  await r.cal.load(true);
  assert.equal(m.get("zoho-refresh"), "ref1");
  assert.ok(r.asked.some((a) => a.url === "https://calendar.zoho.eu/api/v1/calendars" && a.auth === "Zoho-oauthtoken acc1"));
  const again = rig({ kv, config: { grantCode: "" } });
  await again.cal.load(true);
  assert.equal(again.codes(), 0, "no new code needed after a restart");
  assert.ok(again.asked.some((a) => a.auth === "Zoho-oauthtoken acc2"), "the kept refresh token gave a new access token");
  const refused = rig({ config: { grantCode: "1000.old" } });
  await assert.rejects(refused.cal.load(true), /Zoho refused the grant code \(invalid_code\)/);
});

test("AGENDA: today's events with the overlap marked; tomorrow's all-day trip; the next week for the assistant", async () => {
  const r = rig();
  const today = await r.cal.day(0);
  assert.match(today, /^📅 Today, Sunday 15 November:\n• 10:00–11:00 Comité \(Sala 2\) ⚠️ overlaps Llamada con Ana by 30 min\n• 10:30–11:30 Llamada con Ana \(Zoom\) ⚠️ overlaps Comité by 30 min$/);
  assert.match(await r.cal.day(1), /^📅 Tomorrow, Monday 16 November:\n• all day Viaje$/);
  const ctx = await r.cal.context();
  assert.equal(ctx.length, 3);
  assert.match(ctx[0]!, /Sun.* 10:00–11:00 Comité \(Sala 2\) ⚠️ overlaps Llamada con Ana by 30 min$/);
});

test("tick: a reminder a few minutes before each timed event, once; no brief from here any more (src/brief.ts); today() for the brief", async () => {
  const r = rig();
  assert.deepEqual(await r.cal.tick(), { reminded: 0 });
  assert.deepEqual(r.told, [], "08:30: nothing from the calendar itself");
  assert.deepEqual((await r.cal.today()).map((e) => e.title), ["Comité", "Llamada con Ana"], "today only: tomorrow's trip is not in it");
  r.clock.now = Date.parse("2026-11-15T08:52:00Z"); // 09:52, the committee at 10:00
  assert.deepEqual(await r.cal.tick(), { reminded: 1 });
  assert.equal(r.told.at(-1), "⏰ In 8 min: Comité (10:00–11:00)\n📍 Sala 2");
  assert.equal((await r.cal.tick()).reminded, 0, "once per event");
  r.clock.now = Date.parse("2026-11-15T09:21:00Z"); // 10:21, the call at 10:30
  assert.equal((await r.cal.tick()).reminded, 1);
  assert.equal(r.told.at(-1), "⏰ In 9 min: Llamada con Ana (10:30–11:30)\n🎥 https://us06web.zoom.us/j/81234567890?pwd=abc123", "the Zoom link from the invitation");
});

test("joinLink: the Zoom link from an invitation first, else Meet or Teams; none in plain text", () => {
  assert.equal(joinLink("Sala 2", undefined, "Entra: https://acme.zoom.us/j/123456789?pwd=x). Gracias"), "https://acme.zoom.us/j/123456789?pwd=x");
  assert.equal(joinLink("https://meet.google.com/abc-defg-hij"), "https://meet.google.com/abc-defg-hij");
  assert.equal(joinLink("Oficina", "nada"), undefined);
});

test("bug hunt: after a refused grant code Zoho is not asked again every minute; today() says it could not read (the brief says so)", async () => {
  const r = rig({ config: { grantCode: "1000.old" } });
  r.clock.now = Date.parse("2026-11-15T07:05:00Z"); // 08:05 in Madrid
  const errs: string[] = [];
  const keep = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  try {
    await r.cal.tick();
    await assert.rejects(() => r.cal.today(), /Zoho refused the grant code|Zoho/);
    for (let i = 0; i < 5; i++) {
      r.clock.now += 60_000;
      await r.cal.tick();
    }
    assert.equal(r.codes(), 1, "one try in ten minutes, not one a minute");
    assert.equal(errs.filter((e) => e.includes("refused the grant code")).length, 1, "logged once");
  } finally {
    console.error = keep;
  }
});

test("bug hunt: days follow the calendar on a DST change day; an all-day invitation from another zone stays on its own day", () => {
  // 25 Oct 2026 is the autumn change in Madrid (a 25-hour day); parseZohoTime reads a date-only value in the zone given.
  const day = parseZohoTime("20261025", "Europe/Madrid")!;
  assert.equal(day.at, Date.parse("2026-10-24T22:00:00Z"));
  assert.equal(parseZohoTime("20261116", "Europe/Madrid")!.at, Date.parse("2026-11-15T23:00:00Z"));
});

// ---------- bug hunt 2: regression tests ----------

test("hunt2 calendar: one calendar that fails, or one event in an odd time zone, does not take the agenda down; all failing is an outage", async () => {
  const odd = { uid: "odd", title: "Raro", dateandtime: { start: "20261115T120000", end: "20261115T130000", timezone: "W. Europe Standard Time" } };
  const some = rig({ cal2Fails: true, extraEvents: [odd] });
  assert.match(await some.cal.day(0), /10:00–11:00 Comité/);
  const none = rig({ cal1Fails: true, cal2Fails: true });
  await assert.rejects(() => none.cal.day(0), /no calendar could be read/);
});

test("hunt2 calendar: an all-day event ends at the next local midnight, also on the 23-hour day when the clocks go forward", async () => {
  const r = rig({ startAt: "2026-03-28T10:00:00Z", extraEvents: [{ uid: "ad", title: "Fiesta", isallday: true, dateandtime: { start: "20260329", end: "20260329", timezone: "Europe/Madrid" } }] });
  assert.match(await r.cal.day(1), /all day Fiesta/);
  assert.match(await r.cal.day(2), /nothing on the calendar/, "it does not spill into the 30th");
});

test("hunt2 calendar: a refused access token is not used again; a look-alike host is not Zoom; two ticks at once remind once", async () => {
  const r = rig({ unauthorizedOnce: true });
  assert.match(await r.cal.day(0), /nothing on the calendar/, "the refused calendar is missing from this partial agenda");
  const tokenCalls = () => r.asked.filter((a) => a.url.startsWith("https://accounts.zoho.eu/oauth/v2/token?") && /grant_type=refresh_token/.test(a.url)).length;
  assert.equal(tokenCalls(), 1, "a new token was asked for right after the 401 (the refused one was not kept for its hour)");
  r.clock.now += 31_000; // a partial agenda is not kept for five minutes
  assert.match(await r.cal.day(0), /10:00–11:00 Comité/);
  assert.equal(joinLink("https://evilzoom.us/j/123456789"), undefined);
  assert.equal(joinLink("https://evil.example/zoom.us/j/1"), undefined);
  assert.equal(joinLink("https://eu01web.zoom.us/j/123456789?pwd=x"), "https://eu01web.zoom.us/j/123456789?pwd=x");
  const slow = rig({ slowNotify: 40 });
  slow.clock.now = Date.parse("2026-11-15T08:52:00Z");
  const [a, b] = await Promise.all([slow.cal.tick(), slow.cal.tick()]);
  assert.equal(a.reminded + b.reminded, 1, "one reminder, not two");
  assert.equal(slow.told.filter((t) => t.startsWith("⏰")).length, 1);
});
