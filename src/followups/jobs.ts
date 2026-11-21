// Extraction jobs: a Slack conversation's new messages gathered into batches, a mail summary or a meeting's outcome, each made into one job
// for the assistant's computer (an inbox job of its own), with the text it carries.

import { lessonsSection } from "../lessons.ts";
import { personSection } from "../person-context.ts";
import { inline, neutralise } from "../quarantine.ts";
import type { Base, Engine, JobsPart } from "./parts.ts";
import { BATCH_MSGS_MAX, jobInboxId, WHO_MAX } from "./limits.ts";
import { CHANNEL, isOpen, newId, TS } from "./record.ts";
import { T } from "./texts.ts";
import type { Batch, FollowupsDoor, Job, SlackSeen, Where } from "./types.ts";
import { createLog } from "../log.ts";

const log = createLog("followups");

/** The lessons an extraction reads: follow-ups said not to be the owner's, reminders that were not useful, follow-ups the owner undid. */
const FOLLOWUP_LESSONS = ["follow-up", "follow-up reminder", "follow-up kept", "follow-up closed"] as const;

export function mountJobs({ d, now, lang }: Base, { mutate, read, stamp }: Pick<Engine, "mutate" | "read" | "stamp">): JobsPart {
  /**
   * The text a job carries: now, the language, the source, the rules taught, what the owner's memory says of its people (`people`: their
   * names, Slack ids or addresses), what is open in that conversation, and its material.
   */
  const jobText = async (job: Job, material: string[], people: string[] = []): Promise<string> => {
    const l = lang();
    const t = T(l);
    const s = await read();
    const rules = s.rules.slice(-15).map((r) => t("rule", { who: r.who || "?", where: r.where || "?", title: r.title }));
    // What is already open in this conversation: the run can say a new message closes one, or repeats one, instead of making another.
    // An email thread's are its own: a reply in it can close or move what an earlier email of the thread asked.
    const mine = job.where.channel
      ? s.loops.filter((x) => isOpen(x) && x.where.channel === job.where.channel).slice(-8)
      : job.where.mailThread ? s.loops.filter((x) => isOpen(x) && x.where.mailThread === job.where.mailThread).slice(-8) : [];
    const openLines = mine.map((x) => inline(t("openLine", { id: x.id, title: x.title, who: x.who || "?" }), 300));
    const code = d.ownerLanguage ? await d.ownerLanguage().catch(() => l) : l;
    // What the owner corrected before (src/lessons.ts), this person's and this conversation's first: Pako's own records, never the material's.
    const learned = d.lessons
      ? await d.lessons.lines({ kinds: ["not_mine", "wrong", "undo"], about: FOLLOWUP_LESSONS, where: job.where.label, ...(job.where.channel ? { channel: job.where.channel } : {}) })
        .catch(() => [])
      : [];
    // Who these people are to the owner, what was last agreed and what is open with them (src/person-context.ts): so "is this mine?" and
    // "who is this?" are read with what the owner already knows. Pako's own records, neutralised; never the material's words.
    const known = d.people && people.length ? await d.people(people).catch(() => []) : [];
    return [
      // With its weekday: "Friday" is worked out from it, never from a bare date.
      t("now", { now: `${stamp(now(), d.timeZone)}, ${new Intl.DateTimeFormat("en-US", { timeZone: d.timeZone, weekday: "long" }).format(now())}`, tz: d.timeZone }),
      t("lang", { code: code || l }),
      ...(d.ownerName?.() ? [t("owner", { name: inline(d.ownerName(), 60) })] : []),
      t("from", { source: inline(job.label, 120) }),
      ...(rules.length ? ["", t("rulesHead"), ...rules.map((r) => inline(r, 300))] : []),
      ...lessonsSection(learned),
      ...personSection(known),
      ...(openLines.length ? ["", t("openHead"), ...openLines] : []),
      "",
      ...material,
    ].join("\n");
  };

  /**
   * A job into the inbox: "queued", "refused" (the inbox said no: it will not answer, so the job does not hold its conversation's next one)
   * or "failed" (an error: the inbox may or may not have it). `again`: this id may have reached the inbox before a restart; the inbox then
   * refuses it as seen, which means it is there.
   */
  const queueJob = async (job: Job, material: string[], people: string[] = [], again = false): Promise<"queued" | "refused" | "failed"> => {
    const text = await jobText(job, material, people);
    await mutate((st) => {
      st.jobs = [...st.jobs.filter((j) => j.id !== job.id), job];
    });
    // A chat promise is kept at once (fromChat), never a job: "chat" never reaches here, and an older bridge knows only the other three.
    const source = job.source === "chat" ? "slack" : job.source;
    const out = await d.enqueue({ id: jobInboxId(job.id), at: now(), text: "", followup: { source, label: job.label, text: text.slice(0, 16_000) } })
      .then((ok) => (ok || again ? "queued" as const : "refused" as const))
      .catch((err: Error) => (log.error(`could not queue a job: ${err.message}`), "failed" as const));
    if (out !== "queued") await mutate((st) => void (st.jobs = st.jobs.filter((j) => j.id !== job.id)));
    else d.audit?.queued(job, material, people);
    return out;
  };
  const enqueueJob = async (job: Job, material: string[], people: string[] = []): Promise<boolean> => (await queueJob(job, material, people)) === "queued";

  /** A conversation's new messages, with its last ones (the owner's replies too) when Slack can be read, as a job's material, and that job. */
  const slackJob = async (b: Pick<Batch, "channel" | "thread" | "where" | "msgs">): Promise<{ job: Job; material: string[]; people: string[] }> => {
    const l = lang();
    const t = T(l);
    const newTs = new Set(b.msgs.map((m) => m.ts));
    let lines: string[] = [];
    const authors: string[] = [];
    if (d.slackHistory && CHANNEL.test(b.channel)) {
      try {
        const hist = await d.slackHistory(b.channel, { limit: 15, ...(b.thread ? { thread: b.thread } : {}) });
        for (const m of [...hist].reverse()) if (!m.mine) authors.push(m.who);
        lines = hist.map((m) => `${newTs.has(m.ts) ? "* " : ""}[${stamp(m.at, d.timeZone)}] ${m.mine ? t("me") : inline(m.who, WHO_MAX)}: ${inline(m.text, 600)}`);
      } catch (err) {
        log.error(`could not read the Slack conversation: ${(err as Error).message}`);
      }
    }
    // Without the history (or when it does not hold them yet), the new messages themselves.
    for (const m of b.msgs) {
      if (!lines.some((x) => x.startsWith(`* [${stamp(m.at, d.timeZone)}]`) && x.includes(inline(m.text, 600).slice(0, 40)))) {
        lines.push(`* [${stamp(m.at, d.timeZone)}] ${m.mine ? t("me") : inline(m.who, WHO_MAX)}: ${inline(m.text, 600)}`);
      }
    }
    const last = b.msgs[b.msgs.length - 1]!;
    const job: Job = {
      id: newId(), at: now(), source: "slack", where: b.where, whenSaid: last.at, label: b.where.label, afterTs: last.ts, ref: last.ts,
    };
    // Its people: the authors of the new messages first, then the others who spoke there lately (never the owner).
    const people = [...new Set([...b.msgs.filter((m) => !m.mine).map((m) => m.who), ...authors])].filter(Boolean).slice(0, 8);
    return { job, material: [t("conversation"), ...lines.slice(-25)], people };
  };

  /**
   * A conversation's batch is due: it becomes one job, named in the store first (its claim, set by the tick). The batch stays in the store
   * until that job is queued: a restart meanwhile queues it again under the same id (`again`), never lost and never twice. A job the inbox
   * refused lets its claim go, and the next tick tries again; messages that came meanwhile wait for the next job.
   */
  const flushBatch = async (b: Batch, again = false): Promise<boolean> => {
    const claim = b.claim ?? { id: newId(), keys: b.msgs.map((m) => m.ts) };
    const msgs = b.msgs.filter((m) => claim.keys.includes(m.ts));
    const out = !msgs.length ? "refused" as const : await (async () => {
      const { job, material, people } = await slackJob({ ...b, msgs });
      return queueJob({ ...job, id: claim.id }, material, people, again);
    })().catch((err: Error) => (log.error(`could not queue a Slack conversation: ${err.message}`), "failed" as const));
    await mutate((s) => {
      const x = s.batches.find((y) => y.channel === b.channel && y.thread === b.thread);
      // Gone from the store meanwhile (its cap): one not queued goes back.
      if (!x) {
        const { claim: _, ...rest } = b;
        if (out !== "queued") s.batches.push(out === "failed" ? { ...rest, claim } : rest);
        return;
      }
      if (x.claim?.id !== claim.id) return;
      if (out === "failed") return;
      delete x.claim;
      if (out === "refused") return;
      x.msgs = x.msgs.filter((m) => !claim.keys.includes(m.ts));
      if (!x.msgs.length) s.batches = s.batches.filter((y) => y !== x);
      else x.firstAt = now();
    });
    return out === "queued";
  };

  /** A Slack message kept for the owner: added to its conversation's batch (a few minutes, then one job). */
  const observeSlack = (m: SlackSeen): Promise<void> =>
    mutate((s) => {
      if (!CHANNEL.test(m.channel) || !TS.test(m.ts)) return;
      const thread = m.thread && TS.test(m.thread) ? m.thread : undefined;
      let b = s.batches.find((x) => x.channel === m.channel && x.thread === thread);
      if (!b) {
        const where: Where = { type: m.direct ? "slack_dm" : "slack_channel", label: m.where.slice(0, 120), channel: m.channel, ...(thread ? { thread } : {}) };
        b = { channel: m.channel, ...(thread ? { thread } : {}), where, firstAt: now(), msgs: [] };
        s.batches.push(b);
      }
      // A conversation the owner opened is named again by the first message of the other side, which says who it is with.
      if (!m.mine && b.msgs.length && b.msgs.every((x) => x.mine)) b.where.label = m.where.slice(0, 120);
      if (!b.msgs.some((x) => x.ts === m.ts)) b.msgs.push({ ts: m.ts, at: m.at, who: m.who.slice(0, WHO_MAX), text: m.text.slice(0, 600), ...(m.mine ? { mine: true } : {}) });
      b.msgs = b.msgs.slice(-BATCH_MSGS_MAX);
    }).catch((err: Error) => log.error(`could not keep a Slack message: ${err.message}`));

  /** The job a mail summary or a meeting's outcome makes, and its material. */
  const textJob = (
    o: { source: "mail" | "meeting"; ref: string; label: string; text: string; at?: number; closed?: boolean; people?: string[] },
  ): { job: Job; material: string[]; people: string[] } => {
    const t = T(lang());
    const at = o.at ?? now();
    const job: Job = {
      id: newId(), at: now(), source: o.source, where: { type: o.source === "mail" ? "mail" : "zoom_meeting", label: o.label.slice(0, 120) || o.source },
      whenSaid: at, label: o.label.slice(0, 120) || o.source, ref: o.ref.slice(0, 200), ...(o.closed ? { closed: true } : {}),
    };
    return { job, material: [t("material"), neutralise(o.text.trim(), { max: 6000 })], people: (o.people ?? []).slice(0, 8) };
  };

  /** A mail summary or a meeting's outcome: one job at once (no batching). */
  const offer: FollowupsDoor["offer"] = async (o) => {
    const text = (o.text ?? "").trim();
    if (!text) return false;
    const { job, material, people } = textJob(o);
    try {
      return await enqueueJob(job, material, people);
    } catch (err) {
      log.error(`could not queue a ${o.source}: ${(err as Error).message}`);
      return false;
    }
  };

  return { jobText, enqueueJob, queueJob, slackJob, flushBatch, observeSlack, textJob, offer };
}
