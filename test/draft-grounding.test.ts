// A draft says only what its material holds (src/draft-grounding.ts): the live evals' invented details are taken out by code, and what the
// facts do hold (people, times, dates, amounts, the file the follow-up sends) stays.
import assert from "node:assert/strict";
import { test } from "node:test";
import { groundDraft, type DraftGround } from "../src/draft-grounding.ts";
import { loadCases, runDrafts } from "./evals/harness.ts";

const NOW = Date.parse("2026-11-18T10:00:00Z"); // Wednesday 18 Nov, 10:00 London
const WHERE = "A reply to Sofia's email";

/** The client case's material: Sofia, the Q4 renewal, the revised quote by Friday; no Lena, no zone, no file. */
const quote: DraftGround = {
  text: [
    "Send Sofia the revised quote for the Q4 renewal",
    "Email, Mon 16/11 18:10 · Follow-up (you promised) · Sofia Okafor by email, Monday 18:10: send Sofia the revised quote for the Q4 renewal · due: Friday",
    "People · Sofia Okafor · relation: client at Initech, head of procurement · last meeting: «Q4 renewal», 12 Nov: you agreed to send the revised quote by Friday",
  ].join("\n"),
  now: NOW, timeZone: "Europe/London", owner: "Alex", who: "Sofia Okafor", title: "Draft: Send Sofia the revised quote for the Q4 renewal", attached: false,
};

/** The meetings case's material: Sofia asks for two times next week; Lena Park books her meetings. */
const times: DraftGround = {
  ...quote,
  text: [
    "Propose times for the renewal call to Sofia",
    "Email, Tue 17/11 16:05 · Follow-up (you were asked) · Sofia Okafor by email, Tuesday 16:05: propose two times next week for the renewal call",
    "People · Sofia Okafor · relation: client at Initech, head of procurement · assistant: Lena Park books her meetings",
  ].join("\n"),
  title: "Draft: Propose times for the renewal call to Sofia",
};

test("the live evals' inventions are taken out: a person, a zone, a file, a promise about someone else, filler", () => {
  // "Lena can confirm": a person the material never names (the first word of its sentence).
  const lena = groundDraft(`${WHERE}\nDear Sofia, I will send you the revised quote by Friday as agreed. Lena can confirm the figures. Kind regards`, quote);
  assert.equal(lena.text, `${WHERE}\nDear Sofia, I will send you the revised quote by Friday as agreed. Kind regards`);
  assert.deepEqual(lena.removed, ["Lena"]);
  // "London time": a zone no fact names, though the owner lives there.
  const zone = groundDraft(`${WHERE}\nDear Sofia, I could do [blank] or [blank] next week. Both are London time. Kind regards`, times);
  assert.equal(zone.text, `${WHERE}\nDear Sofia, I could do [blank] or [blank] next week. Kind regards`);
  assert.deepEqual(zone.removed, ["London time"]);
  // The quote attached, in a draft that only proposes times: no fact shows it.
  const file = groundDraft(`${WHERE}\nDear Sofia, could we do [blank] or [blank] next week? I've attached the quote for reference.`, times);
  assert.equal(file.text, `${WHERE}\nDear Sofia, could we do [blank] or [blank] next week?`);
  assert.deepEqual(file.removed, ["an attachment"]);
  // "Here is the revised quote" implies one too, when the follow-up does not send it.
  assert.deepEqual(groundDraft(`${WHERE}\nCould we do [blank] or [blank]? Here is the revised quote for reference.`, times).removed, ["an attachment"]);
  // Lena is in the material, but what she can do is not: "Lena can pick whichever fits".
  const promise = groundDraft(`${WHERE}\nDear Sofia, I could do [blank] or [blank] next week. Lena can pick whichever fits your calendar.`, times);
  assert.equal(promise.text, `${WHERE}\nDear Sofia, I could do [blank] or [blank] next week.`);
  assert.deepEqual(promise.removed, ["a promise about Lena"]);
  // "Let me know if you have any questions": filler, with no question in the facts.
  const filler = groundDraft(`${WHERE}\nDear Sofia, I will send the revised quote by Friday. Let me know if you have any questions. Kind regards`, quote);
  assert.equal(filler.text, `${WHERE}\nDear Sofia, I will send the revised quote by Friday. Kind regards`);
});

