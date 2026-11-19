// The panel in English, and the first five minutes on a computer: the panel's words (src/panel/i18n.js, every key the page uses), the
// settings route (src/dashboard.ts: name, welcome done; the strict cookie and the custom header, a computer only), the overview's fields, the
// welcome's state across a restart, the chat's hello waiting for the name (src/app.ts), and the real entry point (src/server.ts) asking nothing
// in the terminal: the panel asks, and what it is told applies at once. Pako's fixed texts are English whatever language the owner writes in.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { createApp, loadAppConfig, STAND_IN_NAME, type LocalContext } from "../src/app.ts";
import { createControl } from "../src/control.ts";
import { categoryOf } from "../src/mail-categories.ts";
import { mountDashboard, type PanelDeps, type PanelSettings } from "../src/dashboard.ts";
import type { Lang } from "../src/i18n.ts";
import { createLocalChannel, createSettings, loadHome, localEnv } from "../src/local.ts";
import { sqliteKv } from "../src/sqlite-kv.ts";
import { loadMemory } from "../src/voice-memory.ts";

type Env = Record<string, string | undefined>;
const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const tmp = (): string => mkdtempSync(join(tmpdir(), "pako-panel-"));
// The page's dictionary is a browser module with no browser code in it: the tests read the very same object.
type Words = Record<string, string>;
const PANEL_WORDS = (await import(new URL("../src/panel/i18n.js", import.meta.url).href)) as Record<string, unknown>;
const { WORDS, CHAT_WORDS } = PANEL_WORDS as { WORDS: Words; CHAT_WORDS: Words };
/** Spanish a fixed text of the panel must never have (the panel used to speak Spanish too). */
const SPANISH = /[áéíóúñ¿¡]|\b(?:Hola|recordatorios?|correos?|reuniones?|escribe|ajustes|hoy|mañana|Entrar)\b/i;

/** Waits for a condition, checking often; the long limit is for a machine running the whole suite at once. */
async function until(ok: () => boolean | Promise<boolean>, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return ok();
}

// ---------- 1. the words ----------

