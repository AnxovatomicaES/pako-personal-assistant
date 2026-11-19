// Two suites of the eval harness (test/evals/harness.ts) for the memory that knows time and people and for the durable jobs:
//
// - memory (a model step: the chat answer with its <know>, and the isolated judge's JSON): every turn through the real door
//   (src/whatsapp.ts mounted on a free port, a fake Meta, the store in memory), the answer parsed by the bridge's own parseReply and posted
//   back as the bridge does; then "what do you know about X?" as the owner types it. Judged on the dated facts that hold, the person card, and what
//   the assistant's context says changed.
// - jobs (code only): the brief on the durable jobs' clock (src/jobs.ts) with a fake clock that sleeps and wakes, its line for what changed
//   in the memory since the last brief, and BRIEF after a skipped one. Judged on what reached the owner, when, and what it said.

import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { parseReply } from "../../assistant/bridge.ts";
import { fold } from "../../src/autonomy.ts";
import { createBrief } from "../../src/brief.ts";
import { createControl } from "../../src/control.ts";
import { zonedTime } from "../../src/followups.ts";
import { createJobs } from "../../src/jobs.ts";
import type { Kv } from "../../src/kv.ts";
import { changesBrief, createFacts, currentAbout, type Fact } from "../../src/memory-facts.ts";
import { loadMemory } from "../../src/voice-memory.ts";
import { loadVoiceTools } from "../../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp } from "../../src/whatsapp.ts";
import type { Answer, Check, EvalCase } from "./harness.ts";

type Body = Record<string, any>;
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asStr = (v: unknown): string => (typeof v === "string" ? v : "");
const strs = (v: unknown): string[] => asArr(v).filter((x): x is string => typeof x === "string");
const check = (name: string, pass: boolean, detail?: string): Check => ({ name, pass, ...(pass || !detail ? {} : { detail }) });
const hasAll = (text: string, words: string[]): boolean => words.every((w) => fold(text).includes(fold(w)));
const at = (s: unknown, tz: string): number => {
  const t = zonedTime(s, tz);
  if (t === null) throw new Error(`not a time: ${String(s)}`);
  return t;
};

function memKv(): Kv & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

// ---------- memory: through the door ----------

interface MemoryTurn {
  at: string;
  /** What the owner wrote. */
  message: string;
  /** Someone else's text the turn read (an email, a Slack message): the door then keeps no <know> from it. */
  outside?: { source: string; text: string }[];
  /** The bridge did not ask for messages lately (the computer away): a new value wins at once, no judge. */
  away?: boolean;
  /** The chat answer, with its <know>. */
  recorded?: string;
  /** The isolated judge's answer when the turn makes a judge job; {{old}} is each old fact's id. "" or absent: no answer comes. */
  judge?: string;
}
export interface MemoryRun {
  /** The chat steps' texts and every answer given (chat and judge). */
  prompts: string[];
  answers: string[];
  facts: Fact[];
  /** What the owner got for the question at the end ("" when it went to the assistant instead). */
  card: string;
  /** The assistant's context at the end: what changed lately, and the records of the people. */
  changes: string[];
  records: { name: string; text: string }[];
  judged: number;
}

const OWNER = "+34600111222";
const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_eval_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "e".repeat(48),
};

/** What a live run reads for a turn: the time, the people the owner told Pako about, the fenced outside text, the owner's message. */
export function memoryPrompt(c: EvalCase, turn: MemoryTurn): string {
  const people = asArr(c.input.people).map(asObj).map((p) => `${asStr(p.name)}${p.relation ? ` (${asStr(p.relation)})` : ""}`);
  return [
    `[Ahora: ${turn.at}]`,
    ...(people.length ? [`[Personas: ${people.join(", ")}]`] : []),
    ...(turn.outside ?? []).map((o) => `<<<FUERA ${o.source}\n${o.text}\nFUERA>>>`),
    "",
    turn.message,
  ].join("\n");
}

