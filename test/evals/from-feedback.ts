// Feedback to cases (npm run evals:from-feedback): the owner's 👎 and «No es mío» (src/quality.ts, src/followups.ts) as DRAFT golden cases.
//
// Each draft is what Pako did (the loop it made, the to-do the brief wrote) recorded as a known-bad answer ("label": "fail") with what the
// owner said instead as its expectation: no loop for «No es mío», no such to-do for a 👎 on the brief. Names (the people Pako knows, whoever
// a loop names), addresses, phone numbers, links and channels are replaced by placeholders (<person1>, <email1>…) before anything is written.
// Pako never kept the message a loop came from, so the draft says TODO there: the owner writes it again, without personal data, checks the
// case, and moves the file into test/evals/cases/<suite>/ to approve it. Drafts go to .claude/evals/drafts/ (not tracked), nothing else is
// written, and the store is only read (its file, not through Pako): run it with Pako stopped or running, it changes nothing.
//
//   npm run evals:from-feedback [-- --home <PAKO_HOME>] [--tz Europe/Madrid] [--days 30] [--out <folder>]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FOLLOWUPS_KEY, stateOf, type Loop } from "../../src/followups.ts";
import { FEEDBACK_KEY, qualityStateOf } from "../../src/quality.ts";
import { openForeignReadOnly, STORE_FILES } from "../../src/sqlite-kv.ts";
import type { EvalCase } from "./harness.ts";

// ---------- placeholders ----------

