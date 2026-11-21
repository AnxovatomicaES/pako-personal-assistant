// The watchdog (src/watchdog.ts): a part that stays broken is told once, on the chat that still works, with what failed, since when and what
// to do; its recovery in one line. The quiet hours hold what can wait. Incidents survive a restart. The assistant computer's version is
// compared with the server's. And the routes: POST /assistant/health on a server, the panel's Health card.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp, loadAppConfig } from "../src/app.ts";
import type { Kv } from "../src/kv.ts";
import {
  bridgeBehind, createWatchdog, loadWatchdogConfig, readBridgeReport, readServerVersion, reportingKv, type ClaudeState, type WatchdogDeps,
} from "../src/watchdog.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Monday 16 November 2026, 12:00 in Madrid (11:00 UTC): outside the quiet hours. */
const NOON = Date.UTC(2026, 10, 16, 11, 0);
/** The same day at 02:00 in Madrid: inside 23:00-08:00. */
const NIGHT = Date.UTC(2026, 10, 16, 1, 0);

function memoryKv(): Kv & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: async (k) => map.get(k) ?? null, set: async (k, v) => void map.set(k, v) };
}

/** `polling`: the assistant's computer asks for messages all the time (its last request is always now). */
function rig(o: Partial<WatchdogDeps> & { at?: number; kv?: Kv | null; polling?: boolean } = {}) {
  const clock = { t: o.at ?? NOON };
  const said: string[] = [];
  const dog = createWatchdog({
    config: { on: true, quiet: { start: 23 * 60, end: 8 * 60 } },
    local: false,
    timeZone: "Europe/Madrid",
    now: () => clock.t,
    notify: () => async (text: string) => void said.push(text),
    log: () => undefined,
    ...o,
    ...(o.polling ? { lastPoll: () => clock.t } : {}),
    kv: o.kv === undefined ? memoryKv() : o.kv,
  });
  // As server.ts does once it listens (its minute timer does not hold the process).
  dog.start();
  return {
    dog,
    said,
    clock,
    /** Lets every pending notice be said. */
    settle: async () => {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setImmediate(r));
        await dog.settled();
      }
    },
  };
}

test("a connection that fails 3 rounds over 5 minutes is told once, with what failed, since when and what to do; its recovery in one line", async () => {
  const r = rig();
  r.dog.watch("slack");
  for (let i = 0; i < 6; i++) {
    r.dog.report("slack", false, "Slack auth.test: token_revoked");
    r.clock.t += 2 * MIN;
    await r.settle();
  }
  assert.equal(r.said.length, 1, "once per incident, however many rounds fail after");
  assert.equal(
    r.said[0],
    "⚠️ Slack is failing (Slack auth.test: token_revoked), since 12:00.\n"
      + "What to do: check the Slack token (SLACK_USER_TOKEN) in the server's settings: it may have been revoked.",
  );
  assert.equal(r.dog.state().parts.find((p) => p.key === "slack")?.status, "down");
  r.dog.report("slack", true);
  r.dog.report("slack", true);
  await r.settle();
  assert.deepEqual(r.said.slice(1), ["✅ Slack works again (it was failing since 12:00)."]);
  assert.equal(r.dog.state().parts.find((p) => p.key === "slack")?.status, "ok");
});

test("HEALTH in words: what is down with what to do, what fails for now, what is not heard yet, and what works; nothing watched is said too", async () => {
  const empty = rig();
  assert.equal(empty.dog.summary(), "✅ I see nothing failing. I have no connection to watch yet.");
  const r = rig();
  r.dog.watch("calendar");
  r.dog.report("store", true);
  r.dog.report("telegram", true);
  r.dog.report("zoom", false, "HTTP 500");
  for (let i = 0; i < 3; i++) {
    r.dog.report("slackEvents", false, "Socket Mode: token_revoked");
    r.clock.t += 3 * MIN;
    await r.settle();
  }
  assert.equal(r.said.length, 1);
  assert.equal(
    r.dog.summary(),
    "⚠️ Slack's connection for new messages (Socket Mode) is failing (Socket Mode: token_revoked), since 12:00.\n"
      + "What to do: check the Socket Mode token (SLACK_APP_TOKEN) in the server's settings, and that Socket Mode is still on in the Slack app.\n"
      + "• Zoom has been failing since 12:00 (HTTP 500). If it goes on, I'll tell you.\n"
      + "• The calendar: nothing heard yet.\n"
      + "✅ Working: the data store, Telegram.",
  );
  assert.equal(r.said[0], r.dog.summary().split("\n").slice(0, 2).join("\n"), "the notice's own words");
  const en = rig({ lang: () => "en" });
  en.dog.report("store", true);
  assert.equal(en.dog.summary(), "✅ Working: the data store.");
  const off = createWatchdog({ config: { on: false, quiet: null }, local: true, timeZone: "Europe/Madrid", notify: () => null, kv: null });
  assert.match(off.summary(), /^The watchdog is off \(WATCHDOG=off\)/);
});

