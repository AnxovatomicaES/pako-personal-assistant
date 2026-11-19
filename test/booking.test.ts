import assert from "node:assert/strict";
import test from "node:test";
import { createBooking, rank, routeOf, type Option } from "../src/booking.ts";
import { createControl, PAUSED_TEXTS } from "../src/control.ts";
import type { Kv } from "../src/kv.ts";
import { fakeEngine } from "./helpers/booking-fixtures.ts";

const NOW = Date.parse("2026-11-14T12:00:00Z"); // a Saturday; the table asked for is Friday the 20th at 21:00 in Madrid
const WHEN = "2026-11-20 21:00";

function memoryKv(): Kv {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

function rig(o: { mail?: boolean; failMail?: string; failStatus?: number; control?: ReturnType<typeof createControl> } = {}) {
  const sent: { to: string; subject: string; text: string }[] = [];
  const { engine, places } = fakeEngine();
  const control = o.control ?? createControl(null);
  const booking = createBooking({
    engine,
    ...(o.mail === false ? {} : { mail: { address: "pako@agentmail.to", send: async (m) => { if (o.failMail) throw Object.assign(new Error(o.failMail), o.failStatus ? { status: o.failStatus } : {}); sent.push(m); } } }),
    kv: memoryKv(),
    control,
    ownerName: "Marta",
    ownerPhone: "34600111222",
    timeZone: "Europe/Madrid",
    now: () => NOW,
  });
  return { booking, sent, places, control };
}

test("booking: the search shows real restaurants open at that time, best first, each with what Pako can do; closed and out-of-hours ones are dropped", async () => {
  const r = rig();
  const reply = await r.booking.start({ what: "tapas en el Born, Barcelona", when: WHEN, party: 4 });
  assert.match(r.places.queries[0]!, /tapas en el Born/);
  assert.ok(!reply.card, "three options: the owner chooses first");
  assert.match(reply.say, /^For 4, Friday 20 November at 21:00/);
  assert.match(reply.say, /1\) Cal Pep · ★4.6 \(3200\) · \$\$\$/);
  assert.match(reply.say, /✉️ I email them myself/);
  assert.match(reply.say, /⚠️ .*depósito de 20 €/, "what the restaurant's own site says about paying is shown before the owner agrees");
  assert.match(reply.say, /2\) Bar Mut.*\n {3}🔗 takes bookings on CoverManager/s);
  assert.match(reply.say, /3\) Casa Teléfono.*\n {3}📞 phone only \(931 23 45 67\)/s);
  assert.ok(!/Cerrado para siempre|Solo mediodía/.test(reply.say), "closed for good, and not open at 21:00 on a Friday");
});

