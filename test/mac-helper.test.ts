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

test("the panel's own time limit is kept; an ask whose page stopped waiting, or older than two minutes, never reaches a helper", async () => {
  let t = 0;
  const p = await serve((app) => mountMacHelper(app, { ...auth, holdMs: 50, now: () => t }));
  try {
    await p.post("/panel/api/helper/next", {}, APP); // the helper is here
    const started = Date.now();
    assert.deepEqual((await p.post("/panel/api/helper/ask", { message: DISCOVER, want: "pakoDiscovered", ms: 300 })).body, { value: null });
    assert.ok(Date.now() - started < 2000, "answered at the page's limit, not after two minutes");
    assert.deepEqual((await p.post("/panel/api/helper/next", {}, APP)).body, { asks: [] }, "the timed-out ask is not delivered later");
    // Sent (no answer waited for) and left: delivered within two minutes, never after.
    await p.post("/panel/api/helper/ask", { message: { type: "openURL", url: "x-apple.systempreferences:" } });
    t += 121_000;
    await p.post("/panel/api/helper/next", {}, APP); // still here (it asked again)
    assert.deepEqual((await p.post("/panel/api/helper/next", {}, APP)).body, { asks: [] });
  } finally {
    await p.close();
  }
});

test("a second helper is told another is waiting (409), and a helper whose held request closes is gone at once", async () => {
  const p = await serve((app) => mountMacHelper(app, { ...auth, holdMs: 5000 }));
  try {
    await p.post("/panel/api/helper/next", {}, APP).catch(() => null);
    const ac = new AbortController();
    const held = fetch(`${p.base}/panel/api/helper/next`, { method: "POST", headers: APP, signal: ac.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await p.post("/panel/api/helper/next", {}, APP)).status, 409, "two helpers do not answer each other's waits");
    assert.deepEqual((await p.get("/panel/api/helper")).body, { here: true });
    ac.abort();
    await held;
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual((await p.get("/panel/api/helper")).body, { here: false }, "it quit: the panel stops offering it");
  } finally {
    await p.close();
  }
});

test("through the helper, the page's ask carries its own time limit and is given up after it", async () => {
  const sent: any[] = [];
  const win = {
    fetch: (_url: string, init: { body: string; signal?: AbortSignal }) => {
      sent.push(JSON.parse(init.body));
      return new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    },
  };
  useHelper({ here: true });
  try {
    const started = Date.now();
    assert.equal(await askApp(win as unknown as Win, { type: "use", what: "contacts" }, "pakoUsed", 200), null);
    assert.ok(Date.now() - started < 4000);
    assert.equal(sent[0].ms, 200);
  } finally {
    useHelper(null);
  }
});
