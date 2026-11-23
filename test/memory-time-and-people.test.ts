// Memory that knows time and people (src/memory-facts.ts, src/people-graph.ts, wired in src/whatsapp.ts, src/app.ts and assistant/bridge.ts):
// dated facts that close instead of overwriting, the isolated judge and its fallback, the old notes and people read into the new shape with
// nothing lost, people matched on identities first and by name only with the owner's yes, what Slack, the mail, the calendar and Zoom feed,
// the assistant's recall, the person card in plain words, and the autonomy and follow-ups using the same person.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { parseReply } from "../assistant/bridge.ts";
import { JUDGE_PROMPT, SYSTEM_PROMPT } from "../assistant/prompt.ts";
import { matchContacts } from "../src/autonomy.ts";
import { attendeesOf } from "../src/calendar.ts";
import { createControl } from "../src/control.ts";
import type { Kv } from "../src/kv.ts";
import { changesBrief, changesSince, createFacts, currentAbout, FACTS_MAX, judgement, ownAttribute, JUDGE_MS, type Fact } from "../src/memory-facts.ts";
import {
  createPeopleGraph, eventSightings, identityValue, mailSightings, slackSightings, splitAddress, whoCommand, zoomSightings,
} from "../src/people-graph.ts";
import { createPeople } from "../src/people.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp } from "../src/whatsapp.ts";
import { speakersOf } from "../src/zoom.ts";

const TZ = "Europe/Madrid";
/** Tuesday 17 November 2026, 10:00 in Madrid. */
const T0 = Date.parse("2026-11-17T09:00:00Z");
const DAY = 24 * 3600_000;
type Body = Record<string, any>;

function memKv(): Kv & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => {
      m.set(k, v);
    },
  };
}

/** The old stores exactly as an earlier Pako wrote them: notes without numbers on one, numbered on another; a person with all its parts. */
function oldStores(kv: Kv & { m: Map<string, string> }): void {
  kv.m.set("owner-memory", JSON.stringify({
    notes: [{ at: T0 - 40 * DAY, text: "Soy alérgico a los frutos secos" }, { at: T0 - 10 * DAY, text: "Vivo en Madrid", id: 7 }],
    calls: [{ at: T0 - DAY, summary: "Llamada con el banco" }],
    nextId: 8,
  }));
  kv.m.set("assistant-people", JSON.stringify([
    {
      id: "0a1b2c3d4e", name: "Ana", relation: "mi hermana", birthday: "1990-03-14", likes: ["el jazz"], notes: ["su hija empieza el cole"],
      at: T0 - 30 * DAY, updated: T0 - 5 * DAY, reminder: "abc123",
    },
  ]));
}

// ---------- 1. dated facts: the store ----------

test("migration: the old notes and people read into dated facts on the first load, nothing lost, the old stores left as they were", async () => {
  const kv = memKv();
  oldStores(kv);
  const before = { memory: kv.m.get("owner-memory"), people: kv.m.get("assistant-people") };
  const memory = loadMemory(kv);
  const people = createPeople(kv);
  const facts = createFacts(kv, { now: () => T0, seed: async () => ({ notes: await memory.numbered(), people: await people.read(true) }) });
  const all = await facts.read();
  const owner = currentAbout(all, [""]).map((f) => [f.attribute, f.value, f.validFrom]);
  assert.deepEqual(owner.sort(), [["note", "Soy alérgico a los frutos secos", T0 - 40 * DAY], ["note", "Vivo en Madrid", T0 - 10 * DAY]].sort());
  const ana = currentAbout(all, ["ana"]).map((f) => `${f.attribute}=${f.value}`).sort();
  assert.deepEqual(ana, ["birthday=1990-03-14", "likes=el jazz", "note=su hija empieza el cole", "relation=mi hermana"]);
  for (const f of all) {
    assert.equal(f.source.who, "owner");
    assert.ok(f.learnedAt > 0 && f.validTo === undefined && f.origin);
  }
  // The old stores are the same bytes: the old commands and an older Pako keep working with them.
  assert.equal(kv.m.get("owner-memory"), before.memory);
  assert.equal(kv.m.get("assistant-people"), before.people);
  // A second load adds nothing (the same facts, the same ids).
  const again = await facts.read();
  assert.deepEqual(again.map((f) => f.id).sort(), all.map((f) => f.id).sort());
});

test("migration: a record from an older shape of the facts store gets what it lacks, and a broken entry is dropped, not the rest", async () => {
  const kv = memKv();
  kv.m.set("memory-facts", JSON.stringify({ facts: [
    { id: "aaaaaaaaaa", subject: "Rohan", attribute: "oficina", value: "Londres", validFrom: T0 - DAY },
    { id: "nothex", attribute: "x", value: "y", validFrom: 1 },
    { id: "bbbbbbbbbb", subject: "Rohan", attribute: "oficina", value: "Dublín", learnedAt: T0 - 2 * DAY, validTo: T0 - DAY },
  ] }));
  const all = await createFacts(kv, { now: () => T0 }).read();
  assert.deepEqual(all.map((f) => f.id), ["aaaaaaaaaa", "bbbbbbbbbb"]);
  // A fact derived before Pako was English only keeps its stored Spanish attribute, and reads as the English one.
  const old = { ...all[0]!, attribute: "relaci\u00f3n", origin: "person:p1:relation" };
  assert.equal(ownAttribute(old), "relation");
  assert.equal(ownAttribute({ ...old, origin: undefined }), "relaci\u00f3n", "a told fact keeps the words it was told in");
  assert.equal(all[0]!.learnedAt, T0 - DAY);
  assert.deepEqual(all[0]!.source, { who: "?", where: "?", at: T0 - DAY });
  assert.equal(all[1]!.validFrom, T0 - 2 * DAY);
  assert.equal(all[1]!.closedAt, T0 - DAY, "closed when it stopped, as far as the old record says");
});