test("three quick failures that come back within 5 minutes are a blip: nothing is said", async () => {
  const r = rig();
  for (let i = 0; i < 3; i++) {
    r.dog.report("telegram", false, "network error");
    r.clock.t += MIN;
  }
  r.dog.report("telegram", true);
  await r.settle();
  assert.deepEqual(r.said, []);
  assert.equal(r.dog.state().parts.find((p) => p.key === "telegram")?.status, "ok");
});

test("a store that keeps failing (a second failed write a minute later) is told at once, even in the quiet hours; a connection waits", async () => {
  const r = rig({ at: NIGHT });
  r.dog.report("store", false, "ECONNREFUSED");
  await r.settle();
  assert.deepEqual(r.said, [], "one failed write could be a blip");
  r.clock.t += MIN;
  r.dog.report("store", false, "ECONNREFUSED");
  await r.settle();
  assert.equal(r.said.length, 1);
  assert.match(r.said[0]!, /^⚠️ I can't save anything \(ECONNREFUSED\): what you tell me now may be lost, since 02:00\.\nWhat to do: check the server's data store/);
  for (let i = 0; i < 4; i++) {
    r.dog.report("zoom", false, "Zoom answered 401");
    r.clock.t += 2 * MIN;
  }
  await r.dog.tick();
  await r.settle();
  assert.equal(r.said.length, 1, "Zoom waits: it is the quiet hours");
  assert.equal(r.dog.state().parts.find((p) => p.key === "zoom")?.status, "down");
  r.clock.t = NIGHT + 7 * HOUR + 5 * MIN; // 08:05
  await r.dog.tick();
  await r.settle();
  assert.equal(r.said.length, 2);
  assert.match(r.said[1]!, /^⚠️ Zoom is failing \(Zoom answered 401\), since 02:01\.\nWhat to do: check the Zoom app/);
});

test("a part that breaks and comes back during the night is never mentioned", async () => {
  const r = rig({ at: NIGHT });
  for (let i = 0; i < 4; i++) {
    r.dog.report("calendar", false, "ICS: calendar.google.com: 503");
    r.clock.t += 2 * MIN;
  }
  await r.dog.tick();
  r.dog.report("calendar", true);
  r.clock.t = NIGHT + 7 * HOUR + 5 * MIN;
  await r.dog.tick();
  await r.settle();
  assert.deepEqual(r.said, []);
});

test("the assistant's computer silent for 15 minutes is told at night too, and back once it asks again", async () => {
  let lastPoll = NIGHT;
  const r = rig({ at: NIGHT, lastPoll: () => lastPoll });
  r.clock.t = NIGHT + 14 * MIN;
  await r.dog.tick();
  await r.settle();
  assert.deepEqual(r.said, [], "14 minutes is not yet down");
  r.clock.t = NIGHT + 16 * MIN;
  await r.dog.tick();
  await r.settle();
  assert.equal(r.said.length, 1);
  assert.equal(
    r.said[0],
    "⚠️ Your assistant gets no messages: its computer has stopped asking me for them, since 02:00.\n"
      + "What to do: check that computer is on, awake and online, and that the assistant is still running "
      + "(tail -f ~/.pako-assistant/assistant.log, or ~/.ai-buyer-assistant/assistant.log if it was set up before Pako had its name).",
  );
  await r.dog.tick();
  await r.settle();
  assert.equal(r.said.length, 1, "told once");
  // Back at 07:00: still the quiet hours, so the recovery line waits for 08:00.
  r.clock.t = NIGHT + 5 * HOUR;
  lastPoll = r.clock.t;
  await r.dog.tick();
  await r.settle();
  assert.equal(r.said.length, 1);
  assert.equal(r.dog.state().parts.find((p) => p.key === "bridge")?.status, "ok");
  r.clock.t = NIGHT + 7 * HOUR;
  lastPoll = r.clock.t;
  await r.dog.tick();
  await r.settle();
  assert.deepEqual(r.said.slice(1), ["✅ Your assistant's computer works again (it was failing since 02:00)."]);
});

