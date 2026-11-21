// Wires the jobs' clock: reminders, routines, check-ins and the weekly reset as durable jobs, the brief's daily slot, then starts
// the clock and mounts the brief's panel routes.

import { mountBriefPage } from "../brief-v2.ts";
import { mountBriefPanel } from "../brief.ts";
import { createBetaAudit } from "../beta-audit.ts";
import { createCheckIns } from "../gentle-checkins.ts";
import { createWeeklyReset } from "../gentle-reset.ts";
import { createLog } from "../log.ts";
import { pausedText } from "../control.ts";
import { ownerRegion } from "../region.ts";
import { createAfterMeeting } from "../after-meeting.ts";
import { createShutdown, loadShutdownConfig } from "../shutdown.ts";
import { createTimeToDo, loadWorkHours } from "../time-to-do.ts";
import type { AfterBrief } from "./context.ts";

const logBrief = createLog("brief");

export function wireSchedule(ctx: AfterBrief) {
  const {
    app, env, local, uiLang, kv, control, jobs, timeZone, calOn, calRef, briefCfg, briefNow, smartRef, followupsCfg, followupsRef, gentleSettings,
    gentleRef, followupsDoor, door, panel, briefReader, betaRef, quality, timeRef, budget, dayHelpers, myAddresses,
  } = ctx;
  // On the jobs' clock: due reminders, then routines and watches (one look each, as before), and the brief's daily slot.
  jobs.define({ kind: "reminders", sweep: () => door.runReminders() });
  jobs.define({ kind: "routines", sweep: () => door.routines.tick() });
  // Check-ins (src/gentle-checkins.ts): for everyone; asked as durable slots, never in the quiet hours or a meeting, within the day's cap
  // shared with the follow-ups' nudges and Pako's own suggestions.
  const meetings = calOn ? () => (calRef.reader ? calRef.reader.load() : Promise.reject(new Error("the calendar is not ready"))) : undefined;
  gentleRef.checkins = createCheckIns({
    kv, timeZone, settings: () => gentleSettings.read(), standardMax: followupsCfg.config?.maxPerDay ?? 6,
    others: () => budget.others("checkins"),
    quiet: followupsCfg.config?.quiet ?? null,
    ...(meetings ? { events: meetings } : {}),
    jobs,
    card: (body, buttons) => door.sendCard(body, buttons),
    // Not built yet (the first look at start): unknown, not gone, so a waiting check-in is not ended for it.
    loop: async (id) => {
      if (!followupsRef.engine) throw new Error("the follow-ups are not ready");
      return (await followupsRef.engine.open()).find((l) => l.id === id) ?? null;
    },
    parkLoop: (id) => followupsDoor.press("7", id),
    // "Check on me in 30 min" on a nudge is an answer: gentle mode's unanswered count starts again.
    engaged: async (id) => (followupsRef.engine ? followupsRef.engine.engaged(id) : false),
    log: (text) => control.log("followup", text),
  });
  const checkins = gentleRef.checkins;
  jobs.define({ kind: "checkins", sweep: () => checkins.sweep() });
  // Gentle mode's weekly reset (src/gentle-reset.ts): three slipping things, pick one, park the rest; and the month-old parked ones.
  if (followupsCfg.config) {
    gentleRef.reset = createWeeklyReset({
      kv, timeZone, settings: () => gentleSettings.view(),
      loops: async () => (followupsRef.engine ? followupsRef.engine.open() : []),
      parked: () => followupsDoor.parked!(),
      park: async (id) => /^Parked/.test(await followupsDoor.press("7", id)),
      letGo: async (id) => (followupsRef.engine ? followupsRef.engine.letGo(id) : false),
      // What the store let go after 45 days parked: in the Parked list's history even when no reset ever asked about it.
      expired: async () => (followupsRef.engine ? followupsRef.engine.expiredParked() : []),
      quiet: followupsCfg.config.quiet ?? null,
      ...(meetings ? { events: meetings } : {}),
      jobs,
      roomy: () => door.roomy(),
      card: (body, buttons) => door.sendButtons(body, buttons),
      log: (text) => control.log("followup", text),
    });
    const reset = gentleRef.reset;
    jobs.define({ kind: "gentle-reset", sweep: () => reset.sweep() });
    // The beta's measuring audit (src/beta-audit.ts): opt-in; a week's sampled questions, one at a time, never in the quiet hours.
    betaRef.audit = createBetaAudit({
      kv, timeZone, quiet: followupsCfg.config.quiet ?? null,
      loops: async () => (followupsRef.engine ? (await followupsRef.engine.read()).loops : Promise.reject(new Error("the follow-ups are not ready"))),
      told: async () => (quality ? ((await quality.read()).misses ?? []).flatMap((m) => (m.loop ? [m.loop] : [])) : []),
      card: (body, buttons) => door.sendButtons(body, buttons),
      log: (text) => control.log("followup", text),
    });
    const audit = betaRef.audit;
    jobs.define({ kind: "beta-audit", sweep: () => audit.sweep() });
    // Time to do it (src/time-to-do.ts): a follow-up the owner owes with too little free time before it, a focus block proposed. Pako
    // writes the block only on the card's Block (the owner's yes), through the Mac app's queue; a calendar it cannot write is said so.
    const work = loadWorkHours(env, ownerRegion());
    if (work.problems.length) logBrief.error(`${work.problems.join("; ")}`);
    timeRef.t = createTimeToDo({
      kv, timeZone, hours: work.hours, quiet: followupsCfg.config.quiet ?? null, standardMax: followupsCfg.config.maxPerDay,
      // Built just after this (src/app/followups.ts): none yet in the first seconds, rather than an error on every start.
      loops: async () => (followupsRef.engine ? followupsRef.engine.open() : []),
      ...(meetings ? { events: meetings } : {}),
      gentle: async () => {
        const g = await gentleSettings.view();
        return g ? { maxPerDay: g.maxPerDay } : null;
      },
      usually: (title) => (gentleRef.anchors ? gentleRef.anchors.usually(title) : Promise.resolve(null)),
      others: () => budget.others("time"),
      writes: () => door.calendarWrites(),
      paused: async () => {
        const p = await control.state();
        return p.paused !== null ? pausedText(p.why, uiLang()) : null;
      },
      stops: () => door.stops(),
      card: (body, buttons) => door.sendCard(body, buttons),
      engaged: async (id) => (followupsRef.engine ? followupsRef.engine.engaged(id) : false),
      log: (text) => control.log("followup", text),
    });
    const timeToDo = timeRef.t;
    jobs.define({ kind: "time-to-do", sweep: () => timeToDo.sweep() });
    // The evening wrap-up (src/shutdown.ts): at the end of the working day (SHUTDOWN), what is due next and whether it fits, with Plan
    // (time-to-do's card above: nothing is written without its Block) and Done. To the owner only; not in gentle mode.
    const shutdownCfg = loadShutdownConfig(env, work.hours);
    if (shutdownCfg.problems.length) logBrief.error(`${shutdownCfg.problems.join("; ")}`);
    timeRef.shutdown = createShutdown({
      kv, timeZone, config: shutdownCfg, hours: work.hours, quiet: followupsCfg.config.quiet ?? null,
      loops: async () => (followupsRef.engine ? (await followupsRef.engine.read()).loops : []),
      ...(meetings ? { events: meetings } : {}),
      gentle: async () => !!(await gentleSettings.view()),
      enabled: () => dayHelpers.on("wrapUp"),
      jobs,
      roomy: () => door.roomy(),
      card: (body, buttons, roomy) => (roomy ? door.sendButtons(body, buttons) : door.sendCard(body, buttons)),
      // As a card: only when the chat can be written to now. A held text would arrive another day saying "tomorrow" (review finding).
      notify: async (text) => {
        if (!(await door.writable())) return false;
        return (await door.notifyOwner(text)) === "sent";
      },
      plan: (id) => timeToDo.findTimeFor(id),
      done: (id) => followupsDoor.press("1", id),
      log: (text) => control.log("followup", text),
    });
    const shutdown = timeRef.shutdown;
    jobs.define({ kind: "shutdown", sweep: () => shutdown.sweep() });
    // After a meeting Pako could not hear (src/after-meeting.ts): "did you promise anything?", within the day's shared cap. The answer is a
    // chat message like any other, kept as a follow-up by the assistant.
    if (meetings) {
      timeRef.after = createAfterMeeting({
        kv, timeZone, on: (env.AFTER_MEETING ?? "").trim().toLowerCase() !== "off", hours: work.hours, quiet: followupsCfg.config.quiet ?? null,
        events: meetings, zoomReview: !!(ctx.zoom.config && ctx.reviewCfg.config), enabled: () => dayHelpers.on("afterMeeting"), self: () => myAddresses(),
        cap: async () => (await gentleSettings.view())?.maxPerDay ?? followupsCfg.config!.maxPerDay,
        others: () => budget.others("after"),
        card: (body, buttons) => door.sendCard(body, buttons),
        log: (text) => control.log("followup", text),
      });
      const after = timeRef.after;
      jobs.define({ kind: "after-meeting", sweep: () => after.sweep() });
    }
  }
  briefReader.start(jobs);
  jobs.start();
  mountBriefPanel(app, { signedIn: panel.signedIn, brief: briefNow });
  mountBriefPage(app, { signedIn: panel.signedIn, brief: () => smartRef.brief, lang: uiLang });
  if (!local) logBrief.info(`${briefCfg.at === null ? "only on demand (BRIEF)" : `ON: every day at ${env.MORNING_BRIEF?.trim() || "08:00"} (${timeZone})`}`);
}