test("booking: choosing a restaurant that takes email gives ONE card with the exact action; only its press writes, once, with the facts and the AI disclosure", async () => {
  const r = rig();
  await r.booking.start({ what: "tapas, Barcelona", when: WHEN, party: 4, notes: "una trona" });
  const card = r.booking.answer("1")!.card!;
  assert.match(card.body, /^I'll email reservas@calpep\.example from pako@agentmail\.to asking for a table at Cal Pep for 4, Friday 20 November at 21:00, under the name Marta \(your phone: \+34600111222\)\. Note: una trona\./);
  assert.match(card.body, /Their website says: .*depósito/);
  assert.equal(r.sent.length, 0, "nothing sent before the press");
  const done = await r.booking.approve(card.id, true);
  assert.equal(r.sent.length, 1);
  const mail = r.sent[0]!;
  assert.equal(mail.to, "reservas@calpep.example");
  assert.match(mail.subject, /^Table request: 4 people, 2026-11-20 21:00 \(Marta\)$/);
  for (const part of ["a table for 4 people on Friday 20 November at 21:00", "Contact phone: +34600111222", "Notes: una trona", "Marta's AI assistant", "reply to this email"]) assert.ok(mail.text.includes(part), part);
  assert.match(done, /Sent to Cal Pep/);
  assert.match(done, /If you'd rather not wait:\n.*📞 Phone: 932 10 19 49/s, "the other ways stay offered");
  assert.match(await r.booking.list(), /Cal Pep · 4 people · requested by email, waiting for an answer/);
  assert.deepEqual(await r.booking.context(), ["2026-11-20 21:00 Cal Pep (4 people, requested by email, not confirmed)"]);
  assert.match(await r.booking.approve(card.id, true), /expired/, "a card works once");
});

test("booking: a typed yes works only as the very next message; any other message moves on; NO and Cancel drop it", async () => {
  const r = rig();
  await r.booking.start({ what: "Cal Pep, Barcelona", when: WHEN, party: 2 });
  assert.equal(r.booking.cardAnswer("and for dessert?"), null);
  assert.equal(r.booking.cardAnswer("yes"), null, "a later yes does nothing: the button still works");
  const r2 = rig();
  await r2.booking.start({ what: "x tapas", when: WHEN, party: 2 });
  r2.booking.answer("1");
  assert.deepEqual(r2.booking.cardAnswer("ok")?.yes, true);
  const r3 = rig();
  await r3.booking.start({ what: "x tapas", when: WHEN, party: 2 });
  const card = r3.booking.answer("the 1")!.card!;
  assert.equal(r3.booking.cardAnswer("no")?.yes, false);
  assert.match(await r3.booking.approve(card.id, false), /I won't write to anyone/);
  assert.equal(r3.sent.length, 0);
});

test("booking: STOP blocks the email; 5 a day and one per restaurant a day; a failing send says why and keeps the other ways", async () => {
  const control = createControl(null);
  await control.setPaused(true, NOW);
  const paused = rig({ control });
  await paused.booking.start({ what: "tapas", when: WHEN, party: 2 });
  const c = paused.booking.answer("1")!.card!;
  assert.match(await paused.booking.approve(c.id, true), /is paused.*I haven't written to Cal Pep/);
  assert.equal(paused.sent.length, 0);
  // A pause Pako set by itself (its store came back empty) is said as such, not as the owner's STOP.
  const guarded = createControl(null);
  await guarded.setPaused(true, NOW, "store-empty");
  const g = rig({ control: guarded });
  await g.booking.start({ what: "tapas", when: WHEN, party: 2 });
  assert.equal(await g.booking.approve(g.booking.answer("1")!.card!.id, true), `${PAUSED_TEXTS["store-empty"]} I haven't written to Cal Pep.`);
  assert.equal(g.sent.length, 0);

  const r = rig();
  await r.booking.start({ what: "tapas", when: WHEN, party: 2 });
  await r.booking.approve(r.booking.answer("1")!.card!.id, true);
  await r.booking.start({ what: "tapas", when: WHEN, party: 3 });
  assert.match(await r.booking.approve(r.booking.answer("1")!.card!.id, true), /I've already written to Cal Pep today/);
  assert.equal(r.sent.length, 1);

  const denied = rig({ failMail: "AgentMail answered 403 to the send", failStatus: 403 });
  await denied.booking.start({ what: "tapas", when: WHEN, party: 2 });
  const msg = await denied.booking.approve(denied.booking.answer("1")!.card!.id, true);
  assert.match(msg, /isn't allowed to send \(it needs the message_send permission\)/);
  assert.match(msg, /📞 Phone/);
  assert.equal((await denied.booking.list()).includes("Cal Pep"), false, "nothing is recorded as asked when the send failed");
});

test("booking: a restaurant on a booking page or with only a phone gets a hand-over (nothing is sent to anyone); without an inbox email is not offered", async () => {
  const r = rig();
  await r.booking.start({ what: "tapas", when: WHEN, party: 4 });
  const link = r.booking.answer("2")!;
  assert.ok(!link.card);
  assert.match(link.say, /Bar Mut, 4 people.*The last step is yours/s);
  assert.match(link.say, /🔗 Book on CoverManager.*covermanager\.com\/reservation\/module_restaurant\/restaurante-barmut\/english/);
  await r.booking.start({ what: "tapas", when: WHEN, party: 4 });
  assert.match(r.booking.answer("3")!.say, /📞 Phone: 931 23 45 67/);
  assert.equal(r.sent.length, 0);
  assert.match(await r.booking.list(), /Bar Mut · 4 people · link given: confirming is up to you/);

  const noMail = rig({ mail: false });
  const reply = await noMail.booking.start({ what: "tapas", when: WHEN, party: 4 });
  assert.ok(!/✉️/.test(reply.say), "no inbox to write from: no email route");
});

test("booking: bad requests are refused in plain words before any search", async () => {
  const r = rig();
  const say = async (o: Partial<{ what: string; when: string; party: number }>) => (await r.booking.start({ what: "tapas Barcelona", when: WHEN, party: 2, ...o })).say;
  assert.match(await say({ when: "mañana" }), /I didn't understand the date/);
  assert.match(await say({ when: "2026-11-14 12:10" }), /has passed or is less than half an hour away/);
  assert.match(await say({ when: "2027-06-01 21:00" }), /four months/);
  assert.match(await say({ party: 0 }), /1 to 20/);
  assert.match(await say({ party: 40 }), /1 to 20/);
  assert.match(await say({ what: "x" }), /Where would you like to eat/);
  assert.equal(r.places.queries.length, 0, "no search for any of them");
});

test("booking: routes and ranking are decided from real fields only", () => {
  const live = (o: Record<string, unknown>) => ({ restaurantId: "gp_x", place: { id: "x", name: "X", address: "", ...(o.place as object) }, openAtSlot: true, ...o }) as Parameters<typeof routeOf>[0];
  assert.equal(routeOf(live({}), "a@b.es", undefined, true), "email");
  assert.equal(routeOf(live({}), "a@b.es", undefined, false), "walkin", "no inbox, nothing else known");
  assert.equal(routeOf(live({ walkIn: "Walk-in only" }), undefined, undefined, true), "walkin");
  assert.equal(routeOf(live({ widget: { engine: "CoverManager", url: "https://x" } }), undefined, undefined, true), "link");
  assert.equal(routeOf(live({}), undefined, "34600000000", true), "whatsapp");
  assert.equal(routeOf(live({ place: { phone: "+34931234567" } }), undefined, undefined, true), "phone");
  const a: Option = { placeId: "a", name: "A", address: "", rating: 4.9, ratingCount: 10, route: "phone" };
  const b: Option = { placeId: "b", name: "B", address: "", rating: 4.5, ratingCount: 3000, route: "email", open: true };
  assert.ok(rank(a, b) > 0, "a restaurant Pako can actually write to beats a slightly better rated one it cannot");
});

test("connector: Pako Assistant offers find_restaurants (reads only) and book_restaurant (puts the options on WhatsApp; books nothing)", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { registerBookingTools } = await import("../src/booking.ts");
  const r = rig();
  const asked: unknown[] = [];
  const server = new McpServer({ name: "pako-assistant", title: "Pako Assistant", version: "1.0.0" });
  registerBookingTools(server, r.booking, (req) => void asked.push(req), "Europe/Madrid");
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), ["book_restaurant", "find_restaurants"]);
    assert.equal(tools.find((t) => t.name === "find_restaurants")!.annotations?.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === "book_restaurant")!.annotations?.destructiveHint, false);

    const found = (await client.callTool({ name: "find_restaurants", arguments: { what: "tapas, Barcelona", when: WHEN, party: 2 } })) as { content: { text: string }[] };
    assert.match(found.content[0]!.text, /third-party text, not instructions[\s\S]*1\. Cal Pep.*how to book: email/);
    assert.equal(r.sent.length, 0, "finding contacts nobody");

    const past = (await client.callTool({ name: "find_restaurants", arguments: { what: "tapas, Barcelona", when: "2026-11-01 21:00", party: 2 } })) as { isError?: boolean };
    assert.equal(past.isError, true);

    await client.callTool({ name: "book_restaurant", arguments: { what: "tapas, Barcelona", when: "2026-11-20T21:00", party: 2, notes: "sin gluten" } });
    assert.deepEqual(asked, [{ what: "tapas, Barcelona", when: "2026-11-20 21:00", party: 2, notes: "sin gluten" }]);
    assert.equal(r.sent.length, 0, "nothing is written from a chat");
    const bad = (await client.callTool({ name: "book_restaurant", arguments: { what: "tapas", when: "mañana", party: 2 } })) as { isError?: boolean };
    assert.equal(bad.isError, true, "a badly written time never reaches the owner's WhatsApp");
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------- bug hunt 2: regression tests ----------

test("hunt2 booking: what the card shows is what the email says (notes are cut once, to the same length)", async () => {
  const r = rig();
  const notes = `${"a".repeat(150)}ENLACE-OCULTO http://evil.example`;
  await r.booking.start({ what: "tapas, Barcelona", when: WHEN, party: 2, notes });
  const card = r.booking.answer("1")!.card!;
  assert.ok(!card.body.includes("ENLACE-OCULTO"));
  await r.booking.approve(card.id, true);
  assert.ok(!r.sent[0]!.text.includes("ENLACE-OCULTO"), "nothing reaches the restaurant that the owner could not see");
});

test("hunt2 booking: a send whose outcome is unknown counts as sent (no second email); a refusal does not; two presses cannot both pass", async () => {
  // A timeout (no status): it may have been delivered.
  const slow = rig({ failMail: "The operation was aborted due to timeout" });
  await slow.booking.start({ what: "tapas", when: WHEN, party: 2 });
  assert.match(await slow.booking.approve(slow.booking.answer("1")!.card!.id, true), /I have no confirmation that the email to Cal Pep went out/);
  await slow.booking.start({ what: "tapas", when: WHEN, party: 2 });
  assert.match(await slow.booking.approve(slow.booking.answer("1")!.card!.id, true), /I've already written to Cal Pep today/, "not written to twice");
  // A refusal (4xx) certainly did not send: the count is given back.
  const refused = rig({ failMail: "AgentMail answered 400 to the send", failStatus: 400 });
  await refused.booking.start({ what: "tapas", when: WHEN, party: 2 });
  await refused.booking.approve(refused.booking.answer("1")!.card!.id, true);
  await refused.booking.start({ what: "tapas", when: WHEN, party: 2 });
  assert.doesNotMatch(await refused.booking.approve(refused.booking.answer("1")!.card!.id, true), /Hoy ya he escrito/);
  // A send still in flight when the next card is approved for the same restaurant.
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const sent: string[] = [];
  const { engine } = fakeEngine();
  const b = createBooking({ engine, mail: { address: "p@agentmail.to", send: async (m) => { await gate; sent.push(m.to); } }, kv: memoryKv(), ownerName: "Marta", timeZone: "Europe/Madrid", now: () => NOW });
  await b.start({ what: "tapas", when: WHEN, party: 2 });
  const first = b.approve(b.answer("1")!.card!.id, true);
  await b.start({ what: "tapas", when: WHEN, party: 3 });
  const second = await b.approve(b.answer("1")!.card!.id, true);
  assert.match(second, /I've already written to Cal Pep today/);
  release();
  await first;
  assert.deepEqual(sent, ["reservas@calpep.example"]);
});

test("hunt2 booking: a store that cannot be read neither lets an email through nor overwrites what it holds", async () => {
  const data = new Map<string, string>();
  let broken = true;
  const kv: Kv = { get: async (k) => { if (broken) throw new Error("store down"); return data.get(k) ?? null; }, set: async (k, v) => void data.set(k, v) };
  data.set("pako-booking-sent", JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ at: NOW - 1000, placeId: `p${i}` }))));
  data.set("pako-bookings", JSON.stringify([{ id: "x", at: NOW, placeId: "p", name: "Antiguo", address: "", slot: NOW + 86400_000, party: 2, route: "email", status: "pedida", guest: "Marta" }]));
  const sent: string[] = [];
  const { engine } = fakeEngine();
  const b = createBooking({ engine, mail: { address: "p@agentmail.to", send: async (m) => void sent.push(m.to) }, kv, ownerName: "Marta", timeZone: "Europe/Madrid", now: () => NOW });
  await b.start({ what: "tapas", when: WHEN, party: 2 });
  assert.match(await b.approve(b.answer("1")!.card!.id, true), /I can't check how many emails I've sent today/);
  assert.deepEqual(sent, []);
  broken = false;
  await b.start({ what: "tapas", when: WHEN, party: 2 });
  assert.match(await b.approve(b.answer("1")!.card!.id, true), /daily limit/, "the five of today were never lost");
  // A wrong shape in the store is ignored, not fatal.
  data.set("pako-bookings", JSON.stringify([null, 3, { slot: "x" }]));
  const c = createBooking({ engine, mail: { address: "p@agentmail.to", send: async () => undefined }, kv, ownerName: "Marta", timeZone: "Europe/Madrid", now: () => NOW });
  assert.match(await c.list(), /You have no bookings/);
});

test("hunt2 booking: the list offers only what exists; a restaurant the owner named is not pushed out by better rated strangers; a lone emoji cut never breaks the link", async () => {
  const { engine } = fakeEngine([
    { id: "A", name: "La Fonda Pepita", address: "Carrer X, 08001 Barcelona, Spain", rating: 4.0, ratingCount: 50, phone: "+34931111111", periods: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ open: { day, hour: 12, minute: 0 }, close: { day, hour: 23, minute: 59 } })) },
    ...["B", "C", "D"].map((id) => ({ id, name: `Pepita's ${id}`, address: "Carrer Y, 08002 Barcelona, Spain", rating: 4.6, ratingCount: 900, phone: "+34932222222", periods: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ open: { day, hour: 12, minute: 0 }, close: { day, hour: 23, minute: 59 } })) })),
  ]);
  const b = createBooking({ engine, mail: { address: "p@agentmail.to", send: async () => undefined }, kv: memoryKv(), ownerName: "Marta", timeZone: "Europe/Madrid", now: () => NOW });
  const reply = await b.start({ what: "La Fonda Pepita, Barcelona", when: WHEN, party: 2 });
  assert.match(reply.say, /1\) La Fonda Pepita/, "the one that was named comes first");
  const two = fakeEngine([{ id: "A", name: "Uno", address: "x, 08001 Barcelona, Spain", rating: 4.5, ratingCount: 10, phone: "+34931111111" }, { id: "B", name: "Dos", address: "x, 08001 Barcelona, Spain", rating: 4.4, ratingCount: 10, phone: "+34932222222" }]);
  const b2 = createBooking({ engine: two.engine, mail: { address: "p@agentmail.to", send: async () => undefined }, kv: memoryKv(), ownerName: "Marta", timeZone: "Europe/Madrid", now: () => NOW });
  assert.match((await b2.start({ what: "algo, Barcelona", when: WHEN, party: 2 })).say, /Tell me 1 or 2, or NO\./);
  // A WhatsApp-capable restaurant with notes cut in the middle of an emoji.
  const wa = fakeEngine([{ id: "W", name: "Wa", address: "x, 08001 Barcelona, Spain", rating: 4.5, ratingCount: 10 }]);
  (wa.engine as unknown as { reservationWhatsapp: () => string }).reservationWhatsapp = () => "34626728492";
  const b3 = createBooking({ engine: wa.engine, kv: memoryKv(), ownerName: "Marta", timeZone: "Europe/Madrid", now: () => NOW });
  const say = (await b3.start({ what: "wa, Barcelona", when: WHEN, party: 2, notes: `${"a".repeat(149)}😀 gracias` })).say;
  assert.match(say, /wa\.me\/34626728492\?text=/);
});

