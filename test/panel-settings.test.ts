// The panel's Settings: a gear in the header (src/panel/index.html) that opens the connections page, /panel/settings, in a new tab (a new window
// in the Mac app), on a person's computer only. The gear is written hidden and only connections.js shows it, once /panel/api/connections
// answered; a hosted server's panel answers 404 there, so its header looks exactly as before.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createControl } from "../src/control.ts";
import { mountDashboard } from "../src/dashboard.ts";
import { loadMemory } from "../src/voice-memory.ts";

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const { WORDS } = (await import(new URL("../src/panel/i18n.js", import.meta.url).href)) as { WORDS: Record<string, string> };

/** The opening tag of the element with this id. */
const tagOf = (html: string, id: string): string => {
  const m = html.match(new RegExp(`<\\w+\\b[^>]*\\bid="${id}"[^>]*>`));
  assert.ok(m, `#${id} is in the page`);
  return m[0];
};

test("settings: the gear sits in the header next to refresh, hidden until connections.js shows it, labelled in English", () => {
  const html = read("src/panel/index.html");
  const actions = html.slice(html.indexOf('<div class="top-actions">'), html.indexOf("</header>"));
  assert.ok(actions.indexOf('id="refresh"') >= 0 && actions.indexOf('id="settings-btn"') > actions.indexOf('id="refresh"'), "after refresh, in .top-actions");
  const gear = tagOf(html, "settings-btn");
  assert.match(gear, /^<button\b/, "a real button: reachable with the keyboard");
  assert.match(gear, /\btype="button"/);
  assert.match(gear, /\bclass="icon-btn settings-btn"/, "the refresh button's style");
  assert.match(gear, /\shidden[\s>]/, "hidden as served: a hosted server's panel never shows it");
  assert.match(gear, /data-i18n-aria="settings"/);
  assert.match(gear, /aria-label="Settings"/);
  assert.doesNotMatch(gear, /aria-controls|aria-haspopup/, "it opens a page, not a dialog");
  assert.match(actions, /id="settings-btn"[\s\S]*?<i data-lucide="settings"><\/i>/, "lucide's gear");
  assert.match(tagOf(html, "settings-dot"), /\shidden[\s>]/, "the dot starts hidden");
  assert.equal(WORDS.settings, "Settings");
});

test("settings: the drawer is gone; the gear's dot stays, and the panel's styles keep only the gear's", () => {
  const html = read("src/panel/index.html");
  assert.doesNotMatch(html, /id="settings"[\s>]/, "no drawer dialog");
  assert.doesNotMatch(html, /id="settings-body"/);
  assert.match(tagOf(html, "settings-dot"), /\shidden[\s>]/, "the dot starts hidden");
  const css = read("src/panel/app.css");
  assert.match(css, /\.settings-btn\[hidden\] \{ display: none; \}/, ".icon-btn's display does not beat [hidden]");
  assert.doesNotMatch(css, /\.settings-body|\.settings \{/, "no drawer styles left behind");
});

test("settings: connections.js shows the gear only once the connections answered, and the gear opens /panel/settings in this same tab or window", () => {
  const js = read("src/panel/connections.js");
  assert.match(js, /if \(!r\.ok\) return;\s*data = await r\.json\(\);/, "a 404 (a server) returns before the gear is shown");
  assert.match(js, /btn\.hidden = false;/);
  assert.match(js, /location\.href = `\/panel\/settings\$\{/, "this tab, or the Mac app's main window");
  assert.doesNotMatch(js, /window\.open\(|openWindow|_blank/, "never a new tab or a window of its own");
  assert.doesNotMatch(read("src/panel/settings-model.js"), /openWindow/);
  assert.match(read("src/panel/settings.html"), /<a class="back" href="\/panel"/, "Back returns to the dashboard in the same tab");
  assert.match(js, /\$\("#settings-dot"\)/);
  assert.doesNotMatch(js, /showModal|#settings-body/, "no drawer");
  assert.match(js, /window\.pakoOpenConnection = \(id\) =>/, "the app's Connect your things still opens one connection");
});

test("settings: a hosted server's panel serves the gear hidden and has no connections to show it with", async () => {
  const app = express();
  const panel = mountDashboard(app, {
    secret: "bridge-token-for-tests-0123456789abcdef", publicUrl: "https://pako.example", ownerName: "Marta", timeZone: "Europe/Madrid",
    control: createControl(null), memory: loadMemory(null), wa: { reminders: async () => [], events: () => [], lastPoll: () => 0 },
    integrations: () => [],
  });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}${new URL(panel.link()).pathname}`, { redirect: "manual" });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await (await fetch(`${base}/panel`, { headers: { cookie } })).text();
    assert.match(tagOf(page, "settings-btn"), /\shidden[\s>]/);
    assert.match(page, /<script type="module" src="\/panel\/assets\/connections\.js"><\/script>/);
    assert.equal((await fetch(`${base}/panel/assets/connections.js`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}/panel/api/connections`, { headers: { cookie } })).status, 404, "nothing answers: the gear stays hidden");
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("settings page: the cards it mounts (How Pako acts, privacy, moving) are styled by a stylesheet the page loads, not only by app.css", () => {
  const html = read("src/panel/settings.html");
  const sheets = [...html.matchAll(/href="\/panel\/assets\/([\w-]+\.css)"/g)].map((m) => read(`src/panel/${m[1]}`)).join("\n");
  for (const rule of [".acts select", ".acts input[type=\"number\"]", ".acts .tg-form", ".tg-form", ".tg-lead"]) {
    assert.ok(sheets.includes(`${rule} {`) || sheets.includes(`${rule},`), `${rule} is styled on the settings page`);
  }
});
