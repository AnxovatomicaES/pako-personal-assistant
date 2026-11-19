// A memory the owner can see and correct: numbered notes (src/voice-memory.ts), NOTAS / NOTES, BORRA NOTA 3 / FORGET 3 and
// CORRIGE NOTA 3: … / EDIT 3: … in the chat (src/whatsapp.ts) with a receipt and Deshacer (src/undo.ts), and the panel's Memory routes
// (src/memory-panel.ts): editable on a person's computer, read only on a server, signed in and with the x-pako header for a change.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import { createApp, loadAppConfig, type LocalContext } from "../src/app.ts";
import { createControl } from "../src/control.ts";
import type { Lang } from "../src/i18n.ts";
import type { Kv } from "../src/kv.ts";
import { createLocalChannel, loadHome, localEnv } from "../src/local.ts";
import { sqliteKv } from "../src/sqlite-kv.ts";
import { mountMemoryPanel } from "../src/memory-panel.ts";
import { loadMemory, MAX_NOTES, notesCommand, notesListText, type MemoryStore } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp } from "../src/whatsapp.ts";

type Body = Record<string, any>;

const OWNER = "+34600111222";
const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};
/** Saturday 14 November 2026, 13:00 in Madrid. */
const T0 = Date.parse("2026-11-14T12:00:00Z");

function memKv(o: { down?: { get: boolean; set: boolean } } = {}): Kv & { m: Map<string, string> } {
  const m = new Map<string, string>();
  const wait = () => new Promise<void>((r) => setTimeout(r, 2));
  return {
    m,
    get: async (k) => {
      await wait();
      if (o.down?.get) throw new Error("store down");
      return m.get(k) ?? null;
    },
    set: async (k, v) => {
      await wait();
      if (o.down?.set) throw new Error("store down");
      m.set(k, v);
    },
  };
}

let n = 0;

