// The connections page, /panel/settings (src/settings-page.ts, src/panel/settings.*): served signed in on a computer only, its words in
// English, its model (states, the next suggestion, what the Mac app found, the checks as you type), and the talk with the Mac app through a
// fake window.webkit.messageHandlers. Nothing here touches a real Mac, account or service.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createControl } from "../src/control.ts";
import { mountDashboard } from "../src/dashboard.ts";
import { mountSettingsPage } from "../src/settings-page.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { SLACK_USER_SCOPES } from "../src/slack.ts";
import { ZOOM_USER_SCOPES } from "../src/zoom.ts";

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const { WORDS } = (await import(new URL("../src/panel/settings-words.js", import.meta.url).href)) as { WORDS: Record<string, string> };
// A plain browser module: typed here by what the tests use of it.
type Chip = { text: string; card: string; use: { card: string; address?: string } };
type Discovery = { apps: Record<string, boolean>; calendars: { id: string; color: string }[]; mailAccounts: unknown[]; contacts: unknown;
  permissions: unknown } & Record<string, unknown>;
type Win = Record<string, unknown>;
const M = (await import(new URL("../src/panel/settings-model.js", import.meta.url).href)) as {
  CARDS: string[]; COUNTED: string[]; ZOOM_SCOPES: string[];
  cardStates: (s: Record<string, unknown>) => Record<string, string>;
  ADVANCED: string[];
  connectedCount: (s: Record<string, string>) => number;
  nextSuggestion: (s: Record<string, string>) => string | null;
  cleanDiscovery: (raw: unknown) => Discovery | null;
  discoveryChips: (d: Discovery | null, t: (k: string, v?: Record<string, unknown>) => string) => Chip[];
  checkField: (kind: string, v: string) => string;
  cleanAppPassword: (v: string) => string;
  providerOf: (a: string) => string;
  accountLine: (a: unknown) => string;
  cleanClients: (raw: unknown) => Record<string, boolean>;
  mailStatus: (d: unknown) => { found: { key: string; vars: Record<string, number> } | null; mail: string | null; denied: boolean } | null;
  resumable: (s: unknown) => unknown;
  inApp: (w: Win) => boolean;
  tellApp: (w: Win, m: unknown) => boolean;
  askApp: (w: Win, m: unknown, cb: string, ms?: number, accept?: (v: never) => boolean) => Promise<unknown>;
};

