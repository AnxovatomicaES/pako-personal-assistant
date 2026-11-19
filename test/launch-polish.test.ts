// Leftovers from the launch bug hunts, one test per item, each failing before its fix.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// 1. The brief page's clock follows the owner's region, as the chat's brief and the panel's other pages do.
test("the brief page writes the day's times on the owner's clock: 2:00 PM in the US, 14:00 elsewhere", async () => {
  const i18n = (await import(new URL("../src/panel/i18n.js", import.meta.url).href)) as {
    clockOf: (hm: string, locale: string) => string;
  };
  assert.equal(i18n.clockOf("14:00", "en-US").replace(/\s/g, " "), "2:00 PM");
  assert.equal(i18n.clockOf("09:05", "en-US").replace(/\s/g, " "), "9:05 AM");
  assert.equal(i18n.clockOf("14:00", "en-GB"), "14:00");
  assert.equal(i18n.clockOf("", "en-US"), "");
  const page = src("src/panel/brief-page.js");
  assert.doesNotMatch(page, /"time" \}, d\.time,/, "the day's start is written through clockOf, not as kept");
  assert.match(page, /clockOf\(d\.time/);
  assert.match(page, /clockOf\(d\.end/);
});

// 2. "+44 (0)7700 900123": the (0) after a country code is the trunk 0 a caller from abroad leaves out; kept, the number is wrong.
test('a "(0)" after the country code is dropped, in contacts, the owner\'s WhatsApp number and a typed number', async () => {
  const region = (await import("../src/region.ts")) as Record<string, unknown>;
  const drop = region.withoutTrunkZero as (raw: string) => string;
  assert.equal(typeof drop, "function");
  assert.equal(drop("+44 (0)7700 900123"), "+44 7700 900123");
  assert.equal(drop("0049 (0)30 1234567"), "0049 30 1234567");
  assert.equal(drop("+49(0)301234567"), "+49301234567");
  // A national number keeps its 0, and a bracket that is not "(0)" is left alone.
  assert.equal(drop("(0)7700 900123"), "(0)7700 900123");
  assert.equal(drop("+1 (415) 555-0100"), "+1 (415) 555-0100");
  const { phoneOf } = await import("../src/contacts.ts");
  assert.equal(phoneOf("+44 (0)7700 900123"), "+447700900123");
  assert.equal(phoneOf("+49 (0)30 1234567"), "+49301234567");
  const { ownerDigits } = await import("../src/whatsapp-computer.ts");
  assert.equal(ownerDigits("+44 (0)7700 900123"), "447700900123");
  assert.equal(ownerDigits("0049 (0)30 1234567"), "49301234567");
  assert.match(src("src/door/messages.ts"), /withoutTrunkZero\(raw\)/, "a number typed in the chat drops it too");
});

// 3. A bare `npm` in PowerShell runs npm.ps1, which Windows's default policy refuses: what these files tell a person to type says npm.cmd
// there (as #180 did for src/autostart-windows.ts and install.ps1), and npm on a Mac or Linux.
test("no message tells a Windows user to type a bare npm: npm.cmd there, npm elsewhere", async () => {
  const bareNpm = /(^|[\s`'"(;])npm (run|start|install)\b/;
  for (const f of ["bin/panel.cjs", "bin/preflight.cjs", "src/autostart.ts", "src/guard-http.ts"]) {
    const said = src(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && /["`]/.test(l) && bareNpm.test(l));
    assert.deepEqual(said, [], f);
  }
  const { npmCommand } = (await import("../src/i18n.ts")) as { npmCommand?: (p?: string) => string };
  assert.equal(npmCommand?.("win32"), "npm.cmd");
  assert.equal(npmCommand?.("darwin"), "npm");
  assert.equal(npmCommand?.("linux"), "npm");
  const { createRequire } = await import("node:module");
  const pre = createRequire(import.meta.url)("../bin/preflight.cjs") as { message: (f: object, platform?: string) => string };
  assert.match(pre.message({ problem: "install", missing: ["x"], all: true }, "win32"), /npm\.cmd install, then npm\.cmd start/);
  assert.match(pre.message({ problem: "install", missing: ["x"], all: true }, "darwin"), /run npm install, then npm start/);
});

