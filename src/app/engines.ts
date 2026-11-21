// Wires the settings and late refs of the engines built once the door is: the brief, follow-ups, gentle mode, proactive Pako, the
// lessons, quality and the rehearsal.

import { type BriefV2, loadBriefV2Config } from "../brief-v2.ts";
import { type Brief, loadBriefConfig } from "../brief.ts";
import { type Followups, type FollowupsDoor, followupsProxy, loadFollowupsConfig } from "../followups.ts";
import type { CheckIns } from "../gentle-checkins.ts";
import type { WeeklyReset } from "../gentle-reset.ts";
import { createGentleSettings, type FirstSteps, loadGentleConfig, type TimeAnchors } from "../gentle.ts";
import type { BetaAudit } from "../beta-audit.ts";
import { createLessons } from "../lessons.ts";
import { createLog } from "../log.ts";
import { createMailFollowups } from "../mail-followups.ts";
import type { PersonContext } from "../person-context.ts";
import { type LifeDoor, loadProactiveConfig, type Proactive } from "../proactive.ts";
import { createQuality, type Quality } from "../quality.ts";
import type { Rehearsal } from "../rehearsal.ts";
import { loadWorkHours, type TimeToDo } from "../time-to-do.ts";
import { ownerRegion } from "../region.ts";
import type { AfterSources } from "./context.ts";

const logBrief = createLog("brief");
const logFollowups = createLog("followups");
const logLessons = createLog("lessons");
const logProactive = createLog("proactive");