test("a changed note or relation closes the old fact and opens a new one; a deleted note or person is forgotten with its history", async () => {
  const kv = memKv();
  oldStores(kv);
  const clock = { now: T0 };
  const memory = loadMemory(kv);
  const people = createPeople(kv);
  const facts = createFacts(kv, { now: () => clock.now, seed: async () => ({ notes: await memory.numbered(), people: await people.read(true) }) });
  await facts.read();
  clock.now = T0 + DAY;
  const ana = (await people.read(true))[0]!;
  await people.edit(ana.id, { relation: "mi prima" }, clock.now);
  await memory.editNote(7, "Vivo en Valencia");
  const all = await facts.read();
  const rel = all.filter((f) => f.subject === "Ana" && f.attribute === "relation");
  assert.equal(rel.length, 2);
  const [old, now] = [rel.find((f) => f.validTo !== undefined)!, rel.find((f) => f.validTo === undefined)!];
  assert.equal(old.value, "mi hermana");
  assert.equal(old.closedBy, now.id);
  assert.equal(now.value, "mi prima");
  assert.equal(now.validFrom, T0 + DAY);
  const lines = changesSince(all, T0, "en", TZ);
  assert.ok(lines.some((l) => l.includes("Ana · relation: “mi hermana” → “mi prima”")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("“Vivo en Madrid” → “Vivo en Valencia”")), lines.join("\n"));
  // Deleting is forgetting: no closed fact, no history, left behind.
  await memory.removeNoteById(7);
  await people.remove(ana.id);
  const left = await facts.read();
  assert.equal(left.filter((f) => /Valencia|Madrid/.test(f.value)).length, 0);
  assert.equal(left.filter((f) => f.subject === "Ana").length, 0);
});

test("a store that cannot be read: the facts are not touched and nothing derived is deleted", async () => {
  const kv = memKv();
  oldStores(kv);
  let down = false;
  const memory = loadMemory(kv);
  const facts = createFacts(kv, {
    now: () => T0,
    seed: async () => {
      if (down) throw new Error("store down");
      return { notes: await memory.numbered(), people: [] };
    },
  });
  const n = (await facts.read()).length;
  down = true;
  assert.equal((await facts.read()).length, n);
});

test("told facts: another value for the same subject and attribute closes the old one (newest wins); the same value is known; many-valued never closes", async () => {
  const kv = memKv();
  const facts = createFacts(kv, { now: () => T0 });
  const src = { who: "owner", where: "chat", at: T0 };
  await facts.add([{ subject: "Rohan", attribute: "reunión semanal", value: "martes 10:00", source: src, validFrom: T0 - 20 * DAY }], T0 - 20 * DAY);
  const same = await facts.add([{ subject: "rohan", attribute: "Reunión semanal", value: "Martes 10:00", source: src }], T0);
  assert.equal(same.same, 1);
  const r = await facts.add([{ subject: "Rohan", attribute: "reunión semanal", value: "jueves 10:00", source: src }], T0);
  assert.equal(r.closed.length, 1);
  assert.equal(r.closed[0]!.old.value, "martes 10:00");
  assert.equal(r.closed[0]!.old.validTo, T0, "true until the new value began");
  const all = await facts.read();
  assert.deepEqual(currentAbout(all, ["Rohan"]).map((f) => f.value), ["jueves 10:00"]);
  assert.deepEqual(changesSince(all, T0 - DAY, "en", TZ), ["Rohan · reunión semanal: “martes 10:00” → “jueves 10:00” (17 Nov)"]);
  assert.match(changesBrief(all, T0, "en", TZ)!, /^🔁 Changed since yesterday:\n• Rohan · reunión semanal/);
  assert.equal(changesBrief(all, T0 + 3 * DAY, "en", TZ), null);
  await facts.add([{ subject: "Rohan", attribute: "habla", value: "inglés", source: src, multi: true }], T0);
  await facts.add([{ subject: "Rohan", attribute: "habla", value: "hindi", source: src, multi: true }], T0);
  assert.deepEqual(currentAbout(await facts.read(), ["Rohan"]).filter((f) => f.attribute === "habla").map((f) => f.value).sort(), ["hindi", "inglés"]);
});

test("told facts: a value that held before the current one (told late) is history; it never closes the newer one, nor shows as a change", async () => {
  const kv = memKv();
  const facts = createFacts(kv, { now: () => T0 });
  const src = { who: "owner", where: "chat", at: T0 };
  await facts.add([{ subject: "Ana", attribute: "works at", value: "Acme", source: src, validFrom: T0 - 30 * DAY }], T0 - 30 * DAY);
  // Today the owner mentions where Ana was in 2020; the weekly review of a meeting held before her last one comes late: the same rule.
  const r = await facts.add([{ subject: "Ana", attribute: "works at", value: "Initech", source: src, validFrom: Date.parse("2020-01-01T00:00:00Z") }], T0, { judge: true });
  assert.equal(r.closed.length, 0);
  assert.equal(r.pending.length, 0, "nothing for the judge: the dates already say which came first");
  const all = await facts.read();
  assert.deepEqual(currentAbout(all, ["Ana"]).map((f) => f.value), ["Acme"]);
  const old = all.find((f) => f.value === "Initech")!;
  assert.equal(old.validTo, T0 - 30 * DAY, "true until Acme began");
  assert.deepEqual(changesSince(all, T0 - DAY, "en", TZ), [], "nothing changed: Pako learnt some history");
});