test("times, dates, weekdays and amounts the material lacks go; the first line loses a clause that names someone unknown", () => {
  const g: DraftGround = { ...quote, text: `${quote.text}\nEmail · Sofia: the budget is €5,000 and the call is Thursday 19/11 at 16:30` };
  const say = (s: string): string[] => groundDraft(`${WHERE}\n${s}`, g).removed;
  assert.deepEqual(say("Can we talk at 15:00? I will send the revised quote by Friday."), ["15:00"]);
  assert.deepEqual(say("The total comes to €7,500. I will send the revised quote by Friday."), ["7,500"]);
  assert.deepEqual(say("I can meet on 24 Nov. I will send the revised quote by Friday."), ["24 nov"]);
  assert.deepEqual(say("I can meet on Tuesday. I will send the revised quote by Friday."), ["Tuesday"]);
  assert.deepEqual(say("We could cover the Q3 numbers. I will send the revised quote by Friday."), ["q3"]);
  // The prompt's own way: a time, date, weekday or number the facts lack becomes a [blank], the sentence stays; a zone set off goes.
  const fill = (s: string): string => groundDraft(`${WHERE}\n${s}`, g).text.split("\n")[1]!;
  assert.equal(fill("Dear Sofia, I could do Tuesday 24 Nov at 15:00 or Thursday 19/11 at 16:30. Would either work?"),
    "Dear Sofia, I could do [blank] at [blank] or Thursday 19/11 at 16:30. Would either work?");
  assert.equal(fill("Could we talk at 3 PM, London time? The total is €7,500."), "Could we talk at [blank]? The total is €[blank].");
  const head = groundDraft(`${WHERE}, copying Lena Park\nDear Sofia, I will send the revised quote by Friday.`, quote);
  assert.equal(head.text, `${WHERE}\nDear Sofia, I will send the revised quote by Friday.`);
});

test("what the material holds stays: names with accents, times in another form, dates, amounts, Spanish", () => {
  const g: DraftGround = {
    ...quote,
    text: `${quote.text}\nSlack · José Núñez, jueves 19/11: el presupuesto es de 5.000 € y la llamada es el jueves a las 16:30`,
    who: "José Núñez",
  };
  const kept = (s: string): void => assert.deepEqual(groundDraft(`${WHERE}\n${s}`, g), { text: `${WHERE}\n${s}`, removed: [], check: false });
  kept("Dear Sofia, following our Q4 renewal meeting on 12 Nov, I will send you the revised quote by Friday as agreed. Kind regards, Alex");
  kept("Hola Jose, te confirmo la llamada del jueves 19 de noviembre a las 16:30. El presupuesto sigue en €5,000. Un saludo");
  kept("Hi José! Thursday at 4:30 PM works, and the budget stays at 5000 euros.");
  kept("Hi Sofia, the figures are [blank] and I can do [blank] on Wednesday 18 Nov.");
  // A question back that is no filler: "Let me know which works".
  kept("Dear Sofia, I could do [blank] or [blank] on Friday. Let me know which works for you.");
});

test("the file the follow-up sends, with no fact showing it, is a line to fill; a draft left with nothing is kept, marked to check", () => {
  // "Here is the revised quote": the eval's implied attachment. The quote may not exist yet: the owner attaches or pastes it.
  const sent = groundDraft(`${WHERE}\nDear Sofia, here is the revised quote, as agreed. Kind regards`, quote);
  assert.equal(sent.text, `${WHERE}\nDear Sofia, The revised quote for the Q4 renewal: [blank]. Kind regards`);
  assert.deepEqual(sent.removed, ["an attachment"]);
  const mei = groundDraft("A reply in your Slack conversation with Mei\nPricing model attached, numbers as of [blank]. Shout if the enterprise tier looks off.",
    { ...quote, text: "Send Mei the pricing model · enterprise tier", who: "Mei", title: "Draft: Send Mei the pricing model" });
  assert.equal(mei.text, "A reply in your Slack conversation with Mei\nThe pricing model: [blank]. Shout if the enterprise tier looks off.");
  // A fact shows the file: it stays as written.
  assert.equal(groundDraft(`${WHERE}\nHere is the revised quote.`, { ...quote, attached: true }).text, `${WHERE}\nHere is the revised quote.`);
  const all = `${WHERE}\nDear Sofia, Lena will call you at 15:00 London time. Kind regards`;
  const left = groundDraft(all, quote);
  assert.equal(left.check, true);
  assert.equal(left.text, `Check before sending (not in the facts: 15:00 (another zone), Lena, London time) · ${all}`);
});

test("through the server: the client case's bad answer reaches the owner without Lena, London time or filler", async () => {
  const c = loadCases().find((x) => x.file === "drafts/client-relation-formal-tone.json")!;
  const bad = `${WHERE}\nDear Sofia, I will send you the revised quote by Friday, as agreed in our Q4 renewal meeting. Lena can confirm the timing, `
    + "16:00 London time. Let me know if you have any questions. Kind regards";
  const r = await runDrafts(c, async () => bad);
  assert.equal(r.message, "Dear Sofia, I will send you the revised quote by Friday, as agreed in our Q4 renewal meeting. Kind regards");
});
