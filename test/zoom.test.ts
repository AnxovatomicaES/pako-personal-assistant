import assert from "node:assert/strict";
import test from "node:test";
import { createControl } from "../src/control.ts";
import { createZoom, encodeUuid, loadZoomConfig, lookBack, plainSummary, vttToText, type ZoomConfig } from "../src/zoom.ts";
import type { Inbound } from "../src/whatsapp.ts";

const CONFIG: ZoomConfig = { accountId: "acct_123456", clientId: "client_123456", clientSecret: "secret_0123456789abcdef", user: "marta@empresa.example", pollMinutes: 10 };

test("loadZoomConfig: off with nothing; each wrong value named; the poll defaults to 10 minutes", () => {
  assert.deepEqual(loadZoomConfig({}), { config: null, problems: [] });
  assert.equal(loadZoomConfig({ ZOOM_ACCOUNT_ID: "x" }).problems.length, 4);
  const ok = loadZoomConfig({ ZOOM_ACCOUNT_ID: CONFIG.accountId, ZOOM_CLIENT_ID: CONFIG.clientId, ZOOM_CLIENT_SECRET: CONFIG.clientSecret, ZOOM_USER: CONFIG.user });
  assert.equal(ok.config?.pollMinutes, 10);
});

test("the person's own app (connected in the panel): a refresh token instead of a secret, 'me' instead of an email, each new token kept", async () => {
  const env = { ZOOM_CLIENT_ID: "AbCdEfGhIjKlMn_0123", ZOOM_REFRESH_TOKEN: "eyJ.refresh-one.sig" };
  const c = loadZoomConfig(env);
  assert.deepEqual(c.problems, []);
  assert.equal(c.config?.mode, "user");
  assert.equal(c.config?.user, "me");
  assert.deepEqual(loadZoomConfig({ ...env, ZOOM_REFRESH_TOKEN: "short" }).problems, ["ZOOM_REFRESH_TOKEN must be the refresh token from connecting Zoom in the panel"]);

  let refreshes = 0;
  const bodies: URLSearchParams[] = [];
  const headers: string[] = [];
  const asked: string[] = [];
  const kept: string[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    if (url === "https://zoom.us/oauth/token") {
      refreshes++;
      bodies.push(new URLSearchParams(String(init?.body)));
      headers.push(String((init?.headers as Record<string, string>).authorization ?? ""));
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ access_token: `access-${refreshes}`, refresh_token: `eyJ.refresh-${refreshes + 1}.sig`, expires_in: 3599 }));
    }
    asked.push(url);
    return new Response(JSON.stringify({ first_name: "Marta", last_name: "Gil", email: "marta@empresa.example" }));
  }) as typeof fetch;
  let clock = Date.parse("2026-11-18T10:00:00Z");
  const zoom = createZoom({
    config: c.config!, kv: null, timeZone: "Europe/Madrid", notify: async () => {}, enqueue: async () => true, fetch: fake, now: () => clock,
    keepRefresh: (t) => void kept.push(t),
  });
  // Two at once share one refresh: Zoom's refresh token works once.
  const [a, b] = await Promise.all([zoom.account(), zoom.account()]);
  assert.deepEqual(a, { name: "Marta Gil", email: "marta@empresa.example" });
  assert.deepEqual(b, a);
  assert.equal(refreshes, 1);
  assert.equal(bodies[0]!.get("grant_type"), "refresh_token");
  assert.equal(bodies[0]!.get("refresh_token"), "eyJ.refresh-one.sig");
  assert.equal(bodies[0]!.get("client_id"), "AbCdEfGhIjKlMn_0123");
  assert.equal(headers[0], "", "a public client: no secret, no Authorization header");
  assert.deepEqual(kept, ["eyJ.refresh-2.sig"], "the new refresh token is kept at once");
  assert.ok(asked.every((u) => u.startsWith("https://api.zoom.us/v2/users/me")), "the person's own data, as 'me'");
  // An hour later the next refresh uses the token Zoom gave last time.
  clock += 3600_000;
  await zoom.account();
  assert.equal(bodies[1]!.get("refresh_token"), "eyJ.refresh-2.sig");
  assert.deepEqual(kept, ["eyJ.refresh-2.sig", "eyJ.refresh-3.sig"]);
});