test("the judge: a candidate waits; compatible keeps both, contradicts closes, anything not strict JSON or no answer in time is the newest winning", async () => {
  const clock = { now: T0 };
  const facts = createFacts(memKv(), { now: () => clock.now });
  const src = { who: "owner", where: "chat", at: T0 };
  const add = (attribute: string, value: string) => facts.add([{ subject: "Lucía", attribute, value, source: src }], clock.now, { judge: true });
  const first = async (attribute: string, a: string, b: string): Promise<{ old: Fact; fresh: Fact }> => {
    const old = (await add(attribute, a)).added[0]!;
    const r = await add(attribute, b);
    assert.equal(r.pending.length, 1);
    assert.equal(r.closed.length, 0);
    assert.deepEqual(r.pending[0]!.against.map((f) => f.id), [old.id]);
    return { old, fresh: r.pending[0]!.fact };
  };
  // Both hold.
  let p = await first("hijos", "Pablo", "Marta");
  assert.deepEqual(await facts.verdict(p.fresh.id, JSON.stringify({ contradicts: [], compatible: [p.old.id] }), clock.now), { ok: true, closed: 0 });
  assert.deepEqual(currentAbout(await facts.read(), ["Lucía"]).filter((f) => f.attribute === "hijos").map((f) => f.value).sort(), ["Marta", "Pablo"]);
  // A contradiction, in a code fence (tolerated).
  p = await first("ciudad", "Sevilla", "Bilbao");
  assert.equal((await facts.verdict(p.fresh.id, "```json\n" + JSON.stringify({ contradicts: [p.old.id] }) + "\n```", clock.now)).closed, 1);
  // Prose: the newest wins.
  p = await first("empresa", "Acme", "Globex");
  assert.equal((await facts.verdict(p.fresh.id, "I think they both hold", clock.now)).closed, 1);
  assert.equal((await facts.verdict(p.fresh.id, "{}", clock.now)).ok, false, "answered once only");
  // No answer (an older bridge let the job go): after JUDGE_MS the next read closes it.
  p = await first("coche", "rojo", "azul");
  clock.now += JUDGE_MS - 1;
  assert.equal((await facts.read()).find((f) => f.id === p.old.id)!.validTo, undefined);
  clock.now += 1;
  const old = (await facts.read()).find((f) => f.id === p.old.id)!;
  assert.equal(old.closedBy, p.fresh.id);
  assert.equal(judgement("nope"), null);
  assert.equal(judgement(JSON.stringify({ contradicts: "x" })), null);
});

// ---------- 2. people with identities ----------

test("identities: an address, a Slack id and a number are kept normalised; machines and junk are not identities", () => {
  assert.equal(identityValue("email", "Ana.Garcia@Example.COM"), "ana.garcia@example.com");
  assert.equal(identityValue("email", "mailto:ana@x.io"), "ana@x.io");
  assert.equal(identityValue("email", "no-reply@shop.com"), "");
  assert.equal(identityValue("email", "not an address"), "");
  assert.equal(identityValue("slack", "U012ABCDEF"), "U012ABCDEF");
  assert.equal(identityValue("slack", "u012"), "");
  assert.equal(identityValue("phone", "+34 611 22 33 44"), "34611223344");
  assert.deepEqual(splitAddress("\"Ana García\" <Ana@X.com>"), { name: "Ana García", email: "ana@x.com" });
  assert.deepEqual(splitAddress("ana@x.com"), { name: "", email: "ana@x.com" });
});

test("resolution: the same identity is the same person (a new name is only seen); a name alone never merges, it asks; yes merges, no is remembered", async () => {
  const kv = memKv();
  const people = createPeople(kv);
  await people.upsert({ name: "Ana", relation: "mi hermana" }, T0 - DAY);
  const g = createPeopleGraph(kv, { now: () => T0, people: () => people.read(true) });
  await g.observe([...mailSightings([{ at: T0, from: "Ana García <ana@x.com>" }]), ...slackSightings({ who: "Rohan S", user: "U0ROHAN1", at: T0 })]);
  // The same Slack id with another display name: the same record, the name only "seen".
  await g.observe(slackSightings({ who: "Bob", user: "U0ROHAN1", at: T0 + 1 }));
  let { persons, questions } = await g.read();
  const vik = persons.find((p) => p.identities.some((i) => i.value === "U0ROHAN1"))!;
  assert.equal(vik.name, "Rohan S");
  assert.deepEqual(vik.seen, ["Bob"]);
  assert.deepEqual(vik.contacts.map((c) => c.via), ["slack", "slack"]);
  assert.deepEqual(g.trustedNames("Bob"), [], "a name from someone else's Slack is never trusted");
  assert.equal(persons.length, 3, "Ana (the owner's), Ana García (mail), Rohan");
  // "Ana" and "Ana García": a question, not a merge.
  assert.equal(questions.length, 1);
  const q = await g.nextQuestion(T0);
  assert.ok(q);
  assert.equal(q.a.name, "Ana");
  assert.equal(q.b.name, "Ana García");
  assert.equal(await g.nextQuestion(T0 + 1), null, "asked: not again for three days");
  assert.ok(await g.nextQuestion(T0 + 3 * DAY));
  const yes = await g.answer(q.q.id, true, T0 + 3 * DAY);
  assert.ok(yes?.yes);
  ({ persons, questions } = await g.read());
  const ana = persons.find((p) => p.personId)!;
  assert.equal(ana.name, "Ana");
  assert.deepEqual(ana.aliases, ["Ana García"]);
  assert.equal(ana.identities[0]!.value, "ana@x.com");
  assert.equal(persons.length, 2);
  assert.deepEqual(g.trustedNames("ana garcía"), ["Ana", "Ana García"]);
  assert.equal(g.canon("ana@x.com"), "Ana");
  assert.equal(g.canon("U0ROHAN1"), "Rohan S");
  // No: remembered, never asked again for the same two.
  await g.observe(mailSightings([{ at: T0, from: "Rohan S <vik@corp.com>" }]));
  const q2 = await g.nextQuestion(T0 + 4 * DAY);
  assert.ok(q2);
  await g.answer(q2.q.id, false, T0 + 4 * DAY);
  await g.observe(mailSightings([{ at: T0 + 5 * DAY, from: "Rohan S <vik@corp.com>" }]));
  assert.equal((await g.read()).questions.length, 0);
});

test("the owner's people: each gets a linked record, renamed with them; a forgotten one's record goes when nothing else was seen of them", async () => {
  const kv = memKv();
  oldStores(kv);
  const people = createPeople(kv);
  const g = createPeopleGraph(kv, { now: () => T0, people: () => people.read(true) });
  let { persons } = await g.read();
  assert.deepEqual(persons.map((p) => [p.name, p.personId]), [["Ana", "0a1b2c3d4e"]]);
  await people.edit("0a1b2c3d4e", { name: "Ana María" }, T0);
  ({ persons } = await g.read());
  assert.equal(persons[0]!.name, "Ana María");
  assert.deepEqual(persons[0]!.aliases, ["Ana"], "the old name stays a trusted alias");
  await people.remove("0a1b2c3d4e");
  assert.equal((await g.read()).persons.length, 0);
});

