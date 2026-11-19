// Plain words for the read-only views (src/intents.ts): the owner asks in their own words, in English, and gets the same view a command
// gives. Only a clear question counts; a longer request, a question about something else or a lone word that could be an answer stays with
// Claude. The same question in another language is Claude's too (it answers in that language, from the same context).

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import type { FollowupsDoor } from "../src/followups.ts";
import { matchView, VIEW_COMMAND, type View } from "../src/intents.ts";
import type { Kv } from "../src/kv.ts";
import type { ReviewDoor } from "../src/meeting-review.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp, type WhatsappDeps } from "../src/whatsapp.ts";

const TABLE: [string, View | null][] = [
  // Open loops: PENDING / OPEN.
  ["What am I forgetting?", "followups"],
  ["what am i forgetting today", "followups"],
  ["Hey Pako, what am I forgetting?", "followups"],
  ["Am I forgetting anything?", "followups"],
  ["Did I forget something?", "followups"],
  ["What's pending?", "followups"],
  ["whats outstanding", "followups"],
  ["my open loops", "followups"],
  ["What am I forgeting?", "followups"],
  ["What have I promised?", "followups"],
  // The calendar: AGENDA / CALENDAR, with the day.
  ["My agenda tomorrow", "agenda-tomorrow"],
  ["What do I have today?", "agenda-today"],
  ["What's on tomorrow?", "agenda-tomorrow"],
  ["What's on my calendar?", "agenda"],
  ["my schedule for today", "agenda-today"],
  ["What does tomorrow look like?", "agenda-tomorrow"],
  ["How's my day looking?", "agenda"],
  ["Any meetings today?", "agenda-today"],
  ["Hi Pako, what do I have tomorrow? Thanks", "agenda-tomorrow"],
  ["tell me my agneda for tomorow", "agenda-tomorrow"],
  ["Anything this afternoon? Do I have any plans this afternoon", null],
  ["Do I have any plans this afternoon", "agenda-today"],
  // The brief: BRIEF.
  ["brief me", "brief"],
  ["Give me my daily brief", "brief"],
  ["today's briefing", "brief"],
  ["summarise my day", "brief"],
  // Slack: SLACK.
  ["Anything on Slack?", "slack"],
  ["What's new on Slack?", "slack"],
  ["any slack messages", "slack"],
  ["Anything on Slakc?", "slack"],
  ["check slack", "slack"],
  // Reminders: REMINDERS.
  ["my reminders", "reminders"],
  ["What reminders do I have?", "reminders"],
  ["show me my reminders please", "reminders"],
  ["my remidners", "reminders"],
  ["What are you going to remind me about?", "reminders"],
  // Meetings: MEETING TODOS.
  ["What came out of my meetings?", "meeting-todos"],
  ["meeting action items", "meeting-todos"],
  ["action items from my meetings", "meeting-todos"],
  ["What's still open from my meetings this week?", "meeting-todos"],
  // Traps: a request with the words in it, a question about something else, a lone word that could be an answer.
  ["tomorrow", null],
  ["today", null],
  ["pending", null],
  ["resume", null],
  ["summary", null],
  ["what do I have to do today", null],
  ["remind me tomorrow about the pending invoice", null],
  ["Write to Juan on Slack that I'm running late", null],
  ["slack messages from Ana about the budget", null],
  ["Set a reminder for tomorrow at 9", null],
  ["What came out of the meeting with Ana?", null],
  ["What's the weather tomorrow?", null],
  ["black messages", null],
  ["remainders", null],
  ["my reminders\ndelete the second one", null],
  ["", null],
  // How Pako is doing: HEALTH (the Health card in words, and the Quality card's week).
  ["How is Pako doing?", "health"],
  ["Is everything working?", "health"],
  ["is anything broken with Pako?", "health"],
  ["status", "health"],
  ["system health check", "health"],
  ["How are my reminders doing?", "health"],
  // The dry run: REHEARSAL.
  ["do a dry run", "rehearsal"],
  ["run a rehearsal now", "rehearsal"],
  ["What would you have told me today?", "rehearsal"],
  // Not about Pako: a greeting, something else broken, a rehearsal of something else.
  ["how are you doing pako", null],
  ["all good", null],
  ["is anything broken?", null],
  ["problems", null],
  ["rehearse my talk for tomorrow with me", null],
  ["how is the project going?", null],
  // The same questions in Spanish (or any other language) are not commands: they go to Claude, which answers in the owner's language.
  ["¿Qué tengo pendiente?", null],
  ["¿Qué tengo hoy?", null],
  ["mi agenda", null],
  ["resumen", null],
  ["¿Algo de Slack?", null],
  ["mis recordatorios", null],
  ["¿Qué salió de las reuniones?", null],
  ["¿Cómo va Pako?", null],
  ["Haz un ensayo de hoy", null],
];

