// The brief's material (src/brief-v2.ts gatherFacts): both sides of a Slack conversation, whether the owner wrote after the latest message
// to them, and an uptime monitor's "down" email checked again this morning.
import assert from "node:assert/strict";
import { test } from "node:test";
import { briefMaterial, gatherFacts, validateBrief, type Gathered, type SlackItem } from "../src/brief-v2.ts";
import type { RecentMail } from "../src/mail.ts";

const MADRID = "Europe/Madrid";
const NOW = Date.parse("2026-11-25T07:00:00Z");
const H = 3600_000;

test("the owner's own Slack lines are facts marked as theirs; the latest message to them says whether they wrote there since", async () => {
  const list: SlackItem[] = [
    { at: NOW - 20 * H, where: "Marta (private)", text: "My guess is if Ines is happy on Wednesday we're off", channel: "D1" },
    { at: NOW - 21 * H, where: "Marta (private)", text: "I'll call Ines to find out if Thursday and Friday are off", channel: "D1", mine: true },
    { at: NOW - 22 * H, where: "Marta (private)", text: "any news on the long weekend?", channel: "D1" },
    { at: NOW - 5 * H, where: "Leo (private)", text: "sent you the deck", channel: "D2" },
    { at: NOW - 4 * H, where: "Leo (private)", text: "thanks, reading it", channel: "D2", mine: true },
  ];
  const g = await gatherFacts({ timeZone: MADRID, lang: "en", now: NOW, slack: async () => list });
  const s = g.facts.filter((f) => f.kind === "slack");
  assert.equal(s.length, 5);
  const own = s.find((f) => f.text.includes("I'll call Ines"))!;
  assert.match(own.text, /YOU \(the owner\) wrote, in Marta \(private\): I'll call Ines/);
  assert.match(own.label, /^Slack · You → Marta \(private\)/);
  const latest = s.find((f) => f.text.includes("we're off"))!;
  assert.match(latest.text, /Pako has seen nothing from you in this conversation since$/);
  assert.doesNotMatch(s.find((f) => f.text.includes("long weekend"))!.text, /nothing from you|after it/, "only the latest message of a conversation");
  assert.match(s.find((f) => f.text.includes("sent you the deck"))!.text, /you wrote in this conversation after it \(/);
});

test("«nothing from you since» only where Pako kept one of the owner's messages from before: never a channel it reads only mentions in", async () => {
  const list: SlackItem[] = [
    { at: NOW - 20 * H, where: "Marta (private)", text: "are we off on Friday?", channel: "D1" },
    { at: NOW - 2 * H, where: "Marta (private)", text: "lunch?", channel: "D1", mine: true },
    { at: NOW - 6 * H, where: "#ops", text: "@you can you look?", channel: "C9" },
    { at: NOW - 30 * H, where: "Leo (private)", text: "the deck?", channel: "D2" },
    { at: NOW - 40 * H, where: "Leo (private)", text: "send me the deck", channel: "D2", mine: true },
  ];
  const g = await gatherFacts({ timeZone: MADRID, lang: "en", now: NOW, slack: async () => list });
  const of = (s: string) => g.facts.find((f) => f.text.includes(s))!.text;
  assert.match(of("are we off"), /you wrote in this conversation after it/);
  assert.doesNotMatch(of("can you look"), /nothing from you|after it/, "a channel with no kept owner message: nothing said");
  assert.match(of("the deck?"), /Pako has seen nothing from you in this conversation since$/, "the owner's earlier message there: Pako reads them");
  // An own message that fell out of the kept list cannot make a false claim: the oldest kept one is after the message.
  const trimmed = await gatherFacts({ timeZone: MADRID, lang: "en", now: NOW, slack: async () => [list[3]!, { ...list[4]!, at: NOW - 3 * H }] });
  assert.match(trimmed.facts.find((f) => f.text.includes("the deck?"))!.text, /after it/);
  assert.deepEqual(g.read, ["slack"]);
});

test("the owner's own lines are capped and only from conversations with a message to them; the day's events come before Slack in the material", async () => {
  const own: SlackItem[] = Array.from({ length: 80 }, (_, i) => ({ at: NOW - i * 60_000, where: "#all", text: "x".repeat(500), channel: "C1", mine: true }));
  const ask: SlackItem = { at: NOW - 72 * H, where: "Marta (private)", text: "can you send the list?", channel: "D1" };
  const mineThere: SlackItem = { at: NOW - 73 * H, where: "Marta (private)", text: "sure", channel: "D1", mine: true };
  const ev = { id: "e1", title: "Board call", start: NOW + 2 * H, end: NOW + 3 * H, allDay: false, calendar: "" };
  const g = await gatherFacts({ timeZone: MADRID, lang: "en", now: NOW, slack: async () => [...own, ask, mineThere], events: async () => [ev] });
  const s = g.facts.filter((f) => f.kind === "slack");
  assert.equal(s.length, 2, "the ask and the owner's line in that conversation; none of the 80 in a channel with nothing to them");
  const text = briefMaterial(g, { now: NOW, timeZone: MADRID, lang: "en", ownerLanguage: "en", name: "" });
  assert.ok(text.indexOf("Board call") < text.indexOf("can you send the list"), "events first");
});

const mail = (o: Partial<RecentMail> & { id: string; at: number; subject: string }): RecentMail =>
  ({ from: "UptimeRobot <alert@uptimerobot.com>", preview: "", summary: o.subject, category: "updates", ...o }) as RecentMail;

test("an uptime monitor's down email is a fact whatever its category, checked again now; a site that came back is left out", async () => {
  const asked: string[] = [];
  const g = await gatherFacts({
    timeZone: MADRID, lang: "en", now: NOW,
    mail: async () => [
      mail({ id: "m1", at: NOW - 13 * H, subject: "Monitor is DOWN: shop.example.org", summary: "shop.example.org returns 503" }),
      mail({ id: "m2", at: NOW - 30 * H, subject: "Monitor is DOWN: api.example.org" }),
      mail({ id: "m3", at: NOW - 28 * H, subject: "Monitor is UP: api.example.org" }),
      mail({ id: "m4", at: NOW - 3 * H, subject: "Newsletter", from: "news@example.com", category: "updates" }),
    ],
    checkSite: async (url) => (asked.push(url), { status: 503 }),
  });
  assert.deepEqual(asked, ["https://shop.example.org/"]);
  const m = g.facts.filter((f) => f.kind === "mail");
  assert.equal(m.length, 1);
  assert.equal(m[0]!.ref, "m1");
  assert.match(m[0]!.text, /no recovery email from it since · Pako checked https:\/\/shop\.example\.org\/ now \(08:00\): still failing, HTTP 503$/);
  const back = await gatherFacts({
    timeZone: MADRID, lang: "en", now: NOW,
    mail: async () => [mail({ id: "m1", at: NOW - 13 * H, subject: "Monitor is DOWN: shop.example.org" })],
    checkSite: async () => ({ status: 200 }),
  });
  assert.match(back.facts[0]!.text, /it answers again, HTTP 200$/);
  const refused = await gatherFacts({
    timeZone: MADRID, lang: "en", now: NOW,
    mail: async () => [mail({ id: "m1", at: NOW - 13 * H, subject: "Monitor is DOWN: shop.example.org" })],
    checkSite: async () => ({ error: "refused" }),
  });
  assert.doesNotMatch(refused.facts[0]!.text, /Pako checked/, "a refused address says nothing of a check");
  // A site down 3 days ago with no recovery email is still told (UptimeRobot sends one down email); a redirect is said as one.
  const old = await gatherFacts({
    timeZone: MADRID, lang: "en", now: NOW,
    mail: async () => [mail({ id: "m1", at: NOW - 72 * H, subject: "Monitor is DOWN: shop.example.org" })],
    checkSite: async () => ({ status: 301 }),
  });
  assert.match(old.facts[0]!.text, /it answers with a redirect, HTTP 301$/);
  // A site that never answers does not hold the brief: told without a check, within the brief's own wait.
  const t0 = Date.now();
  const hung = await gatherFacts({
    timeZone: MADRID, lang: "en", now: NOW,
    mail: async () => [mail({ id: "m1", at: NOW - 13 * H, subject: "Monitor is DOWN: shop.example.org" })],
    checkSite: () => new Promise(() => {}),
  });
  assert.ok(Date.now() - t0 < 9000);
  assert.doesNotMatch(hung.facts[0]!.text, /Pako checked/);
});

test("figures repeated from a meeting summary in the focus come with the ask to check them, said in code; a focus that already asks is left", () => {
  const g: Gathered = {
    read: ["zoom"], unread: [],
    facts: [{
      id: "M1", kind: "meeting", icon: "zoom", label: "Zoom · Monday morning meeting", at: NOW - 48 * H,
      text: "Ines asked for an Excel list of everyone who got the investor-lead email. Pia's list: 578 delivered, 116 opens. Leo's list: 563 delivered, 147 opens.",
    }],
  };
  const focus = (story: string) => JSON.stringify({ focus: {
    title: "Draft the email results readout for Ines", story, offer: "I can draft a short cover note for the Excel list.", sources: ["M1"],
  } });
  const o = { now: NOW, timeZone: MADRID, lang: "en" as const, id: "x" };
  const told = validateBrief(focus("Pia's list had 578 delivered and 116 opens; Leo's had 563 delivered and 147 opens."), g, o)!;
  assert.match(told.focus!.story, /The figures come from the meeting's AI summary, so check them against their source before they go out\.$/);
  const asked = validateBrief(focus("Pia's list had 578 delivered and 116 opens; check them against your send tool."), g, o)!;
  assert.doesNotMatch(asked.focus!.story, /The figures come from/);
  const timed = validateBrief(focus("Ines wants it before the 15:00 call on 26/11."), g, o)!;
  assert.doesNotMatch(timed.focus!.story, /The figures come from/, "a time and a date are not figures");
  const listed = validateBrief(focus("Pia's list had 578 delivered and 116 opens; I can draft a checklist for the send."), g, o)!;
  assert.match(listed.focus!.story, /The figures come from/, "«checklist» is not asking to check them");
});