test("feeds: mail senders, calendar attendees (ICS and Zoho shapes), Slack authors and Zoom speakers become sightings, never their words", () => {
  assert.deepEqual(mailSightings([{ at: 1, from: "Ana <ana@x.com>" }, { at: 2, from: "Shop <no-reply@shop.com>" }]).length, 2);
  assert.deepEqual(eventSightings([{ start: 5, attendees: [{ email: "lu@x.com", name: "Lucía" }] }]), [
    { name: "Lucía", identities: [{ kind: "email", value: "lu@x.com" }], via: "calendario", at: 5 },
  ]);
  assert.deepEqual(attendeesOf([{ email: "MAILTO:Lu@X.com", name: "Lucía" }, { email: "lu@x.com" }, { email: "bad" }]), [{ email: "lu@x.com", name: "Lucía" }]);
  assert.deepEqual(slackSightings({ who: "Ana", at: 1 }), [], "no Slack id (an older payload): nothing");
  assert.deepEqual(zoomSightings(["Ana López"], 9)[0]!.identities, [{ kind: "zoom", value: "Ana López" }]);
  assert.deepEqual(speakersOf("Ana López: hola\nRohan: buenos días\nAna López: otra cosa\nsin hablante"), ["Ana López", "Rohan"]);
});

test("autonomy: a contact is found by a name the owner confirmed for the same person, never by a name seen in someone else's text", () => {
  const book = [{ name: "Victoria Pérez" }, { name: "Ana López" }];
  const trusted = (to: string): string[] => (to.toLowerCase() === "vicky" ? ["Victoria Pérez", "Vicky"] : []);
  assert.deepEqual(matchContacts("Vicky", book, trusted), [{ name: "Victoria Pérez" }]);
  assert.deepEqual(matchContacts("Vicky", book), [], "without the people's names, as before");
  assert.deepEqual(matchContacts("Ana", book, () => ["Victoria Pérez"]), [{ name: "Ana López" }], "an exact or first-name match comes first");
  assert.deepEqual(matchContacts("Bob", book, () => []), []);
});

// ---------- 3. through the door: <know>, the judge job, recall, the card, the question's buttons ----------

const OWNER = "+34600111222";
const OWNER_WA = "34600111222";
const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};
let n = 0;

async function rig(o: { lang?: "en"; seed?: (kv: Kv & { m: Map<string, string> }) => void } = {}) {
  const sent: Body[] = [];
  const meta = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const clock = { now: T0 };
  const kv = memKv();
  o.seed?.(kv);
  const memory = loadMemory(kv);
  const control = createControl(kv, () => clock.now);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => ["Ana"], callContact: async () => ({ ok: true, text: "started" }), lookupCall: async () => "ok" } });
  const config = loadWhatsappConfig(ENV, OWNER).config!;
  const app = express();
  const door = mountWhatsapp(app, {
    config, tools, memory, kv, control, ownerName: "Marta", timeZone: TZ, contacts: () => ["Ana"], fetch: meta, now: () => clock.now, callCheckMs: 5,
    receiptWaitMs: 60_000, ...(o.lang ? { lang: () => o.lang! } : {}),
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hook = async (msgs: Body[]): Promise<void> => {
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: config.phoneNumberId }, messages: msgs } }] }],
    });
    const signature = `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}`;
    const res = await fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body: raw });
    assert.equal(res.status, 200);
  };
  const say = (body: string) => hook([{ from: OWNER_WA, id: `wamid.m${++n}`, timestamp: "1", type: "text", text: { body } }]);
  const press = (id: string) => hook([{ from: OWNER_WA, id: `wamid.m${++n}`, timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: "x" } } }]);
  const auth = { authorization: `Bearer ${config.bridgeToken}`, "content-type": "application/json" };
  const post = async (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  const context = async () => (await (await fetch(`${base}/assistant/context`, { headers: auth })).json()) as Body;
  const inbox = async () => ((await (await fetch(`${base}/assistant/inbox?wait=0`, { headers: auth })).json()) as { messages: Body[] }).messages;
  const texts = (): string[] => sent.map((b) => (b.type === "text" ? (b.text.body as string) : (b.interactive.body.text as string)));
  const buttons = (): string[] => ([...sent].reverse().find((b) => b.type === "interactive")?.interactive.action.buttons as Body[] ?? []).map((x) => String(x.reply.id));
  await say("hola");
  // The owner's own message goes to the inbox for the assistant: taken away so only the jobs remain.
  await post("/assistant/ack", { ids: (await inbox()).map((m) => m.id) });
  sent.length = 0;
  return { sent, clock, kv, door, say, press, post, context, inbox, texts, buttons, close: () => { server.close(); server.closeAllConnections(); } };
}

