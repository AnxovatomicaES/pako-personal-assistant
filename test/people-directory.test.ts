// The People directory (src/people-directory.ts): contacts, calendar attendees, mail senders, Slack, the open loops and the owner's own words
// merged into one ranked list (the same address or number is one person, a name alone only with care), loops both ways, every derived line
// with its source, nothing derived ever written as the owner's facts, a hide that holds, the empty state only with no source at all, and
// "Prep" going through the brief's own run.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createBriefV2 } from "../src/brief-v2.ts";
import type { CalEvent } from "../src/calendar.ts";
import type { Contact } from "../src/contacts.ts";
import type { Loop } from "../src/followups.ts";
import type { RecentMail } from "../src/mail.ts";
import { createFacts, type Fact } from "../src/memory-facts.ts";
import {
  buildDirectory, createHiddenPeople, HIDDEN_KEY, matches, mountPeopleDirectory, prepFacts, type DirEntry, type DirectorySources,
} from "../src/people-directory.ts";
import type { GraphPerson } from "../src/people-graph.ts";
import { createPeople, type Person } from "../src/people.ts";
import { memoryKv, serve } from "./helpers/connect-rig.ts";

const DAY = 24 * 3600_000;
/** Wednesday 18 November 2026, 11:00 in Madrid. */
const NOW = Date.parse("2026-11-18T10:00:00Z");
const auth = { signedIn: (req: { get(h: string): string | undefined }) => req.get("cookie") === "ok=1" };

const contacts: Contact[] = [
  { name: "Ana García", emails: ["ana@garcia.com"], phones: ["+34612345678"] },
  { name: "Ana López", emails: ["ana@lopez.com"], phones: [] },
  { name: "Bruno Díaz", emails: [], phones: ["+447700900123"], org: "Díaz & Co" },
  { name: "Carla Ruiz", emails: ["carla@ruiz.com"], phones: [] },
];
const event = (id: string, at: number, title: string, attendees: { email: string; name?: string }[]): CalEvent => ({
  id, title, start: at, end: at + 3600_000, allDay: false, calendar: "Work", attendees,
});
const events: CalEvent[] = [
  event("e1", NOW + 3 * DAY, "Q4 review", [{ email: "me@owner.com" }, { email: "ana@garcia.com", name: "Ana García" }, { email: "bruno@diaz.com", name: "Bruno Díaz" }]),
  event("e2", NOW - 5 * DAY, "Kickoff", [{ email: "me@owner.com" }, { email: "ana@lopez.com", name: "Ana López" }]),
];
const mail = (id: string, at: number, from: string, subject: string, kind: RecentMail["kind"] = "guardado"): RecentMail => ({
  id, at, from, subject, preview: "", kind,
});
const mails: RecentMail[] = [
  mail("m1", NOW - 2 * DAY, "Ana García <ana@garcia.com>", "Budget draft"),
  mail("m2", NOW - DAY, "Shop <news@shop.com>", "50% off", "masivo"),
  mail("m3", NOW - DAY, "Service <noreply@service.com>", "Your receipt", "aviso"),
  mail("m4", NOW - 60 * DAY, "Daniel Ruiz <daniel@ruiz.com>", "Quick question"),
  mail("m5", NOW - DAY, "Eva Martín <eva@martin.com>", "Lunch?"),
];
const loop = (id: string, kind: Loop["kind"], who: string, title: string, o: Partial<Loop> = {}): Loop => ({
  id, kind, title, detail: "", who, where: { type: "slack_dm", label: `${who} (DM)` }, whenSaid: NOW - 2 * DAY, check: { none: { reason: "" } },
  status: "open", nextCheckAt: 0, nudges: 0, createdAt: NOW - 2 * DAY, sources: [{ kind: "slack", label: `Slack · ${who} (DM)`, at: NOW - 2 * DAY }], ...o,
});
const loops: Loop[] = [
  loop("aaaaaaaaa1", "owner_promise", "ana@lopez.com", "Send Ana the deck", { dueAt: NOW + DAY }),
  loop("aaaaaaaaa2", "other_promise", "Bruno Díaz", "Send the signed contract", { sources: [{ kind: "mail", label: "Mail · Bruno", at: NOW - 3 * DAY }] }),
];
const owner: Person = { id: "0123456789", name: "Ana García", relation: "my former boss", likes: [], notes: ["prefers mornings"], at: NOW - 90 * DAY, updated: NOW - 9 * DAY };
const told: Fact = {
  id: "fffffffff1", subject: "Eva Martín", attribute: "works at", value: "Acme", validFrom: NOW - 4 * DAY, learnedAt: NOW - 4 * DAY,
  source: { who: "owner", where: "chat", at: NOW - 4 * DAY },
};
const slackOnly: GraphPerson = {
  id: "abcdef0123", name: "Rohan S", aliases: [], seen: [], identities: [{ kind: "slack", value: "U12345", source: "slack", at: NOW - 3 * DAY }],
  contacts: [{ at: NOW - 3 * DAY, via: "slack", where: "Rohan (DM)" }], at: NOW - 3 * DAY, updated: NOW - 3 * DAY,
};
const all = (): DirectorySources => ({
  contacts, events, mail: mails, loops, people: [owner], facts: [told], graph: [slackOnly], self: ["me@owner.com"],
});
const byName = (list: DirEntry[], name: string): DirEntry => {
  const e = list.find((x) => x.name === name);
  assert.ok(e, `${name} is in the directory`);
  return e;
};