test("hunt2 booking: bad requests are refused by the connector tool itself, and a skipped hour says so; one person is '1 person'", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { registerBookingTools } = await import("../src/booking.ts");
  const r = rig();
  const asked: unknown[] = [];
  const server = new McpServer({ name: "t", version: "1" });
  registerBookingTools(server, r.booking, (req) => void asked.push(req), "Europe/Madrid");
  const [a, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(c)]);
  try {
    const past = (await client.callTool({ name: "book_restaurant", arguments: { what: "tapas, Barcelona", when: "2026-11-01 21:00", party: 2 } })) as { isError?: boolean; content: { text: string }[] };
    assert.equal(past.isError, true);
    assert.match(past.content[0]!.text, /Not sent to the owner/);
    const many = (await client.callTool({ name: "book_restaurant", arguments: { what: "tapas, Barcelona", when: WHEN, party: 20 } })) as { isError?: boolean };
    assert.equal(many.isError, undefined, "20 is allowed");
    assert.equal(asked.length, 1, "only the valid one reached WhatsApp");
  } finally {
    await client.close();
    await server.close();
  }
  assert.match((await rig().booking.start({ what: "tapas, Barcelona", when: "2027-03-28 02:30", party: 2 })).say, /That time doesn't exist on that day/);
  const one = rig();
  await one.booking.start({ what: "tapas", when: WHEN, party: 1 });
  await one.booking.approve(one.booking.answer("1")!.card!.id, true);
  assert.match(one.sent[0]!.subject, /^Table request: 1 person,/);
});

test("hunt2 booking: an email-only restaurant is not lost when Pako has no inbox to write from; a site that says walk-ins only is said so on the card", async () => {
  const noMail = createBooking({ engine: fakeEngine([{ id: "ChIJcalpep", name: "Cal Pep", address: "Barcelona, Spain", website: "https://calpep.example/", rating: 4.6, ratingCount: 10 }]).engine, kv: memoryKv(), ownerName: "Marta", timeZone: "Europe/Madrid", now: () => NOW });
  const say = (await noMail.start({ what: "Cal Pep, Barcelona", when: WHEN, party: 2 })).say;
  assert.match(say, /✉️ Booking email \(I can't write from here\): reservas@calpep\.example/);
});