test("<know> from the owner's turn: kept dated; a new value goes to the judge job; its answer closes the old one and the context says what changed", async () => {
  const r = await rig();
  try {
    assert.equal((await r.post("/assistant/reply", { text: "Apuntado.", know: [{ who: "Rohan", key: "reunión semanal", value: "martes 10:00" }] })).status, 200);
    r.clock.now += 60_000;
    await r.post("/assistant/reply", { text: "Vale.", know: [{ who: "rohan", key: "Reunión semanal", value: "jueves 10:00", since: "2026-11-19" }] });
    const jobs = (await r.inbox()).filter((m) => m.judge);
    assert.equal(jobs.length, 1);
    assert.match(jobs[0]!.id, /^jd:[0-9a-f]{10}$/);
    assert.equal(jobs[0]!.text, "", "an older bridge lets it go");
    assert.match(jobs[0]!.judge.text, /NEW [0-9a-f]{10}: “jueves 10:00”[\s\S]*OLD [0-9a-f]{10}: “martes 10:00”/);
    // Until the judge answers both hold; then the old one is closed.
    let ctx = await r.context();
    assert.equal(ctx.knowOn, 1);
    assert.equal(ctx.memoryChanges, undefined);
    const old = /OLD ([0-9a-f]{10})/.exec(jobs[0]!.judge.text)![1]!;
    const ans = await r.post("/assistant/judge", { id: jobs[0]!.id, text: JSON.stringify({ contradicts: [old], compatible: [] }) });
    assert.equal(ans.status, 200);
    assert.equal((await r.post("/assistant/judge", { id: jobs[0]!.id, text: "{}" })).status, 400, "once only");
    assert.equal((await r.post("/assistant/judge", { id: "nope", text: "{}" })).status, 400);
    ctx = await r.context();
    assert.deepEqual(ctx.memoryChanges, ["Rohan · reunión semanal: “martes 10:00” → “jueves 10:00” (17 Nov)"]);
    // Recall: Rohan, known only by told facts, has a record of his own for the bridge to give when a message names him.
    const rec = (ctx.peopleRecords as { name: string; text: string }[]).find((x) => x.name === "Rohan");
    assert.equal(rec?.text, "now: reunión semanal: jueves 10:00 (since 19 Nov)");
  } finally {
    r.close();
  }
});

test("<know> from a turn that read other people's text is dropped and logged; a <know> about the owner shows in the context's own facts", async () => {
  const r = await rig();
  try {
    await r.post("/assistant/reply", { text: "Hecho.", outside: ["email"], know: [{ who: "Rohan", key: "cuenta", value: "ES12 3456" }] });
    await r.post("/assistant/reply", { text: "Anotado.", know: [{ key: "gimnasio", value: "lunes y miércoles" }] });
    const ctx = await r.context();
    assert.equal((ctx.peopleRecords ?? []).some((x: Body) => x.name === "Rohan"), false);
    assert.deepEqual(ctx.memoryNow, ["gimnasio: lunes y miércoles (since 17 Nov)"]);
  } finally {
    r.close();
  }
});

test("without the computer (no poll for minutes) a new value wins at once: no judge job, the old value closed", async () => {
  const r = await rig();
  try {
    await r.post("/assistant/reply", { text: "Ok.", know: [{ who: "Lucía", key: "ciudad", value: "Sevilla" }] });
    r.clock.now += 10 * 60_000;
    await r.post("/assistant/reply", { text: "Ok.", know: [{ who: "Lucía", key: "ciudad", value: "Bilbao" }] });
    assert.equal((await r.inbox()).filter((m) => m.judge).length, 0);
    assert.deepEqual((await r.context()).memoryChanges, ["Lucía · ciudad: “Sevilla” → “Bilbao” (17 Nov)"]);
  } finally {
    r.close();
  }
});

test("“what do you know about Ana?”: her card (relation, identities, facts, last contacts) and then the waiting question, answered with a button", async () => {
  const r = await rig({ seed: oldStores });
  try {
    await r.door.peopleGraph.observe(mailSightings([{ at: T0 - DAY, from: "Ana García <ana@x.com>" }]));
    await r.say("What do you know about Ana?");
    const [card, question] = r.texts();
    assert.match(card!, /^👤 Ana \(mi hermana\)/);
    assert.match(card!, /📌 What I know now:\n• (birthday|note|likes)/);
    assert.ok(!/relation: mi hermana/.test(card!), "the relation is in the header, not again as a fact");
    assert.equal(question, "❓ Are these the same person: Ana and Ana García (ana@x.com)?");
    const [yes, no] = r.buttons();
    assert.match(yes!, /^n1:[0-9a-f]{10}$/);
    assert.match(no!, /^n0:[0-9a-f]{10}$/);
    await r.press(yes!);
    assert.match(r.texts().at(-1)!, /^👥 Done: Ana and Ana García \(ana@x.com\) are the same person/);
    await r.press(yes!);
    assert.equal(r.texts().at(-1), "That question isn't open any more.");
    r.sent.length = 0;
    await r.say("What do you know about Ana García?");
    assert.match(r.texts()[0]!, /🪪 email ana@x.com/);
    assert.match(r.texts()[0]!, /Also: Ana García/);
    assert.match(r.texts()[0]!, /🕑 Last seen: mail 16 Nov/);
    // The context names her by either name.
    const recs = (await r.context()).peopleRecords as { name: string; text: string }[];
    assert.ok(recs.some((x) => x.name === "Ana García" && x.text.startsWith("Ana: ")));
    // Someone nobody knows goes to the assistant as before.
    r.sent.length = 0;
    await r.say("what do you know about Kubernetes?");
    assert.equal(r.texts().length, 0);
    assert.ok((await r.inbox()).some((m) => /Kubernetes/.test(m.text)));
  } finally {
    r.close();
  }
});

test("the brief: what changed since yesterday is its own line; after it one same-person question at most a day", async () => {
  const r = await rig({ seed: oldStores });
  try {
    assert.equal(await r.door.changesBrief(), null);
    await r.post("/assistant/reply", { text: "Ok.", know: [{ who: "Ana", key: "office", value: "Madrid" }] });
    r.clock.now += 20 * 60_000;
    await r.post("/assistant/reply", { text: "Ok.", know: [{ who: "Ana", key: "office", value: "Lisbon" }] });
    assert.match((await r.door.changesBrief())!, /^🔁 Changed since yesterday:\n• Ana · office: “Madrid” → “Lisbon”/);
    await r.door.peopleGraph.observe(mailSightings([{ at: T0, from: "Ana García <ana@x.com>" }]));
    r.sent.length = 0;
    assert.equal(await r.door.askSamePerson(), true);
    assert.equal(r.texts()[0], "❓ Are these the same person: Ana and Ana García (ana@x.com)?");
    assert.equal(await r.door.askSamePerson(), false, "one a day");
  } finally {
    r.close();
  }
});

