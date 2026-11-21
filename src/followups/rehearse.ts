// The rehearsal (src/rehearsal.ts): what an answer WOULD make; nothing kept, nothing sent.

import { candidate, clean, parseAnswer } from "./answer.ts";
import type { Base, Engine, Rehearse } from "./parts.ts";
import { LOOPS_PER_JOB, WHO_MAX } from "./limits.ts";
import { isOpen } from "./record.ts";
import type { DraftInput, DryOutcome, Job, Loop, WouldBe } from "./types.ts";

/** A check as the extraction names it: a slackReply that needs a file or a link is "slackFile". */
const checkName = (c: Loop["check"]): WouldBe["check"] =>
  ("slackReply" in c && c.slackReply.file ? "slackFile" : Object.keys(c)[0]) as WouldBe["check"];

export function mountRehearse(
  { d, now, lang }: Base,
  { read, slackJob, textJob, jobText, keep, ruledOut, runCheck, dueText, sourceText, nudgeText, quietNow }: Pick<
    Engine,
    "read" | "slackJob" | "textJob" | "jobText" | "keep" | "ruledOut" | "runCheck" | "dueText" | "sourceText" | "nudgeText" | "quietNow"
  >,
): Rehearse {
  /** A rehearsal's job: the text a real one would carry, built the same way; nothing kept, nothing queued. */
  const draft = async (o: DraftInput): Promise<{ job: Job; text: string }> => {
    const made = o.source === "slack" ? await slackJob(o) : textJob(o);
    return { job: made.job, text: (await jobText(made.job, made.material, made.people)).slice(0, 16_000) };
  };

  /**
   * What the bridge's answer to a rehearsal's job WOULD make: the same field-by-field reading, rules and merging (on a copy of the record), and
   * each new loop checked now (the checks only read). Null when the answer is not the JSON asked for. Nothing is written, nobody is told.
   */
  const dryAnswer = async (job: Job, raw: string): Promise<DryOutcome | null> => {
    const answer = parseAnswer(raw);
    if (!answer) return null;
    const s = await read();
    const copy = structuredClone(s);
    // On the copy, no source is taken for this job's own (a conversation the real engine read already): a loop it would add to then shows.
    for (const l of copy.loops) l.sources = l.sources.map((x) => (x.ref ? { ...x, ref: `${x.ref}#` } : x));
    const before = new Map(copy.loops.map((l) => [l.id, JSON.stringify(l)]));
    const valid = answer.loops.slice(0, LOOPS_PER_JOB).map((v) => candidate(v, job, d.timeZone)).filter((c) => c !== null);
    // The person's name as the real merge step sees it (keep() renames to the contact's own name before it checks the rules): a "Not mine" rule
    // saved under the contact's name then counts here too, so the rehearsal's "ruled out" number is the one real processing would give.
    for (const c of valid) if (c.who && d.who) c.who = clean(d.who(c.who), WHO_MAX) || c.who;
    keep(copy, job, answer.loops, LOOPS_PER_JOB, false);
    const fresh = copy.loops.filter((l) => !before.has(l.id));
    const merged = copy.loops.filter((l) => before.has(l.id) && before.get(l.id) !== JSON.stringify(l)).map((l) => l.title);
    const closes = answer.closes
      .map((id) => s.loops.find((l) => l.id === id && isOpen(l) && job.source === "slack" && !!job.where.channel && l.where.channel === job.where.channel))
      .filter((l): l is Loop => !!l)
      .map((l) => l.title);
    const lg = lang();
    const t = now();
    const items: WouldBe[] = [];
    for (const l of fresh) {
      const seen = await runCheck(l);
      const outcome: WouldBe["outcome"] = seen.done ? "closed"
        : l.dueAt && t >= l.dueAt ? "past"
        : l.nextCheckAt === 0 ? "silent"
        : seen.replied ? "replied"
        : l.escalated ? "later" : "nudge";
      const speaks = outcome === "nudge" || outcome === "later";
      items.push({
        title: l.title, kind: l.kind, who: l.who, due: dueText(l, lg).replace(/^,\s*/, ""), source: sourceText(l.sources[0], lg),
        check: checkName(l.check), seen: seen.done ? seen.what : seen.said, outcome, checkAt: l.nextCheckAt,
        ...(speaks ? { text: nudgeText(l, seen.said, false, lg), quiet: quietNow(l.nextCheckAt || t) } : {}),
      });
    }
    return { items, merged, closes, ruled: valid.filter((c) => ruledOut(s, c, job)).length };
  };

  return { draft, dryAnswer };
}
