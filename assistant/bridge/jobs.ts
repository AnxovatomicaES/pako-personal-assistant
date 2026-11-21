// The server's background jobs (follow-ups, proactive checks, the judge of dated facts, the written brief): isolated runs, raw answers back.

import { randomBytes } from "node:crypto";
import { BRIEF_PROMPT, BRIEF_TASK_PROMPT, FOLLOWUP_PROMPT, JUDGE_PROMPT, PROACTIVE_PROMPT, STEP_PROMPT } from "../prompt.ts";
import type { RunKind } from "../budget.ts";
import { ClaudeError } from "./claude.ts";
import { fenced } from "./context.ts";
import type { BriefJob, FollowupJob, JudgeJob, ProactiveJob, StepJob } from "./items.ts";
import type { AfterLanguage } from "./parts.ts";

export function mountJobs(b: AfterLanguage) {
  const { config, log, api, budget, background, rehearsal, retryAt, hold, unsent, deliver } = b;
  /**
   * A follow-ups job (src/followups.ts): other people's words read in a run of its own (no tools, no conversation, nothing acted on), whose
   * answer goes back to the server as raw text; the server takes only the JSON it asked for, field by field. Nothing is said to the owner here.
   */
  const handleFollowup = async (id: string, job: FollowupJob): Promise<boolean> => {
    const kept = unsent.get(id);
    if (kept !== undefined) return deliver(id, "/assistant/followups", kept, "followup");
    const fence = `SEGUIMIENTO-${randomBytes(4).toString("hex")}`;
    const prompt = [`<<<${fence}`, fenced(job.text, 16_000), `${fence}>>>`].join("\n");
    let text = "";
    try {
      // Without a run (over the day's budget) the answer is empty: no loops from this job, nothing else changes.
      const r = await background(rehearsal(id) ? "rehearsal" : "followup", job.text, prompt, { ...config, tools: [], systemPrompt: FOLLOWUP_PROMPT.replaceAll("SEGUIMIENTO", fence) });
      if ("skipped" in r) {
        if (r.skipped === "paused") {
          hold(id, r.until);
          return false;
        }
      } else {
        text = r.text.slice(0, 20_000);
        log(`followup ${id.slice(-8)}: ${text.length} chars, $${r.costUsd.toFixed(4)}`);
      }
    } catch (err) {
      const kind = err instanceof ClaudeError ? err.kind : "other";
      log(`claude failed on a followup (${kind}): ${(err as Error).message.slice(0, 200)}`);
      if (kind === "limit" || kind === "login") {
        if (kind === "limit") hold(id);
        else retryAt.set(id, Date.now() + 5 * 60_000);
        return false;
      }
    }
    return deliver(id, "/assistant/followups", text, "followup");
  };

  /**
   * A proactive check (src/proactive.ts): what Pako knows of the owner's day and life, read in a run of its own (no tools, no conversation,
   * nothing acted on), whose answer (NO_REPLY or JSON) goes back as raw text: the server decides whether anything is said. A run that failed
   * sends NO_REPLY: nothing is ever said for it, and it is not tried again (the next check comes in half an hour).
   */
  const handleProactive = async (id: string, job: ProactiveJob, superseded = false): Promise<boolean> => {
    // An older check that waited in the inbox (the computer was asleep) when a newer one is there too: the newer one reads the same things,
    // fresher. This one is answered NO_REPLY without a run (several checks that piled up become one).
    if (superseded) {
      budget.coalesced();
      log(`proactive ${id.slice(-8)}: a newer check waits too, this one is let go without a run`);
      await postProactive(id, "NO_REPLY");
      return true;
    }
    const fence = `VIDA-${randomBytes(4).toString("hex")}`;
    const prompt = [`<<<${fence}`, fenced(job.text, 16_000), `${fence}>>>`].join("\n");
    let text = "NO_REPLY";
    try {
      // Without a run (over the budget, Claude's limit) it is NO_REPLY: nothing is said, and the next check comes at its time.
      const r = await background("proactive", job.text, prompt, { ...config, tools: [], systemPrompt: PROACTIVE_PROMPT.replaceAll("VIDA", fence) });
      if (!("skipped" in r)) {
        text = r.text.trim().slice(0, 4000) || "NO_REPLY";
        if (!r.reused) log(`proactive ${id.slice(-8)}: ${text === "NO_REPLY" ? "nothing to say" : `${text.length} chars`}, $${r.costUsd.toFixed(4)}`);
      }
    } catch (err) {
      const kind = err instanceof ClaudeError ? err.kind : "other";
      log(`claude failed on a proactive check (${kind}): ${(err as Error).message.slice(0, 200)}`);
    }
    await postProactive(id, text);
    return true;
  };
  const postProactive = async (id: string, text: string): Promise<void> => {
    try {
      const r = await api("/assistant/proactive", { method: "POST", body: { id, text } });
      if (!r.ok) log(`proactive answer refused: ${r.status}`);
    } catch (err) {
      log(`proactive answer failed: ${(err as Error).message}`);
    }
  };

  /**
   * A judge job (src/memory-facts.ts): whether a new fact contradicts older ones, read in a run of its own (no tools, no conversation, nothing
   * acted on). The answer goes back as raw text; the server takes only strict JSON, and a failed run sends "": the newest fact then wins.
   */
  const handleJudge = async (id: string, job: JudgeJob): Promise<boolean> => {
    const fence = `DATOS-${randomBytes(4).toString("hex")}`;
    const prompt = [`<<<${fence}`, fenced(job.text, 4000), `${fence}>>>`].join("\n");
    let text = "";
    try {
      // Without a run the answer is empty: the newest fact wins, as when the judge never answers.
      const r = await background("judge", job.text, prompt, { ...config, tools: [], systemPrompt: JUDGE_PROMPT.replaceAll("DATOS", fence) });
      if (!("skipped" in r)) {
        text = r.text.trim().slice(0, 2000);
        log(`judge ${id.slice(-8)}: ${text.length} chars, $${r.costUsd.toFixed(4)}`);
      }
    } catch (err) {
      const kind = err instanceof ClaudeError ? err.kind : "other";
      log(`claude failed on a judge job (${kind}): ${(err as Error).message.slice(0, 200)}`);
    }
    try {
      const r = await api("/assistant/judge", { method: "POST", body: { id, text } });
      if (!r.ok) log(`judge answer refused: ${r.status}`);
    } catch (err) {
      log(`judge answer failed: ${(err as Error).message}`);
    }
    return true;
  };

  /**
   * A written-brief job (src/brief-v2.ts): the day's facts read in a run of its own (no tools, no conversation, nothing acted on). The brief is
   * answered as JSON the server takes field by field; a document asked from the page ("Let's do it", "Prepare me") as plain text. Nothing is
   * said to the owner from here: the server decides what goes to the chat.
   */
  const handleBrief = async (id: string, job: BriefJob): Promise<boolean> => {
    const kept = unsent.get(id);
    if (kept !== undefined) return deliver(id, "/assistant/brief", kept, "brief");
    const fence = `BRIEF-${randomBytes(4).toString("hex")}`;
    const prompt = [`<<<${fence}`, fenced(job.text, 32_000), `${fence}>>>`].join("\n");
    const system = (job.kind === "brief" ? BRIEF_PROMPT : BRIEF_TASK_PROMPT).replaceAll("BRIEF", fence);
    let text = "";
    try {
      // The morning brief without a run (over the budget, or Claude's limit) is answered empty at once: the server then sends the brief it
      // builds by itself, on time, instead of waiting for a reset. A document asked from the page is the owner's own and always runs. The brief
      // and a draft run on the writing model (runs.ts).
      const kind: RunKind = rehearsal(id) ? "rehearsal" : job.kind === "brief" ? "brief" : job.draft ? "draft" : "task";
      const r = await background(kind, `${job.kind}\n${job.text}`, prompt, { ...config, tools: [], systemPrompt: system });
      if ("skipped" in r) log(`brief ${id.slice(-8)}: no run (${r.skipped === "cap" ? "over today's background budget" : "Claude's limit"}): the server sends its own`);
      else {
        text = r.text.slice(0, 30_000);
        const what = kind === "draft" ? "draft" : job.kind;
        log(`brief ${what} ${id.slice(-8)}: ${text.length} chars, $${r.costUsd.toFixed(4)}${r.model ? `, ${r.model}` : ""}`);
      }
    } catch (err) {
      const kind = err instanceof ClaudeError ? err.kind : "other";
      log(`claude failed on a brief (${kind}): ${(err as Error).message.slice(0, 200)}`);
      if (kind === "limit" || kind === "login") {
        if (kind === "limit") hold(id);
        else retryAt.set(id, Date.now() + 5 * 60_000);
        return false;
      }
    }
    return deliver(id, "/assistant/brief", text, "brief");
  };
  /**
   * A first-tiny-step job (gentle mode, src/gentle.ts): one stuck follow-up's facts read in a run of its own (no tools, no conversation,
   * nothing acted on). The answer goes back as raw text; the server checks it before anything is kept, and a failed run sends "": no step.
   */
  const handleStep = async (id: string, job: StepJob): Promise<boolean> => {
    const fence = `PASO-${randomBytes(4).toString("hex")}`;
    const prompt = [`<<<${fence}`, fenced(job.text, 8000), `${fence}>>>`].join("\n");
    let text = "";
    try {
      const r = await background("step", job.text, prompt, { ...config, tools: [], systemPrompt: STEP_PROMPT.replaceAll("PASO", fence) });
      if (!("skipped" in r)) {
        text = r.text.trim().slice(0, 2000);
        log(`step ${id.slice(-8)}: ${text.length} chars, $${r.costUsd.toFixed(4)}`);
      }
    } catch (err) {
      const kind = err instanceof ClaudeError ? err.kind : "other";
      log(`claude failed on a step job (${kind}): ${(err as Error).message.slice(0, 200)}`);
    }
    try {
      const r = await api("/assistant/step", { method: "POST", body: { id, text } });
      if (!r.ok) log(`step answer refused: ${r.status}`);
    } catch (err) {
      log(`step answer failed: ${(err as Error).message}`);
    }
    return true;
  };
  return { handleFollowup, handleProactive, handleJudge, handleBrief, handleStep };
}

export type Jobs = ReturnType<typeof mountJobs>;