test("forgetting a person (FORGET PERSON) forgets what the owner told about them too", async () => {
  const r = await rig({ seed: oldStores });
  try {
    await r.post("/assistant/reply", { text: "Ok.", know: [{ who: "Ana", key: "trabajo", value: "enfermera" }] });
    assert.ok(currentAbout(await r.door.facts.read(), ["Ana"]).some((f) => f.value === "enfermera"));
    await r.say("FORGET PERSON Ana");
    assert.deepEqual(currentAbout(await r.door.facts.read(), ["Ana"]), []);
  } finally {
    r.close();
  }
});

// ---------- 4. the bridge and the prompts ----------

test("bridge: <know> parsed (who, key, since) and removed, at most three, a bad date left out; the prompts offer it and the judge asks strict JSON", () => {
  const p = parseReply('Hecho. <know who="Rohan" key="reunión semanal" since="2026-11-19">jueves 10:00</know><know key="gym" since="mañana">lunes</know>');
  assert.equal(p.text, "Hecho.");
  assert.deepEqual(p.know, [{ who: "Rohan", key: "reunión semanal", value: "jueves 10:00", since: "2026-11-19" }, { key: "gym", value: "lunes" }]);
  assert.equal(parseReply("<know key='x'>half").text.includes("<know"), false);
  assert.equal(parseReply("a <know key=\"a\">1</know><know key=\"b\">2</know><know key=\"c\">3</know><know key=\"d\">4</know>").know?.length, 3);
  assert.match(SYSTEM_PROMPT, /<know who="Rohan" key="/);
  assert.match(JUDGE_PROMPT, /\{"contradicts": \["<old id>", \.\.\.\], "compatible": \["<old id>", \.\.\.\]\}/);
  assert.equal(whoCommand("what do you know about rohan"), "rohan");
  assert.equal(whoCommand("tell me about ana lopez"), "ana lopez");
  assert.equal(whoCommand("what do you know"), null);
  assert.equal(whoCommand("que sabes de rohan"), null, "the Spanish words go to Claude, which answers in Spanish");
});

test("facts: a birthday or relation the owner corrects by telling stays corrected on every later read; a change in PEOPLE wins again", async () => {
  const kv = memKv();
  const person = { id: "p1", name: "Ana", relation: "hermana", birthday: "03-14", likes: [], notes: [], at: T0, updated: T0 };
  const facts = createFacts(kv, { now: () => T0 + 3600_000, seed: async () => ({ notes: [], people: [person] }) });
  await facts.read();
  const said = (attribute: string, value: string, at: number) =>
    facts.add([{ subject: "Ana", attribute, value, source: { who: "owner", where: "chat", at } }], at);
  assert.equal((await said("birthday", "05-12", T0 + 7200_000)).closed.length, 1);
  // Told in Spanish (an owner who writes in Spanish, so Claude's key is too): the same attribute as Pako's own English word.
  assert.equal((await said("relación", "prima", T0 + 7200_000)).closed.length, 1);
  const now = async (...attributes: string[]) =>
    currentAbout(await facts.read(), ["Ana"]).filter((f) => attributes.includes(f.attribute)).map((f) => f.value);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await now("birthday"), ["05-12"]);
    assert.deepEqual(await now("relation", "relación"), ["prima"]);
  }
  // The owner then changes it in PEOPLE: that is the newest, and the told value closes.
  person.birthday = "06-01";
  assert.deepEqual(await now("birthday"), ["06-01"]);
  assert.deepEqual(await now("relation", "relación"), ["prima"]);
});

test("facts: a full PERSONAS mirrored into more facts than FACTS_MAX never pushes out what the owner told, nor rewrites the store each read", async () => {
  const kv = memKv();
  const people: any[] = [];
  const facts = createFacts(kv, { now: () => T0, seed: async () => ({ notes: [], people }) });
  await facts.add([{ subject: "", attribute: "oficina", value: "Calle Mayor 3", source: { who: "owner", where: "chat", at: T0 } }], T0);
  // 100 people (PEOPLE_MAX), each with a relation, a birthday, 10 likes and 10 notes: 2200 derived facts.
  for (let i = 0; i < 100; i++) {
    const n = (k: string) => Array.from({ length: 10 }, (_, j) => `${k} ${i}-${j}`);
    people.push({ id: `p${i}`, name: `Persona ${i}`, relation: "amigo", birthday: "01-01", likes: n("like"), notes: n("nota"), at: T0, updated: T0 });
  }
  const first = await facts.read();
  const stored = kv.m.get("memory-facts");
  const again = await facts.read();
  assert.ok(again.some((f) => f.attribute === "oficina" && f.validTo === undefined), "the owner's told fact is still there");
  assert.equal(first.length, 2201);
  assert.equal(kv.m.get("memory-facts"), stored, "nothing changed: the store is not written again");
});

test("facts: a derived fact the owner's later word closed is not pruned as old history while PEOPLE still says it, so it never comes back as current", async () => {
  const kv = memKv();
  let now = T0;
  const people = [{ id: "aaaaaaaaaa", name: "Ana", relation: "my boss", likes: [], notes: [], at: now, updated: now }];
  const facts = createFacts(kv, { now: () => now, seed: async () => ({ notes: [], people: people as any }) });
  await facts.read();
  now += DAY;
  const told = await facts.add([{ subject: "Ana", attribute: "relation", value: "my ex-boss", source: { who: "owner", where: "chat", at: now } }], now);
  assert.deepEqual(told.closed.map((c) => c.old.value), ["my boss"], "the told value closes the derived one");
  const currentRelation = async (): Promise<string[]> =>
    currentAbout(await facts.read(), ["Ana"]).filter((f) => f.attribute === "relation").map((f) => `${f.value}${f.origin ? " (derived)" : ""}`);
  assert.deepEqual(await currentRelation(), ["my ex-boss"]);
  // A year and a day on, any change runs the prune of closed history: PEOPLE has not been touched, and still says "my boss".
  now += 366 * DAY;
  await facts.add([{ subject: "", attribute: "coffee", value: "black", source: { who: "owner", where: "chat", at: now } }], now);
  assert.deepEqual(await currentRelation(), ["my ex-boss"], "not both: the closed derived fact was not forgotten and derived again");
  assert.equal((await facts.read()).filter((f) => f.origin === "person:aaaaaaaaaa:relation").length, 1, "still there, closed");
  // Once PEOPLE says something else, the old closed one is only history and goes with the next prune after its year.
  people[0]!.relation = "my friend";
  now += 2 * DAY;
  assert.deepEqual(await currentRelation(), ["my friend (derived)"], "the owner changed it there after telling another value: the newest wins");
  now += 366 * DAY;
  await facts.add([{ subject: "", attribute: "tea", value: "green", source: { who: "owner", where: "chat", at: now } }], now);
  assert.deepEqual((await facts.read()).filter((f) => f.origin === "person:aaaaaaaaaa:relation").map((f) => f.value), ["my friend"]);
});