const LINK = /\bhttps?:\/\/[^\s<>"')]+/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE = /\+?\d[\d\s().-]{6,20}\d/g;
const CHANNEL = /(^|[\s(«"])#([\w-]{2,80})/g;

export interface Scrubber {
  (text: string): string;
  /** What each placeholder stands for: kept in memory only, never written. */
  readonly seen: Map<string, string>;
}

/**
 * A scrubber that keeps one placeholder per thing across a whole draft: the same person is <person1> in the title, the who and the label.
 * `names`: the people to hide; each part of a name (Marta, García) is hidden too, as the person's own placeholder.
 */
export function scrubber(names: string[]): Scrubber {
  const seen = new Map<string, string>();
  const counts: Record<string, number> = {};
  const holder = (kind: string, key: string): string => {
    const k = `${kind}:${key.toLowerCase()}`;
    if (!seen.has(k)) seen.set(k, `<${kind}${(counts[kind] = (counts[kind] ?? 0) + 1)}>`);
    return seen.get(k)!;
  };
  // Longest first, so "Marta García" is one person before "Marta" alone is looked at.
  const people = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 2))].sort((a, b) => b.length - a.length);
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const f = ((text: string): string => {
    let out = text
      .replace(LINK, (m) => holder("link", m))
      .replace(EMAIL, (m) => holder("email", m))
      .replace(PHONE, (m) => (m.replace(/\D/g, "").length >= 9 ? holder("phone", m.replace(/\D/g, "")) : m))
      .replace(CHANNEL, (_m, pre: string, ch: string) => `${pre}${holder("channel", ch)}`);
    for (const full of people) {
      const p = holder("person", full);
      out = out.replace(new RegExp(`(?<![\\p{L}<])${escape(full)}(?![\\p{L}>])`, "giu"), p);
      for (const part of full.split(/\s+/).filter((w) => w.length >= 3)) {
        out = out.replace(new RegExp(`(?<![\\p{L}<])${escape(part)}(?![\\p{L}>])`, "giu"), p);
      }
    }
    return out;
  }) as Scrubber;
  Object.defineProperty(f, "seen", { value: seen });
  return f;
}

/** One text scrubbed on its own (the placeholders start at 1). */
export const scrub = (text: string, names: string[]): { text: string } => ({ text: scrubber(names)(text) });

// ---------- drafts ----------

export interface Draft {
  /** The file name the draft gets: suite, day, ref. */
  file: string;
  case: EvalCase;
}

const TODO_MSG = "TODO: the message this came from, rewritten without personal data";
const TODO_FACT = "TODO: the fact this to-do came from, rewritten without personal data";
const local = (t: number, tz: string): string =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(t);
const day = (t: number, tz: string): string => local(t, tz).slice(0, 10);

/** The recorded answer that made the loop again: the fields the extraction gives, as Pako stored them. */
function answerOf(l: Loop, s: Scrubber, tz: string): string {
  const check = Object.keys(l.check)[0] ?? "none";
  const zone = l.tz ?? tz;
  return JSON.stringify({
    loops: [{
      kind: l.kind, title: s(l.title), detail: s(l.detail), who: s(l.who), ...(l.dueAt ? { due: local(l.dueAt, zone), tz: zone } : {}), check,
      ...(check === "none" ? { reason: "none" in l.check ? l.check.none.reason : "" } : {}),
    }],
    closes: [],
  });
}

function loopDraft(l: Loop | undefined, what: string, why: string[], at: number, names: string[], tz: string): EvalCase {
  const s = scrubber([...names, ...(l?.who ? [l.who] : [])]);
  const said = l?.whenSaid ?? at;
  const where = l?.where;
  const label = s(where?.label ?? "?");
  const who = s(l?.who || "?");
  const turn = !l || where?.type === "slack_dm" || where?.type === "slack_channel"
    ? { slack: { channel: "D0DRAFT", label, direct: where?.type !== "slack_channel", msgs: [{ at: local(said, tz), who, text: TODO_MSG }] } }
    : { [where?.type === "mail" ? "mail" : "meeting"]: { at: local(said, tz), ref: "draft", label, text: TODO_MSG } };
  const recorded = l
    ? answerOf(l, s, tz)
    : JSON.stringify({ loops: [{ kind: "request_to_owner", title: s(what), detail: "", who: "?", check: "none", reason: "?" }], closes: [] });
  return {
    suite: "followups",
    behaviour: `DRAFT: «${s(what)}» was not for the owner to hear (${why.join(", ")}): no loop`,
    origin: `${why.join(" and ")} on ${day(at, tz)}; placeholders replace personal data. Write the message, check the case, move it to cases/followups/`,
    label: "fail",
    input: { timeZone: tz, lang: "es", turns: [{ ...turn, recorded }] },
    expect: { loops: [] },
  };
}

function briefDraft(what: string, why: string, at: number, names: string[], tz: string): EvalCase {
  const s = scrubber(names);
  const title = s(what);
  return {
    suite: "brief",
    behaviour: `DRAFT: the brief should not have said «${title}» (${why})`,
    origin: `${why} on ${day(at, tz)}; placeholders replace personal data. Write the fact, check the case, move it to cases/brief/`,
    label: "fail",
    input: {
      timeZone: tz, lang: "es", now: `${day(at, tz)} 08:00`, read: ["tasks"],
      facts: [{ id: "L1", kind: "loop", icon: "tasks", label: "TODO", text: TODO_FACT }],
      recorded: JSON.stringify({ opening: "", todos: [{ title, context: "", checked: "", sources: ["L1"] }] }),
    },
    expect: { todos: 0 },
  };
}

/**
 * The drafts from what the store holds: each 👎 on a nudge or a brief item, each «No es mío», once per thing judged; a 👍 is not a failure.
 * `feedback` and `followups` are the stored records (FEEDBACK_KEY, FOLLOWUPS_KEY) as JSON; `people`: names to hide besides the loops' own.
 */
export function draftCases(feedback: unknown, followups: unknown, o: { people?: string[]; timeZone?: string; since?: number } = {}): Draft[] {
  const tz = o.timeZone ?? "Europe/Madrid";
  const since = o.since ?? 0;
  const q = qualityStateOf(feedback);
  const f = stateOf(followups);
  const loops = new Map(f.loops.map((l) => [l.id, l]));
  const names = [...(o.people ?? []), ...f.loops.map((l) => l.who), ...f.rules.map((r) => r.who)].filter(Boolean);
  // One draft per nudge, with every reason it got (a 👎 and a «No es mío» on the same one are one failure).
  const nudges = new Map<string, { what: string; at: number; why: Set<string> }>();
  const mark = (ref: string, what: string, at: number, why: string): void => {
    const n = nudges.get(ref) ?? { what, at, why: new Set<string>() };
    n.why.add(why);
    nudges.set(ref, n);
  };
  for (const n of q.nudges) if (n.outcome === "notmine" && n.at >= since) mark(n.ref, n.what, n.at, "«No es mío»");
  for (const v of q.verdicts) if (v.verdict === "down" && v.source === "nudge" && v.at >= since) mark(v.ref, v.what, v.at, "👎");
  const out: Draft[] = [];
  for (const [ref, n] of nudges) {
    out.push({ file: `followups-${day(n.at, tz)}-${ref}.json`, case: loopDraft(loops.get(ref), n.what, [...n.why], n.at, names, tz) });
  }
  for (const v of q.verdicts) {
    if (v.verdict !== "down" || v.at < since || (v.source !== "brief_todo" && v.source !== "brief_update")) continue;
    const why = v.source === "brief_todo" ? "👎 on a to-do of the brief" : "👎 on an update of the brief";
    out.push({ file: `brief-${day(v.at, tz)}-${v.ref.replace(/[^\w.-]/g, "")}.json`, case: briefDraft(v.what, why, v.at, names, tz) });
  }
  return out;
}

// ---------- the command ----------

/**
 * The Pako folder's store, read, never written: kv.db (SQLite, since 0.3.0; opened read-only, so a running Pako is not disturbed), else an
 * older install's kv.json ({key: {v, exp}}). Entries expired at `now` are left out, as Pako itself would.
 */
export function readStore(home: string, now = Date.now()): (key: string) => unknown {
  const live = (exp: unknown): boolean => !(typeof exp === "number" && exp > 0 && exp < now);
  const raw = new Map<string, string>();
  const db = join(home, STORE_FILES.db);
  if (existsSync(db)) {
    const conn = openForeignReadOnly(db);
    try {
      for (const r of conn.prepare("SELECT k, v, exp FROM kv").all()) {
        if (typeof r.k === "string" && typeof r.v === "string" && live(Number(r.exp))) raw.set(r.k, r.v);
      }
    } finally {
      conn.close();
    }
  } else if (existsSync(join(home, STORE_FILES.legacy))) {
    let data: Record<string, { v?: unknown; exp?: unknown }> = {};
    try {
      data = JSON.parse(readFileSync(join(home, STORE_FILES.legacy), "utf8")) as typeof data;
    } catch (err) {
      throw new Error(`cannot read ${join(home, STORE_FILES.legacy)}: ${(err as Error).message}`);
    }
    for (const [k, e] of Object.entries(data)) if (typeof e?.v === "string" && live(e.exp)) raw.set(k, e.v);
  } else {
    throw new Error(`no Pako store in ${home} (neither ${STORE_FILES.db} nor ${STORE_FILES.legacy}): give the Pako folder with --home`);
  }
  return (key) => {
    const v = raw.get(key);
    try {
      return typeof v === "string" ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  };
}

function main(argv: string[]): void {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const home = arg("home") ?? ((process.env.PAKO_HOME ?? "").trim() || join(homedir(), ".pako"));
  const tz = arg("tz") ?? "Europe/Madrid";
  const days = Number(arg("days") ?? 30);
  const out = arg("out") ?? fileURLToPath(new URL("../../.claude/evals/drafts/", import.meta.url));
  const get = readStore(home);
  const people = (Array.isArray(get("assistant-people")) ? (get("assistant-people") as { name?: unknown }[]) : [])
    .map((p) => (typeof p?.name === "string" ? p.name : "")).filter(Boolean);
  const drafts = draftCases(get(FEEDBACK_KEY), get(FOLLOWUPS_KEY), { people, timeZone: tz, since: Date.now() - days * 24 * 3600_000 });
  if (!drafts.length) {
    console.log(`No 👎 or «No es mío» in the last ${days} days: nothing to draft.`);
    return;
  }
  mkdirSync(out, { recursive: true, mode: 0o700 });
  for (const d of drafts) writeFileSync(join(out, d.file), `${JSON.stringify(d.case, null, 2)}\n`, { mode: 0o600 });
  console.log(`${drafts.length} draft case(s) in ${out}`);
  console.log("Each one: write the message (or fact) without personal data where it says TODO, read every field, then move the file into");
  console.log("test/evals/cases/<suite>/ and run npm run gate. Placeholders like <person1> stand for the names; keep them.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