test("contacts, calendar, mail, Slack and loops make one ranked, de-duplicated list: loops, then this fortnight's meetings, then the recent", () => {
  const dir = buildDirectory(all(), { now: NOW });
  const listed = dir.people.filter((e) => e.listed).map((e) => e.name);
  assert.deepEqual(listed, ["Ana López", "Bruno Díaz", "Ana García", "Eva Martín", "Rohan S", "Carla Ruiz"]);
  // The same person once, whatever the source: the contact, the invitation, the mail and the owner's own record of Ana García.
  const ana = byName(dir.people, "Ana García");
  assert.deepEqual(ana.emails, ["ana@garcia.com"]);
  assert.deepEqual(ana.phones, ["+34612345678"]);
  assert.equal(ana.knownText, "in your contacts · you told me about them · 1 meeting · 1 mail");
  assert.equal(ana.own?.id, owner.id);
  // A phone-only contact and an invitation's address under the same full name are one person; the loop by that name lands on them.
  const bruno = byName(dir.people, "Bruno Díaz");
  assert.deepEqual(bruno.emails, ["bruno@diaz.com"]);
  assert.deepEqual(bruno.phones, ["+447700900123"]);
  assert.equal(bruno.org, "Díaz & Co");
  assert.equal(bruno.loops.length, 1);
  // The owner, bulk mail and machines are nobody; a one-off sender long ago is found by the search but not listed.
  for (const gone of ["me@owner.com", "news@shop.com", "noreply@service.com"]) assert.ok(!dir.people.some((e) => e.emails.includes(gone)), gone);
  const daniel = byName(dir.people, "Daniel Ruiz");
  assert.equal(daniel.listed, false);
  assert.ok(matches(daniel, "dani"));
  assert.ok(matches(ana, "612 345"));
  assert.ok(!matches(ana, "lopez"));
  assert.equal(dir.people.filter((e) => e.name === "Ana García").length, 1);
});

