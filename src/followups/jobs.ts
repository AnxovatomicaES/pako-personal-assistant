// Extraction jobs: a Slack conversation's new messages gathered into batches, a mail summary or a meeting's outcome, each made into one job
// for the assistant's computer (an inbox job of its own), with the text it carries.

import { inline, neutralise } from "../quarantine.ts";
import type { Engine } from "./parts.ts";
import { BATCH_MSGS_MAX, jobInboxId, WHO_MAX } from "./limits.ts";
import { CHANNEL, isOpen, newId, TS } from "./record.ts";
import { T } from "./texts.ts";
import type { Batch, FollowupsDoor, Job, SlackSeen, Where } from "./types.ts";
import { createLog } from "../log.ts";

const log = createLog("followups");

export function mountJobs(fu: Engine): Pick<Engine, "jobText" | "enqueueJob" | "slackJob" | "flushBatch" | "observeSlack" | "textJob" | "offer"> {
  const { d, now, lang, mutate, read, stamp } = fu;
  /** The text a job carries: now, the language, the source, the rules taught, what is open in that conversation, and its material. */
  const jobText = async (job: Job, material: string[]): Promise<string> => {
    const l = lang();
    const t = T(l);
    const s = await read();
    const rules = s.rules.slice(-15).map((r) => t("rule", { who: r.who || "?", where: r.where || "?", title: r.title }));
    // What is already open in this conversation: the run can say a new message closes one, or repeats one, instead of making another.
    const mine = job.where.channel ? s.loops.filter((x) => isOpen(x) && x.where.channel === job.where.channel).slice(-8) : [];
    const openLines = mine.map((x) => inline(t("openLine", { id: x.id, title: x.title, who: x.who || "?" }), 300));
    const code = d.ownerLanguage ? await d.ownerLanguage().catch(() => l) : l;
    return [
      t("now", { now: stamp(now(), d.timeZone), tz: d.timeZone }),
      t("lang", { code: code || l }),
      ...(d.ownerName?.() ? [t("owner", { name: inline(d.ownerName(), 60) })] : []),
      t("from", { source: inline(job.label, 120) }),
      ...(rules.length ? ["", t("rulesHead"), ...rules.map((r) => inline(r, 300))] : []),
      ...(openLines.length ? ["", t("openHead"), ...openLines] : []),
      "",
      ...material,
    ].join("\n");
  };

  const enqueueJob = async (job: Job, material: string[]): Promise<boolean> => {
    const text = await jobText(job, material);
    await mutate((st) => {
      st.jobs.push(job);
    });
    // A chat promise is kept at once (fromChat), never a job: "chat" never reaches here, and an older bridge knows only the other three.
    const source = job.source === "chat" ? "slack" : job.source;
    const ok = await d.enqueue({ id: jobInboxId(job.id), at: now(), text: "", followup: { source, label: job.label, text: text.slice(0, 16_000) } });
    // Never queued: no answer will come, so the job does not hold its conversation's next one.
    if (!ok) await mutate((st) => void (st.jobs = st.jobs.filter((j) => j.id !== job.id)));
    return ok;
  };

  /** A conversation's new messages, with its last ones (the owner's replies too) when Slack can be read, as a job's material, and that job. */
  const slackJob = async (b: Pick<Batch, "channel" | "thread" | "where" | "msgs">): Promise<{ job: Job; material: string[] }> => {
    const l = lang();
    const t = T(l);
    const newTs = new Set(b.msgs.map((m) => m.ts));
    let lines: string[] = [];
    if (d.slackHistory && CHANNEL.test(b.channel)) {
      try {
        const hist = await d.slackHistory(b.channel, { limit: 15, ...(b.thread ? { thread: b.thread } : {}) });
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
    return { job, material: [t("conversation"), ...lines.slice(-25)] };
  };

  /** A conversation's batch is due: it becomes one job. */
  const flushBatch = async (b: Batch): Promise<void> => {
    const { job, material } = await slackJob(b);
    await enqueueJob(job, material);
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
  const textJob = (o: { source: "mail" | "meeting"; ref: string; label: string; text: string; at?: number; closed?: boolean }): { job: Job; material: string[] } => {
    const t = T(lang());
    const at = o.at ?? now();
    const job: Job = {
      id: newId(), at: now(), source: o.source, where: { type: o.source === "mail" ? "mail" : "zoom_meeting", label: o.label.slice(0, 120) || o.source },
      whenSaid: at, label: o.label.slice(0, 120) || o.source, ref: o.ref.slice(0, 200), ...(o.closed ? { closed: true } : {}),
    };
    return { job, material: [t("material"), neutralise(o.text.trim(), { max: 6000 })] };
  };

  /** A mail summary or a meeting's outcome: one job at once (no batching). */
  const offer: FollowupsDoor["offer"] = async (o) => {
    const text = (o.text ?? "").trim();
    if (!text) return false;
    const { job, material } = textJob(o);
    try {
      return await enqueueJob(job, material);
    } catch (err) {
      log.error(`could not queue a ${o.source}: ${(err as Error).message}`);
      return false;
    }
  };

  return { jobText, enqueueJob, slackJob, flushBatch, observeSlack, textJob, offer };
}
