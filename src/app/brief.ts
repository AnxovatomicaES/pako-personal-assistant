// Wires the daily brief and the written brief (src/brief.ts, src/brief-v2.ts), the demo's live brief, gentle mode's time anchors and
// the meeting prep.

import { createBriefV2 } from "../brief-v2.ts";
import { createBrief } from "../brief.ts";
import { createTimeAnchors } from "../gentle.ts";
import type { Lang } from "../i18n.ts";
import { createLog } from "../log.ts";
import { addressOf } from "../mail.ts";
import { createMeetingPrep, loadMeetingPrepConfig } from "../meeting-prep.ts";
import { briefMeetings } from "../meeting-review.ts";
import type { AfterCalendar } from "./context.ts";

const logBrief = createLog("brief");
const logCalendar = createLog("calendar");

export function wireBrief(ctx: AfterCalendar) {
  const {
    env, uiLang, demo, kv, control, timeZone, givenName, mail, imap, box, slack, slackRef, fakeSlack, zoom, zoomRef, reviewRef, calOn, calRef,
    calChangesRef, icsRef, backfillRef, briefCfg, briefRef, smartCfg, smartRef, followupsCfg, followupsRef, personRef, gentleSettings, gentleRef,
    followupsDoor, lessons, quality, publicUrl, door, claudeLive, phoneLink, timeRef,
  } = ctx;
  // The morning brief, then one waiting "is this the same person?" question with its buttons (at most one a day).
  const briefSent = async (text: string): Promise<void> => {
    await door.notifyOwner(text, { urgent: true });
    await door.askSamePerson().catch(() => false);
  };
  // The daily brief says whatever is connected: each calendar's today, the door's reminders and tasks, and one line from the mail and Slack
  // (each writes its own, in the language of the brief). Urgent, like a meeting about to start: it is the one message a day that must arrive.
  const briefReader = (briefRef.reader = createBrief({
    at: briefCfg.at,
    kv,
    timeZone,
    control,
    lang: uiLang,
    name: givenName,
    calendars: calOn ? [() => (calRef.reader ? calRef.reader.todayRead() : Promise.resolve([]))] : [],
    // A birthday's reminder is said once, on the birthdays line below, not again among the reminders.
    reminders: async () => (await door.reminders()).filter((r) => !r.birthday),
    // The tasks due today or overdue (src/lists.ts): its own line, only when there is one.
    extras: [
      () => (box ? box.brief() : Promise.resolve(null)),
      () => (slackRef.reader ? slackRef.reader.brief() : fakeSlack ? fakeSlack.brief() : Promise.resolve(null)),
      // A new mailbox's catch-up, once it is done: "From the last 14 days (mail): …", once.
      async () => (backfillRef.b ? backfillRef.b.briefLine() : null),
      // A private calendar link that stopped working: said once here (its row on the connections page says it for as long as it lasts).
      async () => icsRef.source?.brokenNews(uiLang()) ?? null,
      () => door.tasksBrief(),
      // Today's birthdays (src/people.ts): their own line, only when there is one.
      () => door.birthdaysBrief(),
      // What changed since yesterday (src/memory-facts.ts): a meeting moved, a new value told; only when something did.
      (o) => door.changesBrief(o.since),
      // Monday only, and only when the week's nudges did poorly: one line (src/quality.ts).
      () => (quality ? quality.monday() : Promise.resolve(null)),
    ],
    // Gentle mode: the week's focus first (src/gentle-reset.ts); check-ins kept for the brief after it (src/gentle-checkins.ts).
    // And the follow-ups at risk for want of free time, with their focus block (src/time-to-do.ts).
    first: [
      async () => (gentleRef.reset ? gentleRef.reset.briefLine() : null), async () => (gentleRef.checkins ? gentleRef.checkins.briefLine() : null),
      async () => (timeRef.t ? timeRef.t.briefLine() : null),
    ],
    notify: briefSent,
    notifyNote: (text) => door.notifyOwner(text, { urgent: true }),
    ...(smartCfg.config
      ? {
          smart: {
            begin: (t: number, o?: { since: number }) => (smartRef.brief ? smartRef.brief.begin(t, false, o?.since) : Promise.resolve(false)),
            short: () => (smartRef.brief ? smartRef.brief.short() : Promise.resolve(null)),
          },
        }
      : {}),
  }));
  if (smartCfg.config) {
    // What the written brief reads: each part looked up when the brief is gathered, so a connection made later counts.
    smartRef.brief = createBriefV2({
      config: smartCfg.config,
      kv,
      timeZone,
      control,
      lang: uiLang,
      ownerLanguage: () => door.language(),
      name: givenName,
      sources: {
        ...(followupsCfg.config ? { loops: () => (followupsRef.engine ? followupsRef.engine.open() : Promise.resolve([])) } : {}),
        ...(zoom.config
          ? {
              // Zoom's summaries with the review's outcomes; its to-dos only when no engine keeps them as loops (one source of truth).
              meetings: async () => {
                if (!zoomRef.reader) throw new Error("Zoom is not ready");
                const list = await zoomRef.reader.recent(7);
                const reviews = reviewRef.reviewer ? await reviewRef.reviewer.read() : [];
                return briefMeetings(list, reviews, { now: Date.now(), days: 7, ownItems: !followupsCfg.config });
              },
              zoom: () => (zoomRef.reader ? zoomRef.reader.scheduled() : Promise.reject(new Error("Zoom is not ready"))),
            }
          : {}),
        ...(slack.config ? { slack: () => (slackRef.reader ? slackRef.reader.alerts() : Promise.reject(new Error("Slack is not ready"))) } : {}),
        ...(fakeSlack ? { slack: fakeSlack.alerts } : {}),
        ...(calOn ? { events: () => (calRef.reader ? calRef.reader.load() : Promise.reject(new Error("the calendar is not ready"))) } : {}),
        tasks: async () => (await door.lists.read(true)).tasks,
        ...(box ? { mail: () => box.items(60) } : {}),
        birthdays: () => door.birthdaysBrief(),
        reminders: async () => (await door.reminders()).filter((r) => !r.birthday),
        ...(calOn ? { calendarChanges: (since: number) => (calChangesRef.c ? calChangesRef.c.since(since) : Promise.resolve([])) } : {}),
        // What the owner's memory says of the day's people (src/person-context.ts): one block each, at most three.
        people: async (words: string[]) => (personRef.c ? (await personRef.c.many(words)).map((b) => ({ name: b.name, text: b.text })) : []),
        // Gentle mode's week's focus (src/gentle-reset.ts): that follow-up first among the facts.
        focusLoop: async () => (gentleRef.reset && (await gentleSettings.view()) ? ((await gentleRef.reset.focus())?.loop ?? null) : null),
      },
      // A to-do for a follow-up parked since the brief was written is never shown (gentle mode).
      ...(followupsCfg.config ? { parkedIds: async () => (await followupsDoor.parked!()).map((l) => l.id) } : {}),
      // What Pako closed on its own since the last brief, with why: listed after it, so no close is silent ("reopen <words>" undoes one).
      ...(followupsCfg.config ? { closedForYou: (since: number) => followupsDoor.closedForYou!(since) } : {}),
      // And first in the chat's version, with the check-ins kept for the brief (src/gentle-checkins.ts).
      weekFocus: async () => {
        const lines = [
          gentleRef.reset ? await gentleRef.reset.briefLine() : null, gentleRef.checkins ? await gentleRef.checkins.briefLine() : null,
          timeRef.t ? await timeRef.t.briefLine() : null,
        ];
        return lines.filter((x): x is string => !!x).join("\n") || null;
      },
      enqueue: (m) => door.inbox.add(m),
      // The computer asked for messages in the last three minutes: otherwise the old brief goes at once rather than after the wait.
      bridgeAlive: () => Date.now() - door.lastPoll() < 3 * 60_000,
      plain: (o) => (briefRef.reader ? briefRef.reader.plain(o) : Promise.resolve()),
      // What changed since the last brief (src/memory-facts.ts): its line under the written brief, as under the old one.
      changes: (since) => door.changesBrief(since),
      notify: briefSent,
      tell: (text) => door.notifyOwner(text),
      // A chase's draft goes back to its follow-up, which shows both tones on one card (src/followups/chase.ts).
      ...(followupsCfg.config ? { chaseWritten: (o: { loop: string; tone: "gentle" | "firm"; text: string }) => followupsDoor.chaseWritten!(o) } : {}),
      lessons: (q) => lessons.lines(q),
      // A draft written for the chat: kept to compare with what the owner sends to that conversation or address (src/lessons.ts).
      drafted: async (o) => {
        const m = o.mailRef && box ? await box.get(o.mailRef).catch(() => null) : null;
        const address = m ? addressOf(m.from) : "";
        await lessons.drafted({ text: o.text, ...o.about, ...(address ? { address } : {}) });
      },
      // A draft answering an email comes back as a reply on the email card: the email's sender and subject from the mailbox.
      ...(box
        ? {
            offerSend: async (o: { mailRef: string; title: string; text: string }) => {
              const m = await box.get(o.mailRef);
              if (m) await door.offerDraftSend({ from: m.from, subject: m.subject, title: o.title, text: o.text });
            },
          }
        : {}),
      url: () => publicUrl() || null,
      phone: phoneLink,
      ...(followupsCfg.config ? { closeLoop: (id: string) => followupsDoor.press("1", id) } : {}),
      tickTask: (id: string, done: boolean) => door.lists.tickTask(id, done, Date.now()),
      ...(quality ? { quality: { monday: () => quality.monday(), line: (l: Lang) => quality.briefLine(l), asked: quality.briefAsked } } : {}),
    });
    smartRef.brief.start();
    // The demo week with Claude signed in: a fresh brief is written from the demo's facts once the bridge asks for work (it replaces
    // the recorded one). Tried for ten minutes after the start, once.
    if (demo) {
      const brief = smartRef.brief;
      const started = Date.now();
      const live = setInterval(() => {
        if (Date.now() - started > 10 * 60_000) return void clearInterval(live);
        if (!claudeLive() || Date.now() - door.lastPoll() > 60_000) return;
        clearInterval(live);
        void brief.begin(Date.now(), true).catch((err: Error) => logBrief.error(`the demo's live brief: ${err.message}`));
      }, 5000);
      live.unref?.();
    }
    // A meeting's prep by itself, about 40 minutes before it (src/meeting-prep.ts): the meeting, what is open with its people, what
    // Pako knows of them. MEETING_PREP=off turns it off.
    if (calOn && loadMeetingPrepConfig(env).on) {
      const brief = smartRef.brief;
      const prep = createMeetingPrep({
        kv, timeZone,
        events: () => (calRef.reader ? calRef.reader.load() : Promise.reject(new Error("the calendar is not ready"))),
        ...(followupsCfg.config ? { loops: () => (followupsRef.engine ? followupsRef.engine.open() : Promise.resolve([])) } : {}),
        // What the owner's memory says of its people (src/person-context.ts); the open follow-ups with them come apart, as their own facts.
        about: async (words) =>
          (personRef.c ? await personRef.c.many(words, { loops: false }) : []).map((b) => ({ label: `People · ${b.name}`, text: b.text })),
        self: () => [mail.config?.inbox, imap.config?.user].filter((x): x is string => !!x),
        prep: (o) => brief.prepMeeting(o),
        clock: (t) => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t),
      });
      setInterval(() => void prep.tick().catch((err: Error) => logCalendar.error(`meeting prep: ${err.message}`)), 5 * 60_000).unref?.();
    }
  }
  // Gentle mode's time anchors (src/gentle.ts): "leave now" or "wrap up" before a meeting, and "your call starts in 5" when nothing shows
  // the owner saw it. A look every minute; nothing at all while gentle mode is off. Not tied to the written brief: with BRIEF_SMART=off
  // they were never built, and gentle mode lost them in silence (audit finding).
  gentleRef.anchors = createTimeAnchors({
    kv, timeZone, settings: () => gentleSettings.view(),
    events: () => (calRef.reader ? calRef.reader.load() : Promise.reject(new Error("the calendar is not ready"))),
    quiet: followupsCfg.config?.quiet ?? null,
    lastOwner: () => door.lastOwner(),
    card: (body, buttons) => door.sendCard(body, buttons),
    log: (text) => control.log("followup", text),
  });
  const anchors = gentleRef.anchors;
  setInterval(() => void anchors.tick(), 60_000).unref?.();
  return { briefReader };
}
