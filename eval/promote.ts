// npm run eval:promote: the owner's feedback as DRAFT cases for the live chat eval (eval/README.md), so the golden set grows from real misses.
//
//   npm run eval:promote -- --list                 the 👎 and «Not mine» of the last days, and the owner's latest chat messages, numbered
//   npm run eval:promote -- --feedback <ref>       a draft from one 👎 or «Not mine» (its ref, from --list)
//   npm run eval:promote -- --chat <n>             a draft from one of the owner's chat messages (its number, from --list) and Pako's answer
//   options: --home <PAKO_HOME> (default: PAKO_HOME, else ~/.pako) --days 30 --tz America/New_York
//
// The store is only read (its file, not through Pako): nothing in it changes. Names (the people Pako knows, the contacts, whoever a loop
// names), addresses, phone numbers, links and channels become placeholders (<person1>, <email1>…) before anything is written, with the
// scrubber of test/evals/from-feedback.ts. A draft goes to eval/drafts/ (not tracked) and does not load as a case until the owner gives it a
// behaviour and checks: read it, finish it, then move it into eval/cases/.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTACTS_KEY } from "../src/contacts.ts";
import { FOLLOWUPS_KEY, stateOf } from "../src/followups.ts";
import { FEEDBACK_KEY, qualityStateOf } from "../src/quality.ts";
import { readStore, scrubber, type Scrubber } from "../test/evals/from-feedback.ts";
import type { Area, EvalCase } from "./harness.ts";

const CHAT_KEY = "pako-local-chat";
const PEOPLE_KEY = "assistant-people";

/** A draft: a case still to be finished (its behaviour and checks), and what Pako answered then, for reference. */
export type Draft = Omit<EvalCase, "id" | "area" | "checks"> & { area: Area | "TODO"; checks: EvalCase["checks"]; answered?: string };

export interface FeedbackItem {
  ref: string;
  at: number;
  why: string;
  what: string;
  source: "nudge" | "brief_todo" | "brief_update" | "brief";
}
interface ChatLine {
  n: number;
  at: number;
  who: "you" | "pako";
  text: string;
}

const local = (t: number, tz: string): string =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(t);

/** Each 👎 and «Not mine» since then, once per thing judged (both on one nudge are one item). */
export function feedbackItems(feedback: unknown, since: number): FeedbackItem[] {
  const q = qualityStateOf(feedback);
  const out = new Map<string, FeedbackItem>();
  for (const n of q.nudges) {
    if (n.outcome === "notmine" && n.at >= since) out.set(n.ref, { ref: n.ref, at: n.at, why: "«Not mine»", what: n.what, source: "nudge" });
  }
  for (const v of q.verdicts) {
    if (v.verdict !== "down" || v.at < since) continue;
    const had = out.get(v.ref);
    out.set(v.ref, had ? { ...had, why: `${had.why} and 👎` } : { ref: v.ref, at: v.at, why: "👎", what: v.what, source: v.source });
  }
  return [...out.values()].sort((a, b) => a.at - b.at);
}