test("helpers: a UUID with / is encoded twice; VTT becomes speaker lines; Zoom's markdown becomes plain", () => {
  assert.equal(encodeUuid("abc=="), "abc%3D%3D");
  assert.equal(encodeUuid("/ab//c"), encodeURIComponent(encodeURIComponent("/ab//c")));
  const vtt = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nAna: Hola a todos\n\n2\n00:00:03.000 --> 00:00:05.000\nAna: empezamos\n\n3\n00:00:05.000 --> 00:00:07.000\nLuis: Vale";
  assert.equal(vttToText(vtt), "Ana: Hola a todos empezamos\nLuis: Vale");
  assert.equal(plainSummary("## Resumen\n**Decidido** el lunes.\n\n- Ana: informe\n* Luis: [doc](https://x.example)"), "Resumen\nDecidido el lunes.\n\n• Ana: informe\n• Luis: doc: https://x.example");
});

function rig(o: { summariesStatus?: number; enqueue?: (m: Inbound) => Promise<boolean>; summaryDoc404?: string[]; recordingsFail?: boolean; detail404?: string[] } = {}) {
  const told: string[] = [];
  const queued: Inbound[] = [];
  const asked: { url: string; auth: string }[] = [];
  const clock = { now: Date.parse("2026-11-14T12:00:00Z") };
  const world = {
    summaries: [] as Record<string, unknown>[],
    recordings: [] as Record<string, unknown>[],
  };
  let tokens = 0;
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
    asked.push({ url, auth });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url === "https://zoom.us/oauth/token") {
      tokens++;
      assert.equal(auth, `Basic ${Buffer.from(`${CONFIG.clientId}:${CONFIG.clientSecret}`).toString("base64")}`);
      assert.match(String(init?.body), /grant_type=account_credentials&account_id=acct_123456/);
      return json({ access_token: `tok${tokens}`, expires_in: 3600 });
    }
    if (url.includes("/meetings?type=upcoming"))
      return json({ meetings: [{ topic: "Comité", start_time: "2026-11-15T09:00:00Z", duration: 60 }, { topic: "Antigua", start_time: "2026-10-01T09:00:00Z" }] });
    if (url.includes("/meeting_summaries?")) return o.summariesStatus ? json({ message: "off" }, o.summariesStatus) : json({ summaries: world.summaries });
    if (o.summaryDoc404?.some((u) => url.includes(encodeUuid(u))) && url.includes("/meeting_summary")) return json({ message: "gone" }, 404);
    if (url.includes("/recordings?page_size") && o.recordingsFail) return json({ message: "down" }, 500);
    if (url.includes("/meeting_summary")) return json({ meeting_topic: "Comité", meeting_start_time: "2026-11-14T09:00:00Z", summary_content: "## Resumen\nSe aprobó el plan.\n- Ana: informe el lunes" });
    if (url.includes("/recordings?page_size")) return json({ meetings: world.recordings });
    if (o.detail404?.some((u) => url.includes(`/meetings/${encodeUuid(u)}/recordings?`))) return json({ message: "This recording does not exist." }, 404);
    if (url.includes("/recordings?include_fields=download_access_token"))
      return json({ download_access_token: "dl-token", recording_files: [{ file_type: "TRANSCRIPT", download_url: "https://zoom.example/rec/download/t.vtt" }] });
    if (url === "https://zoom.example/rec/download/t.vtt") return new Response("WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nLuis: Arrancamos\n");
    return json({ message: "unknown" }, 404);
  }) as typeof fetch;
  const zoom = createZoom({
    config: CONFIG,
    kv: null,
    timeZone: "Europe/Madrid",
    control: createControl(null),
    notify: async (t) => void told.push(t),
    enqueue: o.enqueue ?? (async (m) => (queued.push(m), true)),
    fetch: fake,
    now: () => clock.now,
  });
  return { zoom, told, queued, asked, clock, world, tokens: () => tokens };
}