test("panel words: one English table; every key the page uses (index.html's data-i18n, app.js's t() and keys) is in it", () => {
  const html = read("src/panel/index.html");
  const js = read("src/panel/app.js");
  const used = new Set<string>();
  for (const m of html.matchAll(/data-(?:i18n(?:-aria|-placeholder)?|say)="([^"]+)"/g)) used.add(m[1]!);
  for (const m of js.matchAll(/\bt\("([^"]+)"/g)) used.add(m[1]!);
  // Keys picked in a condition (t(a ? "x.y" : "x.z"), dataset.i18n = ...): every dotted string in app.js that names a text.
  for (const m of js.matchAll(/"((?:[a-z]+\.)+[a-zA-Z]+)"/g)) used.add(m[1]!);
  assert.ok(used.size > 150, `the scan found the page's words (${used.size})`);
  assert.equal("es" in WORDS || "en" in WORDS, false, "a plain table, not one per language");
  assert.equal("SERVER_WORDS" in PANEL_WORDS, false, "no Spanish server words to translate any more");
  const missing = [...used].filter((k) => !(typeof WORDS[k] === "string" && WORDS[k]!.trim()));
  assert.deepEqual(missing, [], "keys the page uses that are not in the table");
  assert.deepEqual(Object.keys(WORDS).filter((k) => !used.has(k)), [], "keys nothing uses (a typo)");
  assert.deepEqual(Object.keys(WORDS).filter((k) => k.startsWith("w.lang")), [], "no language step in the welcome");
  assert.deepEqual(Object.entries({ ...WORDS, ...CHAT_WORDS }).filter(([, v]) => SPANISH.test(v)).map(([k]) => k), [], "no Spanish left");
  // The defaults written in index.html are the table's own English (the page shows them before app.js runs).
  const defaults = [...html.matchAll(/<(\w+)\b[^>]*\bdata-i18n="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)];
  assert.equal(defaults.length, html.match(/\bdata-i18n="/g)?.length, "every element with a text in the table was read");
  for (const [, , key, text] of defaults) assert.equal(text!.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&"), WORDS[key!]!.replace(/\*\*/g, ""), key!);
  assert.match(html, /^<!doctype html>\n<html lang="en">/i);
  assert.doesNotMatch(html.replace(/<!--[\s\S]*?-->/g, ""), SPANISH, "no Spanish in the page itself");
  assert.doesNotMatch(html, /name="w-lang"|data-step="lang"/, "no language picker");
});

test("panel words: a server's panel names WhatsApp; only a panel with the chat in it (a computer) names the chat", () => {
  const server = ["rem.empty", "book.hint", "sys.hint", "foot.private"];
  const html = read("src/panel/index.html");
  assert.ok(html.includes('<span class="muted small" data-i18n="book.hint">ask for them on WhatsApp</span>'));
  assert.ok(html.includes(
    '<i data-lucide="smartphone"></i><span data-i18n="sys.hint">On WhatsApp: <b>CALENDAR</b>, <b>MAIL</b>, <b>SLACK</b>, <b>BOOKINGS</b>, <b>LOG</b>, '
    + "<b>STOP</b> / <b>RESUME</b>, <b>PANEL</b>.</span>",
  ), "the hint and its phone icon");
  assert.doesNotMatch(server.map((k) => WORDS[k]).join(" "), /\bchat\b/i, "a server's panel has no chat");
  assert.match(WORDS["sys.hint"]!, /WhatsApp/);
  // The chat's variants: the same four keys, each a text the page has.
  assert.deepEqual(Object.keys(CHAT_WORDS).sort(), [...server].sort());
  for (const [key, text] of Object.entries(CHAT_WORDS)) {
    assert.ok(text.trim() && text !== WORDS[key], `${key}: its own wording`);
    assert.doesNotMatch(text, /WhatsApp/, `${key}: a computer has no WhatsApp`);
  }
  assert.equal(CHAT_WORDS["sys.hint"], "In the chat, ask in your own words (“what do I have today?”); **HELP** shows shortcuts; **STOP** stops it and **RESUME** starts it again.");
  // The page picks them by the mark the server puts on <html>, before anything is drawn.
  const js = read("src/panel/app.js");
  assert.match(js, /const HAS_CHAT = document\.documentElement\.hasAttribute\("data-chat"\);/);
  assert.match(js, /HAS_CHAT && Object\.hasOwn\(CHAT_WORDS, key\)/);
  assert.match(read("src/panel/app.css"), /html\[data-chat\]:not\(\.i18n-ready\) :is\(#sys-hint, \[data-i18n="book\.hint"\], \[data-i18n="foot\.private"\]\)/, "no flash of a server's words");
});

test("panel words: the sign-in pages and the chat's banners are English only", () => {
  assert.equal(existsSync(new URL("../src/panel/signin-en.html", import.meta.url)), false, "one server sign-in page, not one per language");
  const server = read("src/panel/signin.html");
  assert.match(server, /^<!doctype html>\n<html lang="en">/);
  assert.match(server, /<title>Pako · Sign in<\/title>[\s\S]*<h1>Pako's panel<\/h1>\n    <p>To get in, type <b>PANEL<\/b> to Pako on WhatsApp\./);
  const local = read("src/panel/signin-local.html");
  assert.match(local, /<html lang="en">/);
  assert.match(local, /To get in/);
  assert.match(local, /npm run panel/, "the way back in");
  for (const page of [server, local]) assert.doesNotMatch(page, SPANISH);
  const js = read("src/panel/app.js");
  for (const name of ["missing", "login", "limit", "failing", "offline"]) {
    assert.equal(js.match(new RegExp(`\\n  ${name}: \\(\\) => \\[`, "g"))?.length, 1, `${name}: one banner, in English`);
  }
  assert.match(js, /const STATUS_LINE = \{ missing: "[^"]+", login: "[^"]+", limit: "[^"]+", failing: "[^"]+", offline: "[^"]+" \}/, "English status lines");
  assert.doesNotMatch(js, /BANNERS_EN|\blet lang\b|useLang|setLang/, "no language switching left in the page");
});

test("the mail list marks a scam by Claude's verdict, yes or no; only without one (an older bridge) by the summary's Spanish warning", () => {
  // The server files each mail (src/mail-categories.ts categoryOf) and the page shows its category: Suspicious is red.
  const bank = "Tu banco recuerda cómo evitar el phishing.";
  assert.equal(categoryOf({ kind: "guardado", scam: false, summary: bank }), "important", "Claude said it is not one: a bank's advice is no scam");
  assert.equal(categoryOf({ kind: "aviso", scam: false, summary: "Ojo: no es una estafa, es el aviso de siempre." }), "important");
  assert.equal(categoryOf({ kind: "aviso", scam: true, summary: "Careful with this one." }), "suspicious", "the verdict, whatever the words");
  assert.equal(categoryOf({ kind: "aviso", summary: "Ojo: parece un intento de ESTAFA." }), "suspicious", "no verdict (an older bridge): the Spanish warning, as before");
  assert.equal(categoryOf({ kind: "guardado", summary: bank }), "important", "no verdict: as it always was");
  const js = read("src/panel/mail.js");
  assert.match(js, /m\.category === "suspicious" \? " scam" : ""/, "the page marks it from the category alone");
});

// ---------- 2. the settings route and the overview (the dashboard alone) ----------

function deps(over: Partial<PanelDeps> = {}): PanelDeps {
  return {
    secret: "bridge-token-for-tests-0123456789abcdef",
    publicUrl: "http://localhost:8787",
    ownerName: "Marta",
    timeZone: "Europe/Madrid",
    control: createControl(null),
    memory: loadMemory(null),
    wa: { reminders: async () => [], events: () => [], lastPoll: () => 0 },
    integrations: () => [],
    ...over,
  };
}

/** Settings as src/local.ts keeps them, in memory: what was saved, and how often the hello hook ran. */
function memorySettings(o: { fixed?: Partial<PanelSettings["fixed"]> } = {}) {
  const s = { name: "", welcomed: false, saved: [] as string[], changed: 0 };
  const settings: PanelSettings = {
    name: () => s.name,
    setName: (n) => void ((s.name = n.trim()), s.saved.push(`name=${n}`)),
    welcomed: () => s.welcomed,
    setWelcomed: () => void ((s.welcomed = true), s.saved.push("welcomed")),
    fixed: { name: false, ...o.fixed },
    changed: async () => void s.changed++,
  };
  return { s, settings };
}

async function rig(over: Partial<PanelDeps> = {}) {
  const app = express();
  const d = deps(over);
  const panel = mountDashboard(app, d);
  // As src/app.ts ends: a body the JSON reader refuses becomes a plain 400 (and no stack trace in the test's output).
  app.use((err: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).type("text").send("Bad request.");
  });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}${new URL(panel.link()).pathname}`, { redirect: "manual" });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const settings = (body: unknown, headers: Record<string, string> = { cookie, "x-pako": "1" }, type = "application/json") =>
    fetch(`${base}/panel/api/settings`, { method: "POST", headers: { "content-type": type, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const overview = async () => (await (await fetch(`${base}/panel/api/overview`, { headers: { cookie } })).json()) as Record<string, unknown>;
  return { d, base, cookie, login, settings, overview, close: () => (server.close(), server.closeAllConnections()) };
}

test("settings route: only the signed-in panel with its custom header can change anything; nonsense is refused and nothing is saved", async () => {
  const { s, settings } = memorySettings();
  const r = await rig({ settings });
  try {
    assert.equal((await r.settings({ name: "Ana" }, {})).status, 401, "no cookie");
    assert.equal((await r.settings({ name: "Ana" }, { cookie: r.cookie })).status, 401, "no custom header: another site cannot change it");
    assert.equal((await r.settings({ name: "Ana" }, { cookie: "pako_panel_8787=1999999999999.forged", "x-pako": "1" })).status, 401, "a forged cookie");
    for (const [body, why] of [
      [{ name: 42 }, "a name that is not text"],
      [{ name: "x".repeat(41) }, "a name over 40 characters"],
      [{ welcomed: false }, "the welcome cannot be undone"],
      ["[]", "an array"],
    ] as const) {
      const res = await r.settings(body);
      assert.equal(res.status, 400, why);
      assert.match(((await res.json()) as { error: string }).error, /name|welcomed|JSON object/, why);
    }
    // These never reach the route: the JSON reader refuses them, and the app's last handler answers a plain 400 (src/app.ts).
    assert.equal((await r.settings('"en"')).status, 400, "a bare string");
    assert.equal((await r.settings("{not json")).status, 400, "broken JSON");
    assert.equal((await r.settings("name=Ana", undefined, "application/x-www-form-urlencoded")).status, 400, "not JSON");
    assert.deepEqual(s.saved, [], "nothing saved by any of those");
    assert.equal(s.changed, 0);
  } finally {
    r.close();
  }
});

test("settings route: saves the name and the welcome, answers what now holds, runs the hello hook; a language sent by an older page is ignored", async () => {
  const { s, settings } = memorySettings();
  const r = await rig({ settings });
  try {
    let o = await r.overview();
    assert.equal("lang" in o, false, "the overview has no language: the page is English");
    assert.deepEqual([o.firstVisit, o.name, o.choose], [true, "", { name: true }], "a first visit on a computer");
    const saved = await r.settings({ lang: "es", name: "  Ana  " });
    assert.equal(saved.status, 200, "a language is accepted (the Mac app and older pages send one) and ignored");
    assert.deepEqual(await saved.json(), { ok: true, name: "Ana" });
    assert.deepEqual(s.saved, ["name=  Ana  "], "the name is cleaned where it is kept (src/local.ts); no language saved");
    assert.equal(s.changed, 1, "the hello hook ran before the answer");
    assert.deepEqual(await (await r.settings({ lang: "fr" })).json(), { ok: true, name: "Ana" }, "any language: ignored, the same answer, and the hook again");
    assert.equal(s.changed, 2);
    o = await r.overview();
    assert.deepEqual([o.firstVisit, o.name], [true, "Ana"], "still the first visit until the welcome is done");
    assert.equal((await r.settings({ welcomed: true })).status, 200);
    o = await r.overview();
    assert.equal(o.firstVisit, false, "done: it never comes back");
    assert.equal((await r.settings({ name: "" })).status, 200, "a name can be taken back");
    assert.equal((await r.overview()).name, "");
  } finally {
    r.close();
  }
});

test("settings route: a server has none (404, even signed in); its overview has no first visit and nothing to choose, its name is the owner's", async () => {
  const r = await rig();
  try {
    assert.equal((await r.settings({ name: "Ana" })).status, 404);
    const o = await r.overview();
    assert.deepEqual([o.firstVisit, o.name, o.choose], [false, "Marta", null]);
  } finally {
    r.close();
  }
  // What a setting decides is not offered: PAKO_NAME (src/app.ts passes it).
  const { settings } = memorySettings({ fixed: { name: true } });
  const fixed = await rig({ settings });
  try {
    assert.deepEqual((await fixed.overview()).choose, { name: false });
  } finally {
    fixed.close();
  }
});

test("the page is English from its first paint: <html lang>, the page after a link, the panel's lines in the log; its own files are served", async () => {
  const control = createControl(null);
  const r = await rig({ control });
  try {
    assert.match(await r.login.text(), /<html lang="en">[\s\S]*Opening…/, "the page a link answers with");
    assert.ok((await control.recent(5)).some((l) => l.text === "Panel opened in a new browser"));
    const stop = await fetch(`${r.base}/panel/api/pause`, { method: "POST", headers: { cookie: r.cookie, "x-pako": "1", "content-type": "application/json" }, body: '{"on":true}' });
    assert.equal(stop.status, 200);
    assert.ok((await control.recent(5)).some((l) => l.text === "STOP from the panel: everything stopped"));
    // Not signed in, on a server: the sign-in page, byte for byte the file.
    assert.equal(await (await fetch(`${r.base}/panel`)).text(), read("src/panel/signin.html"));
    assert.equal(await (await fetch(`${r.base}/panel/login/not-a-link`)).text(), read("src/panel/signin.html"), "a used or wrong link too");
    // Signed in, on a server with no country known: the page as the file is, with no mark of a chat.
    const hosted = await (await fetch(`${r.base}/panel`, { headers: { cookie: r.cookie } })).text();
    assert.equal(hosted, read("src/panel/index.html"));
    assert.match(hosted, /^<!doctype html>\n<html lang="en">/);
    assert.doesNotMatch(hosted, /<html[^>]*data-chat/);
    const words = await fetch(`${r.base}/panel/assets/i18n.js`);
    assert.equal(words.status, 200);
    assert.match(words.headers.get("content-type") ?? "", /^text\/javascript/);
    assert.match(await words.text(), /export const WORDS/);
    const qr = await fetch(`${r.base}/panel/assets/botfather.svg`);
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get("content-type") ?? "", /^image\/svg\+xml/);
    assert.match(await qr.text(), /^<svg [^>]*viewBox="0 0 \d+ \d+"/, "the QR that opens @BotFather, made here");
    assert.equal((await fetch(`${r.base}/panel/assets/telegram.svg`)).status, 404);
  } finally {
    r.close();
  }
});

// ---------- 3. the first five minutes on a computer, through the whole app ----------

/** Pako in local mode as src/server.ts builds it (its settings, the stand-in name), on a home of its own: a Spanish computer by default. */
async function localPako(o: { dir?: string; env?: Env } = {}) {
  const dir = o.dir ?? tmp();
  const given: Env = { LANG: "es_ES.UTF-8", ...o.env };
  const home = loadHome({ PAKO_HOME: join(dir, "home"), ...given });
  const settings = createSettings(home.dir, given, home.firstRun === true);
  home.name = settings.name() || STAND_IN_NAME;
  const env: Env = { ...localEnv(given, home, 0), PAKO_HOME: home.dir };
  const kv = sqliteKv(home.dir);
  const local: LocalContext = {
    kv, channel: createLocalChannel({ kv }), bridgeToken: home.bridgeToken, panelSecret: home.panelSecret, bridge: { status: () => ({ claude: "ok", running: true }) }, settings,
  };
  const app = createApp(loadAppConfig(env), env, local);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const link = (app.locals.panelLink as () => string)().replace(/^http:\/\/127\.0\.0\.1:\d+/, base);
  const cookie = ((await fetch(link, { redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0]!;
  const json = async (path: string, body?: unknown) =>
    (await (await fetch(`${base}${path}`, body === undefined ? { headers: { cookie } } : {
      method: "POST", headers: { cookie, "x-pako": "1", "content-type": "application/json" }, body: JSON.stringify(body),
    })).json()) as Record<string, unknown>;
  const chat = async () => ((await json("/panel/api/chat?since=0")) as { messages: { who: string; text: string }[] }).messages;
  const context = async () =>
    (await (await fetch(`${base}/assistant/context`, { headers: { authorization: `Bearer ${home.bridgeToken}` } })).json()) as { ownerName: string };
  return {
    dir, home, app, base, json, chat, context, uiLang: app.locals.uiLang as () => Lang,
    page: (path: string) => fetch(`${base}${path}`, { headers: { cookie } }),
    close: () => (server.close(), server.closeAllConnections()),
  };
}

test("a computer's panel is marked as having the chat, and is English on a Spanish computer; its sign-in page is English", async () => {
  const p = await localPako();
  try {
    const page = async () => (await p.page("/panel")).text();
    assert.match(await page(), /^<!doctype html>\n<html lang="en" data-chat data-region="ES">/);
    await p.json("/panel/api/settings", { lang: "es" });
    assert.match(await page(), /^<!doctype html>\n<html lang="en" data-chat data-region="ES">/, "a language sent changes nothing");
    assert.equal(await (await fetch(`${p.base}/panel`)).text(), read("src/panel/signin-local.html"));
  } finally {
    p.close();
  }
});

test("first visit: the hello waits for the welcome's name and comes once (two saves at once), in English for an owner on a Spanish computer", async () => {
  const p = await localPako();
  try {
    let o = await p.json("/panel/api/overview");
    assert.deepEqual([o.firstVisit, o.name, o.choose], [true, "", { name: true }]);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(await p.chat(), [], "no hello before the person has said their name");
    assert.equal((await p.context()).ownerName, "friend", "the stand-in, in English");
    assert.equal(o.ownerName, "friend");
    // The welcome's "about you" save (an older page also sends a language), and a second tab saving at the same moment.
    const [a, b] = await Promise.all([p.json("/panel/api/settings", { lang: "es", name: "Ana" }), p.json("/panel/api/settings", {})]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    // The hello is written right after the save answers: wait for it (a busy machine can take a moment), then make sure it came once.
    assert.ok(await until(async () => (await p.chat()).length > 0), "the hello came");
    await new Promise((r) => setTimeout(r, 100));
    const hello = await p.chat();
    assert.equal(hello.length, 1, "said once");
    assert.match(hello[0]!.text, /^Hi, Ana\. I'm Pako, your assistant\./);
    assert.match(hello[0]!.text, /No commands to learn; if you'd like shortcuts, type HELP\.$/);
    assert.equal(p.uiLang(), "en", "the server's own texts are English");
    assert.equal((await p.context()).ownerName, "Ana", "the assistant knows the name at once, no restart");
    o = await p.json("/panel/api/overview");
    assert.deepEqual([o.name, o.ownerName, o.firstVisit], ["Ana", "Ana", true]);
    assert.equal((await p.json("/panel/api/settings", { welcomed: true })).ok, true);
    assert.equal((await p.json("/panel/api/overview")).firstVisit, false);
    assert.deepEqual(JSON.parse(readFileSync(join(p.home.dir, "config.json"), "utf8")), { name: "Ana", welcomed: true }, "kept in ~/.pako/config.json, no language");
  } finally {
    p.close();
  }
  // A restart on the same home: the welcome stays done, and the hello is not said again.
  // The restart waits for the hello to be in the store's file, however long the first answer takes on a busy machine.
  const kept = join(p.home.dir, "kv.db");
  assert.ok(await until(() => existsSync(kept) && /I'm Pako/.test(readFileSync(kept, "utf8"))), "the hello reached the chat's file");
  const again = await localPako({ dir: p.dir });
  try {
    const o = await again.json("/panel/api/overview");
    assert.deepEqual([o.firstVisit, o.name], [false, "Ana"]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await again.chat()).filter((m) => /I'm Pako/.test(m.text)).length, 1);
  } finally {
    again.close();
  }
});

test("first visit: an empty save that lands first (a second tab) does not say the hello before the name; the name's save then says it", async () => {
  const p = await localPako();
  try {
    assert.equal((await p.json("/panel/api/settings", {})).ok, true);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(await p.chat(), [], "no hello yet: the welcome is still asking for the name");
    assert.equal((await p.json("/panel/api/settings", { name: "Ana" })).ok, true);
    assert.ok(await until(async () => (await p.chat()).length > 0), "the hello came");
    const hello = await p.chat();
    assert.equal(hello.length, 1);
    assert.match(hello[0]!.text, /^Hi, Ana\. I'm Pako/);
  } finally {
    p.close();
  }
});

test("first visit: someone already welcomed gets the hello at the start, with their name and HELP in it; a Spanish choice kept from before is English now", async () => {
  const dir = tmp();
  const home = join(dir, "home");
  loadHome({ PAKO_HOME: home });
  writeFileSync(join(home, "config.json"), JSON.stringify({ lang: "en", name: "Bo", welcomed: true }));
  const p = await localPako({ dir });
  try {
    assert.ok(await until(async () => (await p.chat()).length === 1));
    assert.equal((await p.chat())[0]!.text, "Hi, Bo. I'm Pako, your assistant. Ask me anything in your own words: “what do I have today?”, “what am I forgetting?”, "
      + "“remind me to call Ana tomorrow”.\n\nNo commands to learn; if you'd like shortcuts, type HELP.");
  } finally {
    p.close();
  }
  // No name at all, and Spanish chosen in the panel back when it offered it: a hello with no name, in English, not "Hi, friend".
  const nameless = tmp();
  loadHome({ PAKO_HOME: join(nameless, "home") });
  writeFileSync(join(nameless, "home", "config.json"), JSON.stringify({ lang: "es", welcomed: true }));
  const q = await localPako({ dir: nameless });
  try {
    assert.ok(await until(async () => (await q.chat()).length === 1));
    assert.match((await q.chat())[0]!.text, /^Hi, I'm Pako, your assistant\./);
    assert.equal((await q.context()).ownerName, "friend");
    assert.equal(q.uiLang(), "en");
  } finally {
    q.close();
  }
});

test("first visit: what PAKO_NAME decides is not offered and a save cannot change it; PAKO_LANGUAGE changes nothing", async () => {
  const p = await localPako({ env: { PAKO_LANGUAGE: "es", PAKO_NAME: "Marta" } });
  try {
    const o = await p.json("/panel/api/overview");
    assert.deepEqual([o.name, o.choose, o.firstVisit], ["Marta", { name: false }, true]);
    assert.deepEqual(await p.json("/panel/api/settings", { lang: "en", name: "Otra" }), { ok: true, name: "Marta" }, "the setting wins");
    assert.equal(p.uiLang(), "en", "PAKO_LANGUAGE=es is ignored");
    assert.equal((await p.context()).ownerName, "Marta");
    assert.match((await p.chat())[0]!.text, /^Hi, Marta\. I'm Pako/, "the save brought the hello, in English");
  } finally {
    p.close();
  }
});

// ---------- 4. the real entry point: no question in the terminal ----------

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function startPako(dir: string, env: Env) {
  const fake = join(dir, "claude");
  writeFileSync(fake, "#!/bin/sh\nexit 0\n");
  chmodSync(fake, 0o755);
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", new URL("../src/server.ts", import.meta.url).pathname], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: dir, PAKO_HOME: join(dir, "home"), PAKO_NO_OPEN: "1", CLAUDE_BIN: fake, ...env } as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return {
    out: () => out,
    shows: (re: RegExp) => until(() => re.test(out)),
    stop: async () => {
      child.kill("SIGINT");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000).unref())]);
      child.kill("SIGKILL");
      child.stdout!.destroy();
      child.stderr!.destroy();
    },
  };
}

test("start: the terminal asks nothing in local mode; a Spanish computer gets the English stand-in; the panel's answers apply without a restart", async () => {
  assert.doesNotMatch(read("src/server.ts"), /askName/, "the entry point never asks in the terminal");
  const dir = tmp();
  const port = await freePort();
  const pako = startPako(dir, { PORT: String(port), LANG: "es_ES.UTF-8" });
  try {
    assert.ok(await pako.shows(/Pako is running for you/), pako.out());
    assert.doesNotMatch(pako.out(), /¿Cómo quieres que te llame\?|What should I call you\?/);
    const link = /http:\/\/127\.0\.0\.1:\d+\/panel\/login\/\S+/.exec(pako.out())![0].replace("localhost", "127.0.0.1");
    const cookie = ((await fetch(link, { redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0]!;
    const base = `http://127.0.0.1:${port}`;
    const token = (JSON.parse(readFileSync(join(dir, "home", "secrets.json"), "utf8")) as { bridgeToken: string }).bridgeToken;
    const ownerName = async () => ((await (await fetch(`${base}/assistant/context`, { headers: { authorization: `Bearer ${token}` } })).json()) as { ownerName: string }).ownerName;
    const o = (await (await fetch(`${base}/panel/api/overview`, { headers: { cookie } })).json()) as Record<string, unknown>;
    assert.deepEqual([o.firstVisit, o.name, o.choose], [true, "", { name: true }]);
    assert.equal(await ownerName(), "friend");
    const saved = await fetch(`${base}/panel/api/settings`, { method: "POST", headers: { cookie, "x-pako": "1", "content-type": "application/json" }, body: '{"name":"Lin","welcomed":true}' });
    assert.deepEqual(await saved.json(), { ok: true, name: "Lin" });
    assert.equal(await ownerName(), "Lin", "the name the panel was given, at once");
    const chat = (await (await fetch(`${base}/panel/api/chat?since=0`, { headers: { cookie } })).json()) as { messages: { text: string }[] };
    assert.match(chat.messages[0]!.text, /^Hi, Lin\. I'm Pako/);
  } finally {
    await pako.stop();
  }
});
