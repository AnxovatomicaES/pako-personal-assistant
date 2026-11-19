// The eval harness in the gate (test/evals/harness.ts; docs/testing.md, "How Pako's quality is measured"): every golden case under test/evals/cases,
// with the model's answer recorded in the case, judged by code against the validators and decisions the server runs. No Claude, no network.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { briefMaterial } from "../src/brief-v2.ts";
import { clockTimes } from "../src/brief-support.ts";
import { zonedTime } from "../src/followups.ts";
import { draftCases, scrub } from "./evals/from-feedback.ts";
import { inventedNames, loadCases, samePerson, MODEL_SUITES, recordedAnswer, runCase, SUITES, type EvalCase } from "./evals/harness.ts";
import { estimate, liveCases, options as liveOptions } from "./evals/live.ts";
import { compare, outcomes, previousReport, readOutcomes, weeklyLines } from "./evals/weekly.ts";

const cases = loadCases();
const briefOf = (g: Parameters<typeof briefMaterial>[0], c: EvalCase) => {
  const tz = typeof c.input.timeZone === "string" ? c.input.timeZone : "Europe/Madrid";
  // input.lang is the owner's own language (what Claude writes in); Pako's fixed words are English for every owner.
  const ownerLanguage = typeof c.input.lang === "string" && c.input.lang ? c.input.lang : "en";
  return briefMaterial(g, { now: zonedTime(c.input.now, tz) ?? 0, timeZone: tz, lang: "en", ownerLanguage, name: "" });
};

for (const c of cases) {
  const name = `${c.suite}: ${c.behaviour}${c.label === "fail" ? " (a known-bad answer, caught)" : ""}`;
  test(name, async () => {
    const r = await runCase(c, recordedAnswer, { briefMaterial: briefOf });
    const failed = r.checks.filter((x) => !x.pass).map((x) => `${x.name}${x.detail ? `: ${x.detail}` : ""}`);
    if (c.label === "fail") assert.ok(failed.length > 0, `${c.file}: the judges let a known-bad answer through`);
    else assert.deepEqual(failed, [], `${c.file}`);
  });
}

test("the golden set: every suite has cases, and every suite with a model step has a known-bad answer its judges catch", () => {
  for (const s of SUITES) assert.ok(cases.filter((c) => c.suite === s).length >= 3, `at least 3 cases in ${s}`);
  for (const s of MODEL_SUITES) assert.ok(cases.some((c) => c.suite === s && c.label === "fail"), `a known-bad case in ${s}`);
  assert.ok(cases.length >= 40, `at least 40 cases (${cases.length})`);
});

test("the golden set holds no personal data: no real addresses or phone numbers, only example domains", () => {
  for (const c of cases) {
    const text = JSON.stringify(c);
    for (const m of text.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g)) {
      assert.match(m[1]!, /(^|\.)(example\.(com|org|net)|example|test|invalid)$/, `${c.file}: ${m[0]} is not an example address`);
    }
  }
});