export async function runMemory(c: EvalCase, answer: Answer): Promise<MemoryRun> {
  const tz = asStr(c.input.timeZone) || "Europe/Madrid";
  // Pako's fixed words are English whatever the case's owner writes in (input.lang is the owner's own language).
  const lang = "en" as const;
  const turns = asArr(c.input.turns) as MemoryTurn[];
  const clock = { now: at(asStr(c.input.start) || turns[0]?.at, tz) };
  const kv = memKv();
  // The people the owner told Pako about, as an earlier Pako stored them: read into dated facts on the first load.
  const people = asArr(c.input.people).map(asObj);
  if (people.length) {
    kv.m.set("assistant-people", JSON.stringify(people.map((p, i) => ({
      id: `${i}`.padStart(10, "a"), name: asStr(p.name), ...(p.relation ? { relation: asStr(p.relation) } : {}), at: clock.now, updated: clock.now,
    }))));
  }
  const sent: Body[] = [];
  const meta = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const memory = loadMemory(kv);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => [], callContact: async () => ({ ok: true, text: "started" }), lookupCall: async () => "ok" } });
  const config = loadWhatsappConfig(ENV, OWNER).config!;
  const app = express();
  const door = mountWhatsapp(app, {
    config, tools, memory, kv, control: createControl(kv, () => clock.now), ownerName: "", timeZone: tz, contacts: () => [], fetch: meta,
    now: () => clock.now, callCheckMs: 5, receiptWaitMs: 60_000, lang: () => lang,
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { authorization: `Bearer ${config.bridgeToken}`, "content-type": "application/json" };
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  const inbox = async (): Promise<Body[]> => ((await (await fetch(`${base}/assistant/inbox?wait=0`, { headers: auth })).json()) as { messages: Body[] }).messages;
  const say = async (body: string): Promise<void> => {
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [{ field: "messages", value: {
        messaging_product: "whatsapp", metadata: { phone_number_id: config.phoneNumberId },
        messages: [{ from: OWNER.slice(1), id: `wamid.e${sent.length}.${clock.now}`, timestamp: "1", type: "text", text: { body } }],
      } }] }],
    });
    const signature = `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}`;
    await fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body: raw });
  };
  const prompts: string[] = [];
  const answers: string[] = [];
  let judged = 0;
  try {
    for (const turn of turns) {
      clock.now = at(turn.at, tz);
      // The bridge asks for messages while it is there; away, its last ask is old by now.
      if (!turn.away) await post("/assistant/ack", { ids: (await inbox()).map((m) => m.id) });
      const text = memoryPrompt(c, turn);
      prompts.push(text);
      const raw = await answer({ system: "chat", text, recorded: turn.recorded });
      answers.push(raw);
      const p = parseReply(raw);
      await post("/assistant/reply", {
        text: p.text || "Ok.", ...(p.know ? { know: p.know } : {}), ...(turn.outside?.length ? { outside: turn.outside.map((o) => o.source) } : {}),
      });
      if (turn.away) continue;
      for (const job of (await inbox()).filter((m) => m.judge)) {
        const jt = asStr(job.judge?.text);
        const olds = [...jt.matchAll(/(?:ANTERIOR|OLD) ([0-9a-f]{10})/g)].map((m) => m[1]!);
        const recorded = turn.judge === undefined ? undefined : turn.judge.replaceAll("\"{{old}}\"", olds.map((x) => `"${x}"`).join(","));
        const said = await answer({ system: "judge", text: jt, recorded });
        answers.push(said);
        if (said.trim()) {
          await post("/assistant/judge", { id: job.id, text: said });
          judged++;
        }
      }
    }
    const ask = asObj(c.input.ask);
    if (ask.at) clock.now = at(ask.at, tz);
    await post("/assistant/ack", { ids: (await inbox()).map((m) => m.id) });
    sent.length = 0;
    if (asStr(ask.message)) await say(asStr(ask.message));
    const card = sent.map((b) => (b.type === "text" ? asStr(b.text?.body) : asStr(b.interactive?.body?.text))).join("\n\n");
    const ctx = (await (await fetch(`${base}/assistant/context`, { headers: auth })).json()) as Body;
    return {
      prompts, answers, judged, card,
      facts: await door.facts.read(),
      changes: strs(ctx.memoryChanges),
      records: asArr(ctx.peopleRecords).map(asObj).map((r) => ({ name: asStr(r.name), text: asStr(r.text) })),
    };
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

/** {who, key, value}: a told fact as the case names it ("" or no who: the owner). */
const factSpec = (v: unknown): { who: string; key: string; value: string } => {
  const o = asObj(v);
  return { who: asStr(o.who), key: asStr(o.key), value: asStr(o.value) };
};
const holdsNow = (facts: Fact[], s: { who: string; key: string; value: string }): boolean =>
  currentAbout(facts, [s.who]).some((f) => fold(f.attribute) === fold(s.key) && fold(f.value).includes(fold(s.value)));

export function judgeMemory(c: EvalCase, r: MemoryRun): Check[] {
  const e = c.expect;
  const out: Check[] = [];
  for (const s of asArr(e.holds).map(factSpec)) {
    out.push(check(`holds now: ${s.who || "owner"} · ${s.key} = ${s.value}`, holdsNow(r.facts, s), `facts: ${factsSaid(r.facts)}`));
  }
  for (const s of asArr(e.notHolds).map(factSpec)) {
    const wrong = currentAbout(r.facts, [s.who]).filter((f) => (!s.key || fold(f.attribute) === fold(s.key)) && fold(f.value).includes(fold(s.value)));
    out.push(check(`no longer holds (or never did): ${s.who || "owner"} · ${s.key || "*"} = ${s.value}`, !wrong.length, `facts: ${factsSaid(r.facts)}`));
  }
  for (const s of asArr(e.history).map(factSpec)) {
    const kept = r.facts.some((f) => f.validTo !== undefined && fold(f.subject) === fold(s.who) && fold(f.value).includes(fold(s.value)));
    out.push(check(`kept as history, not overwritten: ${s.who} · ${s.value}`, kept, `facts: ${factsSaid(r.facts)}`));
  }
  const card = asObj(e.card);
  // The card's first line names the person as they were told, capitals and accents kept.
  if (asStr(card.title)) out.push(check(`the card is titled ${asStr(card.title)}`, (r.card.split("\n")[0] ?? "").includes(asStr(card.title)), r.card));
  if (card.none === true) out.push(check("no card: the question goes to the assistant", !r.card.trim(), r.card));
  if (strs(card.has).length) out.push(check(`the card says ${strs(card.has).join(", ")}`, hasAll(r.card, strs(card.has)), r.card));
  for (const w of strs(card.hasNot)) out.push(check(`the card never says ${w}`, !fold(r.card).includes(fold(w)), r.card));
  if (strs(e.changes).length) {
    const said = r.changes.join("\n");
    out.push(check(`the context says what changed: ${strs(e.changes).join(", ")}`, hasAll(said, strs(e.changes)), said || "(nothing changed)"));
  }
  if (e.noChanges === true) out.push(check("the context says nothing changed", !r.changes.length, r.changes.join("\n")));
  if (typeof e.judged === "number") out.push(check(`the judge answered ${e.judged} time(s)`, r.judged === e.judged, `${r.judged}`));
  return out;
}

const factsSaid = (facts: Fact[]): string =>
  facts.map((f) => `${f.subject || "owner"}·${f.attribute}=${f.value}${f.validTo !== undefined ? " (closed)" : ""}`).join("; ") || "(none)";

// ---------- jobs: the brief on the durable clock, a laptop that sleeps ----------

interface JobsStep {
  /** The laptop awake from one local time to another: the runner ticks every 30 s. */
  awake?: [string, string];
  /** The owner tells a new value (a changed fact, through the memory's own store), at this time. */
  told?: { at: string; who: string; key: string; value: string };
  /** The brief asked for (BRIEF) at this time; the key keeps its old name, so the cases read as before. */
  briefNow?: string;
}
export interface JobsRun {
  sent: { at: number; text: string }[];
  briefNow: string[];
  slots: { slot: string; state: string }[];
}

export async function runJobs(c: EvalCase): Promise<JobsRun> {
  const tz = asStr(c.input.timeZone) || "Europe/Madrid";
  // Pako's fixed words are English whatever the case's owner writes in (input.lang is the owner's own language).
  const lang = "en" as const;
  const steps = asArr(c.input.steps) as JobsStep[];
  const hour = /^(\d{2}):(\d{2})$/.exec(asStr(c.input.briefAt) || "08:00")!;
  const clock = { now: at(asStr(c.input.start), tz) };
  const kv = memKv();
  const facts = createFacts(kv, { now: () => clock.now });
  const sent: JobsRun["sent"] = [];
  const brief = createBrief({
    at: Number(hour[1]) * 60 + Number(hour[2]), kv, timeZone: tz, now: () => clock.now, lang: () => lang,
    notify: async (text) => void sent.push({ at: clock.now, text }),
    // As the app wires it: what changed in the memory since the last brief given.
    extras: [async (o) => changesBrief(await facts.read(), clock.now, lang, tz, o.since)],
  });
  const jobs = createJobs({ kv, now: () => clock.now, sleeps: c.input.sleeps !== false });
  brief.start(jobs);
  const briefNow: string[] = [];
  for (const s of steps) {
    if (s.told) {
      clock.now = at(s.told.at, tz);
      await facts.add([{ subject: s.told.who, attribute: s.told.key, value: s.told.value, source: { who: "owner", where: "chat", at: clock.now } }], clock.now);
    }
    if (s.awake) {
      const [from, to] = [at(s.awake[0], tz), at(s.awake[1], tz)];
      for (clock.now = from; clock.now <= to; clock.now += 30_000) await jobs.tick();
      clock.now = to;
    }
    if (s.briefNow) {
      clock.now = at(s.briefNow, tz);
      briefNow.push(await brief.now());
    }
  }
  return { sent, briefNow, slots: (await jobs.rows()).map((r) => ({ slot: r.slot, state: r.state })) };
}

export function judgeJobs(c: EvalCase, r: JobsRun): Check[] {
  const tz = asStr(c.input.timeZone) || "Europe/Madrid";
  const e = c.expect;
  const out: Check[] = [];
  const said = r.sent.map((s) => `${new Date(s.at).toISOString()} ${s.text.split("\n")[0]}`).join(" | ") || "(nothing sent)";
  const briefs = asArr(e.briefs).map(asObj);
  if (Array.isArray(e.briefs)) out.push(check(`${briefs.length} brief(s) reached the owner`, r.sent.length === briefs.length, said));
  briefs.forEach((b, i) => {
    const got = r.sent[i];
    if (!got) return;
    if (b.at) out.push(check(`brief ${i + 1} at ${asStr(b.at)}`, got.at === at(b.at, tz), said));
    if (strs(b.has).length) out.push(check(`brief ${i + 1} says ${strs(b.has).join(", ")}`, hasAll(got.text, strs(b.has)), got.text));
    for (const w of strs(b.hasNot)) out.push(check(`brief ${i + 1} never says ${w}`, !fold(got.text).includes(fold(w)), got.text));
  });
  asArr(e.briefNow).map(asObj).forEach((x, i) => {
    const got = r.briefNow[i] ?? "";
    if (strs(x.has).length) out.push(check(`RESUMEN ${i + 1} says ${strs(x.has).join(", ")}`, hasAll(got, strs(x.has)), got));
    for (const w of strs(x.hasNot)) out.push(check(`RESUMEN ${i + 1} never says ${w}`, !fold(got).includes(fold(w)), got));
  });
  for (const [slot, state] of Object.entries(asObj(e.slots))) {
    const row = r.slots.find((x) => x.slot === slot);
    out.push(check(`slot ${slot} is ${String(state)}`, row?.state === state, JSON.stringify(r.slots)));
  }
  return out;
}