test("two people with the same name and different addresses stay two; a bare first name that fits both joins neither", () => {
  const dir = buildDirectory({
    contacts: [{ name: "Ana", emails: ["ana@one.com"], phones: [] }, { name: "Ana", emails: ["ana@two.com"], phones: [] }],
    events: [event("e9", NOW + DAY, "Sync", [{ email: "ana@three.com", name: "Ana" }])],
    loops: [loop("bbbbbbbbb1", "request_to_owner", "Ana", "Review the plan")],
  }, { now: NOW });
  const anas = dir.people.filter((e) => e.name === "Ana");
  assert.equal(anas.length, 4, "three addresses and a loop that could be any of them");
  assert.deepEqual(anas.map((e) => e.emails.join()).sort(), ["", "ana@one.com", "ana@three.com", "ana@two.com"]);
  // Two full names that match, each with its own address, stay apart too: a name never outweighs two different addresses.
  const two = buildDirectory({
    contacts: [{ name: "Ana García", emails: ["ana@a.com"], phones: [] }],
    events: [event("e8", NOW + DAY, "Sync", [{ email: "ana@b.com", name: "Ana García" }])],
  }, { now: NOW });
  assert.equal(two.people.length, 2);
  // And a mail's From line never joins a contact by name: anyone can write "Ana García" on a mail.
  const forged = buildDirectory({
    contacts: [{ name: "Ana García", emails: [], phones: ["+34612345678"] }],
    mail: [mail("mx", NOW - DAY, "Ana García <ana@evil.example>", "Urgent")],
  }, { now: NOW });
  assert.equal(forged.people.length, 2);
});

test("loops show both ways, with due dates and where they were said; every derived line carries its source", () => {
  const dir = buildDirectory(all(), { now: NOW });
  const lopez = byName(dir.people, "Ana López");
  assert.deepEqual(lopez.loops.map((l) => [l.dir, l.title, l.due]), [["you_owe", "Send Ana the deck", NOW + DAY]]);
  assert.equal(lopez.loops[0]!.source, "Follow-ups · Slack · ana@lopez.com (DM)");
  const bruno = byName(dir.people, "Bruno Díaz");
  assert.equal(bruno.loops[0]!.dir, "they_owe");
  assert.match(bruno.loops[0]!.source, /^Follow-ups · Mail/);
  const ana = byName(dir.people, "Ana García");
  assert.deepEqual(ana.next, { at: NOW + 3 * DAY, kind: "meeting", label: "Q4 review", source: "Calendar" });
  assert.deepEqual(ana.last, { at: NOW - 2 * DAY, kind: "mail", label: "Budget draft", source: "Mail" });
  assert.deepEqual(byName(dir.people, "Rohan S").last, { at: NOW - 3 * DAY, kind: "slack", label: "Rohan (DM)", source: "Slack" });
  assert.equal(byName(dir.people, "Ana López").last?.label, "Kickoff");
  for (const e of dir.people) {
    for (const l of e.loops) assert.ok(l.source.length > 12, `${e.name}: a loop with its source`);
    for (const m of [e.next, e.last]) if (m) assert.ok(["Mail", "Calendar", "Slack", "Zoom"].includes(m.source), `${e.name}: ${m.label}`);
  }
  // The owner's own words are apart and dated: the record's parts, and a told fact on the person it names.
  assert.deepEqual(ana.told.map((t) => t.text), ["Relation: my former boss", "prefers mornings"]);
  assert.deepEqual(byName(dir.people, "Eva Martín").told, [{ text: "works at: Acme", at: NOW - 4 * DAY }]);
  // Prep's material: who they are, the loops both ways, the meetings and the owner's words, each with its label.
  const facts = prepFacts(bruno, "Europe/Madrid");
  assert.ok(facts.some((f) => /they owe the owner · Send the signed contract/.test(f.text)));
  assert.ok(facts.some((f) => /^next meeting: Q4 review/.test(f.text) && f.label === "Calendar"));
});

