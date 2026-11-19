// Every connection's status in one look (src/connections-status.ts): connected, needs something, not set, or failing, from the settings, the
// watchdog's parts, Telegram's pairing, this Mac's calendars and contacts; and the suggestion built on what the Mac found.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connectionsStatus, mountConnectionsStatus } from "../src/connections-status.ts";
import type { Discovery } from "../src/discovery.ts";
import type { HealthState } from "../src/watchdog.ts";
import { APP, auth, serve } from "./helpers/connect-rig.ts";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const FOUND: Discovery = {
  at: NOW,
  apps: { zoom: true, slack: true, telegram: true, whatsapp: false, mail: true, outlook: false, teams: false },
  calendars: [{ id: "c1", title: "Trabajo", source: "iCloud", color: "", writable: true }, { id: "c2", title: "Casa", source: "iCloud", color: "", writable: true }],
  mailAccounts: [{ address: "ana@gmail.com", name: "Ana", provider: "google", kind: "imap" }],
  contacts: { count: 120 },
  zoomRecordings: { folder: "/Users/ana/Documents/Zoom", count: 2 },
  permissions: { calendars: "granted", contacts: "granted", mail: "granted" },
};
const health = (parts: HealthState["parts"]): HealthState => ({ on: true, quietNow: false, parts, bridge: null, server: null });
const by = (list: ReturnType<typeof connectionsStatus>) => Object.fromEntries(list.map((c) => [c.id, c]));

test("nothing set up: every connection is notSet, with a suggestion from what the Mac found", () => {
  const s = by(connectionsStatus({ env: {}, stored: {}, fromStore: new Set(), lang: "en", discovery: FOUND, now: NOW }));
  assert.equal(s.imap!.state, "notSet");
  assert.match(s.imap!.suggestion, /ana@gmail\.com/);
  assert.match(s.calendar!.suggestion, /2 calendars/);
  assert.match(s.zoom!.suggestion, /you record here/);
  assert.match(s.slack!.suggestion, /one click/);
  assert.match(s.contacts!.suggestion, /120 contacts/);
  assert.equal(s.telegram!.state, "notSet");
  assert.equal(s.claude!.state, "connected", "Claude needs nothing set: the plan's sign-in is the default");
  const blind = by(connectionsStatus({ env: {}, stored: {}, fromStore: new Set(), lang: "en", now: NOW }));
  assert.match(blind.calendar!.suggestion, /look at what's on this Mac/, "before the Mac looked: offer the look");
});

test("set up: the watchdog's incident is an error, its failures need a look, a problem is an error; Telegram unpaired needs action", () => {
  const env = { SLACK_USER_TOKEN: `xoxp-${"1".repeat(30)}`, SLACK_APP_TOKEN: `xapp-${"2".repeat(30)}`, IMAP_HOST: "imap.gmail.com", IMAP_USER: "a", IMAP_PASSWORD: "p" };
  const s = by(connectionsStatus({
    env, stored: {}, fromStore: new Set(), lang: "en", now: NOW, telegram: "unpaired",
    health: health([
      { key: "slack", status: "ok", okAt: NOW - 1000, failSince: null, detail: "" },
      { key: "slackEvents", status: "down", okAt: NOW - 9e6, failSince: NOW - 600_000, detail: "invalid_auth" },
    ]),
    problems: { imap: "the login was refused" },
    macCalendar: { at: NOW - 3600_000, calendars: 2, events: 14 },
    contacts: 30,
  }));
  assert.equal(s.slack!.state, "error");
  assert.equal(s.slack!.detail, "invalid_auth");
  assert.equal(s.slack!.lastCheck, NOW - 1000);
  assert.equal(s.imap!.state, "error");
  assert.equal(s.telegram!.state, "needsAction");
  assert.equal(s.macCalendar!.state, "needsAction", "the Mac has not pushed for an hour");
  assert.equal(s.macCalendar!.detail, "14 events from 2 calendars");
  assert.equal(s.contacts!.state, "connected");
  const partial = by(connectionsStatus({ env: { ZOOM_ACCOUNT_ID: "x" }, stored: {}, fromStore: new Set(), lang: "en", now: NOW }));
  assert.equal(partial.zoom!.state, "needsAction");
});

test("the status route answers the panel and the Mac app, even when a piece cannot be read; a server answers 404", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pako-st-"));
  const p = await serve((app) => mountConnectionsStatus(app, {
    ...auth, env: { PAKO_HOME: dir }, lang: () => "en", dir, fromStore: () => new Set(), now: () => NOW,
    discovery: { read: async () => { throw new Error("store"); }, write: async () => undefined, forget: async () => undefined },
    telegram: async () => "paired",
    contacts: async () => 3,
  }));
  const s = await serve((app) => mountConnectionsStatus(app, null));
  try {
    const r = await p.get("/panel/api/connections/status");
    assert.equal(r.status, 200);
    assert.equal(r.body.discovered, false);
    const list = by(r.body.connections as ReturnType<typeof connectionsStatus>);
    assert.equal(list.telegram!.state, "connected");
    assert.equal(list.contacts!.detail, "3 contacts");
    assert.equal((await p.get("/panel/api/connections/status", APP)).status, 200);
    assert.equal((await p.get("/panel/api/connections/status", {})).status, 401);
    assert.equal((await s.get("/panel/api/connections/status")).status, 404);
  } finally {
    await p.close();
    await s.close();
  }
});
