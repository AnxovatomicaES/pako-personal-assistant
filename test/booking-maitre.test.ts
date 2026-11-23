// The booking card and the owner's order through Maître (src/booking.ts with src/maitre/): the real search over fake Google Places and fake
// restaurant sites, the real planner and ledger, and a stand-in CoverManager cartridge (no browser). Bar Mut takes bookings on CoverManager.
//
// The owner's own order books at once, with a receipt and Undo; outside text, the connector and PAKO_BOOKING_CONFIRM=1 keep the card;
// anything ambiguous asks; gates go to Handoff; STOP and the daily limits still hold.

import assert from "node:assert/strict";
import test from "node:test";
import { createBooking, type BookingReply } from "../src/booking.ts";
import { createControl } from "../src/control.ts";
import type { Kv } from "../src/kv.ts";
import type { Page, PagePool } from "../src/maitre/cdp.ts";
import type { BookResult, Cartridge, Evidence } from "../src/maitre/cartridge.ts";
import type { MailLine } from "../src/maitre/ledger.ts";
import { createMaitre } from "../src/maitre/planner.ts";
import { directOrder } from "../src/door/calls.ts";
import type { Place } from "../src/restaurants/places.ts";
import { coverManagerSites, EVERY_DAY, fakeEngine } from "./helpers/booking-fixtures.ts";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const WHEN = "2026-11-20 21:00";