/** The door with Meta faked; the owner's messages arrive as they would from WhatsApp. */
async function rig(o: { lang?: Lang; kv?: Kv } = {}) {
  const sent: Body[] = [];
  const meta = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.body) sent.push(JSON.parse(String(init.body)) as Body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const kv = o.kv ?? memKv();
  const memory = loadMemory(kv);
  const control = createControl(kv, () => T0);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => [], callContact: async () => ({ ok: true, text: "" }), lookupCall: async () => "" } });
  const config = loadWhatsappConfig(ENV, OWNER).config!;
  const app = express();
  const door = mountWhatsapp(app, {
    config, tools, memory, kv, control, ownerName: "Marta", timeZone: "Europe/Madrid", contacts: () => [], fetch: meta, now: () => T0,
    callCheckMs: 5, receiptWaitMs: 5, ...(o.lang ? { lang: () => o.lang! } : {}),
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${config.bridgeToken}` };
  const msg = (text: string, id = `wamid.m${++n}`) => ({ from: door.ownerFrom, id, timestamp: "1", type: "text", text: { body: text } });
  const say = (text: string, id?: string): Promise<string> => door.ingest(msg(text, id));
  const press = (id: string): Promise<string> =>
    door.ingest({ from: door.ownerFrom, id: `wamid.m${++n}`, timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: "" } } });
  /** The last thing the owner was shown: a text's words or a card's body, with the card's button ids. */
  const last = (): { text: string; buttons: string[] } => {
    const b = sent.at(-1)!;
    if (b.type === "text") return { text: String(b.text.body), buttons: [] };
    return { text: String(b.interactive.body.text), buttons: (b.interactive.action.buttons as Body[]).map((x) => String(x.reply.id)) };
  };
  const context = async (): Promise<string> => JSON.stringify(await (await fetch(`${base}/assistant/context`, { headers: auth })).json());
  const texts = async (): Promise<string[]> => (await memory.numbered()).map((x) => `${x.id} ${x.text}`);
  return { sent, memory, kv, say, press, last, context, texts, close: () => (server.close(), server.closeAllConnections()) };
}

test("ids: notes kept before there were numbers get them on first read, the same every time; a write keeps them, and a number is never given twice", async () => {
  const kv = memKv();
  const old = { notes: [{ at: 1, text: "uno" }, { at: 2, text: "dos" }, { at: 3, text: "tres" }], calls: [{ at: 4, summary: "una llamada" }] };
  kv.m.set("owner-memory", JSON.stringify(old));
  const m = loadMemory(kv);
  assert.deepEqual(await m.numbered(), [{ id: 1, at: 1, text: "uno" }, { id: 2, at: 2, text: "dos" }, { id: 3, at: 3, text: "tres" }]);
  assert.deepEqual((await m.numbered()).map((x) => x.id), [1, 2, 3], "read again: the same numbers");
  // What the bridge and the prompt see is unchanged: words and dates, no numbers.
  assert.deepEqual((await m.read()).notes, old.notes);
  assert.deepEqual(await m.removeNoteById(2), { id: 2, at: 2, text: "dos" });
  await m.addNote("cuatro", 5);
  assert.deepEqual((await m.numbered()).map((x) => `${x.id} ${x.text}`), ["1 uno", "3 tres", "4 cuatro"], "2 is not given to the new note");
  // A restarted server reads the same numbers from the store.
  assert.deepEqual((await loadMemory(kv).numbered()).map((x) => x.id), [1, 3, 4]);
  // A record with two notes under one number (an old copy of the server wrote one back without numbers, say): the second gets a new one.
  kv.m.set("owner-memory", JSON.stringify({ notes: [{ id: 7, at: 1, text: "a" }, { id: 7, at: 2, text: "b" }, { at: 3, text: "c" }], calls: [], nextId: 3 }));
  assert.deepEqual((await loadMemory(kv).numbered()).map((x) => `${x.id} ${x.text}`), ["7 a", "8 b", "9 c"]);
});

test("the commands are English words; a sentence without the colon, or the old Spanish words, go to the assistant", () => {
  const cmd = (s: string) => notesCommand(s, s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim());
  assert.deepEqual(cmd("NOTES"), { kind: "list" });
  assert.deepEqual(cmd("my notes"), { kind: "list" });
  assert.deepEqual(cmd("Delete note 3"), { kind: "forget", id: 3 });
  assert.deepEqual(cmd("FORGET NOTE 12"), { kind: "forget", id: 12 });
  assert.deepEqual(cmd("forget 3"), { kind: "forget", id: 3 });
  assert.deepEqual(cmd("Edit note 3: vive en Valencia"), { kind: "edit", id: 3, text: "vive en Valencia" });
  assert.deepEqual(cmd("EDIT 4: likes tea"), { kind: "edit", id: 4, text: "likes tea" });
  assert.deepEqual(cmd("EDIT NOTE 3"), { kind: "edit", id: 3, text: "" });
  for (const s of ["NOTAS", "BORRA NOTA 3", "CORRIGE NOTA 3: algo"]) assert.equal(cmd(s), null, s);
  assert.equal(cmd("edit 3 photos for me"), null);
  assert.equal(cmd("forget about it"), null);
});

test("NOTES lists the notes numbered, newest last; FORGET and EDIT answer with a receipt whose Undo puts it back", async () => {
  const r = await rig();
  try {
    assert.equal(await r.say("NOTES"), "notes shown");
    assert.match(r.last().text, /^I don't have any notes about you yet/);
    await r.memory.addNote("Vive en Madrid", T0 - 3 * 86_400_000);
    await r.memory.addNote("Le gusta el té verde", T0 - 86_400_000);
    await r.memory.addNote("Su hermana se llama Ana", T0);
    await r.say("notes");
    assert.equal(r.last().text, [
      "📝 What I know about you (3 of 60 notes, newest last):",
      "1. Vive en Madrid (11 Nov)",
      "2. Le gusta el té verde (13 Nov)",
      "3. Su hermana se llama Ana (14 Nov)",
      "",
      "To delete one: FORGET 3. To change it: EDIT 3: the new text. I tell you every change, with a button to undo it.",
    ].join("\n"));

    assert.equal(await r.say("FORGET 2"), "note deleted");
    assert.equal(r.last().text, "🗑️ Deleted note 2: “Le gusta el té verde”");
    const [undoDelete] = r.last().buttons;
    assert.match(undoDelete!, /^u1:[0-9a-f]{10}$/);
    assert.deepEqual(await r.texts(), ["1 Vive en Madrid", "3 Su hermana se llama Ana"]);
    assert.match(await r.context(), /deleted their note “Le gusta el té verde”/);
    // Delivered again under another id (or typed twice): there is no note 2 now, and nothing else is touched.
    assert.equal(await r.say("FORGET 2"), "no such note");
    assert.match(r.last().text, /^I don't have a note 2\./);
    // The same message delivered twice by Meta is handled once.
    await r.say("FORGET 3", "wamid.twice");
    const before = r.sent.length;
    await r.say("FORGET 3", "wamid.twice");
    assert.equal(r.sent.length, before);
    assert.deepEqual(await r.texts(), ["1 Vive en Madrid"]);
    assert.equal(await r.say("UNDO"), "undone");
    assert.deepEqual(await r.texts(), ["1 Vive en Madrid", "3 Su hermana se llama Ana"], "back under its own number");

    assert.equal(await r.press(undoDelete!), "button pressed");
    assert.deepEqual(await r.texts(), ["1 Vive en Madrid", "2 Le gusta el té verde", "3 Su hermana se llama Ana"], "back in its place");

    assert.equal(await r.say("Edit note 1: Vive en Valencia desde 2025"), "note edited");
    assert.equal(r.last().text, "✏️ Corrected note 1: “Vive en Valencia desde 2025”\n(Before: “Vive en Madrid”)");
    const [undoEdit] = r.last().buttons;
    assert.equal((await r.memory.numbered())[0]!.at, T0 - 3 * 86_400_000, "a correction keeps the note's date, so its place");
    assert.match(await r.context(), /corrected their note “Vive en Madrid”: it now says “Vive en Valencia desde 2025”/);
    assert.equal(await r.press(undoEdit!), "button pressed");
    assert.match(r.last().text, /^↩️ Undone/);
    assert.deepEqual(await r.texts(), ["1 Vive en Madrid", "2 Le gusta el té verde", "3 Su hermana se llama Ana"]);

    // What is refused says why and changes nothing.
    assert.equal(await r.say("EDIT 2"), "note not edited (empty)");
    assert.match(r.last().text, /EDIT 2: the new text/);
    assert.equal(await r.say("EDIT 2: Le gusta el té verde"), "note not edited (same)");
    assert.equal(await r.say("EDIT 2: Su hermana se llama Ana"), "note not edited (duplicate)");
    assert.equal(r.last().text, "I already have that in note 3: note 2 is as it was.");
    assert.equal(await r.say(`EDIT 2: ${"x".repeat(301)}`), "note not edited (long)");
    assert.equal(await r.say("EDIT 9: algo"), "note not edited (gone)");
    assert.equal(await r.say("edit 2 photos of the beach for me"), "queued", "a sentence: for the assistant");
    assert.deepEqual(await r.texts(), ["1 Vive en Madrid", "2 Le gusta el té verde", "3 Su hermana se llama Ana"]);

    // While paused too: they change only what Pako knows.
    await r.say("STOP");
    assert.equal(await r.say("NOTES"), "notes shown");
    assert.equal(await r.say("FORGET 3"), "note deleted");
  } finally {
    r.close();
  }
});

test("in English: NOTES, FORGET 3, EDIT 3: text and UNDO, and the receipt's button says Undo", async () => {
  const r = await rig({ lang: "en" });
  try {
    await r.memory.addNote("Lives in Madrid", T0 - 86_400_000);
    await r.memory.addNote("Likes green tea", T0);
    await r.say("NOTES");
    assert.equal(r.last().text.split("\n")[0], "📝 What I know about you (2 of 60 notes, newest last):");
    assert.match(r.last().text, /\n1\. Lives in Madrid \(13 Nov\)\n2\. Likes green tea \(14 Nov\)\n\nTo delete one: FORGET 3\./);
    assert.equal(await r.say("EDIT 1: Lives in Valencia"), "note edited");
    assert.equal(r.last().text, "✏️ Corrected note 1: “Lives in Valencia”\n(Before: “Lives in Madrid”)");
    const card = r.sent.at(-1)!;
    assert.equal(card.interactive.action.buttons[0].reply.title, "Undo");
    assert.equal(await r.say("forget 2"), "note deleted");
    assert.equal(r.last().text, "🗑️ Deleted note 2: “Likes green tea”");
    assert.equal(await r.say("UNDO"), "undone");
    assert.deepEqual(await r.texts(), ["1 Lives in Valencia", "2 Likes green tea"]);
    assert.equal(await r.say("forget 7"), "no such note");
    assert.equal(r.last().text, "I don't have a note 7. Type NOTES to see them with their numbers.");
    // The Spanish word is no command: it goes to the assistant.
    assert.equal(await r.say("NOTAS"), "queued");
  } finally {
    r.close();
  }
});

test("a store that does not answer: NOTES and the changes say so, and nothing is changed or shown from an old copy", async () => {
  const down = { get: false, set: false };
  const r = await rig({ kv: memKv({ down }) });
  try {
    await r.memory.addNote("Vive en Madrid", T0);
    down.get = true;
    assert.equal(await r.say("NOTES"), "notes not read");
    assert.match(r.last().text, /^I couldn't read your notes/);
    assert.equal(await r.say("FORGET 1"), "note not changed");
    assert.match(r.last().text, /^I couldn't change the note/);
    down.get = false;
    down.set = true;
    assert.equal(await r.say("EDIT 1: Vive en Valencia"), "note not changed");
    down.set = false;
    assert.deepEqual(await r.texts(), ["1 Vive en Madrid"]);
  } finally {
    r.close();
  }
});

test("the 60-note limit: the oldest leaves, the numbers keep growing, and an undo with no room keeps the note for later", async () => {
  const m = loadMemory(memKv());
  for (let i = 1; i <= MAX_NOTES + 1; i++) await m.addNote(`nota ${i}`, i);
  const all = await m.numbered();
  assert.equal(all.length, MAX_NOTES);
  assert.deepEqual([all[0]!.id, all.at(-1)!.id], [2, MAX_NOTES + 1]);
  const gone = await m.removeNoteById(5);
  assert.ok(gone && gone !== "changed");
  await m.addNote("otra", 100);
  const back = await m.restoreNotes([gone]);
  assert.deepEqual(back, { restored: [], full: [gone] });
  await m.removeNoteById(10);
  assert.deepEqual((await m.restoreNotes([gone])).restored, [gone], "with room, under its own number");
  assert.equal((await m.numbered()).find((x) => x.id === 5)?.text, "nota 5");
  // The list in the chat stays whole: the door cuts a long text into WhatsApp's 4096-character messages.
  assert.match(notesListText(await m.numbered(), "Europe/Madrid", "en"), /^📝 What I know about you \(60 of 60 notes/);
});

test("concurrent corrections of one note: one lands, the other is told it changed; edits and deletes never lose another note", async () => {
  const m = loadMemory(memKv());
  await m.addNote("uno", 1);
  await m.addNote("dos", 2);
  const [a, b] = await Promise.all([m.editNote(1, "uno corregido", "uno"), m.editNote(1, "uno, otra versión", "uno")]);
  assert.equal(a.status, "edited");
  assert.deepEqual(b, { status: "changed", now: { id: 1, at: 1, text: "uno corregido" } });
  await Promise.all([m.editNote(2, "dos corregido"), m.addNote("tres", 3), m.removeNoteById(1, "uno corregido"), m.addNote("cuatro", 4)]);
  assert.deepEqual((await m.numbered()).map((x) => `${x.id} ${x.text}`), ["2 dos corregido", "3 tres", "4 cuatro"]);
  assert.equal(await m.removeNoteById(3, "otra cosa"), "changed");
});

/** The memory routes alone, with a session check that looks for one cookie. */
async function panelRig(editable: boolean) {
  const memory: MemoryStore = loadMemory(memKv());
  const logged: string[] = [];
  const app = express();
  mountMemoryPanel(app, {
    signedIn: (req) => req.get("cookie") === "s=ok",
    memory,
    editable,
    lang: () => "en",
    control: { log: (_kind: string, text: string) => void logged.push(text) } as never,
  });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown, headers: Record<string, string> = { cookie: "s=ok", "x-pako": "1" }) => {
    const res = await fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Body, headers: res.headers };
  };
  return { memory, logged, call, close: () => (server.close(), server.closeAllConnections()) };
}

test("panel routes: signed in to read, signed in with the x-pako header to change, changes on a person's computer only", async () => {
  const p = await panelRig(true);
  try {
    await p.memory.addNote("Vive en Madrid", T0);
    await p.memory.addNote("Le gusta el té", T0 + 1);
    assert.equal((await p.call("/panel/api/memory", undefined, {})).status, 401);
    const read = await p.call("/panel/api/memory");
    assert.equal(read.status, 200);
    assert.equal(read.headers.get("cache-control"), "no-store");
    assert.deepEqual(read.body, { notes: [{ id: 1, at: T0, text: "Vive en Madrid" }, { id: 2, at: T0 + 1, text: "Le gusta el té" }], max: 60, calls: 0, lastCallAt: null, editable: true });

    assert.equal((await p.call("/panel/api/memory/delete", { id: 1, was: "Vive en Madrid" }, { cookie: "s=ok" })).status, 401, "no x-pako header");
    assert.equal((await p.call("/panel/api/memory/delete", { id: 1, was: "Vive en Madrid" }, { "x-pako": "1" })).status, 401, "not signed in");
    assert.equal((await p.call("/panel/api/memory/edit", { id: "1", text: "x", was: "y" })).status, 400);
    assert.equal((await p.call("/panel/api/memory/edit", { id: 1, text: "x" })).status, 400, "without the words it showed");

    // The page showed old words: nothing changes, and it gets the note as it is now.
    const stale = await p.call("/panel/api/memory/edit", { id: 1, text: "Vive en Sevilla", was: "Vive en Barcelona" });
    assert.deepEqual([stale.status, stale.body], [409, { error: "changed", note: { id: 1, at: T0, text: "Vive en Madrid" } }]);
    const edit = await p.call("/panel/api/memory/edit", { id: 1, text: "  Vive en  Valencia ", was: "Vive en Madrid" });
    assert.deepEqual([edit.status, edit.body], [200, { ok: true, note: { id: 1, at: T0, text: "Vive en Valencia" } }]);
    assert.equal((await p.call("/panel/api/memory/edit", { id: 2, text: "vive en valencia", was: "Le gusta el té" })).body.error, "duplicate");
    assert.equal((await p.call("/panel/api/memory/edit", { id: 2, text: "y".repeat(301), was: "Le gusta el té" })).body.error, "long");
    assert.equal((await p.call("/panel/api/memory/edit", { id: 9, text: "z", was: "z" })).status, 404);

    assert.equal((await p.call("/panel/api/memory/delete", { id: 2, was: "otra cosa" })).status, 409);
    const del = await p.call("/panel/api/memory/delete", { id: 2, was: "Le gusta el té" });
    assert.deepEqual([del.status, del.body], [200, { ok: true, note: { id: 2, at: T0 + 1, text: "Le gusta el té" } }]);
    assert.equal((await p.call("/panel/api/memory/delete", { id: 2, was: "Le gusta el té" })).status, 404, "pressed twice: gone");
    assert.deepEqual(p.logged, ["Note 1 corrected from the panel: Vive en Valencia", "Note 2 deleted from the panel: Le gusta el té"]);
    assert.deepEqual((await p.memory.numbered()).map((x) => x.text), ["Vive en Valencia"]);
  } finally {
    p.close();
  }

  const hosted = await panelRig(false);
  try {
    await hosted.memory.addNote("Vive en Madrid", T0);
    assert.equal((await hosted.call("/panel/api/memory")).body.editable, false);
    assert.equal((await hosted.call("/panel/api/memory/delete", { id: 1, was: "Vive en Madrid" })).status, 404, "a server's panel reads only");
    assert.equal((await hosted.call("/panel/api/memory/edit", { id: 1, text: "x", was: "Vive en Madrid" })).status, 404);
    assert.equal((await hosted.memory.numbered()).length, 1);
  } finally {
    hosted.close();
  }
});

test("the real app on a person's computer: the Memory routes are mounted behind the panel's own session, and memory.js is served", async () => {
  const home = loadHome({ PAKO_HOME: join(mkdtempSync(join(tmpdir(), "pako-memory-")), "home"), PAKO_NAME: "Ana" });
  const env: Record<string, string | undefined> = { ...localEnv({}, home, 0), PAKO_HOME: home.dir };
  const kv = sqliteKv(home.dir);
  const local: LocalContext = { kv, channel: createLocalChannel({ kv }), bridgeToken: home.bridgeToken, panelSecret: home.panelSecret, bridge: { status: () => ({ claude: "ok", running: true }) } };
  const app = createApp(loadAppConfig(env), env, local);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/panel/api/memory`)).status, 401);
    const login = await fetch((app.locals.panelLink as () => string)().replace(/^http:\/\/127\.0\.0\.1:\d+/, base), { redirect: "manual" });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const headers = { cookie, "x-pako": "1", "content-type": "application/json" };
    const bridge = { authorization: `Bearer ${home.bridgeToken}`, "content-type": "application/json" };
    assert.equal((await fetch(`${base}/assistant/memory`, { method: "POST", headers: bridge, body: JSON.stringify({ remember: ["Riega las plantas los domingos"] }) })).status, 200);
    const read = (await (await fetch(`${base}/panel/api/memory`, { headers })).json()) as Body;
    assert.equal(read.editable, true);
    assert.deepEqual(read.notes.map((x: Body) => `${x.id} ${x.text}`), ["1 Riega las plantas los domingos"]);
    const edit = await fetch(`${base}/panel/api/memory/edit`, { method: "POST", headers, body: JSON.stringify({ id: 1, text: "Riega las plantas los sábados", was: "Riega las plantas los domingos" }) });
    assert.equal(edit.status, 200);
    const ctx = (await (await fetch(`${base}/assistant/context`, { headers: bridge })).json()) as { memory: string };
    assert.match(ctx.memory, /Riega las plantas los sábados/);
    const js = await fetch(`${base}/panel/assets/memory.js`, { headers: { cookie } });
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