test("Claude signed out for 15 minutes is told with what to do on that computer; its usage limit is not an incident", async () => {
  const r = rig({ polling: true });
  r.dog.bridgeReport({ claude: "limit" });
  await r.settle();
  r.clock.t += HOUR;
  await r.dog.tick();
  await r.settle();
  assert.deepEqual(r.said, []);
  assert.equal(r.dog.state().parts.find((p) => p.key === "claude")?.status, "warn");
  assert.match(r.dog.summary(), /• Claude has reached its usage limit: it comes back by itself when that renews\./);
  // The reset the computer said with its numbers is in the summary, in the owner's clock.
  const usage = { day: "2026-11-14", interactive: 1, background: 2, perDay: 40, skipped: { cap: 0, paused: 3, same: 0 }, pausedUntil: r.clock.t + 2 * HOUR };
  r.dog.bridgeReport({ usage });
  assert.match(r.dog.summary(), /when that renews, around \d{2}:\d{2}\. What needs it waits; nothing is lost\./);
  r.dog.bridgeReport({ claude: "login" });
  await r.settle();
  r.clock.t += 10 * MIN;
  await r.dog.tick();
  await r.settle();
  assert.deepEqual(r.said, []);
  r.clock.t += 6 * MIN;
  await r.dog.tick();
  await r.settle();
  assert.deepEqual(r.said, [
    "⚠️ Claude does not answer on your assistant's computer (not signed in), since 13:00.\n"
      + "What to do: on that computer, open Terminal, type claude and sign in.",
  ]);
  r.dog.bridgeReport({ claude: "ok" });
  await r.settle();
  assert.equal(r.said[1], "✅ Claude works again (it was failing since 13:00).");
});

test("on a computer: Claude not signed in is the Claude keeper's one notice, not the watchdog's; not installed is told with the panel's button", async () => {
  let claude: ClaudeState = "login";
  const r = rig({ local: true, lang: () => "en", claude: () => claude });
  await r.dog.tick();
  r.clock.t += 16 * MIN;
  await r.dog.tick();
  await r.settle();
  assert.deepEqual(r.said, [], "src/claude-connect.ts tells it once, with its Sign in again button");
  assert.equal(r.dog.state().parts.find((p) => p.key === "claude")?.detail, "login", "the Health card still shows it");
  claude = "ok";
  await r.dog.tick();
  await r.settle();
  assert.deepEqual(r.said, [], "nothing was told, so nothing is over");
  // Not installed at all: the connections page's button installs it.
  claude = "missing";
  await r.dog.tick();
  r.clock.t += 16 * MIN;
  await r.dog.tick();
  await r.settle();
  assert.equal(
    r.said[0],
    "⚠️ Claude does not answer on this computer (the claude command is not installed), since 12:16.\n"
      + "What to do: in Pako's settings, press “Connect your Claude account”.",
  );
  assert.equal(r.dog.state().parts.some((p) => p.key === "bridge"), false, "a computer has no bridge to watch");
});

test("a restart neither repeats an incident nor forgets to say it is over: the incidents are kept in the store", async () => {
  const kv = memoryKv();
  const first = rig({ kv });
  first.dog.report("store", false, "disk full");
  first.clock.t += MIN;
  first.dog.report("store", false, "disk full");
  await first.settle();
  assert.equal(first.said.length, 1);
  assert.match(kv.map.get("watchdog") ?? "", /"store":\{"since":\d+,"told":true\}/);

  const second = rig({ kv, at: NOON + HOUR });
  second.dog.report("store", false, "disk full");
  await second.settle();
  assert.deepEqual(second.said, [], "the same incident, already told before the restart");
  second.dog.report("store", true);
  await second.settle();
  assert.deepEqual(second.said, ["✅ The data store works again (it was failing since 12:00)."]);
  assert.equal(kv.map.get("watchdog"), "{}");
});