test("the empty state is only for no source at all; hidden people, bulk mail or a quiet contact list are not 'connect something'", () => {
  assert.equal(buildDirectory({}, { now: NOW }).empty, true);
  assert.equal(buildDirectory({ contacts: [], events: [], mail: [] }, { now: NOW }).empty, true);
  const onlyBulk = buildDirectory({ mail: [mail("m3", NOW, "Service <noreply@service.com>", "Receipt", "aviso")] }, { now: NOW });
  assert.equal(onlyBulk.people.length, 0);
  assert.equal(onlyBulk.empty, false, "the mail is connected: there is just nobody to list yet");
  const hiddenAll = buildDirectory({ contacts: [contacts[3]!] }, { now: NOW, hidden: ["e:carla@ruiz.com"] });
  assert.deepEqual([hiddenAll.people.length, hiddenAll.hiddenCount, hiddenAll.empty], [0, 1, false]);
});

test("the routes: the list and the search, hide and show again (kept as the owner's choice), and nothing derived ever becomes a fact", async () => {
  const kv = memoryKv();
  const people = createPeople(kv);
  await people.upsert({ name: "Ana García", relation: "my former boss" }, NOW - 9 * DAY);
  const facts = createFacts(kv, { now: () => NOW, seed: async () => ({ notes: [], people: await people.read(true) }) });
  await facts.read();
  const before = new Map([...kv.data].filter(([k]) => k !== HIDDEN_KEY));
  const prepped: { name: string; facts: { label: string; text: string }[] }[] = [];
  const hidden = createHiddenPeople(kv);
  const p = await serve((app) => mountPeopleDirectory(app, {
    ...auth, local: true, timeZone: "Europe/Madrid", hidden, now: () => NOW,
    sources: {
      contacts: async () => contacts, events: async () => events, mail: async () => mails, loops: async () => loops, graph: async () => [slackOnly],
      people: () => people.read(true), facts: () => facts.read(), self: () => ["me@owner.com"],
    },
    prep: async (o) => (prepped.push(o), { id: "0a0a0a0a0a", title: `Prep: ${o.name}`, status: "pending", text: "" }),
    prepTask: async (id) => (id === "0a0a0a0a0a" ? { id, title: "Prep", status: "done", text: "Ask about the deck." } : null),
  }));
  try {
    const list = await p.get("/panel/api/people/directory");
    assert.equal(list.status, 200);
    assert.equal(list.body.people[0].name, "Ana López");
    assert.equal(list.body.empty, false);
    assert.equal(list.body.edit, true);
    assert.equal(list.body.prep, true);
    const ana = (list.body.people as DirEntry[]).find((e) => e.name === "Ana García")!;
    assert.equal(ana.own?.relation, "my former boss");
    const found = await p.get(`/panel/api/people/directory?q=${encodeURIComponent("daniel")}`);
    assert.deepEqual((found.body.people as DirEntry[]).map((e) => e.name), ["Daniel Ruiz"]);

    // Hide: kept as identities, so the person stays hidden whichever address shows up next; then shown again.
    const lopez = (list.body.people as DirEntry[]).find((e) => e.name === "Ana López")!;
    assert.equal((await p.post("/panel/api/people/hide", { keys: lopez.keys })).status, 200);
    assert.deepEqual(JSON.parse(kv.data.get(HIDDEN_KEY)!).keys, ["e:ana@lopez.com"]);
    const after = await p.get("/panel/api/people/directory");
    assert.ok(!(after.body.people as DirEntry[]).some((e) => e.name === "Ana López"));
    assert.equal(after.body.hidden, 1);
    const shown = await p.get("/panel/api/people/directory?hidden=1");
    assert.deepEqual((shown.body.people as DirEntry[]).map((e) => e.name), ["Ana López"]);
    assert.equal((await p.post("/panel/api/people/unhide", { keys: lopez.keys })).status, 200);
    assert.ok(((await p.get("/panel/api/people/directory")).body.people as DirEntry[]).some((e) => e.name === "Ana López"));
    assert.equal((await p.post("/panel/api/people/hide", { keys: "x" })).status, 400);
    assert.equal((await p.post("/panel/api/people/hide", { keys: lopez.keys }, { cookie: "ok=1" })).status, 401, "a change needs x-pako");

    // Prep: the brief's run, given this person's facts.
    const prep = await p.post("/panel/api/people/prep", { key: ana.key });
    assert.equal(prep.body.task.status, "pending");
    assert.equal(prepped[0]!.name, "Ana García");
    assert.ok(prepped[0]!.facts.some((f) => /the owner told Pako: Relation: my former boss/.test(f.text)));
    assert.equal((await p.get("/panel/api/people/prep?id=0a0a0a0a0a")).body.task.text, "Ask about the deck.");
    assert.equal((await p.post("/panel/api/people/prep", { key: "e:nobody@x.com" })).status, 404);

    // Nothing the directory read or did wrote into the owner's records or facts: only the hidden list is new.
    const now = new Map([...kv.data].filter(([k]) => k !== HIDDEN_KEY));
    assert.deepEqual(now, before);
    assert.deepEqual((await people.read(true)).map((x) => x.name), ["Ana García"]);
    assert.ok((await facts.read()).every((f) => f.source.who === "owner" && f.subject === "Ana García"));
  } finally {
    await p.close();
  }
});

