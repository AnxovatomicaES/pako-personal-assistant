// The gentle suite (src/gentle.ts, src/gentle-dump.ts): a brain dump sorted by the chat turn, a first tiny step written by its isolated run,
// and the tone of a gentle nudge carrying that step. Each judged by the server's own code: the dump through dumpItemsOf and ownItems, the
// step through parseStep (short, concrete, supported), the nudge through the no-shame scan. Live, a rubric judges the tone last.
//
//   input.kind "dump":  { now, timeZone, message, recorded }              expect { kinds: {reminder, promise, task, note}, remindAt?, who?, maxReplyChars? }
//   input.kind "step":  { loop: {...}, people?: [{name, text}], recorded }  expect { mentions?: [words, one of them], maxWords? }
//   input.kind "nudge": { loop: {...}, recorded }                         expect { asks: true }
//   input.kind "checkin": { now, timeZone, message, recorded }           expect { at: "YYYY-MM-DD HH:MM", mentions?: [words, one of them], maxReplyChars? }
//
// A check-in ("check on me at 3", "ping me in 20 min if I haven't started") is read like the server reads it (checkinItemsOf, checkinTime):
// one, at the right minute in the owner's zone, whether the model wrote the time or the minutes.

import { parseReply } from "../../assistant/bridge.ts";
import { dumpItemsOf, ownItems, type DumpKind } from "../../src/gentle-dump.ts";
import { checkinItemsOf, checkinTime } from "../../src/gentle-checkins.ts";
import { zonedTime } from "../../src/followups.ts";
import { gentleNudgeText, parseStep, shameIn, stepFacts, stepMaterial } from "../../src/gentle.ts";
import type { Loop } from "../../src/followups.ts";
import type { PersonBlock } from "../../src/person-context.ts";
import type { Answer, Check, EvalCase } from "./harness.ts";

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const asStr = (v: unknown): string => (typeof v === "string" ? v : "");
const check = (name: string, pass: boolean, detail?: string): Check => ({ name, pass, ...(pass || !detail ? {} : { detail }) });

export interface GentleRun {
  raw: string;
  material: string;
  output: string;
  checks: Check[];
}

/** A case's loop, with what a stored one always has. */
const loopOf = (v: unknown): Loop => {
  const o = asObj(v);
  return {
    id: "a1b2c3d4e5", kind: (asStr(o.kind) || "owner_promise") as Loop["kind"], title: asStr(o.title), detail: asStr(o.detail), who: asStr(o.who),
    where: { type: "slack_dm", label: asStr(o.where) || "Slack" }, whenSaid: 0, check: { none: { reason: "chat" } }, status: "open", nextCheckAt: 0,
    nudges: 1, createdAt: 0, sources: [], ...(asStr(o.lastCheck) ? { lastCheck: asStr(o.lastCheck) } : {}),
  };
};
const peopleOf = (v: unknown): PersonBlock[] =>
  (Array.isArray(v) ? v : []).map(asObj).map((p) => ({ name: asStr(p.name), text: asStr(p.text) }) as unknown as PersonBlock);

/** The chat's prompt for a dump, as the bridge's context lines start it, then the owner's words. */
export const dumpPrompt = (c: EvalCase): string =>
  [`[Now: ${asStr(c.input.now) || "2026-11-18 09:00"} (${asStr(c.input.timeZone) || "Europe/London"}).]`, "[Friends you can propose a call to: none.]", "",
    asStr(c.input.message)].join("\n");

