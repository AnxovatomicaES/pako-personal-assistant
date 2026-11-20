// Wires the follow-ups engine (src/followups.ts) with everything it reads, and gentle mode's first tiny steps.

import { createFollowups } from "../followups.ts";
import { CT } from "../gentle-checkins.ts";
import { createFirstSteps } from "../gentle.ts";
import { createLog } from "../log.ts";
import { isTeamsChannel } from "../teams.ts";
import type { AfterMeetings } from "./context.ts";

const logFollowups = createLog("followups");

export function wireFollowups(ctx: AfterMeetings) {
  const {
    local, uiLang, kv, control, jobs, timeZone, givenName, slack, slackRef, zoom, zoomRef, teamsCfg, teamsRef, calOn, calRef, smartCfg, followupsCfg,
    followupsRef, personRef, gentleSettings, gentleRef, lifeRef, lessons, quality, door,
  } = ctx;
  if (followupsCfg.config) {
    // Looks only at what this server already reads (each part looked up when a check runs, so one set up later counts).
    followupsRef.engine = createFollowups({
      config: followupsCfg.config,
      drafts: !!smartCfg.config,
      ownerName: givenName,
      kv,
      timeZone,
      control,
      lang: uiLang,
      ownerLanguage: () => door.language(),
      enqueue: (m) => door.inbox.add(m),
      card: (body, buttons) => door.sendCard(body, buttons),
      notify: (text) => door.notifyOwner(text),
      ...(quality ? { quality: quality.followups } : {}),
      // The day's budget is shared with proactive Pako's suggestions.
      // And with the check-ins' first asks (src/gentle-checkins.ts).
      othersToday: async () => ((await lifeRef.engine?.spentToday()) ?? 0) + ((await gentleRef.checkins?.spentToday()) ?? 0),
      ...(zoom.config ? { zoom: () => (zoomRef.reader ? zoomRef.reader.scheduled() : Promise.reject(new Error("Zoom is not ready"))) } : {}),
      ...(calOn && !teamsCfg.config ? { calendar: () => (calRef.reader ? calRef.reader.load() : Promise.reject(new Error("the calendar is not ready"))) } : {}),
      // With Teams, its calendar's Teams meetings count as "it happened" too (src/teams.ts events).
      ...(teamsCfg.config
        ? {
            calendar: async () => {
              const own = calOn ? (calRef.reader ? await calRef.reader.load() : Promise.reject(new Error("the calendar is not ready"))) : [];
              return [...(await own), ...(teamsRef.reader ? await teamsRef.reader.events().catch(() => []) : [])];
            },
          }
        : {}),
      // A Teams conversation has a Slack-shaped id of its own (src/teams.ts teamsChannel): its history comes from Teams.
      ...(slack.config || teamsCfg.config
        ? {
            slackHistory: (ch, o) =>
              isTeamsChannel(ch)
                ? teamsRef.reader ? teamsRef.reader.history(ch, o) : Promise.reject(new Error("Teams is not ready"))
                : slackRef.reader ? slackRef.reader.history(ch, o) : Promise.reject(new Error("Slack is not ready")),
          }
        : {}),
      // One name per person across Slack, the mail and meetings (src/people-graph.ts).
      who: (name: string) => door.peopleGraph.canon(name),
      lessons,
      // Who the people of a job are to the owner (src/person-context.ts): read by the extraction with its material.
      people: (words: string[]) => (personRef.c ? personRef.c.many(words) : Promise.resolve([])),
      // Gentle mode, read before each round of nudges: its cap, its words and buttons, and what similar meetings took.
      gentle: async () => {
        const g = await gentleSettings.view();
        if (!g) return null;
        return {
          maxPerDay: g.maxPerDay, usually: (title: string) => (gentleRef.anchors ? gentleRef.anchors.usually(title) : Promise.resolve(null)),
          // A stuck one's nudge offers a check-in: "Check on me in 30 min" (src/gentle-checkins.ts).
          checkin: async (id: string) => {
            if (!gentleRef.checkins) throw new Error("check-ins are not ready");
            return { buttons: [await gentleRef.checkins.loopButton(id)], line: CT()("loopLine", { min: g.checkinMin }) };
          },
        };
      },
    });
    followupsRef.engine.start(jobs);
    // Gentle mode's first tiny steps (src/gentle.ts): a stuck follow-up gets one, written on the owner's computer, a few a day.
    const engine = followupsRef.engine;
    gentleRef.steps = createFirstSteps({
      kv, timeZone, settings: () => gentleSettings.view(), loops: () => engine.open(),
      people: (words: string[]) => (personRef.c ? personRef.c.many(words) : Promise.resolve([])),
      ownerLanguage: () => door.language(),
      enqueue: (m) => door.inbox.add(m),
      setStep: (id, step) => engine.setStep(id, step),
      log: (text) => control.log("followup", text),
    });
    const steps = gentleRef.steps;
    const sweepSteps = (): void => void steps.sweep().catch((err: Error) => logFollowups.error(`first steps: ${err.message}`));
    // A first look a minute after the start (what got stuck while Pako was off), then every half hour.
    setTimeout(sweepSteps, 60_000).unref?.();
    setInterval(sweepSteps, 30 * 60_000).unref?.();
    const fc = followupsCfg.config;
    if (!local) logFollowups.info(`ON: checked ${fc.delayMs / 60_000} min after, at most ${fc.maxPerDay} reminders a day`);
  }
}