function memoryKv(): Kv {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

function rig(o: {
  book?: (slot: { time: string }) => BookResult; confirmFirst?: boolean; control?: ReturnType<typeof createControl>; cancelFails?: boolean;
  /** Other restaurants than the fixtures' (each with a website, which is a CoverManager module). */
  places?: Place[];
  /** What the engine's page confirms when the Handoff window is looked at (null: nothing yet). */
  verify?: () => Evidence | null;
  /** The recent mail Maître reads for the engine's confirmations. */
  mail?: () => MailLine[];
} = {}) {
  const calls = { book: [] as string[], cancel: 0, submits: 0, reminders: [] as string[], unreminded: [] as string[] };
  const cart: Cartridge = {
    engine: "CoverManager",
    version: 1,
    matches: (u) => /covermanager\.com\/(reservation|reserve)\/module_restaurant\//.test(u),
    required: ["firstName", "lastName", "email", "phone"],
    gates: [],
    blocks: [],
    look: async () => ({ kind: "slots", slots: [] }),
    book: async (ctx, slot, guest) => {
      calls.book.push(`${slot.date} ${slot.time} x${slot.party} ${guest.firstName}/${guest.lastName}/${guest.email}/${guest.phone}`);
      const r = o.book?.(slot);
      if (r) return r;
      await ctx.submitting();
      calls.submits++;
      return { kind: "confirmed", evidence: { url: "https://barmut.com/gracias-por-su-reserva?date=20-11-2026&time=21:00&pax=2", text: "ok", confirmationId: "CM1X", cancelUrl: "https://www.covermanager.com/cancel/CM1X", said: { date: slot.date, time: slot.time, party: slot.party } } };
    },
    verify: async () => o.verify?.() ?? null,
    cancel: async () => {
      calls.cancel++;
      if (o.cancelFails) throw new Error("net::ERR_INTERNET_DISCONNECTED");
      return true;
    },
  };
  const pool: PagePool = {
    withPage: (fn) => fn({} as Page),
    openWindow: async () => ({ page: { goto: async () => ({ status: 200 }) } as unknown as Page, release: () => undefined }),
  };
  const kv = memoryKv();
  const clock = { now: NOW };
  const maitre = createMaitre({ kv, pool, cartridges: [cart], now: () => clock.now, sleep: async () => undefined, ...(o.mail ? { recentMail: async () => o.mail!() } : {}) });
  const { engine } = o.places ? fakeEngine(o.places, coverManagerSites(o.places)) : fakeEngine();
  const control = o.control ?? createControl(null);
  const booking = createBooking({
    engine, kv, control, maitre,
    ownerName: "Marta Puig", ownerPhone: "34600111222", guestEmail: "marta@example.com", timeZone: "Europe/Madrid", now: () => NOW,
    ...(o.confirmFirst ? { confirmFirst: true } : {}),
    remind: async (when, text) => (calls.reminders.push(`${when} ${text}`), "rem0000001"),
    unremind: async (id) => void calls.unreminded.push(id),
  });
  return { booking, calls, maitre, control, clock };
}

/** What the owner sees, in order, the way the door delivers a reply (its text or card, the receipt with Undo, then what comes after). */
async function seen(r: BookingReply): Promise<{ texts: string[]; card?: BookingReply["card"]; undo?: BookingReply["undo"] }> {
  const out: { texts: string[]; card?: BookingReply["card"]; undo?: BookingReply["undo"] } = { texts: [] };
  let cur: BookingReply | undefined = r;
  while (cur) {
    if (cur.card) out.card = cur.card;
    else if (cur.say) out.texts.push(cur.say);
    if (cur.undo) out.undo = cur.undo;
    cur = cur.after ? await cur.after() : undefined;
  }
  return out;
}

const OWNER_WORDS = ["resérvame mesa en Bar Mut el viernes a las 21:00 para 2"];

test("booking maitre: the owner's own order naming the restaurant books at once, with no card: proof, a reminder and Undo", async () => {
  const r = rig();
  const reply = await r.booking.start({ what: "Bar Mut, Barcelona", when: WHEN, party: 2 }, { direct: true, owner: OWNER_WORDS });
  assert.ok(!reply.card, "no card to press");
  const s = await seen(reply);
  assert.match(s.texts[0]!, /^Booking Bar Mut for 2 people, Friday 20 November at 21:00…$/);
  assert.deepEqual(r.calls.book, ["2026-11-20 21:00 x2 Marta/Puig/marta@example.com/34600111222"]);
  assert.equal(r.calls.submits, 1);
  assert.ok(s.undo, "a receipt with Undo");
  assert.match(s.undo!.body, /✅ Booked: Bar Mut, 2 people, Friday 20 November at 21:00 \(CoverManager, confirmation CM1X\)\./);
  assert.match(s.undo!.body, /Proof: https:\/\/barmut\.com\/gracias-por-su-reserva/);
  assert.match(s.undo!.body, /I'll remind you three hours before/);
  assert.equal(s.undo!.label, "Undo");
  assert.deepEqual(r.calls.reminders, ["2026-11-20 18:00 Table at Bar Mut at 21:00 for 2 (CM1X)"]);
  assert.match(await r.booking.list(), /Bar Mut · 2 people · confirmed, with proof/);
  assert.ok((await r.control.recent(20)).some((e) => /Booked Bar Mut/.test(e.text)), "in the action log");
});

test("booking maitre: Undo on the receipt calls the cartridge's cancel, marks it cancelled and takes the reminder back", async () => {
  const r = rig();
  const s = await seen(await r.booking.start({ what: "Bar Mut, Barcelona", when: WHEN, party: 2 }, { direct: true, owner: OWNER_WORDS }));
  const said = await r.booking.undo(s.undo!.id);
  assert.equal(r.calls.cancel, 1);
  assert.match(said, /↩️ Cancelled the booking at Bar Mut \(Friday 20 November at 21:00\)\./);
  assert.deepEqual(r.calls.unreminded, ["rem0000001"]);
  assert.match(await r.booking.list(), /cancelled|You have no bookings/);
  assert.equal((await r.maitre.ledger.get(s.undo!.id))?.state, "cancelled");
  // Pressed again: nothing more to undo, and the engine is not asked twice.
  assert.match(await r.booking.undo(s.undo!.id), /can't be undone from here any more/);
  assert.equal(r.calls.cancel, 1);
});

test("booking maitre: a turn with outside text (no direct order) still shows the card, and only its press books", async () => {
  const r = rig();
  const reply = await r.booking.start({ what: "Bar Mut, Barcelona", when: WHEN, party: 2 });
  assert.ok(!reply.card, "three restaurants found: a list first");
  const card = r.booking.answer("1")!.card!;
  assert.match(card.body, /^I'll book Bar Mut \(CoverManager\) for 2, Friday 20 November at 21:00, under the name Marta Puig, with the phone \+34600111222 and the email marta@example\.com\./);
  assert.equal(card.yes, "Book");
  assert.equal(r.calls.book.length, 0, "nothing booked before the press");
  const s = await seen(await r.booking.press(card.id, true));
  assert.equal(r.calls.book.length, 1);
  assert.ok(s.undo);
});

test("booking maitre: the restaurant named in an email (not in the owner's words) is not booked at once", async () => {
  const r = rig();
  // The assistant asked for Bar Mut, but the owner only said "book the place from the email".
  const reply = await r.booking.start({ what: "Bar Mut, Barcelona", when: WHEN, party: 2 }, { direct: true, owner: ["resérvame donde dice el correo de Ana"] });
  assert.ok(!reply.after, "not booked straight away");
  assert.match(reply.say, /^For 2, Friday/);
  assert.equal(r.calls.book.length, 0);
});

test("booking maitre: PAKO_BOOKING_CONFIRM=1 brings the card back even for the owner's own order", async () => {
  const r = rig({ confirmFirst: true });
  const reply = await r.booking.start({ what: "Bar Mut, Barcelona", when: WHEN, party: 2 }, { direct: true, owner: OWNER_WORDS });
  assert.ok(reply.card, "the card");
  assert.equal(r.calls.book.length, 0);
  assert.match(await r.booking.approve(reply.card!.id, true), /✅ Booked: Bar Mut/);
  assert.equal(r.calls.book.length, 1);
});

test("booking maitre: an order with no specific restaurant asks with the options; the owner's pick books at once", async () => {
  const r = rig();
  const reply = await r.booking.start({ what: "tapas en el Born, Barcelona", when: WHEN, party: 2 }, { direct: true, owner: ["mesa para 2 el viernes a las 21 de tapas en el Born"] });
  assert.match(reply.say, /1\) Bar Mut.*\n {3}📅 I book it myself on CoverManager\n2\) Cal Pep/);
  assert.equal(r.calls.book.length, 0);
  const picked = r.booking.answer("1")!;
  assert.ok(!picked.card, "the pick is the order: no card after it");
  const s = await seen(picked);
  assert.equal(r.calls.book.length, 1);
  assert.ok(s.undo);
});

test("booking maitre: the exact time is taken: the real free times are offered, and the one picked is booked at once", async () => {
  const r = rig({ book: (slot) => (slot.time === "21:00" ? { kind: "no_slot", alternatives: [{ date: "2026-11-20", time: "21:30", party: 2 }, { date: "2026-11-20", time: "20:30", party: 2 }] } : undefined) as BookResult });
  const s = await seen(await r.booking.start({ what: "Bar Mut, Barcelona", when: WHEN, party: 2 }, { direct: true, owner: OWNER_WORDS }));
  assert.match(s.texts.at(-1)!, /Bar Mut has no table at 21:00 that day for 2 people\. Free: 21:30, 20:30\. Which one shall I book\?/);
  assert.equal(r.calls.submits, 0);
  const s2 = await seen(r.booking.answer("21:30")!);
  assert.deepEqual(r.calls.book.map((b) => b.slice(0, 16)), ["2026-11-20 21:00", "2026-11-20 21:30"]);
  assert.match(s2.undo!.body, /21:30/);
});

test("booking maitre: a gate opens the Handoff and says the one thing to do; 'done' checks the page", async () => {
  const r = rig({ book: () => ({ kind: "gate", gate: "captcha", detail: "reCAPTCHA", submitted: false }) });
  const s = await seen(await r.booking.start({ what: "Bar Mut, Barcelona", when: WHEN, party: 2 }, { direct: true, owner: OWNER_WORDS }));
  assert.match(s.texts.at(-1)!, /^One tap needed from you: the captcha\. I've opened the window at that step, with everything filled in/);
  const done = r.booking.answer("done")!;
  const s2 = await seen(done);
  assert.match(s2.texts.join(" "), /I don't see the confirmation on the page yet/);
});

test("booking maitre: STOP, the daily limit and once per restaurant a day still hold for an order", async () => {
  const control = createControl(null);
  await control.setPaused(true, NOW);
  const r = rig({ control });
  const s = await seen(await r.booking.start({ what: "Bar Mut, Barcelona", when: WHEN, party: 2 }, { direct: true, owner: OWNER_WORDS }));
  assert.match(s.texts.at(-1)!, /I haven't written to Bar Mut/);
  assert.equal(r.calls.book.length, 0);

  const r2 = rig();
  await seen(await r2.booking.start({ what: "Bar Mut, Barcelona", when: WHEN, party: 2 }, { direct: true, owner: OWNER_WORDS }));
  const again = await seen(await r2.booking.start({ what: "Bar Mut, Barcelona", when: "2026-11-20 22:00", party: 2 }, { direct: true, owner: ["y otra en Bar Mut a las 22:00"] }));
  assert.match(again.texts.at(-1)!, /I've already booked or written to Bar Mut today/);
  assert.equal(r2.calls.book.length, 1);
});

test("booking maitre: only the owner's own turn is a direct order; a turn that read outside text, or one Pako started, is not", () => {
  const own = { sources: { owner: ["mesa en Bar Mut el viernes a las 21 para 2"], outside: [] }, initiative: false, ownerUnknown: false, key: "k" };
  assert.equal(directOrder(own), true);
  assert.equal(directOrder({ ...own, context: ["email"] }), false, "new outside text in the turn's context");
  assert.equal(directOrder(undefined), false, "a held reply the owner pressed Do it on (its turn read outside text)");
  assert.equal(directOrder({ ...own, initiative: true }), false, "Pako's own initiative");
  assert.equal(directOrder({ ...own, ownerUnknown: true, sources: { owner: [], outside: [] } }), false, "an older bridge: the owner's words unknown");
});

test("booking maitre: an Undo whose cancel could not run says the booking still stands and to try again, never 'can't be undone'", async () => {
  // The cartridge failing on its page: "I couldn't cancel it from here", with how (as before).
  const page = rig({ cancelFails: true });
  const s1 = await seen(await page.booking.start({ what: "Bar Mut, Barcelona", when: WHEN, party: 2 }, { direct: true, owner: OWNER_WORDS }));
  assert.match(await page.booking.undo(s1.undo!.id), /I couldn't cancel it from here/);
  // The cancel itself not running (its store did not answer): the booking stands, try again (it said "can't be undone any more").
  const r = rig();
  const s = await seen(await r.booking.start({ what: "Bar Mut, Barcelona", when: WHEN, party: 2 }, { direct: true, owner: OWNER_WORDS }));
  r.maitre.cancel = async () => Promise.reject(new Error("the store did not answer"));
  const said = await r.booking.undo(s.undo!.id);
  assert.doesNotMatch(said, /can't be undone from here any more/);
  assert.match(said, /the booking still stands\. Press Undo again in a moment/);
});

// ---------- who counts as "named by the owner": whole words, and not a food word or the place of the request ----------

const place = (id: string, name: string, rating: number): Place => ({ id, name, address: `1 Test St, ${name}`, rating, ratingCount: 500, website: `https://${id.toLowerCase()}.example/`, periods: EVERY_DAY });

test("booking maitre: a result called like a food word or the place of the request ('Thai', 'Soho') is not 'named': the owner gets the list", async () => {
  for (const [what, owner, odd] of [
    ["thai in Soho, London", "book me a thai in soho for 2 on friday at 9pm", place("ChIJthai", "Thai", 3.9)],
    ["pizza in Roma, Madrid", "una pizza en Roma para 2 el viernes a las 21", place("ChIJroma", "Roma", 4.0)],
    ["somewhere to eat in Soho, London", "find me somewhere to eat in soho on friday at 9pm for 2", place("ChIJeat", "Eat", 3.8)],
  ] as const) {
    const r = rig({ places: [place("ChIJrosas", "Rosa's Place", 4.7), odd, place("ChIJbusaba", "Busaba", 4.4)] });
    const reply = await r.booking.start({ what, when: WHEN, party: 2 }, { direct: true, owner: [owner] });
    assert.ok(!reply.after && !reply.card, `${what}: nothing is booked, no card: a list`);
    assert.match(reply.say, /^For 2, Friday 20 November at 21:00 \(from Google Maps/);
    assert.equal(r.calls.book.length, 0, `${what}: no cartridge run before the owner picks`);
    // The pick is then the order.
    assert.ok((await seen(r.booking.answer("1")!)).undo);
    assert.equal(r.calls.book.length, 1);
  }
});

test("booking maitre: a name must be in the request as whole words ('Cal Pep' is not 'Cal Pepito'); a real name still books at once", async () => {
  const places = [place("ChIJcalpep", "Cal Pep", 4.6), place("ChIJpepito", "Casa Pepito", 4.5), place("ChIJmut", "Bar Mut", 4.5)];
  const r = rig({ places });
  const reply = await r.booking.start({ what: "Cal Pepito, Barcelona", when: WHEN, party: 2 }, { direct: true, owner: ["resérvame mesa en Cal Pepito el viernes a las 21:00 para 2"] });
  assert.ok(!reply.after, "Cal Pep is a different restaurant: not booked");
  assert.equal(r.calls.book.length, 0);
  const ok = rig({ places });
  const named = await seen(await ok.booking.start({ what: "Bar Mut, Barcelona", when: WHEN, party: 2 }, { direct: true, owner: OWNER_WORDS }));
  assert.equal(ok.calls.book.length, 1, "a restaurant named in full, in the request and in the owner's words, is booked at once");
  assert.ok(named.undo);
});

test("booking maitre: a booking finished in the Handoff window follows what the confirmation says (day, time, party): receipt, warning, saved booking and reminder", async () => {
  let page: Evidence | null = null;
  const r = rig({ book: () => ({ kind: "gate", gate: "captcha", detail: "reCAPTCHA", submitted: false }), verify: () => page });
  await seen(await r.booking.start({ what: "Bar Mut, Barcelona", when: WHEN, party: 2 }, { direct: true, owner: OWNER_WORDS }));
  // In the window the asked time was gone: the owner took Saturday 22:30 for 4, and the page says so.
  page = { url: "https://barmut.com/gracias?date=21-11-2026&time=22:30&pax=4", text: "Gracias por su reserva", confirmationId: "CM9", said: { date: "2026-11-21", time: "22:30", party: 4 } };
  const done = r.booking.resolve(r.booking.take(), "done");
  const s = await seen((done as { reply: BookingReply }).reply);
  const text = s.undo?.body ?? s.texts.join("\n");
  assert.match(text, /^✅ Booked: Bar Mut, 4 people, Saturday 21 November at 22:30 \(CoverManager, confirmation CM9\)\./);
  assert.match(text, /⚠️ The confirmation says date 2026-11-21, time 22:30, party 4: please check it\./);
  assert.deepEqual(r.calls.reminders, ["2026-11-21 19:30 Table at Bar Mut at 22:30 for 4 (CM9)"], "the reminder is for the booked time, not the asked one");
  assert.match(await r.booking.list(), /Saturday 21 November at 22:30 · Bar Mut · 4 people · confirmed/);

  // A confirmation that says what was asked has no warning, and the asked slot stands.
  const ok = rig({ book: () => ({ kind: "gate", gate: "captcha", detail: "reCAPTCHA", submitted: false }), verify: () => ({ url: "https://barmut.com/gracias", text: "Gracias", confirmationId: "CM1", said: { date: "2026-11-20", time: "21:00", party: 2 } }) });
  await seen(await ok.booking.start({ what: "Bar Mut, Barcelona", when: WHEN, party: 2 }, { direct: true, owner: OWNER_WORDS }));
  const same = await seen((ok.booking.resolve(ok.booking.take(), "done") as { reply: BookingReply }).reply);
  assert.match(same.undo?.body ?? same.texts.join("\n"), /^✅ Booked: Bar Mut, 2 people, Friday 20 November at 21:00 /);
  assert.doesNotMatch(same.undo?.body ?? same.texts.join("\n"), /⚠️/);
  assert.deepEqual(ok.calls.reminders, ["2026-11-20 18:00 Table at Bar Mut at 21:00 for 2 (CM1)"]);
});

test("booking maitre: after Undo the same restaurant can be booked again for that day: the old confirmation and the cancellation mail do not count as 'already booked'", async () => {
  let mail: MailLine[] = [];
  const r = rig({ mail: () => mail });
  const s1 = await seen(await r.booking.start({ what: "Bar Mut, Barcelona", when: WHEN, party: 2 }, { direct: true, owner: OWNER_WORDS }));
  // The engine's confirmation arrives right after the booking; the owner presses Undo a minute later; the cancellation mail follows.
  mail = [{ at: NOW + 1000, from: "CoverManager <no-reply@covermanager.com>", subject: "Reserva confirmada en Bar Mut", preview: "Tu reserva para el 20/11/2026 a las 21:00 para 2 personas" }];
  r.clock.now = NOW + 60_000;
  assert.match(await r.booking.undo(s1.undo!.id), /↩️ Cancelled the booking at Bar Mut/);
  mail = [{ at: NOW + 61_000, from: "CoverManager <no-reply@covermanager.com>", subject: "Your reservation at Bar Mut has been cancelled", preview: "Your reservation for 20/11/2026 at 21:00 for 2 people was cancelled." }, ...mail];
  r.clock.now = NOW + 120_000;
  const again = await seen(await r.booking.start({ what: "Bar Mut, Barcelona", when: "2026-11-20 21:30", party: 2 }, { direct: true, owner: ["y otra en Bar Mut a las 21:30"] }));
  assert.doesNotMatch(again.texts.join(" "), /already in the mail/);
  assert.ok(again.undo, "booked again");
  assert.deepEqual(r.calls.book.map((b) => b.slice(0, 16)), ["2026-11-20 21:00", "2026-11-20 21:30"]);
});

test("booking maitre: a confirmation mail for another time that day (lunch) does not stop a dinner; one for the same time still does", async () => {
  const lunch: MailLine = { at: NOW - 3600_000, from: "CoverManager <no-reply@covermanager.com>", subject: "Reserva confirmada en Bar Mut", preview: "Tu reserva para el 20/11/2026 a las 13:30 para 2 personas" };
  const r = rig({ mail: () => [lunch] });
  const dinner = await seen(await r.booking.start({ what: "Bar Mut, Barcelona", when: WHEN, party: 2 }, { direct: true, owner: OWNER_WORDS }));
  assert.ok(dinner.undo, "dinner booked");
  const same = rig({ mail: () => [{ ...lunch, preview: "Tu reserva para el 20/11/2026 a las 21:00 para 2 personas" }] });
  const blocked = await seen(await same.booking.start({ what: "Bar Mut, Barcelona", when: WHEN, party: 2 }, { direct: true, owner: OWNER_WORDS }));
  assert.match(blocked.texts.join(" "), /confirmation for that day is already in the mail/);
  assert.equal(same.calls.book.length, 0);
});