test("a broken golden file fails loudly: a case in the wrong folder or without its parts is an error, not a skipped case", () => {
  const dir = mkdtempSync(join(tmpdir(), "pako-evals-"));
  try {
    mkdirSync(join(dir, "brief"));
    writeFileSync(join(dir, "brief", "x.json"), JSON.stringify({ suite: "intents", behaviour: "x", input: {}, expect: {} }));
    assert.throws(() => loadCases(pathToFileURL(`${dir}/`)), /suite must be "brief"/);
    writeFileSync(join(dir, "brief", "x.json"), JSON.stringify({ suite: "brief", input: {}, expect: {} }));
    assert.throws(() => loadCases(pathToFileURL(`${dir}/`)), /needs behaviour/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the invented-people judge: a name the material never had is caught; days, months, sentence starts and known names are not", () => {
  const material = "L1 · Ravi pidió montar la reunión con Laura y Tom el lunes 16 de noviembre.";
  assert.deepEqual(inventedNames("Monta la reunión con Laura y Tom. El lunes hablas con Ravi.", material), []);
  assert.deepEqual(inventedNames("Monta la reunión con Laura, Tom y Gregorio.", material), ["Gregorio"]);
  assert.deepEqual(inventedNames("Hoy, Madrid: Ravi espera el lunes de noviembre.", material), []);
});

test("the invented-people judge, its false positive fixed: UI and label words are not people, an invented name still is", () => {
  const material = "L1 · Ana asked by email for the signed NDA by Wednesday.";
  // A mailbox's and Pako's own words, capitalised mid-sentence: the owner's real false positive was «Sent».
  for (const line of [
    "Pako can't see your Sent folder, so check it before you chase Ana.",
    "Ana's email sits under Needs you; you pressed Not mine on a similar one.",
    "Look in Drafts or the Inbox for the NDA Ana asked about on Wed 18 Nov.",
    "The NDA for Ana is due Wed, Sept is far off, and the Standup moved to 09:30 IST.",
  ]) assert.deepEqual(inventedNames(line, material), [], line);
  // A fact's label is Pako's own words: a word it gives ("Receipts · Billing") is known even when no fact's text repeats it.
  assert.deepEqual(inventedNames("Ana's NDA came in, and Billing confirmed it.", material), ["Billing"], "without the labels it is unknown");
  assert.deepEqual(inventedNames("Ana's NDA came in, and Billing confirmed it.", material, "Email · Receipts · Billing"), []);
  // The other direction: a real invented name is still caught beside every one of those words, and a common first name is never a UI word.
  assert.deepEqual(inventedNames("Check your Sent folder, then ask Gregorio about the NDA.", material, "Email · Sent"), ["Gregorio"]);
  assert.deepEqual(inventedNames("Ana and Grace both want the NDA; ask Mark and Will.", material), ["Grace", "Mark", "Will"]);
  assert.deepEqual(inventedNames("Forward it to Priyanka under Needs you.", material), ["Priyanka"]);
  // The UI words are never a zone: "10:00 Standup" stays the owner's own time.
  assert.deepEqual(clockTimes("10:00 Standup, 11:00 Sent, 16:30 Hong Kong", "Madrid"), { bare: [600, 660], ampm: [], zoned: [990] });
});

test("live mode: the cost is shown before running and the cap stops a run that would cost more", () => {
  const live = cases.filter((c) => MODEL_SUITES.includes(c.suite) && c.label !== "fail");
  const e = estimate(live, 3);
  assert.ok(e.runs >= live.length * 3, "every model step k times");
  assert.ok(e.usd > 0);
  assert.equal(estimate(live, 1).runs * 3, e.runs, "k multiplies the runs");
  const once = liveCases(cases);
  assert.ok(once.some((c) => c.file === "followups/meeting-5-15-et.json"));
  assert.ok(!once.some((c) => c.file === "followups/meeting-5-15-et-read-as-madrid.json"), "a known-bad answer beside the good one: its input runs once");
  assert.ok(!once.some((c) => c.suite === "intents" || c.suite === "redflags"), "code-only suites never call Claude");
});

test("feedback to cases: 👎 and «No es mío» become draft cases with names, addresses, numbers and links replaced by placeholders", async () => {
  const T = Date.parse("2026-11-16T09:00:00Z");
  const feedback = {
    verdicts: [
      { what: "Llamar a Marta García (+34 611 222 333)", verdict: "down", at: T, source: "nudge", ref: "a1b2c3d4e5" },
      { what: "brief del lunes", verdict: "up", at: T, source: "brief", ref: "0000000000" },
      { what: "Revisar la propuesta de Jorge", verdict: "down", at: T, source: "brief_todo", ref: "0123456789.t1" },
    ],
    nudges: [{ at: T, ref: "f0f0f0f0f0", what: "Mandar a jorge.ruiz@empresa.es el contrato", outcome: "notmine" }],
  };
  const followups = {
    loops: [
      {
        id: "f0f0f0f0f0", kind: "request_to_owner", title: "Mandar a jorge.ruiz@empresa.es el contrato", detail: "Jorge Ruiz lo pidió en #ventas.",
        who: "Jorge Ruiz", where: { type: "slack_channel", label: "#ventas", channel: "C123" }, whenSaid: T, check: { none: "email" }, status: "dismissed",
        nextCheckAt: 0, nudges: 1, createdAt: T, sources: [{ kind: "slack", label: "Slack · Jorge Ruiz (#ventas)", at: T }],
      },
    ],
    rules: [{ at: T, who: "Jorge Ruiz", where: "#ventas", title: "Mandar a jorge.ruiz@empresa.es el contrato" }],
  };
  const drafts = draftCases(feedback, followups, { people: ["Marta García"] });
  assert.equal(drafts.length, 3, "two 👎 and one «No es mío»; a 👍 is not a failure");
  const text = JSON.stringify(drafts);
  for (const secret of ["Marta", "García", "611", "jorge", "Jorge", "empresa.es", "Ruiz"]) assert.ok(!text.includes(secret), `${secret} is replaced`);
  const notMine = drafts.find((d) => d.case.origin?.includes("No es mío"))!;
  assert.equal(notMine.case.suite, "followups");
  assert.equal(notMine.case.label, "fail", "what Pako did is the recorded known-bad answer");
  assert.deepEqual(notMine.case.expect, { loops: [] }, "what was not the owner's: no loop expected");
  assert.match(notMine.case.behaviour, /DRAFT/);
  // Approved as it is, each draft holds in the gate: the judges catch what the owner said was wrong.
  for (const d of drafts) {
    const r = await runCase({ ...d.case, file: d.file }, recordedAnswer, { briefMaterial: briefOf });
    assert.ok(r.checks.some((x) => !x.pass), `${d.file}: the judges catch it`);
  }
  assert.match(scrub("Escribe a ana@x.es o al 600 111 222, mira https://a.b/c", ["Ana"]).text, /^Escribe a <email1> o al <phone1>, mira <link1>$/);
});

test("the weekly run: one line per case, read back, and a case that passed last week and fails now is a regression", () => {
  const live = liveCases(cases);
  assert.ok(live.length >= 100, `about 100 live-capable cases (${live.length})`);
  const [a, b, c, d] = live;
  const o = { ...liveOptions(["--max-usd", "5"]), k: 1 };
  const run = { rows: [{ c: a!, passed: 1, ran: 1, fails: [] }, { c: b!, passed: 0, ran: 1, fails: ["run 1: x"] }, { c: c!, passed: 1, ran: 1, fails: [] }],
    spent: 0.4, stopped: true };
  const now = outcomes(run, [a!, b!, c!, d!].map((x) => x.file!), 1);
  assert.deepEqual([...now.values()], ["PASS", "FAIL", "PASS", "NOT RUN"], "the cap left the last one not run: never a regression");
  const text = weeklyLines(run, [a!, b!, c!, d!], o, "2026-11-26", now, null).join("\n");
  assert.deepEqual(readOutcomes(text), now, "the report's case lines read back as they were");
  const before = new Map([[a!.file!, "PASS"], [b!.file!, "PASS"], [c!.file!, "FAIL"]] as const);
  assert.deepEqual(compare(before, now), { regressions: [b!.file!], fixed: [c!.file!], added: [d!.file!] });
  const dir = mkdtempSync(join(tmpdir(), "pako-weekly-"));
  try {
    assert.equal(previousReport(dir, "2026-11-26"), null);
    for (const f of ["weekly-2026-11-12.md", "weekly-2026-11-19.md", "weekly-2026-11-26.md", "2026-11-25.md"]) writeFileSync(join(dir, f), "");
    assert.equal(previousReport(dir, "2026-11-26"), join(dir, "weekly-2026-11-19.md"), "the latest earlier weekly report, never today's or a live run's");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the loop's person: the expected first name with a surname is the same person; another name never is", () => {
  assert.ok(samePerson("Owen Hart", "Owen") && samePerson("Owen", "Owen") && samePerson("lucía ferrer", "Lucía"));
  assert.ok(!samePerson("Owena Hart", "Owen") && !samePerson("Hart Owen", "Owen") && !samePerson("Ravi", "Owen"));
  assert.ok(!samePerson("Owen", "Owen Hart"), "a full name expected needs the full name");
});
