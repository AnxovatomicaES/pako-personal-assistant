// The panel's one API guard (src/panel-guard.ts): headers on every answer, sign-in and x-pako first (so a stranger learns nothing of what is
// on), then "off", then "read only here"; and the one constant-time comparison of secrets.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { API_HEADERS, panelGuard, sameSecret } from "../src/panel-guard.ts";

test("guard: 401 before 404; x-pako for a change; read only here; headers on each answer", async () => {
  const state = { signed: false, off: true, ro: true };
  const guard = panelGuard(() => state.signed, { off: () => state.off, readOnly: () => state.ro });
  const app = express();
  app.get("/x", guard(false), (_req, res) => void res.json({ ok: true }));
  app.post("/x", guard(true), (_req, res) => void res.json({ ok: true }));
  const server = createServer(app).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
  try {
    let r = await fetch(url);
    assert.equal(r.status, 401, "signed out: nothing said of the feature being off");
    for (const [k, v] of Object.entries(API_HEADERS)) assert.equal(r.headers.get(k), v);
    state.signed = true;
    assert.equal((await fetch(url)).status, 404);
    state.off = false;
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(url, { method: "POST" })).status, 401, "a change needs x-pako");
    r = await fetch(url, { method: "POST", headers: { "x-pako": "1" } });
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: "read only here" });
    state.ro = false;
    assert.equal((await fetch(url, { method: "POST", headers: { "x-pako": "1" } })).status, 200);
  } finally {
    server.close();
  }
});

test("sameSecret: equal only when equal, whatever the lengths", () => {
  assert.equal(sameSecret("a".repeat(40), "a".repeat(40)), true);
  assert.equal(sameSecret("a".repeat(40), "a".repeat(41)), false);
  assert.equal(sameSecret("", "x"), false);
});