async function serve(local: boolean) {
  const app = express();
  const panel = mountDashboard(app, {
    secret: "bridge-token-for-tests-0123456789abcdef", publicUrl: "http://127.0.0.1", ownerName: "Marta", timeZone: "Europe/Madrid",
    control: createControl(null), memory: loadMemory(null), wa: { reminders: async () => [], events: () => [], lastPoll: () => 0 },
    integrations: () => [],
  });
  mountSettingsPage(app, { signedIn: panel.signedIn, lang: () => "en", local });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}${new URL(panel.link()).pathname}`, { redirect: "manual" });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  return { base, cookie, close: () => (server.close(), server.closeAllConnections()) };
}

test("settings page: a computer's signed-in panel gets the page in English, under the panel's strict headers; its files are served", async () => {
  const s = await serve(true);
  try {
    const r = await fetch(`${s.base}/panel/settings`, { headers: { cookie: s.cookie }, redirect: "manual" });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /<html lang="en">/);
    assert.match(r.headers.get("content-security-policy") ?? "", /script-src 'self'; style-src 'self'/, "no inline script, no other site");
    assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, "every script is a file");
    for (const f of ["settings.js", "settings.css", "settings-words.js", "settings-model.js"]) {
      assert.match(html + read("src/panel/settings.js"), new RegExp(f.replace(".", "\\.")), `${f} is used`);
      assert.equal((await fetch(`${s.base}/panel/assets/${f}`, { headers: { cookie: s.cookie } })).status, 200, f);
    }
  } finally {
    s.close();
  }
});

test("settings page: not signed in, or a hosted server (its connections are its environment), goes back to /panel", async () => {
  const local = await serve(true);
  const hosted = await serve(false);
  try {
    const anon = await fetch(`${local.base}/panel/settings`, { redirect: "manual" });
    assert.equal(anon.status, 302);
    assert.equal(anon.headers.get("location"), "/panel");
    const server = await fetch(`${hosted.base}/panel/settings`, { headers: { cookie: hosted.cookie }, redirect: "manual" });
    assert.equal(server.status, 302);
    assert.equal(server.headers.get("location"), "/panel");
  } finally {
    local.close();
    hosted.close();
  }
});

test("settings words: one English table with every key the page asks for, and no Spanish", () => {
  assert.equal("es" in WORDS || "en" in WORDS, false, "a plain table, not one per language");
  assert.deepEqual(Object.entries(WORDS).filter(([, v]) => /[áéíóúñ¿¡]|\b(?:Conecta|tus|correo|Probar)\b/.test(v)).map(([k]) => k), [], "no Spanish left");
  assert.doesNotMatch(read("src/panel/settings.html"), /[áéíóúñ¿¡]|lang="es"/);
  const code = read("src/panel/settings.js") + read("src/panel/settings-model.js");
  const used = new Set([...code.matchAll(/\bt\("([\w.]+)"/g)].map((m) => m[1]!));
  // The keys made from a name: each card's name and sentence, the providers' steps, the states, what the app found.
  for (const id of M.CARDS) used.add(`${id}.name`).add(`${id}.what`);
  for (const id of M.COUNTED) used.add(`next.${id}`);
  for (const p of ["google", "microsoft", "icloud", "zoho"]) for (const k of ["1", "2", "3", "where", "row1", "row2"]) used.add(`ics.${p}.${k}`);
  for (const p of ["google", "icloud", "microsoft", "yahoo", "other"]) for (const k of ["1", "2", "3", "where"]) used.add(`apppw.${p}.${k}`);
  for (const p of ["google", "microsoft", "icloud", "zoho", "yahoo", "other"]) used.add(`prov.${p}`);
  for (const k of ["on", "partial", "problem", "off", "advanced"]) used.add(`state.${k}`);
  for (const k of ["zoom", "slack", "telegram", "whatsapp", "mail", "outlook", "teams"]) used.add(`app.${k}`);
  for (const k of ["calendars", "contacts", "mail"]) used.add(`perm.${k}`);
  for (const k of ["email", "telegramToken", "slackUser", "slackApp", "ics", "anthropic", "appPassword", "zoomId", "zoomSecret", "agentmailKey", "places", "resendKey"]) {
    for (const bad of ["x", "xoxb-1", "xapp-1", "xoxp-1", "http://a", "with space"]) {
      const v = M.checkField(k, bad);
      if (v !== "ok" && v !== "empty") used.add(v);
    }
  }
  for (const n of [1, 2, 3]) used.add(`disc.promise${n}`).add(`fwd.how${n}`).add(`slack.how${n}`).add(`zoom.make${n}`).add(`tables.how${n}`).add(`resend.how${n}`);
  const missing = [...used].filter((k) => !Object.hasOwn(WORDS, k)).sort();
  assert.deepEqual(missing, []);
  // The page's own fixed texts (data-t in the HTML).
  for (const m of read("src/panel/settings.html").matchAll(/data-t="([\w.]+)"/g)) assert.ok(Object.hasOwn(WORDS, m[1]!), m[1]!);
});

test("settings model: the states come from the server's answers, the ring counts the four essentials, the suggestion is the half-done one first, then by help", () => {
  const none = M.cardStates({});
  assert.equal(M.connectedCount(none), 0);
  assert.equal(M.nextSuggestion(none), "calendar", "nothing yet: the calendar helps most");
  const s = M.cardStates({
    connections: { connections: [{ id: "calendar", state: "on" }, { id: "imap", state: "on", problem: "Gmail rejected the password" }, { id: "slack", state: "partial" }] },
    telegram: { state: "paired" }, whatsapp: { state: "on" }, claude: { status: { claude: "ok" } }, people: { people: [{ name: "Ana" }] },
  });
  assert.deepEqual([s.calendar, s.mail, s.telegram, s.whatsapp, s.contacts, s.claude, s.slack], ["on", "problem", "on", "on", "on", "on", "partial"]);
  assert.equal(M.connectedCount(s), 3, "calendar, Telegram and contacts; WhatsApp is Advanced and Claude is not counted");
  assert.equal(M.nextSuggestion(s), "mail", "what is half done or failing comes first");
  const local = M.cardStates({ localCalendar: { calendars: ["c1"] } });
  assert.equal(local.calendar, "on", "the Mac's own calendars count");
  assert.equal(M.cardStates({ telegram: { state: "unpaired" } }).telegram, "partial", "a bot with no phone yet is half done");
  const all = Object.fromEntries(M.COUNTED.map((id) => [id, "on"]));
  assert.equal(M.nextSuggestion(all), null);
  const noBrain = M.cardStates({ claude: { status: { claude: "missing" } }, connections: { connections: [{ id: "slack", state: "partial" }] } });
  assert.equal(M.nextSuggestion(noBrain), "claude", "Claude not working comes before anything else, even a half-done card");
  assert.equal(M.nextSuggestion({ ...all, claude: "problem" }), "claude");
});

test("settings model: the computer's WhatsApp guide and the imported contacts give their cards' states", () => {
  const wa = (v: unknown) => M.cardStates({ whatsapp: v }).whatsapp;
  assert.equal(wa({ step: "app", done: [], tunnel: { state: "off" }, problems: [] }), "off", "nothing begun");
  assert.equal(wa({ step: "tunnel", done: ["app", "number", "values"], tunnel: { state: "starting" }, problems: [] }), "partial");
  assert.equal(wa({ step: "tunnel", done: ["app"], tunnel: { state: "error" }, problems: [] }), "problem", "a tunnel that failed");
  assert.equal(wa({ step: "done", done: ["app", "number", "values", "tunnel", "test"], tunnel: { state: "on" } }), "on");
  assert.equal(wa({ state: "partial" }), "partial", "the older answer still works");
  assert.equal(M.cardStates({ people: { count: 12, people: [], more: 0 } }).contacts, "on", "the imported count, not the names shown");
  assert.equal(M.cardStates({ people: { count: 0, people: [] } }).contacts, "off");
});

test("settings model: what the app found is trusted field by field: junk and unknown fields are dropped, only the contract's survive", () => {
  assert.equal(M.cleanDiscovery(null), null);
  assert.equal(M.cleanDiscovery({}), null, "nothing found is no discovery");
  const d = M.cleanDiscovery({
    at: "2026-11-16T10:00:00Z",
    apps: { zoom: true, slack: "yes", spy: true },
    calendars: [{ id: "c1", title: "Trabajo", source: "iCloud", color: "#3b9bff", writable: true }, { id: "c2", title: "" }, { id: "c3", title: "X", color: "red" }],
    mailAccounts: [{ address: "Marta@Gmail.com", provider: "google", kind: "imap", password: "never" }, { address: "not an address" }],
    contacts: { count: 214, preview: ["Ana García", "Luis\nMartín", "Carmen", "Cuarto"] },
    zoomRecordings: { folder: "~/Documents/Zoom", count: 12 },
    permissions: { calendars: "granted", contacts: "weird", mail: "denied" },
    bodies: ["a mail body"],
  })!;
  assert.deepEqual(Object.keys(d).sort(), ["apps", "at", "calendars", "contacts", "mailAccounts", "mailState", "permissions", "zoomRecordings"]);
  assert.equal(d.apps.zoom, true);
  assert.equal(d.apps.slack, false, "only a true is a yes");
  assert.ok(!("spy" in d.apps));
  assert.deepEqual(d.calendars.map((c) => c.id), ["c1", "c3"]);
  assert.equal(d.calendars[1]!.color, "#8b7bff", "a colour that is not a hex code gets the page's own");
  assert.deepEqual(d.mailAccounts, [{ address: "marta@gmail.com", name: "", provider: "google", kind: "imap", apps: ["mail"], icloudMail: false }], "no other field of an account is kept");
  assert.deepEqual(d.contacts, { count: 214 }, "the number only: no name of a contact is kept from a look");
  assert.deepEqual(d.permissions, { calendars: "granted", contacts: "notAsked", mail: "denied" });
});

test("settings model: the chips say what was found in plain words, each with what \"Use this\" opens", () => {
  const t = (key: string, vars?: Record<string, unknown>) => String(WORDS[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars?.[k] ?? ""));
  const d = M.cleanDiscovery({
    at: 1, apps: { zoom: true, slack: true },
    calendars: [{ id: "a", title: "Work" }, { id: "b", title: "Home" }, { id: "c", title: "Holidays" }, { id: "d", title: "Birthdays" }],
    mailAccounts: [{ address: "marta@icloud.com" }], contacts: { count: 214 }, zoomRecordings: { folder: "/z", count: 3 },
  });
  const chips = M.discoveryChips(d, t);
  assert.deepEqual(chips.map((c) => c.text), [
    "4 calendars: Work, Home, Holidays and 1 more", "Email: marta@icloud.com", "214 contacts", "You have Zoom (3 recordings on this Mac)", "You have Slack",
  ]);
  assert.deepEqual(chips.map((c) => c.use.card), ["calendar", "mail", "contacts", "zoom", "slack"]);
  assert.equal(chips[1]!.use.address, "marta@icloud.com", "an account opens the mail wizard on that address");
});

test("settings model: fields check themselves with the mistakes people make (the wrong Slack token, a token with spaces, an http link)", () => {
  assert.equal(M.checkField("telegramToken", "123456789:AAHabcdefghijklmnopqrstuvwxyz012345"), "ok");
  assert.equal(M.checkField("telegramToken", "123456789: AAH abc"), "bad.spaces");
  assert.equal(M.checkField("telegramToken", ""), "empty");
  assert.equal(M.checkField("slackUser", "xoxb-123-456-abcdefabcdefabcdefabcd"), "bad.slackBot");
  assert.equal(M.checkField("slackUser", "xapp-1-A0-123-abcdefabcdefabcdef"), "bad.slackSwap");
  assert.equal(M.checkField("slackApp", "xoxp-1234567890-abcdefabcdefabcdef"), "bad.slackSwap");
  assert.equal(M.checkField("slackApp", "xapp-1-A0123-4567-abcdefabcdefabcdef"), "ok");
  assert.equal(M.checkField("ics", "webcal://p01-caldav.icloud.com/published/2/abc"), "ok");
  assert.equal(M.checkField("ics", "http://example.com/cal.ics"), "bad.icsHttp");
  assert.equal(M.checkField("email", "marta@gmail"), "bad.email");
  assert.equal(M.checkField("appPassword", "abcd efgh ijkl mnop"), "ok");
  assert.equal(M.cleanAppPassword(" abcd efgh ijkl mnop "), "abcdefghijklmnop", "the spaces Google shows are not part of it");
  assert.equal(M.checkField("places", `AIza${"x".repeat(35)}`), "ok");
  assert.deepEqual(["me@icloud.com", "a@gmail.com", "b@hotmail.es", "c@yahoo.co.uk", "d@empresa.com"].map(M.providerOf),
    ["icloud", "google", "microsoft", "yahoo", "other"]);
});

test("settings model: the mail card says exactly how the look on this Mac went, and where each address was found", () => {
  const look = (mailState: string, addresses: { address: string; apps?: string[]; icloudMail?: boolean }[] = []) =>
    M.cleanDiscovery({ at: 1, mailState, mailAccounts: addresses.map((a) => ({ provider: "other", kind: "other", ...a })) });
  const t = (k: string | null | undefined, vars?: Record<string, unknown>) =>
    k ? String(WORDS[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => String(vars?.[x] ?? "")) : "";
  const said = (d: unknown) => {
    const st = M.mailStatus(d)!;
    return [st.found ? t(st.found.key, st.found.vars) : "", t(st.mail)].filter(Boolean).join(" ");
  };
  assert.equal(said(look("empty")), "Mail isn't set up on this Mac.");
  assert.equal(said(look("denied")), "Allow Pako to read Mail's account list: System Settings › Privacy & Security › Automation › Pako › Mail.");
  assert.equal(M.mailStatus(look("denied"))!.denied, true);
  assert.equal(said(look("closed")), "Mail is closed: open it, or press “Find my accounts on this Mac”.");
  assert.equal(said(look("failed")), "Mail didn't answer. Press “Find my accounts on this Mac” to try again.");
  assert.equal(said(look("found", [{ address: "a@b.example", apps: ["mail"] }, { address: "c@d.example", apps: ["outlook", "emclient"] }])),
    "Found 2 addresses on this Mac.");
  assert.equal(said(look("closed", [{ address: "a@icloud.com", apps: ["icloud", "bogus"], icloudMail: true }])),
    "Found 1 address on this Mac. Mail is closed: open it, or press “Find my accounts on this Mac”.");
  const d = look("closed", [{ address: "a@icloud.com", apps: ["icloud", "bogus"], icloudMail: true }]) as { mailAccounts: { apps: string[]; icloudMail: boolean }[] };
  assert.deepEqual(d.mailAccounts[0]!.apps, ["icloud"], "only the known places");
  assert.equal(d.mailAccounts[0]!.icloudMail, true);
  assert.equal(M.mailStatus(M.cleanDiscovery({ at: 1, mailAccounts: [] })), null, "an older app says no state: nothing is claimed");
  for (const k of ["mail", "outlook", "emclient", "thunderbird", "icloud", "contacts"]) assert.ok(Object.hasOwn(WORDS, `from.${k}`), k);
});

test("settings model: the Client ID fields, 'Connected as', the Zoom scopes are src/zoom.ts's and the docs list Slack's", () => {
  assert.equal(M.checkField("slackClientId", "1234567890.9876543210"), "ok");
  assert.equal(M.checkField("slackClientId", "xoxp-1234567890-abcdef"), "bad.slackClientToken", "a token is not what is asked for");
  assert.equal(M.checkField("slackClientId", "12345"), "bad.slackClientId");
  assert.equal(M.checkField("zoomClientId", "AbCdEfGhIjKl_0123"), "ok");
  assert.equal(M.checkField("zoomClientId", "abc"), "bad.zoomClientId");
  assert.equal(M.accountLine({ user: "Ana Ruiz", team: "Acme" }), "Ana Ruiz in Acme");
  assert.equal(M.accountLine({ user: "Ana Ruiz", email: "ana@acme.example" }), "Ana Ruiz (ana@acme.example)");
  assert.equal(M.accountLine({ team: "Acme" }), "");
  assert.deepEqual(M.ZOOM_SCOPES, ZOOM_USER_SCOPES);
  const channels = read("docs/channels.md");
  for (const scope of [...SLACK_USER_SCOPES, ...ZOOM_USER_SCOPES]) assert.ok(channels.includes(`\`${scope}\``), `docs/channels.md names ${scope}`);
});