/** Who to hide: the people Pako knows, the contacts, whoever a loop or a learned rule names. */
export function namesOf(get: (key: string) => unknown): string[] {
  const names = (v: unknown): string[] =>
    (Array.isArray(v) ? v : []).map((x) => (x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string" ? (x as { name: string }).name : ""));
  const f = stateOf(get(FOLLOWUPS_KEY));
  return [...names(get(PEOPLE_KEY)), ...names(get(CONTACTS_KEY)), ...f.loops.map((l) => l.who), ...f.rules.map((r) => r.who)].filter(Boolean);
}

/**
 * A 👎 or «Not mine» as a chat case: what Pako told the owner (a nudge's loop, a brief's to-do) is in the context as Pako keeps it, the owner
 * asks what is pending, and the reply must not hand it back as theirs. Null for a 👎 on a whole brief: it names nothing to test.
 */
export function feedbackDraft(item: FeedbackItem, get: (key: string) => unknown, s: Scrubber, o: { tz: string }): Draft | null {
  if (item.source === "brief") return null;
  const loop = item.source === "nudge" ? stateOf(get(FOLLOWUPS_KEY)).loops.find((l) => l.id === item.ref) : undefined;
  const title = s(loop?.title ?? item.what);
  const line = loop ? `${s(loop.who || "?")} (${s(loop.where?.label ?? "?")}): ${title}` : title;
  return {
    area: "followups",
    behaviour: `DRAFT TODO: «${title}» was not the owner's (${item.why}): asked what is pending, Pako does not give it back as theirs`,
    origin: `${item.why} on ${local(item.at, o.tz).slice(0, 10)} (${item.source}); placeholders replace personal data. Check every field, then move it to eval/cases/`,
    input: {
      now: local(Date.now(), o.tz),
      timeZone: o.tz,
      message: "What do I have pending?",
      context: item.source === "nudge" ? { followups: [line] } : { briefTodos: [line] },
    },
    checks: [{ check: "noActions" }],
    judge: `Does the reply leave out «${title}», or say it is not the owner's to do?`,
  };
}

/** One of the owner's chat messages and what Pako answered (its next messages until the owner wrote again), as a draft to finish. */
export function chatDraft(chat: ChatLine[], n: number, s: Scrubber, o: { tz: string }): Draft | null {
  const i = chat.findIndex((m) => m.n === n && m.who === "you");
  if (i < 0) return null;
  const asked = chat[i]!;
  const answered = [];
  for (const m of chat.slice(i + 1)) {
    if (m.who === "you") break;
    answered.push(s(m.text));
  }
  return {
    area: "TODO",
    behaviour: "DRAFT TODO: what Pako should have done instead",
    origin: `the owner's chat message ${n} on ${local(asked.at, o.tz).slice(0, 10)}; placeholders replace personal data. Add the context it needs `
      + "(notes, contacts, emails...), an area, checks that the answer below fails, then move it to eval/cases/",
    input: { now: local(asked.at, o.tz), timeZone: o.tz, message: s(asked.text), context: {} },
    checks: [],
    answered: answered.join("\n\n"),
  };
}

const chatOf = (v: unknown): ChatLine[] =>
  (Array.isArray(v) ? v : []).flatMap((m): ChatLine[] =>
    m && typeof m === "object" && typeof m.n === "number" && typeof m.at === "number" && (m.who === "you" || m.who === "pako") && typeof m.text === "string"
      ? [{ n: m.n, at: m.at, who: m.who, text: m.text }]
      : []);

function main(argv: string[]): void {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const home = arg("home") ?? ((process.env.PAKO_HOME ?? "").trim() || join(homedir(), ".pako"));
  const tz = arg("tz") ?? "UTC";
  const days = Number(arg("days") ?? 30);
  const get = readStore(home);
  const s = scrubber(namesOf(get));
  const items = feedbackItems(get(FEEDBACK_KEY), Date.now() - days * 24 * 3600_000);
  const chat = chatOf(get(CHAT_KEY));
  const out = fileURLToPath(new URL("./drafts/", import.meta.url));
  const write = (name: string, d: Draft): void => {
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const file = join(out, `${name}.json`);
    writeFileSync(file, `${JSON.stringify(d, null, 2)}\n`, { mode: 0o600 });
    console.log(`Draft: ${file}`);
    console.log("Read every field (placeholders like <person1> stand for names: keep them), finish what says TODO, move it into eval/cases/,");
    console.log(`then run: npm run eval:live -- --case ${name} --k 3`);
  };
  const ref = arg("feedback");
  const n = arg("chat");
  if (ref) {
    const item = items.find((x) => x.ref === ref);
    if (!item) throw new Error(`no 👎 or «Not mine» with ref ${ref} in the last ${days} days (see --list)`);
    const d = feedbackDraft(item, get, s, { tz });
    if (!d) throw new Error("a 👎 on a whole brief names nothing to test: write that case by hand");
    return write(`feedback-${local(item.at, tz).slice(0, 10)}-${item.ref.replace(/[^\w-]/g, "")}`, d);
  }
  if (n) {
    const d = chatDraft(chat, Number(n), s, { tz });
    if (!d) throw new Error(`no message of the owner's numbered ${n} in the chat (see --list)`);
    return write(`chat-${n}`, d);
  }
  console.log(`👎 and «Not mine», last ${days} days:${items.length ? "" : " none"}`);
  for (const x of items) console.log(`  --feedback ${x.ref}  ${local(x.at, tz)}  ${x.why}  ${x.source}: ${s(x.what).slice(0, 90)}`);
  const own = chat.filter((m) => m.who === "you").slice(-15);
  console.log(`\nThe owner's latest chat messages:${own.length ? "" : " none kept"}`);
  for (const m of own) console.log(`  --chat ${m.n}  ${local(m.at, tz)}  ${s(m.text).replace(/\s+/g, " ").slice(0, 90)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
