// Wires the jobs' clock: reminders, routines, check-ins and the weekly reset as durable jobs, the brief's daily slot, then starts
// the clock and mounts the brief's panel routes.

import { mountBriefPage } from "../brief-v2.ts";
import { mountBriefPanel } from "../brief.ts";
import { createCheckIns } from "../gentle-checkins.ts";
import { createWeeklyReset } from "../gentle-reset.ts";
import { createLog } from "../log.ts";
import type { AfterBrief } from "./context.ts";

const logBrief = createLog("brief");

export function wireSchedule(ctx: AfterBrief) {
  const {
    app, env, local, uiLang, kv, control, jobs, timeZone, calOn, calRef, briefCfg, briefNow, smartRef, followupsCfg, followupsRef, gentleSettings,
    gentleRef, followupsDoor, lifeRef, door, panel, briefReader,
  } = ctx;
  // On the jobs' clock: due reminders, then routines and watches (one look each, as before), and the brief's daily slot.
  jobs.define({ kind: "reminders", sweep: () => door.runReminders() });
  jobs.define({ kind: "routines", sweep: () => door.routines.tick() });
  // Check-ins (src/gentle-checkins.ts): for everyone; asked as durable slots, never in the quiet hours or a meeting, within the day's cap
  // shared with the follow-ups' nudges and Pako's own suggestions.
  const meetings = calOn ? () => (calRef.reader ? calRef.reader.load() : Promise.reject(new Error("the calendar is not ready"))) : undefined;
  gentleRef.checkins = createCheckIns({
    kv, timeZone, settings: () => gentleSettings.read(), standardMax: followupsCfg.config?.maxPerDay ?? 6,
    others: async () => ((await followupsRef.engine?.spentToday?.()) ?? 0) + ((await lifeRef.engine?.spentToday()) ?? 0),
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
  }
  briefReader.start(jobs);
  jobs.start();
  mountBriefPanel(app, { signedIn: panel.signedIn, brief: briefNow });
  mountBriefPage(app, { signedIn: panel.signedIn, brief: () => smartRef.brief, lang: uiLang });
  if (!local) logBrief.info(`${briefCfg.at === null ? "only on demand (BRIEF)" : `ON: every day at ${env.MORNING_BRIEF?.trim() || "08:00"} (${timeZone})`}`);
}
