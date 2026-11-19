// What the Mac found (src/discovery.ts): read field by field, kept under "discovery", given back, forgotten in one click (with ?all=1 the Mac's
// events and imported contacts too); the panel's session or the Mac app's token, never a browser page with the token, never a server.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createDiscoveryStore, discoveryOf, DISCOVERY_KEY, mountDiscoveryPanel } from "../src/discovery.ts";
import { APP, auth, memoryKv, serve } from "./helpers/connect-rig.ts";

const FOUND = {
  at: "2026-11-16T09:00:00Z",
  apps: { zoom: true, slack: false, telegram: true, whatsapp: false, mail: true, outlook: false, teams: false, other: true },
  calendars: [
    { id: "cal-1", title: "Trabajo", source: "iCloud", color: "#ff0000", writable: true },
    { id: "cal-1", title: "repeated" },
    { id: "cal-2", title: "Familia", source: "Google", color: "javascript:x" },
  ],
  mailAccounts: [{ address: "Ana@Gmail.com", name: "Ana", provider: "google", kind: "imap" }, { address: "not an address" }],
  contacts: { count: 312 },
  zoomRecordings: { folder: "/Users/ana/Documents/Zoom", count: 4 },
  permissions: { calendars: "granted", contacts: "denied", mail: "maybe" },
};

test("a discovery is read field by field: unknown apps, repeats, bad colours and bad addresses are dropped", () => {
  const d = discoveryOf(FOUND, Date.parse("2026-11-16T10:00:00Z"))!;
  assert.equal(d.at, Date.parse("2026-11-16T09:00:00Z"));
  assert.deepEqual(Object.keys(d.apps).sort(), ["mail", "outlook", "slack", "teams", "telegram", "whatsapp", "zoom"]);
  assert.deepEqual(d.calendars.map((c) => [c.id, c.color]), [["cal-1", "#ff0000"], ["cal-2", ""]]);
  assert.deepEqual(d.mailAccounts, [{ address: "ana@gmail.com", name: "Ana", provider: "google", kind: "imap", apps: ["mail"] }], "an older app sends no list of apps: its addresses came from Mail");
  assert.deepEqual(d.permissions, { calendars: "granted", contacts: "denied", mail: "notAsked" });
  assert.equal(discoveryOf("nope", 0), null);
  assert.equal(discoveryOf({ zoomRecordings: { folder: "relative/path" } }, 0)!.zoomRecordings, null, "only an absolute folder");
});

test("the Mac app posts what it found with its token; the panel reads it back and forgets it in one click", async () => {
  const kv = memoryKv();
  const forgotten: string[] = [];
  const logs: string[] = [];
  const store = createDiscoveryStore(kv);
  const p = await serve((app) => mountDiscoveryPanel(app, {
    ...auth, store, lang: () => "en", control: { log: (_w: string, t: string) => void logs.push(t) } as never,
    forgetAlso: [async () => void forgotten.push("calendar"), async () => void forgotten.push("contacts")],
  }));
  try {
    assert.deepEqual((await p.get("/panel/api/discovery")).body, {}, "nothing before the person said yes");
    const posted = await p.post("/panel/api/discovery", FOUND, APP);
    assert.equal(posted.status, 200);
    assert.ok(kv.data.get(DISCOVERY_KEY));
    assert.ok(kv.ttl.get(DISCOVERY_KEY)! > 365 * 24 * 3600, "no expiry in practice: it is forgotten by the person");
    const back = await p.get("/panel/api/discovery");
    assert.equal((back.body as { calendars: unknown[] }).calendars.length, 2);
    assert.match(logs[0]!, /2 calendars, 1 mail accounts, 312 contacts/);
    assert.doesNotMatch(logs.join(), /ana@gmail/, "no address in the log");
    assert.equal((await p.del("/panel/api/discovery")).status, 200);
    assert.deepEqual((await p.get("/panel/api/discovery")).body, {});
    assert.deepEqual(forgotten, [], "the plain forget leaves the events and contacts");
    await p.post("/panel/api/discovery", FOUND, APP);
    await p.del("/panel/api/discovery?all=1");
    assert.deepEqual(forgotten, ["calendar", "contacts"]);
  } finally {
    await p.close();
  }
});

test("discovery is refused without the session, without x-pako on a change, with a wrong token, from a browser, and on a server", async () => {
  const p = await serve((app) => mountDiscoveryPanel(app, { ...auth, store: createDiscoveryStore(memoryKv()), lang: () => "en" }));
  const s = await serve((app) => mountDiscoveryPanel(app, null));
  try {
    assert.equal((await p.get("/panel/api/discovery", {})).status, 401);
    assert.equal((await p.post("/panel/api/discovery", FOUND, { cookie: "ok=1" })).status, 401);
    assert.equal((await p.post("/panel/api/discovery", FOUND, { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await p.post("/panel/api/discovery", FOUND, { ...APP, origin: "https://evil.example" })).status, 401);
    assert.equal((await p.post("/panel/api/discovery", "x", APP)).status, 400);
    assert.equal((await s.get("/panel/api/discovery")).status, 404);
  } finally {
    await p.close();
    await s.close();
  }
});