export async function runGentle(c: EvalCase, answer: Answer): Promise<GentleRun> {
  const kind = asStr(c.input.kind);
  const recorded = typeof c.input.recorded === "string" ? c.input.recorded : undefined;
  const e = c.expect;
  if (kind === "dump") {
    const material = dumpPrompt(c);
    const raw = await answer({ system: "chat", text: material, recorded });
    const reply = parseReply(raw);
    const items = dumpItemsOf(reply.dump ?? []);
    const { dropped } = ownItems(items, [asStr(c.input.message)]);
    const checks: Check[] = [check("dumped", items.length > 0, "no <dump> item")];
    const want = asObj(e.kinds);
    for (const k of ["reminder", "promise", "task", "note"] as DumpKind[]) {
      if (typeof want[k] !== "number") continue;
      const n = items.filter((x) => x.kind === k).length;
      checks.push(check(`${k}s`, n === want[k], `${n} ${k}(s), wanted ${want[k]}: ${JSON.stringify(items)}`));
    }
    for (const at of Array.isArray(e.remindAt) ? e.remindAt.map(asStr) : []) {
      checks.push(check(`reminder at ${at}`, items.some((x) => x.kind === "reminder" && x.at === at), JSON.stringify(items.filter((x) => x.kind === "reminder"))));
    }
    if (asStr(e.who)) checks.push(check(`promise to ${asStr(e.who)}`, items.some((x) => x.kind === "promise" && (x.who ?? "").includes(asStr(e.who)))));
    checks.push(check("only the owner's words", !dropped.length, `not said by the owner: ${dropped.map((x) => x.text).join("; ")}`));
    checks.push(check("no other action", !reply.call && !reply.message && !reply.email && !reply.send && !reply.book, "a call, message, email or booking"));
    if (typeof e.maxReplyChars === "number") checks.push(check("short reply", reply.text.length <= e.maxReplyChars, `${reply.text.length} characters`));
    checks.push(check("no shame in the reply", !shameIn(reply.text).length, shameIn(reply.text).join(", ")));
    return { raw, material, output: `${reply.text}\n${JSON.stringify(items)}`, checks };
  }
  if (kind === "checkin") {
    const material = dumpPrompt(c);
    const raw = await answer({ system: "chat", text: material, recorded });
    const reply = parseReply(raw);
    const tz = asStr(c.input.timeZone) || "Europe/London";
    const now = zonedTime((asStr(c.input.now) || "2026-11-18 09:00").replace(/^[A-Za-z]+ /, ""), tz) ?? 0;
    const items = checkinItemsOf(reply.checkins ?? []);
    const checks: Check[] = [check("one check-in", items.length === 1, `${items.length} check-ins: ${JSON.stringify(reply.checkins ?? [])}`)];
    const when = items[0] ? checkinTime(items[0], now, tz) : null;
    const want = zonedTime(asStr(e.at), tz);
    checks.push(check(`at ${asStr(e.at)}`, when !== null && want !== null && Math.abs(when - want) <= 60_000,
      when === null ? "no time" : `at ${new Date(when).toISOString()}, wanted ${want === null ? "?" : new Date(want).toISOString()}`));
    const mentions = Array.isArray(e.mentions) ? e.mentions.map(asStr) : [];
    if (mentions.length) {
      const thing = (items[0]?.thing ?? "").toLowerCase();
      checks.push(check("names the thing", mentions.some((m) => thing.includes(m.toLowerCase())), `“${thing}”`));
    }
    checks.push(check("no reminder instead", !reply.remind.length, JSON.stringify(reply.remind)));
    checks.push(check("no other action", !reply.call && !reply.message && !reply.email && !reply.send && !reply.book, "a call, message, email or booking"));
    if (typeof e.maxReplyChars === "number") checks.push(check("short reply", reply.text.length <= e.maxReplyChars, `${reply.text.length} characters`));
    checks.push(check("no shame in the reply", !shameIn(reply.text).length, shameIn(reply.text).join(", ")));
    return { raw, material, output: `${reply.text}\n${JSON.stringify(items)}`, checks };
  }
  const loop = loopOf(c.input.loop);
  const people = peopleOf(c.input.people);
  const material = stepMaterial(loop, { people, ownerLanguage: asStr(c.input.lang) || "en" });
  const raw = await answer({ system: "step", text: material, recorded });
  const step = parseStep(raw, stepFacts(loop, people));
  const checks: Check[] = [check("a step that checks out", step !== null, `refused by parseStep: ${raw.slice(0, 200)}`)];
  const words = (step ?? "").split(/\s+/).filter(Boolean).length;
  checks.push(check("short", words > 0 && words <= (typeof e.maxWords === "number" ? e.maxWords : 20), `${words} words`));
  const mentions = Array.isArray(e.mentions) ? e.mentions.map(asStr) : [];
  if (mentions.length) checks.push(check("names this item", mentions.some((m) => (step ?? "").toLowerCase().includes(m.toLowerCase())), `none of ${mentions.join(", ")}`));
  if (kind === "nudge") {
    const body = gentleNudgeText(loop, { variant: 2, due: "", checked: loop.lastCheck ?? "", source: loop.where.label, ...(step ? { step } : {}) });
    checks.push(check("no shame in the nudge", !shameIn(body).length, shameIn(body).join(", ")));
    if (e.asks === true) checks.push(check("asks whether it happened", /\?/.test(body.split("\n")[0]!)));
    return { raw, material, output: body, checks };
  }
  return { raw, material, output: step ?? raw, checks };
}