test("after a restart, an incident of a part met later (the computer, once the server listens) is kept, and its recovery said", async () => {
  const kv = memoryKv();
  kv.map.set("watchdog", JSON.stringify({ bridge: { since: NOON - HOUR, told: true }, zoom: { since: NOON - HOUR, told: true } }));
  const r = rig({ kv, polling: true });
  r.dog.report("store", true); // the store's first write reads what was kept, before the computer's part is met
  await r.settle();
  await r.dog.tick();
  await r.settle();
  assert.deepEqual(r.said, ["✅ Your assistant's computer works again (it was failing since 11:00)."]);
  assert.deepEqual(JSON.parse(kv.map.get("watchdog")!), { zoom: { since: NOON - HOUR, told: true } }, "Zoom's waits for Zoom's next round");
});

test("the assistant's computer more than a day behind is told once, with why it does not update itself; up to date again in one line", async () => {
  const server = { sha: "a".repeat(40), committedAt: NOON - HOUR };
  const r = rig({ polling: true, serverVersion: () => server });
  r.dog.bridgeReport({ version: { sha: "b".repeat(40), committedAt: NOON - 3 * DAY, autoupdate: "local changes" } });
  await r.settle();
  assert.equal(r.said.length, 1);
  assert.equal(
    r.said[0],
    "⚠️ Your assistant's computer still runs an old version (bbbbbbb, from 13 November) and the server is more than a day ahead, since 12:00.\n"
      + "What to do: on that computer, in the Pako folder, type git pull and restart the assistant (it does not update itself: local changes).",
  );
  const st = r.dog.state();
  assert.equal(st.bridge?.behind, true);
  assert.equal(st.server?.sha, server.sha);
  r.dog.bridgeReport({ version: { sha: "a".repeat(40), committedAt: NOON - HOUR, updatedAt: NOON + MIN, autoupdate: "on" } });
  await r.settle();
  assert.deepEqual(r.said.slice(1), ["✅ Your assistant's computer is up to date again (aaaaaaa)."]);
});

test("behind means more than a day older by the commits' times, else a different version for more than a day", () => {
  const server = { sha: "a".repeat(40), committedAt: NOON };
  const bridge = (committedAt: number, sha = "b".repeat(40)) => ({ sha, committedAt });
  assert.equal(bridgeBehind(server, bridge(NOON - 2 * HOUR), null, NOON), false, "a few hours behind is fine");
  assert.equal(bridgeBehind(server, bridge(NOON - DAY - MIN), null, NOON), true);
  assert.equal(bridgeBehind(server, bridge(NOON - 9 * DAY, "aaaaaaa"), null, NOON), false, "the same commit, by its short form");
  const noTime = { sha: "a".repeat(40), committedAt: null };
  assert.equal(bridgeBehind(noTime, bridge(NOON - 9 * DAY), NOON - HOUR, NOON), false);
  assert.equal(bridgeBehind(noTime, bridge(NOON - 9 * DAY), NOON - DAY - MIN, NOON), true);
});

test("the server's version: Render's commit with its time from git, or nothing outside a checkout", () => {
  const sha = "c".repeat(40);
  assert.deepEqual(readServerVersion({ RENDER_GIT_COMMIT: sha }, "/", () => `${sha} 1763290800\n`), { sha, committedAt: 1763290800_000 });
  assert.deepEqual(readServerVersion({ RENDER_GIT_COMMIT: sha }, "/", () => { throw new Error("no git"); }), { sha, committedAt: null });
  assert.equal(readServerVersion({}, "/", () => { throw new Error("no git"); }), null);
});

test("settings: on by default, quiet hours from WATCHDOG_QUIET_HOURS, else SLACK_QUIET_HOURS, else 23:00-08:00", () => {
  assert.deepEqual(loadWatchdogConfig({}), { config: { on: true, quiet: { start: 1380, end: 480 } }, problems: [] });
  assert.deepEqual(loadWatchdogConfig({ SLACK_QUIET_HOURS: "22:30-07:00" }).config.quiet, { start: 1350, end: 420 });
  assert.equal(loadWatchdogConfig({ WATCHDOG_QUIET_HOURS: "off", SLACK_QUIET_HOURS: "22:30-07:00" }).config.quiet, null);
  assert.equal(loadWatchdogConfig({ WATCHDOG: "off" }).config.on, false);
  assert.deepEqual(loadWatchdogConfig({ WATCHDOG_QUIET_HOURS: "late" }).problems, ["WATCHDOG_QUIET_HOURS must be like 23:00-08:00, or off (23:00-08:00 is used)"]);
});