test("settings model: a wizard is resumed by its step and choices only: nothing typed in a field is ever kept", () => {
  const kept = M.resumable({
    mail: { step: 2, path: "imap", address: "marta@gmail.com", provider: "google", password: "abcd efgh", typed: "secret" },
    slack: { step: 1, user: "xoxp-secret" },
    nope: { step: 1 },
    zoom: { step: 99 },
  });
  assert.deepEqual(kept, { mail: { step: 2, path: "imap", address: "marta@gmail.com", provider: "google" }, slack: { step: 1 }, zoom: { step: 0 } });
  const js = read("src/panel/settings.js");
  assert.match(js, /localStorage\.setItem\(KEEP, JSON\.stringify\(\{ wiz: resumable\(S\.wiz\)/, "only what resumable() keeps is written");
});

/** A window with the Mac app's message handler, answering like desktop/mac would (or not at all). */
function fakeWindow(answer: ((m: Record<string, unknown>, w: Record<string, unknown>) => void) | null) {
  const sent: Record<string, unknown>[] = [];
  const w: Record<string, unknown> = {};
  w.webkit = { messageHandlers: { pako: { postMessage: (m: Record<string, unknown>) => {
    sent.push(m);
    if (answer) setTimeout(() => answer(m, w), 5);
  } } } };
  return { w, sent };
}

test("settings and the Mac app: discovery is asked with one message and its answer comes through window.pakoDiscovered", async () => {
  const found = { at: 1, apps: { zoom: true }, calendars: [], mailAccounts: [], contacts: { count: 2 }, zoomRecordings: null, permissions: {} };
  const { w, sent } = fakeWindow((m, win) => (win.pakoDiscovered as (r: unknown) => void)(m.type === "discover" ? found : null));
  const before = () => undefined;
  w.pakoDiscovered = before;
  assert.equal(M.inApp(w), true);
  const got = await M.askApp(w, { type: "discover", what: ["apps", "contacts"] }, "pakoDiscovered", 1000);
  assert.deepEqual(sent, [{ type: "discover", what: ["apps", "contacts"] }]);
  assert.deepEqual(got, found);
  assert.equal(w.pakoDiscovered, before, "the callback is put back as it was");
});

test("settings and the Mac app: a \"use\" waits for its own answer; an app that never answers, or no app at all, gives null", async () => {
  const { w } = fakeWindow((m, win) => {
    const used = win.pakoUsed as (r: unknown) => void;
    used({ what: "other", ok: true });
    used({ what: m.what, ok: true, count: 214 });
  });
  const r = await M.askApp(w, { type: "use", what: "contacts" }, "pakoUsed", 1000, (v: { what?: string } | null) => v?.what === "contacts");
  assert.deepEqual(r, { what: "contacts", ok: true, count: 214 });
  const silent = fakeWindow(null);
  assert.equal(await M.askApp(silent.w, { type: "use", what: "calendars", ids: ["a"] }, "pakoUsed", 50), null);
  assert.equal(M.inApp({}), false);
  assert.equal(M.tellApp({}, { type: "discover" }), false);
  assert.equal(await M.askApp({}, { type: "discover" }, "pakoDiscovered", 50), null, "a plain browser: nothing is asked");
});

test("settings privacy: the page looks at nothing by itself: discovery is only asked from a press, and its yes card promises what it does", () => {
  const js = read("src/panel/settings.js");
  // The only message that asks the app to look is in discover(); discover() is only called from a button's handler.
  assert.equal([...js.matchAll(/type: "discover"/g)].length, 1);
  const start = js.slice(js.indexOf("async function start()"), js.indexOf("window.addEventListener(\"hashchange\""));
  assert.doesNotMatch(start, /discover\(|askApp\(|tellApp\(/, "loading the page asks the app nothing");
  for (const m of js.matchAll(/(?<!function )\bdiscover\(/g)) {
    const before = js.slice(Math.max(0, m.index - 260), m.index);
    assert.match(before, /(btn\(|choice\(|onclick: )[^]*=>/, `a press: …${before.slice(-60)}`);
  }
  assert.match(WORDS["disc.ask"]!, /May I look at what you have on this Mac\?/);
  assert.match(WORDS["disc.promise1"]!, /I don't read any email/);
  // What was found is listed with a one-click forget, asked first: the look, the Mac's events and the imported contacts all go (?all=1).
  assert.match(js, /api\("\/panel\/api\/discovery\?all=1", \{ method: "DELETE" \}\)/);
  assert.match(js, /confirm\(t\("known\.forgetConfirm"\)\)/);
  // Everything from the server or the app goes on the page as text.
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML/);
});

test("settings page: 'connected' is only said after a live check: mail, Slack and Zoom are tried with their service before they are kept", () => {
  const js = read("src/panel/settings.js");
  const routes = new Set([...js.matchAll(/"(\/panel\/api\/[a-z/]+)/g)].map((m) => m[1]));
  for (const r of ["/panel/api/mail/connect", "/panel/api/zoom/manifest", "/panel/api/zoom/setup", "/panel/api/slack/setup"]) assert.ok(routes.has(r), r);
  // Slack, Zoom and Microsoft/Google mail: connected only once the service's own Allow came back to Pako (the account route), never on a
  // typed value.
  assert.match(js, /start: `\/panel\/api\/\$\{id\}\/connect`/);
  assert.match(js, /start: "\/panel\/api\/mail\/oauth\/start"/);
  assert.match(js, /a\.data\.state === "connected"/);
  // The mailbox is never saved through the plain save, and no timed "quiet means it works" wait is left.
  assert.doesNotMatch(js, /saveConnection\("(imap|slack|zoom)"/);
  assert.doesNotMatch(js, /for \(let i = 0; i < \d+; i\+\+\) \{\s*await sleep/);
  // What has no live check is called "Save" and ends on "saved", not on the connected tick.
  for (const id of ["claude", "tables"]) {
    const view = js.slice(js.indexOf(`VIEWS.${id} =`), js.indexOf("};", js.indexOf(`VIEWS.${id} =`)));
    assert.doesNotMatch(view, /btn\(t\("saveTest"\)/, `${id}: no "Test and connect" without a test`);
  }
  assert.match(js, /saved\(t\("cal\.icsSaved"\)/);
  // The autoconfiguration's warning and source are kept and used: a guessed server is shown to be confirmed.
  assert.match(js, /note: typeof d\.note === "string"/);
  assert.match(js, /cfg\.source === "guess"/);
});

test("settings and the Mac app: the mail button may open Mail; a refused permission opens its own privacy pane; forgetting stops the feed", () => {
  const js = read("src/panel/settings.js");
  assert.match(js, /discover\(\["mail"\], \{ openMail: true \}\)/, "the explicit mail button sends openMail");
  assert.match(js, /\{ type: "discover", what, \.\.\.\(openMail \? \{ openMail: true \} : \{\}\) \}/);
  // Only the panes the app allows (desktop/mac/DiscoveryCore.swift openablePrivacy).
  const swift = read("desktop/mac/DiscoveryCore.swift");
  for (const m of js.matchAll(/Privacy_[A-Za-z]+/g)) assert.ok(swift.includes(`"${m[0]}"`), m[0]);
  assert.match(js, /x-apple\.systempreferences:com\.apple\.preference\.security\?/);
  assert.ok(swift.includes('"com.apple.preference.security"'));
  // Forget: the app's calendar feed is stopped (ids: []), and the imported contacts have a forget of their own.
  assert.match(js, /\{ type: "use", what: "calendars", ids: \[\] \}/);
  assert.match(js, /api\("\/panel\/api\/people\/imported", \{ method: "DELETE" \}\)/);
  assert.doesNotMatch(WORDS["contacts.private"]!, /delete anyone/);
  // A count of 0 is "not looked" (a mail-only look stores 0 too), so no "Import 0 people": the look button, unless the card's own look said 0.
  assert.match(js, /if \(perm !== "granted" \|\| \(!n && !contactsLooked\)\)/);
  assert.match(js, /if \(!n\) \{\s*return step\(\{ title: t\("contacts\.s1"\), text: t\("contacts\.none"\)/);
  // The contacts' "done" says what Pako's import counted, which the app passes on.
  assert.match(read("desktop/mac/App.swift"), /for k in \["added", "merged", "count"\]/);
  assert.match(js, /go\("contacts", 1, \{ added: num\(r\.added\), merged: num\(r\.merged\) \}\)/);
});

test("settings page: every motion stops under reduced motion; dark and light; a narrow window gets one column", () => {
  const css = read("src/panel/settings.css");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(prefers-color-scheme: light\)/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.step-view\.with-art \{ grid-template-columns: 1fr; \}/);
  const html = read("src/panel/settings.html");
  assert.match(html, /id="live" role="status" aria-live="polite"/, "test results are announced");
  assert.match(html, /<a class="skip"/);
});

test("settings model: a saved Claude key is not 'connected' while Claude refuses it or the claude command is missing", () => {
  assert.match(WORDS["claude.keySavedLine"]!, /Check/, "the page promises the card says “Check” then");
  const keyOn = { connections: { connections: [{ id: "claude", state: "on" }] } };
  assert.equal(M.cardStates({ ...keyOn, claude: { status: { claude: "login" } } }).claude, "problem");
  assert.equal(M.cardStates({ ...keyOn, claude: { status: { claude: "missing" } } }).claude, "problem");
  assert.equal(M.cardStates({ ...keyOn, claude: { status: { claude: "ok" } } }).claude, "on");
  assert.equal(M.cardStates(keyOn).claude, "on", "a key with no status yet is still on");
  // A free plan is a problem too, signed in or not.
  assert.equal(M.cardStates({ claude: { status: { claude: "ok" } }, claudeConnect: { phase: "needs-plan" } }).claude, "problem");
  // A sign-in past its expiry still reads as signed in: a problem, not "on"; one that expires later is on.
  const account = (expiresAt: number) => ({ claude: { status: { claude: "ok" } }, claudeConnect: { phase: "idle", account: { loggedIn: true, expiresAt } } });
  assert.equal(M.cardStates(account(Date.now() - 60_000)).claude, "problem");
  assert.equal(M.cardStates(account(Date.now() + 86_400_000)).claude, "on");
  // And the open card never says "Claude está listo" beside a problem box: only an older Pako without the connect route says it on its own.
  const js = read("src/panel/settings.js");
  assert.match(js, /\/\/ An older Pako without the connect route: its own word\.\s*kids\.push\(success\(t\("claude\.ready"\)/);
});

test("settings page: Zoom's recordings on this Mac reach their own step (it is not a 'Listo' the wizard starts again from)", () => {
  const js = read("src/panel/settings.js");
  const wizard = js.slice(js.indexOf("function wizard(id)"), js.indexOf("const body = VIEWS[id]"));
  assert.match(wizard, /const lastIsAction = id === "zoom" && w\.path === "local";/);
  assert.match(wizard, /DONE_LAST\.has\(id\) && !lastIsAction && names\.length > 1 && w\.step === names\.length - 1/);
  // The chip and the choice both open that step.
  assert.match(js, /go\("zoom", 1, \{ path: "local" \}\)/);
  assert.match(js, /S\.wiz\.zoom = \{ step: 1, path: "local" \}/);
});

test("settings page: Telegram's card says why a stored bot cannot be used here, as the panel does, instead of only 'create a bot'", () => {
  const js = read("src/panel/settings.js");
  const view = js.slice(js.indexOf("VIEWS.telegram ="), js.indexOf("if (w.step === 2)", js.indexOf("VIEWS.telegram =")));
  assert.match(view, /const why = tg\.state === "no-token" && typeof tg\.why === "string" && tg\.why\.trim\(\) \? problem\(/);
  assert.equal([...view.matchAll(/children: \[\s*why,/g)].length, 2, "at the first step and at the token's");
});

test("settings page: an import of contacts or of the Mac's calendars redraws 'Lo que Pako sabe' (with its forget) and the chips at once", () => {
  const js = read("src/panel/settings.js");
  for (const at of ['{ type: "use", what: "contacts" }', '{ type: "use", what: "calendars", ids: [...chosen] }']) {
    const after = js.slice(js.indexOf(at), js.indexOf("go(", js.indexOf("await loadAll();", js.indexOf(at))));
    assert.match(after, /await loadAll\(\);[\s\S]*drawKnown\(\);\s*drawDiscovery\(\);/, at);
  }
});

test("settings page: custom properties in a style object are set (the sparks fly, the rows stagger); a step's column never grows past the card", () => {
  const js = read("src/panel/settings.js");
  const h = js.slice(js.indexOf("function h(tag"), js.indexOf("const icon ="));
  assert.match(h, /p\.startsWith\("--"\) \? el\.style\.setProperty\(p, String\(x\)\)/);
  assert.doesNotMatch(h, /Object\.assign\(el\.style/);
  const css = read("src/panel/settings.css");
  assert.match(css, /\.step-main \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.btn \{ white-space: normal;/);
});

test("settings model: a calendar link or a Places key not tried yet is saved, not connected, and does not count in the ring", () => {
  const s = M.cardStates({
    connections: { connections: [{ id: "calendar", state: "on", checked: false }, { id: "tables", state: "on", checked: false }] },
  });
  assert.equal(s.calendar, "saved");
  assert.equal(s.tables, "saved");
  assert.equal(M.connectedCount(s), 0, "a link Pako has not read yet is not counted as connected");
  assert.notEqual(M.nextSuggestion(s), "calendar", "nothing to do on a card that waits for its first answer");
  const read = M.cardStates({ connections: { connections: [{ id: "calendar", state: "on", checked: true }, { id: "tables", state: "on", checked: true }] } });
  assert.deepEqual([read.calendar, read.tables], ["on", "on"]);
  const older = M.cardStates({ connections: { connections: [{ id: "calendar", state: "on" }, { id: "tables", state: "on" }] } });
  assert.deepEqual([older.calendar, older.tables], ["on", "on"], "an older Pako that does not say stays as before");
  const mac = M.cardStates({ localCalendar: { calendars: ["c1"] }, connections: { connections: [{ id: "calendar", state: "on", checked: false }] } });
  assert.equal(mac.calendar, "on", "the Mac's own calendars are read already");
  const refused = M.cardStates({ connections: { connections: [{ id: "tables", state: "on", checked: false, problem: "refused" }] } });
  assert.equal(refused.tables, "problem");
});

test("settings model: what needs a developer account (WhatsApp, Slack, Zoom) is Advanced: never counted in the ring, never suggested", () => {
  assert.deepEqual([...M.COUNTED].sort(), ["calendar", "contacts", "mail", "telegram"]);
  for (const id of ["whatsapp", "slack", "zoom"]) {
    assert.ok(M.ADVANCED.includes(id), id);
    assert.ok(!M.COUNTED.includes(id), id);
  }
  const essentials = Object.fromEntries(M.COUNTED.map((id) => [id, "on"]));
  assert.equal(M.nextSuggestion({ ...essentials, whatsapp: "off", slack: "partial", zoom: "problem" }), null,
    "with the essentials on, nothing is suggested, whatever the Advanced cards say");
  assert.equal(M.connectedCount({ ...essentials, whatsapp: "on" }), 4);
  // The page has a place for the Advanced list and the words for its title and note.
  assert.match(read("src/panel/settings.html"), /id="cards-advanced"/);
  for (const k of ["advancedTitle", "advancedNote"]) assert.ok(WORDS[k], k);
});

test("settings page: with the project's own app a card is one Connect button, its own-app steps under Advanced; without it, the own-app steps", () => {
  assert.deepEqual(M.cleanClients({ slack: true, zoom: "yes", google: true, extra: true }), { slack: true, zoom: false, microsoft: false, google: true, gmail: false });
  assert.deepEqual(M.cleanClients(null), { slack: false, zoom: false, microsoft: false, google: false, gmail: false }, "an older Pako: none");
  const js = read("src/panel/settings.js");
  // The one-button view only when the server says this Pako has the app; the person's own app otherwise, or when chosen under Advanced.
  assert.match(js, /if \(w\.step === 0 && S\.data\.clients\?\.slack && w\.path !== "own"\) \{\s*return oneButton\("slack"/);
  assert.match(js, /if \(w\.step === 1 && S\.data\.clients\?\.zoom && w\.path !== "cloudOwn"\) \{\s*return oneButton\("zoom"/);
  assert.match(js, /h\("details", \{ class: "advanced" \}, h\("summary", \{\}, t\("connect\.ownApp"\)\)/);
  assert.match(js, /start: `\/panel\/api\/\$\{id\}\/connect`, body: \{\}/, "the one button sends no Client ID");
  assert.match(js, /S\.data\.clients\?\.google \? choice\("calendar", t\("cal\.google"\)/);
  assert.equal(WORDS["slack.adminNote"], "Your workspace admin may need to approve Pako. Slack sends them the request, and you press Connect Slack again once it's approved.");
  for (const k of ["slack.connectOne", "zoom.connectOne", "connect.ownApp", "cal.google"]) assert.ok(Object.hasOwn(WORDS, k), k);
});

test("settings page: a refusal for too many tries is said in plain words with what to do, never the server's bare 'too many'", () => {
  // Every panel route's rate limit answers 429 { error: "too many" }; the page's one fetch helper puts a sentence in its place.
  const code = read("src/panel/settings.js");
  const api = code.slice(code.indexOf("async function api("), code.indexOf("/** A route's answer"));
  assert.match(api, /r\.status === 429/);
  assert.match(api, /t\("err\.tooMany"\)/);
  assert.match(WORDS["err.tooMany"] ?? "", /wait a minute/i);
});