test("plain English words find the view their command gives; requests, other questions, lone words and other languages do not", () => {
  assert.ok(TABLE.length >= 60, "a table of at least 60 phrasings");
  const wrong = TABLE.filter(([said, view]) => matchView(said) !== view).map(([said, view]) => `${JSON.stringify(said)}: ${matchView(said)} (wanted ${view})`);
  assert.deepEqual(wrong, []);
});

test("every view is a command the door already answers", () => {
  assert.deepEqual(VIEW_COMMAND, {
    followups: "pending",
    agenda: "agenda",
    "agenda-today": "agenda today",
    "agenda-tomorrow": "agenda tomorrow",
    brief: "brief",
    slack: "slack",
    reminders: "reminders",
    "meeting-todos": "meeting todos",
    health: "health",
    rehearsal: "rehearsal",
  });
});

test("a message longer than a question is never a view, whatever words it has", () => {
  assert.equal(matchView(`What am I forgetting?${" ".repeat(100)}x`), null);
  assert.equal(matchView("what am i forgetting ".repeat(6)), null);
});

// ---- The door: the words are answered as their command is, only when that view is on; the rest goes to Claude, with the views in context.

const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};
let n = 0;

async function door(on: boolean) {
  const sent: string[] = [];
  const meta = (async (_url: string | URL | Request, init?: RequestInit) => {
    const b = init?.body ? (JSON.parse(String(init.body)) as { type?: string; text?: { body?: string } }) : {};
    if (b.type === "text") sent.push(String(b.text?.body));
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  const memory = loadMemory(kv);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => [], callContact: async () => ({ ok: false, text: "" }), lookupCall: async () => "{}" } });
  const days: number[] = [];
  const features: Partial<WhatsappDeps> = on
    ? {
        calendar: { day: async (d: number) => (days.push(d), d === 0 ? "Today: dentist at 10:00" : "Tomorrow: nothing"), context: async () => ["Mon 16 Nov 10:00 Dentist"] },
        brief: { now: async () => "☀️ Your brief for today", daily: true },
        slack: { search: async () => [], recent: async () => ["#general Ana: lunch at one?"] },
        followups: { command: async () => "📌 Pending: send the quote to Luis", context: async () => ["send the quote to Luis"] } as unknown as FollowupsDoor,
        reviews: {
          command: async () => "🎥 Still open from your meetings: review the contract",
          context: async () => ["Weekly committee: review the contract (Luis)"],
        } as unknown as ReviewDoor,
        briefTodos: async () => ["Call the bank: the card expires on Friday"],
        status: { summary: async () => ["✅ Working: Slack, the calendar.", "Quality, last 7 days: no nudges and no 👍/👎 yet."] },
        rehearsal: { start: async () => ({ text: "🧪 Rehearsal under way" }), answer: async () => ({ ok: true }), acked: async () => undefined },
      }
    : {};
  const app = express();
  const d = mountWhatsapp(app, {
    config: loadWhatsappConfig(ENV, "+34600111222").config!, tools, memory, kv, ownerName: "Marta", timeZone: "Europe/Madrid", contacts: () => [],
    fetch: meta, ...features,
  });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const say = (text: string): Promise<string> => d.ingest({ from: d.ownerFrom, id: `wamid.n${++n}`, timestamp: "1", type: "text", text: { body: text } });
  const context = async (): Promise<Record<string, unknown>> =>
    (await (await fetch(`${base}/assistant/context`, { headers: { authorization: `Bearer ${ENV.ASSISTANT_BRIDGE_TOKEN}` } })).json()) as Record<string, unknown>;
  return { sent, days, say, context, close: () => (server.close(), server.closeAllConnections()) };
}