test("a server's panel shows the list but cannot hide or prep; signed out gets nothing", async () => {
  const p = await serve((app) => mountPeopleDirectory(app, {
    ...auth, local: false, timeZone: "Europe/Madrid", hidden: createHiddenPeople(null), now: () => NOW, sources: { contacts: async () => contacts },
  }));
  try {
    const list = await p.get("/panel/api/people/directory");
    assert.equal(list.body.edit, false);
    assert.equal(list.body.prep, false);
    assert.equal((await p.post("/panel/api/people/hide", { keys: ["e:carla@ruiz.com"] })).status, 404);
    assert.equal((await p.get("/panel/api/people/directory", {})).status, 401);
  } finally {
    await p.close();
  }
});

test("a source that fails leaves only itself out", async () => {
  const quiet = console.error;
  console.error = () => undefined;
  const p = await serve((app) => mountPeopleDirectory(app, {
    ...auth, local: true, timeZone: "Europe/Madrid", hidden: createHiddenPeople(null), now: () => NOW,
    sources: { contacts: async () => contacts, events: async () => Promise.reject(new Error("down")) },
  }));
  try {
    const list = await p.get("/panel/api/people/directory");
    assert.equal(list.status, 200);
    assert.equal(list.body.sources.contacts, 4);
    assert.equal(list.body.sources.calendar, 0);
  } finally {
    console.error = quiet;
    await p.close();
  }
});

test("Prep goes through the brief's own run: the person's facts first, the answer kept and told in the chat", async () => {
  const queued: { id: string; brief?: { kind: string; text: string } }[] = [];
  const docs: string[] = [];
  const v2 = createBriefV2({
    config: { waitMs: 15 * 60_000 }, kv: null, timeZone: "Europe/Madrid", now: () => NOW, ownerLanguage: async () => "en", lang: () => "en",
    sources: {}, enqueue: async (m) => (queued.push(m), true), plain: async () => undefined, notify: async () => "sent", tell: async (t) => void docs.push(t),
  });
  const task = await v2.prepPerson({ name: "Ana García", facts: [{ label: "Calendar", text: "next meeting: Q4 review" }, { label: "Mail", text: "last contact: Budget draft" }] });
  assert.ok(task);
  assert.equal(task.title, "Prep: Ana García");
  assert.equal(queued[0]!.brief?.kind, "prep");
  assert.match(queued[0]!.brief!.text, /OWNER'S REQUEST: Prepare me for my next meeting with the person in facts P1 to P2/);
  assert.match(queued[0]!.brief!.text, /\nP1 · next meeting: Q4 review\nP2 · last contact: Budget draft/);
  assert.equal((await v2.prepPerson({ name: "Ana García", facts: [{ label: "x", text: "y" }] }))?.id, task.id, "one at a time per person");
  await v2.result(task.id, "Ask Ana about the budget.");
  assert.equal((await v2.task(task.id))?.status, "done");
  assert.match(docs[0]!, /Ask Ana about the budget\./);
});