test("upcoming: the next week's meetings, in the owner's time zone, through the owner's email (not 'me'); one token reused", async () => {
  const r = rig();
  const lines = await r.zoom.upcoming();
  assert.equal(lines.length, 1, "the old meeting is left out");
  assert.match(lines[0]!, /^15\/11,? 10:00 “Comité” \(60 min\)$/);
  assert.ok(r.asked.some((a) => a.url === "https://api.zoom.us/v2/users/marta%40empresa.example/meetings?type=upcoming&page_size=50" && a.auth === "Bearer tok1"));
  await r.zoom.poll();
  assert.equal(r.tokens(), 1, "the token is reused while it lasts");
});

test("after a meeting: Zoom's own summary is told as it is; a transcript waits 30 minutes, then goes to the Mac; nothing twice, nothing from before", async () => {
  const r = rig();
  r.world.summaries = [{ meeting_uuid: "old==", meeting_topic: "Vieja" }];
  r.world.recordings = [{ uuid: "oldrec==", topic: "Vieja", recording_files: [{ file_type: "TRANSCRIPT", status: "completed", recording_end: "2026-11-13T10:00:00Z" }] }];
  assert.deepEqual(await r.zoom.poll(), { summaries: 0, transcripts: 0 }, "the first listing only marks what is there");

  r.world.summaries.push({ meeting_uuid: "/new//uuid", meeting_topic: "Comité" });
  r.world.recordings.push(
    { uuid: "/new//uuid", topic: "Comité", recording_files: [{ file_type: "TRANSCRIPT", status: "completed", recording_end: "2026-11-14T10:00:00Z" }] },
    { uuid: "rec2==", topic: "Ventas", start_time: "2026-11-14T10:00:00Z", recording_files: [{ file_type: "TRANSCRIPT", status: "completed", recording_end: "2026-11-14T11:45:00Z" }] },
  );
  assert.deepEqual(await r.zoom.poll(), { summaries: 1, transcripts: 0 });
  assert.match(r.told[0]!, /^🎥 Zoom · “Comité” \(14\/11,? 10:00\)\nResumen\nSe aprobó el plan\.\n• Ana: informe el lunes$/);
  assert.ok(r.asked.some((a) => a.url.endsWith(`/meetings/${encodeURIComponent(encodeURIComponent("/new//uuid"))}/meeting_summary`)), "a UUID with // is encoded twice");
  assert.equal(r.queued.length, 0, "the meeting with a summary is not summarized again, and the other one ended 15 minutes ago");

  r.clock.now += 31 * 60_000;
  assert.deepEqual(await r.zoom.poll(), { summaries: 0, transcripts: 1 });
  assert.equal(r.queued[0]!.id, "zoom:rec2==");
  assert.deepEqual(r.queued[0]!.meeting, { topic: "Ventas", when: r.queued[0]!.meeting!.when, transcript: "Luis: Arrancamos" });
  assert.equal(r.asked.find((a) => a.url.endsWith("t.vtt"))!.auth, "Bearer dl-token", "the download uses the download token");
  assert.equal(await r.zoom.annotate("rec2==", "Se habló de ventas."), true);
  const lines = await r.zoom.summaries();
  assert.match(lines[0]!, /“Ventas”: Se habló de ventas\.$/);
  assert.match(lines[1]!, /“Comité”: Resumen Se aprobó el plan/);
  assert.deepEqual(await r.zoom.poll(), { summaries: 0, transcripts: 0 }, "nothing twice");
});