test("the door answers the owner's own words as the view's command, and the day follows the words", async () => {
  const r = await door(true);
  try {
    assert.equal(await r.say("What am I forgetting?"), "followups shown");
    assert.equal(r.sent.at(-1), "📌 Pending: send the quote to Luis");
    assert.equal(await r.say("What do I have today?"), "agenda shown");
    assert.equal(await r.say("my agenda tomorrow"), "agenda shown");
    assert.equal(await r.say("How's my day looking?"), "agenda shown");
    assert.deepEqual(r.days, [0, 1, 0, 1]);
    assert.equal(await r.say("Give me my daily brief"), "brief shown");
    assert.equal(r.sent.at(-1), "☀️ Your brief for today");
    assert.equal(await r.say("Anything on Slack?"), "slack shown");
    assert.equal(await r.say("my reminders"), "reminders shown");
    assert.equal(await r.say("What came out of my meetings?"), "meeting todos shown");
    assert.equal(r.sent.at(-1), "🎥 Still open from your meetings: review the contract");
    // How Pako is doing: the watchdog's words, the week's quality, and how to see the dry run.
    assert.equal(await r.say("How is Pako doing?"), "health shown");
    assert.equal(r.sent.at(-1), "✅ Working: Slack, the calendar.\n\nQuality, last 7 days: no nudges and no 👍/👎 yet.\n\n"
      + "To see what I would tell you now from the last 48 hours, type REHEARSAL (nothing is sent).");
    assert.equal(await r.say("do a dry run"), "rehearsal started");
    assert.equal(r.sent.at(-1), "🧪 Rehearsal under way");
    // Both are in the help, after the plain words.
    await r.say("HELP");
    assert.match(r.sent.at(-1)!, /• REHEARSAL: [^\n]+\n• HEALTH: /);
    // A request with the same words is the assistant's, and so is the same question in Spanish.
    assert.equal(await r.say("remind me tomorrow about the pending invoice"), "queued");
    assert.equal(await r.say("What came out of the meeting with Ana?"), "queued");
    assert.equal(await r.say("¿Qué tengo pendiente?"), "queued");
  } finally {
    r.close();
  }
});

test("a view that is off here is not a command: the owner's words go to Claude as before", async () => {
  const r = await door(false);
  try {
    for (const said of ["What am I forgetting?", "What do I have today?", "Anything on Slack?", "What came out of my meetings?", "brief me", "How is Pako doing?", "do a dry run"]) {
      assert.equal(await r.say(said), "queued", said);
    }
    // The reminders are always kept: their view always answers.
    assert.equal(await r.say("what reminders do I have?"), "reminders shown");
  } finally {
    r.close();
  }
});

test("the assistant's context carries the views it can quote: open loops, the calendar, the meetings' open items, the brief's to-dos", async () => {
  const on = await door(true);
  const off = await door(false);
  try {
    const ctx = await on.context();
    assert.deepEqual(ctx.followups, ["send the quote to Luis"]);
    assert.deepEqual(ctx.calendar, ["Mon 16 Nov 10:00 Dentist"]);
    assert.deepEqual(ctx.meetingTodos, ["Weekly committee: review the contract (Luis)"]);
    assert.deepEqual(ctx.briefTodos, ["Call the bank: the card expires on Friday"]);
    // Nothing to say: no key at all (a small context).
    const bare = await off.context();
    for (const k of ["followups", "calendar", "meetingTodos", "briefTodos"]) assert.equal(k in bare, false, k);
  } finally {
    on.close();
    off.close();
  }
});