test("nothing is said before the server listens; what failed meanwhile is said at its first look", async () => {
  const said: string[] = [];
  let t = NOON;
  const dog = createWatchdog({
    config: { on: true, quiet: null }, local: true, timeZone: "Europe/Madrid", now: () => t, notify: () => async (s: string) => void said.push(s), log: () => undefined,
  });
  dog.report("store", false, "ENOSPC");
  t += MIN;
  dog.report("store", false, "ENOSPC");
  await dog.tick();
  await dog.settled();
  assert.deepEqual(said, [], "an app that is only built (most tests) keeps count silently");
  dog.start();
  await dog.tick();
  await dog.settled();
  dog.stop();
  assert.equal(said.length, 1);
  assert.match(said[0]!, /^⚠️ Pako couldn't save to disk \(ENOSPC\)\. Changes since 12:00 may be lost\.\nWhat to do: check the disk has free space and the ~\/\.pako folder can be written to\.$/);
});

test("WATCHDOG=off: the panel still shows each part, and nothing is said", async () => {
  const r = rig({ config: { on: false, quiet: null } });
  r.dog.report("store", false, "EIO");
  await r.dog.tick();
  await r.settle();
  assert.deepEqual(r.said, []);
  assert.equal(r.dog.state().on, false);
});

test("a store that fails a write says so to the watchdog and still throws to its caller", async () => {
  const seen: [boolean, string?][] = [];
  let fail = false;
  const kv = reportingKv({ get: async () => null, set: async () => { if (fail) throw new Error("READONLY"); } }, (ok, detail) => seen.push([ok, detail]));
  await kv.set("k", "v", 10);
  fail = true;
  await assert.rejects(kv.set("k", "v", 10), /READONLY/);
  assert.deepEqual(seen, [[true, undefined], [false, "READONLY"]]);
});

test("what the assistant's computer may say: claude's state and its version, nothing else", () => {
  assert.deepEqual(readBridgeReport({ claude: "login" }), { claude: "login" });
  assert.equal(readBridgeReport({ claude: "maybe" }), null);
  assert.equal(readBridgeReport({}), null);
  assert.equal(readBridgeReport({ version: { sha: "not a sha", committedAt: 1 } }), null);
  assert.deepEqual(readBridgeReport({ version: { sha: "abcdef1", committedAt: 5, autoupdate: "<b>local changes</b>\n" } }), {
    version: { sha: "abcdef1", committedAt: 5, autoupdate: "b local changes /b" },
  });
});

// ---------- the routes, on a hosted app built as src/server.ts builds it ----------

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

test("a server takes the computer's word on POST /assistant/health (its token only) and shows every part on the panel's Health card", async () => {
  const token = "b".repeat(48);
  const env: Record<string, string | undefined> = {
    PERSONAL_CALLER_TOKEN: "t".repeat(32),
    PERSONAL_OWNER_NAME: "Ana",
    PERSONAL_OWNER_NUMBER: "+34600111222",
    WHATSAPP_ACCESS_TOKEN: "EAAB_made_up_value",
    WHATSAPP_PHONE_NUMBER_ID: "109876543210",
    WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
    WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
    ASSISTANT_BRIDGE_TOKEN: token,
    PUBLIC_URL: "https://pako.example.com",
    RENDER_GIT_COMMIT: "d".repeat(40),
  };
  const app = createApp(loadAppConfig(env), env);
  const server = createServer(app);
  const base = await listen(server);
  try {
    const post = (body: unknown, auth = token) =>
      fetch(`${base}/assistant/health`, { method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ claude: "ok" }, "x".repeat(48))).status, 401);
    assert.equal((await post({ claude: "sometimes" })).status, 400);
    assert.equal((await post({ claude: "ok", version: { sha: "e".repeat(40), committedAt: Date.now() - 3 * DAY, autoupdate: "on" } })).status, 200);

    assert.equal((await fetch(`${base}/panel/api/health`)).status, 401, "the panel's session only");
    const link = new URL((app.locals.panelLink as () => string)());
    const signIn = await fetch(`${base}${link.pathname}`, { redirect: "manual" });
    const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0]!;
    const res = await fetch(`${base}/panel/api/health`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { on: boolean; parts: { key: string; status: string }[]; bridge: { sha: string; behind: boolean } };
    assert.equal(body.on, true);
    assert.deepEqual(body.parts.map((p) => p.key), ["bridge", "claude", "whatsapp", "update"], "what this server has: its computer, Claude, WhatsApp, the version");
    assert.equal(body.parts.find((p) => p.key === "claude")?.status, "ok");
    assert.equal(body.bridge.sha, "e".repeat(40));
    assert.equal(body.bridge.behind, false, "the server's commit time is not known here, and the versions have differed for less than a day");
    // The page's script is served, and named on the page.
    assert.equal((await fetch(`${base}/panel/assets/health.js`)).status, 200);
    assert.match(await (await fetch(`${base}/panel`, { headers: { cookie } })).text(), /\/panel\/assets\/health\.js/);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("a store that drops one write now and then is a blip each time: nothing is said, and the panel shows it was failing", async () => {
  const r = rig({ kv: null });
  let n = 0;
  const kv = reportingKv({ get: async () => null, set: async () => { if (++n % 10 === 0) throw new Error("ECONNRESET"); } }, r.dog.reporter("store"));
  for (let i = 0; i < 60; i++) {
    // A write every 5 minutes for 5 hours, one in ten failing, and the minute's look in between.
    r.clock.t += 5 * MIN;
    await kv.set("k", "v", 10).catch(() => undefined);
    await r.dog.tick();
    await r.settle();
  }
  assert.deepEqual(r.said, [], "6 blips, none told");
});

test("a store whose one write failed and then nothing good comes for ten minutes is an incident, said by the minute's look", async () => {
  const r = rig();
  r.dog.report("store", false, "ETIMEDOUT");
  r.clock.t += 9 * MIN;
  await r.dog.tick();
  await r.settle();
  assert.deepEqual(r.said, []);
  r.clock.t += MIN;
  await r.dog.tick();
  await r.settle();
  assert.equal(r.said.length, 1);
  assert.match(r.said[0]!, /^⚠️ I can't save anything \(ETIMEDOUT\)/);
});

test("a part that fails again soon after its recovery was said waits before it is said; one that ends before that is never said", async () => {
  const r = rig();
  const outage = async (minutes: number) => {
    for (let i = 0; i < minutes; i++) {
      r.dog.report("zoom", false, "Zoom answered 500");
      r.clock.t += MIN;
      await r.dog.tick();
      await r.settle();
    }
    r.dog.report("zoom", true);
    await r.settle();
  };
  await outage(10);
  assert.equal(r.said.length, 2, "the first incident and its recovery");
  r.clock.t += HOUR;
  await outage(10);
  assert.equal(r.said.length, 2, "a short repeat within six hours: shown on the panel, not said");
  r.clock.t += HOUR;
  for (let i = 0; i < 6; i++) r.dog.report("zoom", false, "Zoom answered 500"), (r.clock.t += MIN);
  await r.dog.tick();
  await r.settle();
  assert.equal(r.dog.state().parts.find((p) => p.key === "zoom")?.status, "down", "the panel shows it at once");
  assert.equal(r.said.length, 2);
  r.clock.t += 30 * MIN;
  await r.dog.tick();
  await r.settle();
  assert.equal(r.said.length, 3, "a repeat that lasts is said");
  assert.match(r.said[2]!, /^⚠️ Zoom is failing/);
  // Six hours after the last recovery said, a new incident is said at once again.
  r.dog.report("zoom", true);
  await r.settle();
  r.clock.t += 7 * HOUR;
  await outage(10);
  assert.match(r.said.at(-2)!, /^⚠️ Zoom is failing/);
});

test("on a computer: Meta refusing the WhatsApp webhook for long is told with the panel's card as the thing to do, not a server's token", async () => {
  const r = rig({ local: true, lang: () => "en" });
  const wa = r.dog.reporter("whatsapp");
  const why = "Meta hasn't accepted the tunnel's address yet (code 2). I'll keep trying by myself.";
  wa(false, why);
  r.clock.t += 3 * MIN;
  wa(false, why);
  r.clock.t += 3 * MIN;
  wa(false, why);
  await r.dog.tick();
  await r.settle();
  assert.equal(r.said.length, 1, JSON.stringify(r.said));
  assert.match(r.said[0]!, /^⚠️ WhatsApp/);
  assert.match(r.said[0]!, /open the WhatsApp card in the panel: Meta is not accepting the tunnel's address/);
  assert.doesNotMatch(r.said[0]!, /WHATSAPP_ACCESS_TOKEN/);
  wa(true);
  await r.dog.tick();
  await r.settle();
  assert.match(r.said[1]!, /^✅ WhatsApp/);
});
