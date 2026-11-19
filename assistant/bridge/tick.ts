// One round of the bridge: ask the server's inbox for what waits, answer each item in order, and acknowledge it.

import { briefOf, emailOf, followupOf, judgeOf, meetingOf, paperOf, proactiveOf, reviewOf } from "./items.ts";
import type { AfterTurn } from "./parts.ts";

export function mountTick(b: AfterTurn) {
  const { log, api, pendingNotes, flushNotes, reportHealth, reportVersion, healthDue, versionDue, handledUnacked, retryAt, attempts, handle } = b;
  /** One round: ask for messages (the server holds the request while there are none) and answer each in order. */
  const tick = async (waitSeconds = 25): Promise<{ seen: number; done: number }> => {
    if (pendingNotes.length) await flushNotes();
    if (healthDue()) await reportHealth();
    if (versionDue()) await reportVersion();
    const r = await api(`/assistant/inbox?wait=${waitSeconds}`, { timeoutMs: (waitSeconds + 15) * 1000 });
    if (!r.ok) throw new Error(`inbox answered ${r.status}`);
    type Raw = {
      id: string; at: number; text: string; audio?: { id?: unknown; mime?: unknown }; email?: unknown; meeting?: unknown; forwarded?: unknown; routine?: unknown;
      paper?: unknown; followup?: unknown; review?: unknown; brief?: unknown; proactive?: unknown; judge?: unknown;
    };
    // The inbox may also carry uiLanguage (an older server's choice of Spanish or English): ignored, Pako's fixed texts are English.
    const { messages } = (await r.json()) as { messages?: Raw[] };
    const audioOf = (m: { audio?: { id?: unknown; mime?: unknown } }): { id: string; mime: string } | undefined =>
      typeof m.audio?.id === "string" && m.audio.id ? { id: m.audio.id, mime: typeof m.audio.mime === "string" ? m.audio.mime : "audio/ogg" } : undefined;
    const usable = (m: Raw) =>
      m && typeof m.id === "string" && typeof m.text === "string" &&
      (m.text.trim() || audioOf(m) || emailOf(m) || meetingOf(m) || paperOf(m) || followupOf(m) || reviewOf(m) || briefOf(m) || proactiveOf(m) || judgeOf(m));
    const ack = async (id: string): Promise<boolean> => {
      try {
        // `papers: 1`: this bridge reads papers, so a paper acknowledged here was answered (an older bridge's ack makes the server say update);
        // `briefs: 1`: the same for a written-brief job (an older bridge's ack makes the old brief go at once).
        const a = await api("/assistant/ack", { method: "POST", body: { ids: [id], papers: 1, briefs: 1 } });
        if (!a.ok) log(`ack refused: ${a.status}`);
        return a.ok;
      } catch (err) {
        log(`ack failed: ${(err as Error).message}`);
        return false;
      }
    };
    // Something this computer cannot handle (an unknown kind) is let go, so the inbox does not answer at once for ever.
    const unusable = (messages ?? []).filter((m) => !usable(m) && m && typeof m.id === "string");
    for (const m of unusable) {
      log(`let go of an inbox item it cannot handle (${m.id.slice(-12)})`);
      await ack(m.id);
    }
    // The owner's own messages first, in order; then emails, transcripts and follow-ups jobs.
    type Side = { email?: unknown; meeting?: unknown; followup?: unknown; review?: unknown; brief?: unknown; proactive?: unknown; judge?: unknown };
    const later = (m: Side) => (m.email || m.meeting || m.followup || m.review || m.brief || m.proactive || m.judge ? 1 : 0);
    const list = (messages ?? [])
      .filter(usable)
      .map((m) => ({
        id: m.id, at: m.at, text: m.text, audio: audioOf(m), email: emailOf(m), meeting: meetingOf(m), paper: paperOf(m), followup: followupOf(m),
        review: reviewOf(m), brief: briefOf(m), proactive: proactiveOf(m), judge: judgeOf(m),
        ...(m.forwarded === true ? { forwarded: true } : {}), ...(m.routine && typeof m.routine === "object" ? { routine: true } : {}),
      }))
      .sort((a, b) => later(a) - later(b) || a.at - b.at);
    // The newest proactive check: an older one still waiting is let go without a run (handleProactive).
    const newestCheck = list.filter((m) => m.proactive).sort((a, b) => b.at - a.at)[0]?.id;
    let done = 0;
    for (const m of list) {
      if (handledUnacked.has(m.id)) {
        if (await ack(m.id)) handledUnacked.delete(m.id);
        continue; // answered already: never twice
      }
      const side = !!(m.email || m.meeting || m.followup || m.review || m.brief || m.proactive || m.judge);
      if ((retryAt.get(m.id) ?? 0) > Date.now()) {
        if (side) continue;
        break; // an owner's message waits for Claude: the ones after it wait too, to keep the order
      }
      const superseded = !!m.proactive && m.id !== newestCheck;
      if (!(await handle(superseded ? { ...m, superseded } : m))) {
        if (side) continue; // an email that cannot be read now never holds up the rest
        break; // keep the order: the rest wait for the next round
      }
      done++;
      attempts.delete(m.id);
      retryAt.delete(m.id);
      if (!(await ack(m.id))) handledUnacked.add(m.id);
      // One email or transcript per round: each is a whole run of Claude, and the owner's message that arrived meanwhile must wait for one, not for all of them.
      // A check let go without a run took no time: the next item goes in this round.
      if (side && !superseded) break;
    }
    return { seen: list.length + unusable.length, done };
  };
  return { tick };
}

export type Tick = ReturnType<typeof mountTick>;