test("an account without AI Companion summaries falls back to transcripts only", async () => {
  const r = rig({ summariesStatus: 403 });
  await r.zoom.poll();
  r.world.recordings.push({ uuid: "r==", topic: "Equipo", recording_files: [{ file_type: "TRANSCRIPT", status: "completed", recording_end: "2026-11-14T09:00:00Z" }] });
  assert.deepEqual(await r.zoom.poll(), { summaries: 0, transcripts: 1 });
});

test("bug hunt: a first look that fails is not counted as primed, so the next one does not flood the owner", async () => {
  const r = rig();
  let fail = true;
  const real = r.world.recordings;
  Object.defineProperty(r.world, "recordings", { get: () => { if (fail) throw new Error("zoom down"); return real; } });
  r.world.summaries = [{ meeting_uuid: "old==", meeting_topic: "Vieja" }];
  const keep = console.error;
  console.error = () => undefined;
  try {
    await r.zoom.poll();
    fail = false;
    assert.deepEqual(await r.zoom.poll(), { summaries: 0, transcripts: 0 }, "the second look is the real first one: nothing announced");
    assert.equal(r.told.length, 0);
  } finally {
    console.error = keep;
  }
});

// ---------- bug hunt 2: regression tests ----------

const RECORDING = { uuid: "u-rec", topic: "Planificación", start_time: "2026-11-14T09:00:00Z", recording_files: [{ file_type: "TRANSCRIPT", status: "completed", recording_end: "2026-11-14T10:00:00Z" }] };

test("zoom: a transcript whose queueing failed is tried again on the next look, not lost", async () => {
  let fail = true;
  const queued: Inbound[] = [];
  const r = rig({ enqueue: async (m) => { if (fail) throw new Error("store down"); queued.push(m); return true; } });
  await r.zoom.poll(); // the first listing: nothing announced
  r.world.recordings = [RECORDING];
  assert.equal((await r.zoom.poll()).transcripts, 0, "the store was down");
  fail = false;
  assert.equal((await r.zoom.poll()).transcripts, 1, "the next look queues it");
  assert.equal(queued.length, 1);
  assert.equal((await r.zoom.poll()).transcripts, 0, "and only once");
});

test("zoom: a summary that cannot be fetched does not hold back the ones behind it (and is given up after three tries); "
  + "a meeting without a recording end waits before its transcript goes", async () => {
  const r = rig({ summaryDoc404: ["u-bad"] });
  await r.zoom.poll();
  r.world.summaries = [{ meeting_uuid: "u-bad", meeting_topic: "Rota" }, { meeting_uuid: "u-good", meeting_topic: "Comité" }];
  const told = await r.zoom.poll();
  assert.equal(told.summaries, 1, "the good one is told in the same look");
  await r.zoom.poll();
  await r.zoom.poll();
  assert.equal(r.told.length, 1, "the broken one is never told, and stops being tried");
  const noEnd = rig();
  await noEnd.zoom.poll();
  noEnd.world.recordings = [{ ...RECORDING, uuid: "u-noend", start_time: "2026-11-14T11:30:00Z", recording_files: [{ file_type: "TRANSCRIPT", status: "completed" }] }];
  assert.equal((await noEnd.zoom.poll()).transcripts, 0, "no end given: two hours after the start, not at once");
});

test("zoom: each source is primed by its own first listing (a recordings outage does not make new summaries 'already seen')", async () => {
  const r = rig({ recordingsFail: true });
  await r.zoom.poll(); // summaries primed (empty), recordings failing
  r.world.summaries = [{ meeting_uuid: "u-new", meeting_topic: "Comité" }];
  assert.equal((await r.zoom.poll()).summaries, 1, "a summary that arrived between two failed recordings listings is told");
});

