// What mountWhatsapp gives the rest of Pako: the door's functions for the panel, the channels, the brief and the proactive check.

import type { Every } from "../undo.ts";
import { briefLine } from "../lists.ts";
import { birthdaysBrief } from "../people.ts";
import { changesBrief } from "../memory-facts.ts";
import type { OwnerChannel } from "./deps.ts";
import { TEMPLATE_TEXT_MAX } from "./shared.ts";
import type { Door } from "./door.ts";

export function doorApi(door: Door) {
  const {
    d, config, now, lang, inbox, lists, people, facts, idGraph, companion, routines, papers, events, note, via, startedRoute, reachable,
    ownerLanguage, graph, sendText, startBooking, askCall, loadReminders, windowOpen, addReminder, sendReminderTemplate, runReminders, hold,
    notifyOwner, askSame, peopleDoor, handleMessage, deliverBooking, removeReminderById,
  } = door;
  return {
    inbox,
    /** The friend, health companion and teacher (src/companion.ts): its `offers` are for the proactive check. */
    companion,
    /**
     * A card with up to three buttons, when the owner can be written to now (the 24-hour window, Telegram or the panel's chat); false when it
     * could not go (the caller keeps a plain notice instead). For src/followups.ts.
     */
    sendCard: async (
      body: string, buttons: { id: string; title: string }[], feedback?: { buttons: { id: string; title: string }[]; line: string },
    ): Promise<boolean> => {
      if (!d.local && !(await reachable(now()))) return false;
      // `feedback` (src/quality.ts): its 👍/👎 after the three where the chat has room (Telegram, the panel's chat), else its line under the text.
      const roomy = !!d.local || ((via.getStore() ?? (await startedRoute())) === "telegram" && !!d.telegram);
      const all = [...buttons.slice(0, 3), ...(feedback && roomy ? feedback.buttons.slice(0, 2) : [])];
      const text = feedback && !roomy ? `${body}\n${feedback.line}` : body;
      return graph({
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: text.slice(0, 1000) },
          action: { buttons: all.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) },
        },
      });
    },
    lastPoll: () => door.lastPollAt,
    /** When the owner last wrote (ms; 0: not since this start): proactive Pako speaks only when they have been quiet a while. */
    lastOwner: () => Math.max(door.lastHeardAt, door.lastOwnerAt),
    /** A reminder at "YYYY-MM-DD HH:MM" in the owner's zone, as the <remind> tag sets one (src/proactive.ts: an offer pressed). */
    remindAt: async (when: string, text: string): Promise<{ ok: boolean; say: string }> => {
      const r = await addReminder(when, text);
      return { ok: r.ok, say: r.say };
    },
    runReminders,
    notifyOwner,
    /**
     * A message the owner typed (or a button pressed) in the panel's chat, handled like one that came from WhatsApp; or, with "telegram", one
     * the Telegram channel received from the paired account.
     */
    ingest: (m: Record<string, unknown>, channel: OwnerChannel = "base"): Promise<string> => handleMessage(m, channel),
    /** The number local messages carry as their sender (the owner's). */
    ownerFrom: config.ownerDigits,
    /** A message to the owner on a given chat. */
    tellOwner: (text: string, channel: OwnerChannel): Promise<boolean> => via.run(channel, () => sendText(text)),
    /**
     * A notice that belongs on the door's own chat (Telegram's pairing: a new account must not be the one told): sent there while it can
     * arrive, otherwise by the notice template, otherwise kept until the owner next writes.
     */
    tellBase: async (text: string): Promise<void> => {
      if (d.local || (await windowOpen(now()))) {
        if (await via.run("base", () => sendText(text))) return;
      }
      const flat = text.replace(/\s+/g, " ").trim();
      if (config.reminderTemplate && flat.length <= TEMPLATE_TEXT_MAX && (await sendReminderTemplate(flat))) return;
      await hold(text);
    },
    /** For the connector's book_restaurant tool: the same search and card as the assistant's <book> tag. */
    startBooking,
    /** For Maître (src/maitre/): a booking reply told later (a Handoff that ended by itself), and the reminder of a confirmed table. */
    deliverBooking,
    remindBooking: async (when: string, text: string): Promise<string | null> => (await addReminder(when, text)).added?.id ?? null,
    unremindBooking: async (id: string): Promise<void> => void (await removeReminderById(id)),
    /** For the connector's call_contact tool: the owner's card; nothing rings unless they press Call. */
    askCall,
    /** For the owner's panel: the pending reminders, and what happened to proposed calls and messages. */
    /** `birthday`: a person's yearly one (src/people.ts), which the brief leaves to its own birthdays line. */
    reminders: async (): Promise<{ at: number; text: string; held: boolean; every?: Every; birthday?: true }[]> =>
      (await loadReminders()).map((r) => ({
        at: r.at, text: r.text, held: r.held, ...(r.every ? { every: r.every } : {}), ...(r.birthday ? { birthday: true as const } : {}),
      })),
    /** The owner's lists and tasks (src/lists.ts), for the panel. */
    lists,
    /** The people in the owner's life (src/people.ts), for the panel: changes made there get the same reminders and receipt as a command. */
    people: peopleDoor,
    /** The morning brief's line for today's birthdays (src/people.ts), in the language of Pako's texts; null when there is none. */
    birthdaysBrief: async (): Promise<string | null> => {
      try {
        return birthdaysBrief(await people.read(true), now(), d.timeZone, lang());
      } catch {
        return null;
      }
    },
    /** The owner's routines and watches (src/routines.ts), for the panel and the tests' clock. */
    routines,
    /** Where the papers the owner sends are kept (src/papers.ts): the panel's chat puts its files here before they come in as a message. */
    papers,
    /** The morning brief's line for the tasks due today (src/lists.ts briefLine), in the language of Pako's texts; null when there is none. */
    tasksBrief: async (): Promise<string | null> => {
      try {
        return briefLine(await lists.read(true), now(), d.timeZone, lang());
      } catch {
        return null;
      }
    },
    events: (): { at: number; text: string }[] => events.map((e) => ({ at: e.at, text: e.text })),
    /** A line for the assistant's context, as the door's own events (the store guard's pause, which is not the owner's STOP). */
    note,
    /** The owner's language as a two-letter code (PAKO_LANGUAGE, else the last one heard from them, else the one of Pako's own texts). */
    language: ownerLanguage,
    /** Dated facts (src/memory-facts.ts) and people with identities (src/people-graph.ts): what Slack, the mail, the calendar and Zoom feed. */
    facts,
    peopleGraph: idGraph,
    /** One waiting "Is this the same person?" question as a card (after the morning brief); false when none waits or it could not go. */
    askSamePerson: async (): Promise<boolean> => {
      if (now() - door.sameAskedAt < 20 * 3600_000) return false;
      const ok = await askSame();
      if (ok) door.sameAskedAt = now();
      return ok;
    },
    /** What the Mac app did with a calendar write (src/calendar-writes.ts): the receipt with Undo, or what went wrong. */
    calendarResult: (w: Parameters<Door["calendarResult"]>[0]): Promise<void> => door.calendarResult(w),
    /** A draft answering an email, offered as a reply on the email card (src/brief-v2.ts offerSend). */
    offerDraftSend: (o: { from: string; subject: string; title: string; text: string }): Promise<void> => door.offerDraftSend(o),
    /** The morning brief's line for what changed since the last brief (yesterday's, or before when one was skipped); null when nothing did. */
    changesBrief: async (since?: number): Promise<string | null> => {
      try {
        return changesBrief(await facts.read(), now(), lang(), d.timeZone, since);
      } catch {
        return null;
      }
    },
  };
}
