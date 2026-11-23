// Wires the follow-ups engine (src/followups.ts) with everything it reads, and gentle mode's first tiny steps.

import { createFollowups } from "../followups.ts";
import { CT } from "../gentle-checkins.ts";
import { createFirstSteps } from "../gentle.ts";
import { createLog } from "../log.ts";
import { isImessageChannel } from "../imessage.ts";
import { addressOf } from "../mail.ts";
import { senderName } from "../mail-categories.ts";
import { isTeamsChannel } from "../teams.ts";
import type { AfterMeetings } from "./context.ts";

const logFollowups = createLog("followups");

export function wireFollowups(ctx: AfterMeetings) {
  const {
    local, uiLang, kv, control, jobs, timeZone, givenName, slack, slackRef, zoom, zoomRef, teamsCfg, teamsRef, imessageCfg, imessageRef, calOn, calRef,
    smartCfg, smartRef, followupsCfg, followupsRef, personRef, gentleSettings, gentleRef, lessons, quality, door, betaRef,
    box, budget,
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
      // A STOP ends a chase card waiting (its Send and Copy), as every other card.
      stops: () => door.stops(),
      ...(quality ? { quality: quality.followups } : {}),
      // The beta's audit (src/beta-audit.ts): told of each conversation read; it keeps nothing unless the tester opted in.
      audit: {
        queued: (job, material, people) => betaRef.audit?.followups.queued(job, material, people),
        answered: (o) => betaRef.audit?.followups.answered(o),
      },
      // The day's budget is shared with proactive Pako's suggestions.
      // And with the check-ins' first asks (src/gentle-checkins.ts).
      // And with the at-risk cards of time to do it (src/time-to-do.ts).
      othersToday: () => budget.others("followups"),
      take: (limit, fn) => budget.take("followups", limit, fn),
      ...(zoom.config ? { zoom: () => (zoomRef.reader ? zoomRef.reader.scheduled() : Promise.reject(new Error("Zoom is not ready"))) } : {}),
      ...(calOn && !teamsCfg.config ? { calendar: () => (calRef.reader ? calRef.reader.readAll() : Promise.reject(new Error("the calendar is not ready"))) } : {}),
      // With Teams, its calendar's Teams meetings count as "it happened" too (src/teams.ts events).
      ...(teamsCfg.config
        ? {
            calendar: async () => {
              const own = calOn ? (calRef.reader ? await calRef.reader.readAll() : Promise.reject(new Error("the calendar is not ready"))) : null;
              const mine = await own;
              const teams = teamsRef.reader ? await teamsRef.reader.events().catch(() => []) : [];
              return { events: [...(mine?.events ?? []), ...teams], partial: !!mine?.partial };
            },
          }
        : {}),
      // A Teams or Messages conversation has a Slack-shaped id of its own (src/teams.ts teamsChannel, src/imessage.ts imessageChannel): its
      // history comes from Teams, or from Messages on this Mac.
      ...(slack.config || teamsCfg.config || imessageCfg.config
        ? {
            slackHistory: (ch, o) =>
              isTeamsChannel(ch)
                ? teamsRef.reader ? teamsRef.reader.history(ch, o) : Promise.reject(new Error("Teams is not ready"))
                : isImessageChannel(ch)
                  ? imessageRef.reader ? imessageRef.reader.history(ch, o) : Promise.reject(new Error("Messages is not ready"))
                  : slackRef.reader ? slackRef.reader.history(ch, o) : Promise.reject(new Error("Slack is not ready")),
          }
        : {}),
      // Chasing what others owe the owner (src/followups/chase.ts): each tone written in a run of its own, from the loop, that person's own
      // words and what the owner's memory says of them (the tone), held to those facts (src/brief-v2.ts draftFor). Only with the written brief.
      ...(smartCfg.config
        ? {
            chaseDraft: async (o) => {
              if (!smartRef.brief) return false;
              const block = o.loop.who && personRef.c ? await personRef.c.about(o.loop.who, { exclude: [o.loop.id] }).catch(() => null) : null;
              const about = {
                ...(o.loop.who ? { who: o.loop.who } : {}), where: o.loop.where.label, ...(o.loop.where.channel ? { channel: o.loop.where.channel } : {}),
                ...(o.loop.where.thread ? { thread: o.loop.where.thread } : {}),
              };
              const task = await smartRef.brief.draftFor({
                title: o.title, request: o.request, chase: { loop: o.loop.id, tone: o.tone }, about,
                facts: [...o.facts, ...(block ? [{ label: `People · ${block.name}`, text: block.text }] : [])], ...(block?.own.length ? { allow: block.own } : {}),
              });
              return !!task && task.status !== "failed";
            },
          }
        : {}),
      ...(box
        ? {
            mailOf: async (ref: string) => {
              const m = await box.get(ref);
              return m ? { address: addressOf(m.from), name: senderName(m.from), subject: m.subject, text: (await box.body(ref).catch(() => "")) || m.preview } : null;
            },
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