test("zoom by polling only (a computer with no webhook): a listing reaches back to the last good one, so a weekend off finds Friday's meeting, once", async () => {
  const day = 24 * 3600_000;
  assert.equal(lookBack(10 * day, undefined), 8 * day, "no listing yet: two days");
  assert.equal(lookBack(10 * day, 9.5 * day), 8 * day, "a recent listing: still two days");
  assert.equal(lookBack(10 * day, 5 * day), 5 * day - 3600_000, "back to the last good listing, an hour more");
  assert.equal(lookBack(30 * day, 1 * day), 16 * day, "never more than fourteen days");

  const r = rig();
  const friday = r.clock.now;
  assert.deepEqual(await r.zoom.poll(), { summaries: 0, transcripts: 0 }, "the first listing only marks");
  // The computer is off for four days; a meeting happened an hour after the last listing.
  r.clock.now += 4 * day;
  r.world.summaries.push({ meeting_uuid: "fri==", meeting_topic: "Comité", meeting_start_time: new Date(friday + 3600_000).toISOString() });
  assert.deepEqual(await r.zoom.poll(), { summaries: 1, transcripts: 0 });
  const listed = r.asked.filter((a) => a.url.includes("/meeting_summaries?")).at(-1)!.url;
  const from = Date.parse(new URL(listed).searchParams.get("from")!);
  assert.ok(from <= friday - 3600_000 + 1000 && from >= friday - 3600_000 - 1000, `reaches back to the last listing (${new Date(from).toISOString()})`);
  const recs = r.asked.filter((a) => a.url.includes("/recordings?page_size")).at(-1)!.url;
  assert.equal(new URL(recs).searchParams.get("from"), new Date(friday - 3600_000).toISOString().slice(0, 10));
  assert.equal(r.told.length, 1);
  r.clock.now += 10 * 60_000;
  assert.deepEqual(await r.zoom.poll(), { summaries: 0, transcripts: 0 }, "found by polling once, never twice");
});

test("zoom by polling only: a listing that failed does not move the mark, so the next one still reaches back to the last good one", async () => {
  const day = 24 * 3600_000;
  const opts: { recordingsFail?: boolean } = {};
  const r = rig(opts);
  const good = r.clock.now;
  await r.zoom.poll(); // both answered: the mark
  opts.recordingsFail = true;
  r.clock.now += 3 * day;
  await r.zoom.poll(); // recordings down: the mark stays
  opts.recordingsFail = false;
  r.clock.now += 3 * day;
  await r.zoom.poll();
  const listed = r.asked.filter((a) => a.url.includes("/meeting_summaries?")).at(-1)!.url;
  assert.equal(Date.parse(new URL(listed).searchParams.get("from")!), good - 3600_000, "back to the last listing where both answered");
});

// ---------- chat and meeting bugs: regression tests ----------

test("zoom: a recording that cannot be fetched does not hold back the transcripts behind it (given up after three tries)", async () => {
  const r = rig({ detail404: ["u-gone"] });
  await r.zoom.poll();
  r.world.recordings = [{ ...RECORDING, uuid: "u-gone", topic: "Borrada" }, { ...RECORDING, uuid: "u-ok", topic: "Planificación" }];
  const first = await r.zoom.poll();
  assert.equal(first.transcripts, 1, "the good one goes in the same look");
  assert.equal(r.queued[0]!.id, "zoom:u-ok");
  await r.zoom.poll();
  await r.zoom.poll();
  const tries = () => r.asked.filter((a) => a.url.includes(`/meetings/${encodeUuid("u-gone")}/recordings?`)).length;
  const before = tries();
  await r.zoom.poll();
  assert.equal(tries(), before, "after three tries it is not asked for again");
  assert.equal(r.queued.length, 1);
});

test("zoom: a meeting whose transcript went to the Mac is not told again when Zoom's own summary comes later", async () => {
  const r = rig();
  await r.zoom.poll();
  r.world.recordings = [RECORDING];
  assert.equal((await r.zoom.poll()).transcripts, 1);
  // Zoom's AI Companion summary of the same meeting appears an hour later.
  r.world.summaries = [{ meeting_uuid: RECORDING.uuid, meeting_topic: RECORDING.topic }];
  assert.equal((await r.zoom.poll()).summaries, 0, "the meeting was already sent to be summarized");
  assert.equal(r.told.length, 0, "the owner is not told the same meeting twice");
});