// 4. Calendar writes made by the Mac app, and their Undo, when the Mac restarted mid-way or the event was not there.
test("calendar writes: a re-applied move keeps the original times, a delete of nothing says so, a re-sent delete keeps what to restore", async () => {
  const { createCalendarWrites, undoOf } = await import("../src/calendar-writes.ts");
  type W = import("../src/calendar-writes.ts").CalendarWrite;
  const MIN = 60_000;
  const T0 = Date.parse("2026-11-16T09:00:00Z");
  const m = new Map<string, string>();
  const clock = { now: T0 };
  const told: W[] = [];
  const q = createCalendarWrites({
    kv: { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) }, now: () => clock.now,
    onResult: async (w) => void told.push(structuredClone(w)),
  });
  const was = { start: T0 + 60 * MIN, end: T0 + 90 * MIN, title: "Dentist", calendarId: "C1" };
  // (a) The Mac moved it, restarted before answering, and was sent it again: the second time the event is already at the new times.
  await q.enqueue({ id: "mmmmmmmmmm", op: "move", eventId: "E1", at: was.start, start: T0 + 120 * MIN, end: T0 + 150 * MIN, title: "Dentist", was });
  await q.exchange([]);
  clock.now += 3 * MIN;
  await q.exchange([]);
  await q.exchange([{ id: "mmmmmmmmmm", ok: true, eventId: "E1", before: { start: T0 + 120 * MIN, end: T0 + 150 * MIN } }]);
  const moved = told.find((w) => w.id === "mmmmmmmmmm")!;
  assert.deepEqual(moved.result?.before, { start: was.start, end: was.end }, "Undo puts it back where it was, not where it is");
  assert.equal(undoOf(moved, "u")!.start, was.start);
  // (b) A delete of an event that is not there (an older app answers ok with nothing before; this one says notFound): not "deleted".
  await q.enqueue({ id: "dddddddddd", op: "delete", eventId: "E2", at: was.start, title: "Dentist", was });
  await q.exchange([]);
  await q.exchange([{ id: "dddddddddd", ok: true }]);
  const nothing = told.find((w) => w.id === "dddddddddd")!;
  assert.equal(nothing.status, "failed");
  assert.match(nothing.error!, /wasn't found/);
  await q.enqueue({ id: "eeeeeeeeee", op: "delete", eventId: "E3", at: was.start, title: "Dentist", was });
  await q.exchange([]);
  await q.exchange([{ id: "eeeeeeeeee", ok: false, notFound: true, error: "it wasn't found on this Mac's calendars" }]);
  assert.match(told.find((w) => w.id === "eeeeeeeeee")!.error!, /wasn't found/);
  // (c) A delete sent again after a restart: the first try deleted it, the second finds nothing. Undo still has what to bring back.
  await q.enqueue({ id: "ffffffffff", op: "delete", eventId: "E4", at: was.start, title: "Dentist", was });
  await q.exchange([]);
  clock.now += 3 * MIN;
  await q.exchange([]);
  await q.exchange([{ id: "ffffffffff", ok: true }]);
  const resent = told.find((w) => w.id === "ffffffffff")!;
  assert.equal(resent.status, "done");
  assert.deepEqual(resent.result?.before, was);
  assert.equal(undoOf(resent, "u2")!.op, "create");
  // The door keeps the event as the calendar showed it when the owner said yes.
  assert.match(src("src/door/calendar-cards.ts"), /was: \{ start: e\.start, end: e\.end/);
  // The Mac app keeps the first try's "before" per write, and says when a delete found nothing.
  const swift = src("desktop/mac/Discovery.swift");
  assert.match(swift, /rememberedBefore\(id\)/);
  assert.match(swift, /"notFound": true/);
});

// 5. A meeting held twice in a day under one title (a 9:00 and a 16:00 "Sync") gets a prep for each: a prep is one event at one start.
test("meeting prep: the same title twice in a day is two meetings, each with its own prep; the same one asked twice is one", async () => {
  const { createBriefV2 } = await import("../src/brief-v2.ts");
  const T0 = Date.parse("2026-11-16T09:00:00Z");
  const m = new Map<string, string>();
  const queued: unknown[] = [];
  const v2 = createBriefV2({
    config: { waitMs: 15 * 60_000 }, kv: { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) }, timeZone: "Europe/London",
    now: () => T0, sources: {}, enqueue: async (x) => (queued.push(x), true), plain: async () => undefined, notify: async () => undefined,
  });
  const facts = [{ label: "Calendar · Sync", text: "The meeting: Sync" }];
  const morning = (await v2.prepMeeting({ event: "E1", title: "Sync", at: T0 + 40 * 60_000, facts }))!;
  const again = (await v2.prepMeeting({ event: "E1", title: "Sync", at: T0 + 40 * 60_000, facts }))!;
  assert.equal(again.id, morning.id, "the same meeting asked twice: one prep");
  const afternoon = (await v2.prepMeeting({ event: "E2", title: "Sync", at: T0 + 7 * 3600_000, facts }))!;
  assert.notEqual(afternoon.id, morning.id, "the afternoon's Sync is its own meeting");
  assert.equal(queued.length, 2);
  assert.match(src("src/meeting-prep.ts"), /d\.prep\(\{ event: e\.id, /);
});

// 6. The chat's glow (.chat::before) reaches 20% past each side of the box; with overflow: hidden the box is still a scroll container, so a
// focus or scrollIntoView after "Skip" on the welcome scrolled it sideways (66px on a 330px box). overflow: clip cuts it and never scrolls.
test("the chat box cannot be scrolled sideways by its wider glow: overflow: clip, on the box and its header", () => {
  const css = src("src/panel/app.css");
  assert.match(css, /^\.chat::before \{[^}]*left: -20%; right: -20%/m, "the layer wider than the box");
  // After the rules that say overflow: hidden (kept for a browser without clip), so it wins.
  const clip = css.indexOf(".chat, .chat-head { overflow: clip; }");
  assert.ok(clip > css.indexOf(".chat { position: fixed;") && clip > css.indexOf(".chat-head { position: relative;"), "clip after hidden");
});

// 7. The export's last line of defence: every secret value this computer holds is searched for and replaced. The owner's WhatsApp set up in
// the panel (secrets.json whatsappComputer: Meta's app secret, access token, webhook token) is one of them.
test("export: the WhatsApp settings saved from the panel are among the secrets the export never carries", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { exportData } = await import("../src/data.ts");
  const dir = mkdtempSync(join(tmpdir(), "pako-export-wa-"));
  try {
    const wa = { appSecret: "a".repeat(32), accessToken: `EAAG${"t".repeat(60)}`, verifyToken: "v".repeat(32), appId: "1234567890", ownerNumber: "447700900123" };
    writeFileSync(join(dir, "secrets.json"), JSON.stringify({ whatsappComputer: wa }), { mode: 0o600 });
    const said = `Here: ${wa.accessToken} and ${wa.appSecret} and ${wa.verifyToken}`;
    const store = { get: async (k: string) => (k === "assistant-log" ? JSON.stringify([{ at: 1, kind: "note", text: said }]) : null), set: async () => undefined };
    const text = JSON.stringify(await exportData({ store, dir, env: {}, lang: "en" }));
    for (const k of ["appSecret", "accessToken", "verifyToken"] as const) assert.ok(!text.includes(wa[k]), `the export carries WhatsApp's ${k}`);
    assert.match(text, /Here: \[secret: not exported\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 8. Without Zoom the panel still asks for its meetings at every load: a 404 there was a red console error each time. An empty list, said.
test("GET /panel/api/meetings without Zoom: 200, no meetings and connected: false; the panel's card stays hidden", async () => {
  const express = (await import("express")).default;
  const { mountMeetingsPanel } = await import("../src/meeting-review.ts");
  const app = express();
  mountMeetingsPanel(app, { signedIn: () => true, recent: null });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const r = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/panel/api/meetings`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { meetings: [], connected: false });
  } finally {
    server.close();
  }
  const page = src("src/panel/meetings.js");
  assert.match(page, /body\?\.connected === false/, "the card is not shown when Zoom is not connected");
});

// 9. With no claude command on this computer every message got "I couldn't work out an answer just now. Try again in a moment.", which
// trying again never fixes. It says what is wrong and the fix, in the panel's words (src/panel/app.js BANNERS.missing).
test("no claude command: the answer says Claude is missing and how to connect it, as the panel does, not 'try again'", async () => {
  const { runClaude, ClaudeError } = await import("../assistant/bridge.ts");
  const { classify } = await import("../assistant/bridge/claude.ts");
  const { T } = await import("../assistant/bridge/texts.ts");
  const err = await runClaude("x", { claudeBin: "/nonexistent/claude", tools: [], model: "", runTimeoutMs: 5_000 } as never).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof ClaudeError);
  assert.equal((err as InstanceType<typeof ClaudeError>).kind, "missing");
  // The warm process says it the same way (assistant/bridge/warm.ts classifies its "could not start" line).
  assert.equal(classify("could not start claude: spawn claude ENOENT"), "missing");
  assert.equal(classify("something else broke"), "other");
  const said = T()("missing" as never);
  assert.match(said, /Pako needs Claude to think/);
  assert.match(said, /Connect your Claude account/);
  assert.doesNotMatch(said, /Try again in a moment/);
  assert.match(src("src/panel/app.js"), /h\("b", \{\}, "Pako needs Claude to think\. "\),\s*claudeLink\("Connect your Claude account"\)/);
});