test("facts: the limit on facts never drops a closed derived fact its origin still derives (it is the only closed one, so the limit would take it first)", async () => {
  const kv = memKv();
  let now = T0;
  const people = [{ id: "aaaaaaaaaa", name: "Ana", relation: "my boss", likes: [], notes: [], at: now, updated: now }];
  const facts = createFacts(kv, { now: () => now, seed: async () => ({ notes: [], people: people as any }) });
  await facts.read();
  // More told facts than FACTS_MAX (10 a call), then the one that closes the derived relation.
  for (let i = 0; i < FACTS_MAX / 10 + 2; i++) {
    now += 1000;
    await facts.add(Array.from({ length: 10 }, (_, j) => ({ subject: `Person ${i}-${j}`, attribute: "likes tea", value: "yes", source: { who: "owner", where: "chat", at: now } })), now);
  }
  now += 1000;
  await facts.add([{ subject: "Ana", attribute: "relation", value: "my ex-boss", source: { who: "owner", where: "chat", at: now } }], now);
  const all = await facts.read();
  assert.ok(all.filter((f) => !f.origin).length <= FACTS_MAX, "the limit still holds for what the owner told");
  assert.equal(all.filter((f) => f.origin === "person:aaaaaaaaaa:relation" && f.validTo !== undefined).length, 1, "the closed derived fact was kept");
  assert.deepEqual(currentAbout(all, ["Ana"]).map((f) => f.value), ["my ex-boss"], "and so it did not come back as current beside what was told");
});

test("facts: when the notes and people cannot be read at this load, no closed derived fact is pruned (nothing can be said to have changed)", async () => {
  const kv = memKv();
  let now = T0;
  let readable = true;
  const people = [{ id: "aaaaaaaaaa", name: "Ana", relation: "my boss", likes: [], notes: [], at: now, updated: now }];
  const facts = createFacts(kv, { now: () => now, seed: async () => { if (!readable) throw new Error("locked"); return { notes: [], people: people as any }; } });
  await facts.read();
  now += DAY;
  await facts.add([{ subject: "Ana", attribute: "relation", value: "my ex-boss", source: { who: "owner", where: "chat", at: now } }], now);
  now += 366 * DAY;
  readable = false;
  const errors = console.error;
  console.error = () => undefined;
  try {
    await facts.add([{ subject: "", attribute: "coffee", value: "black", source: { who: "owner", where: "chat", at: now } }], now);
  } finally {
    console.error = errors;
  }
  readable = true;
  assert.deepEqual(currentAbout(await facts.read(), ["Ana"]).map((f) => f.value), ["my ex-boss"]);
});

test("people: a first name the owner says never resolves to a stranger named only in a mail header, so the stranger's fact stays", async () => {
  const kv = memKv();
  const graph = createPeopleGraph(kv, { now: () => T0, people: async () => [] });
  const facts = createFacts(kv, { now: () => T0 });
  await graph.observe(mailSightings([{ at: T0, from: "David Gómez <david.gomez@recruit.example>" }]));
  await facts.add([{ subject: "David Gómez", attribute: "trabajo", value: "Recruit SA", source: { who: "owner", where: "chat", at: T0 } }], T0);
  // What whatsapp.ts learnKnow does with <know who="David" key="trabajo">Google</know>, about a friend not in PERSONAS.
  assert.equal(await graph.find("David"), undefined);
  assert.equal(graph.canon("David"), "David", "the follow-ups do not merge two Davids either");
  const who = (await graph.find("David"))?.name ?? "David";
  await facts.add([{ subject: who, attribute: "trabajo", value: "Google", source: { who: "owner", where: "chat", at: T0 + 1 } }], T0 + 1);
  const all = await facts.read();
  assert.deepEqual(currentAbout(all, ["David Gómez"]).map((f) => f.value), ["Recruit SA"]);
  assert.deepEqual(currentAbout(all, ["David"]).map((f) => f.value), ["Google"]);
  // The full name, and a first name the owner gave (a record of theirs), still resolve.
  assert.equal((await graph.find("David Gómez"))?.name, "David Gómez");
  const mine = createPeopleGraph(memKv(), { now: () => T0, people: async () => [{ id: "p1", name: "Ana García", relation: "", birthday: "", likes: [], notes: [], at: T0, updated: T0 } as any] });
  await mine.observe(mailSightings([{ at: T0, from: "Ana López <ana@else.example>" }]));
  assert.equal((await mine.find("Ana"))?.name, "Ana García");
});

// ---------- forgetting, undo, and names seen in other people's mail ----------

test("OLVIDA PERSONA after a rename forgets the facts told under the old name too; nothing of them stays in the context", async () => {
  const r = await rig({ seed: oldStores });
  try {
    await r.post("/assistant/reply", { text: "Ok.", know: [{ who: "Ana", key: "trabajo", value: "enfermera" }] });
    await r.say("PERSON Ana: name Ana María");
    await r.say("FORGET PERSON Ana María");
    assert.deepEqual((await r.door.facts.read()).filter((f) => !f.origin), []);
    assert.ok(!JSON.stringify((await r.context()).peopleRecords ?? []).includes("enfermera"));
  } finally {
    r.close();
  }
});

