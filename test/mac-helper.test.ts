// The relay to the Mac helper (src/mac-helper.ts): the panel in a browser asks, the helper (its bridge token) picks the ask up and answers,
// and the panel gets the answer it waited for; no helper, no wait; the helper's side is never open to the panel's session.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mountMacHelper } from "../src/mac-helper.ts";
import { APP, auth, PANEL, serve } from "./helpers/connect-rig.ts";

type Win = { fetch: (url: string, init: { body: string }) => Promise<unknown> };
const { askApp, inApp, tellApp, useHelper } = (await import(new URL("../src/panel/settings-model.js", import.meta.url).href)) as {
  askApp: (win: Win, message: unknown, callback: string, ms?: number, accept?: (v: unknown) => boolean) => Promise<unknown>;
  inApp: (win: Win) => boolean;
  tellApp: (win: Win, message: unknown) => boolean;
  useHelper: (r: unknown) => void;
};

const DISCOVER = { type: "discover", what: ["calendars"] };

test("no helper yet: the panel hears it is not here, and an ask comes back null at once", async () => {
  const p = await serve((app) => mountMacHelper(app, auth));
  try {
    assert.deepEqual((await p.get("/panel/api/helper")).body, { here: false });
    assert.deepEqual((await p.post("/panel/api/helper/ask", { message: DISCOVER, want: "pakoDiscovered" })).body, { value: null });
  } finally {
    await p.close();
  }
});

test("an ask reaches the waiting helper, and the panel gets the answer it named (not another one)", async () => {
  const p = await serve((app) => mountMacHelper(app, { ...auth, holdMs: 2000 }));
  try {
    // The helper asks first (nothing yet: held, then empty), and is then here.
    assert.deepEqual((await p.post("/panel/api/helper/next", {}, APP)).body, { asks: [] });
    assert.deepEqual((await p.get("/panel/api/helper")).body, { here: true });
    const held = p.post("/panel/api/helper/next", {}, APP);
    const asked = p.post("/panel/api/helper/ask", { message: { type: "use", what: "calendars", ids: ["c1"] }, want: "pakoUsed" });
    const got = await held;
    assert.equal(got.body.asks.length, 1);
    const { id, message } = got.body.asks[0];
    assert.deepEqual(message, { type: "use", what: "calendars", ids: ["c1"] });
    await p.post("/panel/api/helper/answer", { id, fn: "pakoCalendarSynced", value: { events: 4, calendars: 1 } }, APP);
    await p.post("/panel/api/helper/answer", { id, fn: "pakoUsed", value: { what: "calendars", ok: true, count: 4 } }, APP);
    assert.deepEqual((await asked).body, { value: { what: "calendars", ok: true, count: 4 } });
  } finally {
    await p.close();
  }
});

test("the helper's side takes only the bridge token; the panel's side only the session with x-pako", async () => {
  const p = await serve((app) => mountMacHelper(app, auth));
  try {
    assert.equal((await p.post("/panel/api/helper/next", {}, PANEL)).status, 401);
    assert.equal((await p.post("/panel/api/helper/answer", { id: "x", fn: "pakoUsed" }, PANEL)).status, 401);
    assert.equal((await p.post("/panel/api/helper/ask", { message: DISCOVER }, { cookie: "ok=1" })).status, 401);
    assert.equal((await p.post("/panel/api/helper/ask", { message: DISCOVER, want: "alert" })).status, 400);
    assert.equal((await p.post("/panel/api/helper/ask", { message: "discover" })).status, 400);
  } finally {
    await p.close();
  }
});

test("in a browser with the helper here, the page's asks go to Pako's relay; without it, nothing is asked", async () => {
  const sent: { url: string; body: any }[] = [];
  const win = {
    fetch: async (url: string, init: { body: string }) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ value: { what: "contacts", ok: true, count: 3 } }) };
    },
  };
  useHelper(null);
  assert.equal(inApp(win), false);
  assert.equal(await askApp(win, { type: "use", what: "contacts" }, "pakoUsed"), null);
  assert.equal(sent.length, 0);
  useHelper({ here: true });
  try {
    assert.equal(inApp(win), true);
    assert.deepEqual(await askApp(win, { type: "use", what: "contacts" }, "pakoUsed", 1000, (v: any) => v?.what === "contacts"), { what: "contacts", ok: true, count: 3 });
    assert.equal(await askApp(win, { type: "use", what: "contacts" }, "pakoUsed", 1000, (v: any) => v?.what === "calendars"), null, "an answer the page does not accept");
    assert.equal(tellApp(win, { type: "openURL", url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts" }), true);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent.map((s) => [s.url, s.body.want ?? null]), [["/panel/api/helper/ask", "pakoUsed"], ["/panel/api/helper/ask", "pakoUsed"], ["/panel/api/helper/ask", null]]);
  } finally {
    useHelper(null);
  }
});