export function wireEngines(ctx: AfterSources) {
  const { env, uiLang, kv, timeZone, repliedRef, box } = ctx;
  // The daily brief (src/brief.ts), for everyone: built once the door is (it sends through it); BRIEF and the panel's button look it up then.
  const briefCfg = loadBriefConfig(env);
  if (briefCfg.problems.length) logBrief.error(`${briefCfg.problems.join("; ")}`);
  const briefRef: { reader: Brief | null } = { reader: null };
  const briefNow = (): Promise<string> => (briefRef.reader ? briefRef.reader.now() : Promise.resolve(""));
  // The written brief (src/brief-v2.ts): on unless BRIEF_SMART=off; it needs the assistant's computer (an older bridge: the brief as before).
  const smartCfg = loadBriefV2Config(env);
  if (smartCfg.problems.length) logBrief.error(`${smartCfg.problems.join("; ")}`);
  const smartRef: { brief: BriefV2 | null } = { brief: null };
  // Follow-ups (src/followups.ts): on unless FOLLOWUPS=off. Built once the door is (it sends cards through it); the door reaches it here.
  const followupsCfg = loadFollowupsConfig(env);
  // The owner's working day (WORK_HOURS, WORK_DAYS) times the chases too, as it times "time to do it" (src/time-to-do.ts).
  if (followupsCfg.config) followupsCfg.config.work = loadWorkHours(env, ownerRegion()).hours;
  if (followupsCfg.problems.length) logFollowups.error(`${followupsCfg.problems.join("; ")}`);
  const followupsRef: { engine: Followups | null } = { engine: null };
  // What the owner's memory says about a person (src/person-context.ts), built once the door is: its facts and people graph are the door's.
  const personRef: { c: PersonContext | null } = { c: null };
  // Gentle mode (src/gentle.ts): opt-in (PAKO_GENTLE=1, or the panel's How Pako acts). Its settings now; its time anchors and first tiny
  // steps once the door, the calendar and the follow-ups are built (the door reaches them here).
  const gentleCfg = loadGentleConfig(env);
  if (gentleCfg.problems.length) logFollowups.error(`${gentleCfg.problems.join("; ")}`);
  const gentleSettings = createGentleSettings(kv, gentleCfg.config);
  const gentleRef: { anchors: TimeAnchors | null; steps: FirstSteps | null; checkins: CheckIns | null; reset: WeeklyReset | null } = {
    anchors: null, steps: null, checkins: null, reset: null,
  };
  // Every method of the door the engine has, reached through the engine once it is built (src/followups/door-proxy.ts).
  const followupsDoor: FollowupsDoor = followupsProxy(() => followupsRef.engine);
  // The mail the follow-ups read whole (src/mail-followups.ts): the categories that matter, and what the owner sent.
  const mailFollowups = box ? createMailFollowups({ box, followups: () => (followupsRef.engine ? followupsDoor : null) }) : null;
  repliedRef.close = (ids) => {
    const engine = followupsRef.engine;
    if (!engine) return;
    for (const id of ids) void engine.doneFor(id, "You replied to the email.").catch(() => undefined);
  };
  // Proactive Pako (src/proactive.ts): on unless PROACTIVE=off. Built once the door is (it sends cards through it); the door reaches it here.
  const proactiveCfg = loadProactiveConfig(env);
  if (proactiveCfg.problems.length) logProactive.error(`${proactiveCfg.problems.join("; ")}`);
  const lifeRef: { engine: Proactive | null } = { engine: null };
  const lifeDoor: LifeDoor = {
    learn: (f, o) => (lifeRef.engine ? lifeRef.engine.learn(f, o) : Promise.resolve(0)),
    press: (b, id) => (lifeRef.engine ? lifeRef.engine.press(b, id) : Promise.resolve("")),
    words: (text) => (lifeRef.engine ? lifeRef.engine.words(text) : Promise.resolve(null)),
    context: () => (lifeRef.engine ? lifeRef.engine.context() : Promise.resolve({ life: [], emergency: "" })),
    result: (id, raw) => (lifeRef.engine ? lifeRef.engine.result(id, raw) : Promise.resolve({ ok: false })),
    forgetHealth: () => (lifeRef.engine ? lifeRef.engine.forgetHealth() : Promise.resolve()),
    health: () => (lifeRef.engine ? lifeRef.engine.health() : Promise.resolve([])),
  };
  // Quality (src/quality.ts): the 👍/👎 on the nudges and the brief, the panel's "Calidad" card, the Monday line. With either of them on.
  // What Pako learned from the owner's corrections (src/lessons.ts): Not mine, an undo, a 👎, a draft changed before it was sent.
  const lessons = createLessons({ kv, timeZone });
  /** A 👎 the owner gave: on a follow-up's reminder (its loop's person and place), or on a to-do or an update of the brief. */
  const verdictLesson = async (v: { verdict: "up" | "down"; source: string; ref: string; what: string }): Promise<void> => {
    if (v.verdict !== "down") return;
    if (v.source === "nudge") {
      const l = (await followupsRef.engine?.read())?.loops.find((x) => x.id === v.ref);
      if (l) await lessons.wrong({ what: "follow-up reminder", title: l.title, who: l.who, where: l.where.label, ...(l.where.channel ? { channel: l.where.channel } : {}) });
    } else if (v.source === "brief_todo" || v.source === "brief_update") {
      await lessons.wrong({ what: v.source === "brief_todo" ? "brief to-do" : "brief update", title: v.what });
    }
  };
  const quality: Quality | null = followupsCfg.config || smartCfg.config || proactiveCfg.config
    ? createQuality({ kv, timeZone, lang: uiLang, onVerdict: (v) => void verdictLesson(v).catch((err: Error) => logLessons.error(err.message)) })
    : null;
  // The rehearsal (src/rehearsal.ts): REHEARSAL and the panel's button; built once the door is (its jobs go through its inbox).
  const rehearsalRef: { r: Rehearsal | null } = { r: null };
  /** What a 👍/👎 button is about: the nudge's loop, or today's written brief. */
  const judged = async (kind: "nudge" | "brief", ref: string): Promise<string | null> => {
    if (kind === "nudge") {
      const loop = (await followupsRef.engine?.read())?.loops.find((l) => l.id === ref)?.title;
      return loop ?? (await lifeRef.engine?.judged(ref)) ?? null;
    }
    const doc = await smartRef.brief?.todayDoc();
    return doc && doc.id === ref ? `brief ${doc.day}` : null;
  };
  const panelRef: { link: (() => string | null) | null } = { link: null };
  // The beta's measuring audit (src/beta-audit.ts): opt-in in the panel; built with the jobs' clock (src/app/schedule.ts), with follow-ups on.
  const betaRef: { audit: BetaAudit | null } = { audit: null };
  // Time to do it (src/time-to-do.ts): the follow-ups at risk for want of free time, with a focus block; built with the jobs' clock.
  const timeRef: { t: TimeToDo | null } = { t: null };
  return {
    briefCfg, briefRef, briefNow, smartCfg, smartRef, followupsCfg, followupsRef, personRef, gentleSettings, gentleRef, followupsDoor, mailFollowups,
    proactiveCfg, lifeRef, lifeDoor, lessons, quality, rehearsalRef, judged, panelRef, betaRef, timeRef,
  };
}