test("renaming the owner's person to a name already confirmed for her keeps the old name as an alias: what was told under it still shows on her card, and OLVIDA PERSONA reaches it", async () => {
  const r = await rig({ seed: oldStores });
  try {
    // The mail's “Ana García” was confirmed to be the owner's Ana (a trusted alias), and a fact was told under “Ana”.
    await r.door.peopleGraph.observe([{ name: "Ana García", identities: [{ kind: "email", value: "ana@x.example" }], via: "correo", at: T0 }], T0);
    const q = await r.door.peopleGraph.nextQuestion(T0);
    assert.ok(q);
    await r.door.peopleGraph.answer(q.q.id, true, T0);
    await r.post("/assistant/reply", { text: "Ok.", know: [{ who: "Ana", key: "trabajo", value: "enfermera" }] });
    // The owner then renames her record to that very name: the name she had must not be dropped from the card.
    await r.say("PERSON Ana: name Ana García");
    const card = (await r.door.peopleGraph.read()).persons.find((p) => p.personId === "0a1b2c3d4e")!;
    assert.deepEqual([card.name, card.aliases], ["Ana García", ["Ana"]]);
    r.sent.length = 0;
    await r.say("What do you know about Ana García?");
    assert.match(r.texts()[0]!, /enfermera/, "the fact told under the old name is on her card");
    await r.say("FORGET PERSON Ana García");
    assert.deepEqual((await r.door.facts.read()).filter((f) => !f.origin), [], "and is forgotten with her");
  } finally {
    r.close();
  }
});

test("Deshacer on OLVIDA PERSONA brings back what the owner told about the person, not only PERSONAS", async () => {
  const r = await rig({ seed: oldStores });
  try {
    await r.post("/assistant/reply", { text: "Ok.", know: [{ who: "Ana", key: "trabajo", value: "enfermera" }] });
    r.sent.length = 0;
    await r.say("FORGET PERSON Ana");
    assert.ok(!currentAbout(await r.door.facts.read(), ["Ana"]).some((f) => f.value === "enfermera"), "forgotten");
    const undo = r.buttons().find((b) => b.startsWith("u1:"));
    assert.ok(undo, "an Undo button");
    await r.press(undo!);
    const now = currentAbout(await r.door.facts.read(), ["Ana"]);
    assert.ok(now.some((f) => f.attribute === "relation"), "the person is back");
    assert.ok(now.some((f) => f.attribute === "trabajo" && f.value === "enfermera"), "and what was told about her");
  } finally {
    r.close();
  }
});

test("two of the owner's own people with the same first name are never asked “¿la misma persona?”, so no question comes back", async () => {
  const kv = memKv();
  const people = [
    { id: "aaaaaaaaaa", name: "Ana", likes: [], notes: [], at: T0 - 1000, updated: T0 },
    { id: "bbbbbbbbbb", name: "Ana García", likes: [], notes: [], at: T0, updated: T0 },
  ];
  const g = createPeopleGraph(kv, { now: () => T0, people: async () => people as never });
  assert.equal(await g.nextQuestion(T0), null);
  assert.equal((await g.read()).questions.length, 0);
  // One kept from before is dropped too.
  const stored = JSON.parse((await kv.get("people-identities"))!);
  const [a, b] = stored.persons;
  stored.questions = [{ id: "cccccccccc", a: a.id, b: b.id, at: T0 }];
  await kv.set("people-identities", JSON.stringify(stored), 3600);
  assert.equal((await g.read()).questions.length, 0);
});

for (const [via, seen] of [
  ["mail", mailSightings([{ at: T0, from: "Ana <ana.verify@evil.example>" }])],
  ["Slack", slackSightings({ who: "Ana", user: "U0123ABCD", at: T0 })],
] as const) {
  test(`a stranger shown as “Ana” in ${via} never takes the owner's Ana García: her card, her relation and the facts told about her`, async () => {
    const r = await rig({
      seed: (kv) => kv.m.set("assistant-people", JSON.stringify([
        { id: "0a1b2c3d4e", name: "Ana García", relation: "mi hermana", likes: [], notes: [], at: T0 - 30 * DAY, updated: T0 - DAY },
      ])),
    });
    try {
      await r.door.peopleGraph.observe(seen);
      await r.post("/assistant/reply", { text: "Ok.", know: [{ who: "Ana", key: "trabajo", value: "enfermera" }] });
      r.sent.length = 0;
      await r.say("What do you know about Ana?");
      const card = r.texts()[0]!;
      assert.match(card, /^👤 Ana García \(mi hermana\)/);
      assert.doesNotMatch(card, /evil\.example|U0123ABCD/);
      assert.match(card, /enfermera/, "what the owner told about Ana is on her card");
    } finally {
      r.close();
    }
  });
}

test("splitAddress: a hostile From line costs linear time (blanks, quotes, brackets), and the usual shapes still split", () => {
  // The old pattern took cubic time on a run of blanks with no address: 8,000 characters took over a minute. CPU time, not the wall clock.
  const t0 = process.cpuUsage();
  for (const s of [`${" ".repeat(20_000)}x`, `"${" ".repeat(20_000)}`, "<".repeat(20_000), `${" ".repeat(10_000)}"${" ".repeat(10_000)}<a@b`, `a@${" ".repeat(20_000)}`]) splitAddress(s);
  const used = process.cpuUsage(t0);
  assert.ok((used.user + used.system) / 1000 < 1000, `took ${(used.user + used.system) / 1000} ms of CPU`);
  assert.deepEqual(splitAddress("  Ana Ruiz  <ana@x.com> "), { name: "Ana Ruiz", email: "ana@x.com" });
  assert.deepEqual(splitAddress("<ana@x.com>"), { name: "", email: "ana@x.com" });
  assert.deepEqual(splitAddress("\"Ruiz, Ana\" <Ana@X.com>"), { name: "Ruiz, Ana", email: "ana@x.com" });
  assert.deepEqual(splitAddress("Ana <not an address>"), { name: "Ana <not an address>", email: "" });
  assert.deepEqual(splitAddress("Ana <ana@x.com> extra"), { name: "Ana <ana@x.com> extra", email: "" });
  assert.deepEqual(splitAddress("Ana"), { name: "Ana", email: "" });
});
