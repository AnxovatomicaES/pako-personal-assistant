// The read-only views the server answers by itself (src/intents.ts): the mail, the agenda, the brief, Zoom, the meetings' to-dos, the
// rehearsal, Pako's health, the follow-ups, the bookings, Slack and the action log.

import { logText } from "../control.ts";
import { createPersonContext } from "../person-context.ts";
import { matchView, VIEW_COMMAND, type View } from "../intents.ts";
import type { Loop } from "../followups/types.ts";
import type { Door } from "./door.ts";
import type { Handler } from "./incoming.ts";
import { createLog } from "../log.ts";

const logCalendar = createLog("calendar");
const logWatchdog = createLog("watchdog");

export function mountViews(door: Door): Pick<Door, "viewOn"> {
  const { d } = door;
  /** Whether this server answers a view by itself (its feature is on); a view that is off is the assistant's to answer. */
  const viewOn = (v: View): boolean =>
    v === "followups" ? !!d.followups
    : v === "brief" ? !!d.brief
    : v === "slack" ? !!d.slack
    : v === "meeting-todos" ? !!d.reviews
    : v === "reminders" ? true
    : v === "health" ? !!d.status
    : v === "rehearsal" ? !!d.rehearsal
    : !!d.calendar;

  return { viewOn };
}

/**
 * The owner's own words for a read-only view (src/intents.ts): "what's pending?", "my agenda tomorrow", "anything on Slack?" are read
 * as PENDING, CALENDAR TOMORROW and SLACK, when that view is on here. Anything less clear, or a view that is off, goes to Claude as before.
 * It never answers by itself: it only changes the command the steps after it read.
 */
export const onView: Handler = async (door, msg) => {
  const view = matchView(msg.text);
  if (view && door.viewOn(view)) msg.command = VIEW_COMMAND[view];
  return null;
};

/**
 * The commands below are English words, like every fixed text of Pako's (the accents and capitals are gone from `command`). "Email" alone
 * is left to the assistant: it is the usual one-word answer to a question ("by WhatsApp or by email?").
 */
export const onMail: Handler = async (door, { command }) => {
  const { d, sendText } = door;
  if (d.mail?.digest && /^(mail|inbox)$/.test(command)) {
    await sendText(await d.mail.digest());
    return "mail digest shown";
  }
  return null;
};

export const onAgenda: Handler = async (door, { command }) => {
  const { d, tx, sendText } = door;
  const agenda = d.calendar ? /^(agenda|calendar)(?: (today|tomorrow))?$/.exec(command) : null;
  if (d.calendar && agenda) {
    try {
      const days = agenda[2] === "today" ? [0] : agenda[2] ? [1] : [0, 1];
      await sendText((await Promise.all(days.map((n) => d.calendar!.day(n)))).join("\n\n"));
    } catch (err) {
      logCalendar.error(`${(err as Error).message}`);
      await sendText(tx("calendarUnread"));
    }
    return "agenda shown";
  }
  return null;
};

/** Answered while paused too: the owner's own day is not an action STOP holds. "Today's brief" loses its apostrophe to the clean-up above. */
export const onBrief: Handler = async (door, { command }) => {
  const { d, sendText } = door;
  if (d.brief && /^(brief|daily brief|todays brief|today s brief|briefing)$/.test(command)) {
    await sendText(await d.brief.now());
    return "brief shown";
  }
  return null;
};

export const onZoom: Handler = async (door, { command }) => {
  const { d, tx, sendText } = door;
  if (d.zoom && /^(zoom|meetings)$/.test(command)) {
    const [up, done] = await Promise.all([d.zoom.upcoming().catch(() => [] as string[]), d.zoom.summaries().catch(() => [] as string[])]);
    const parts = [up.length ? tx("zoomUpcoming", { list: up.slice(0, 10).map((l) => `• ${l}`).join("\n") }) : tx("zoomNone")];
    if (done.length) parts.push(tx("zoomSummaries", { list: done.slice(0, 5).map((l) => `• ${l}`).join("\n") }));
    await sendText(parts.join("\n\n"));
    return "zoom shown";
  }
  return null;
};

export const onMeetingTodos: Handler = async (door, { command }) => {
  const { d, sendText } = door;
  if (d.reviews && /^(meeting todos|meeting todo|meetings todos)$/.test(command)) {
    await sendText(await d.reviews.command());
    return "meeting todos shown";
  }
  return null;
};

/** A dry run of the follow-ups and the brief on what Pako already keeps (src/rehearsal.ts): nothing is sent, nothing changes. */
export const onRehearsal: Handler = async (door, { command }) => {
  const { d, sendText } = door;
  if (d.rehearsal && /^(rehearsal|rehearse|dry run)$/.test(command)) {
    await sendText((await d.rehearsal.start()).text);
    return "rehearsal started";
  }
  return null;
};

/** How Pako is doing (src/watchdog.ts) and how useful its nudges were this week (src/quality.ts): read only, answered while paused too. */
export const onHealth: Handler = async (door, { command }) => {
  const { d, tx, sendText } = door;
  if (d.status && /^(health|status)$/.test(command)) {
    const blocks = await d.status.summary().catch((err: Error) => {
      logWatchdog.error(`the summary failed: ${err.message}`);
      return [] as string[];
    });
    await sendText([...blocks.filter(Boolean), ...(d.rehearsal ? [tx("healthRehearsal")] : [])].join("\n\n") || tx("healthUnread"));
    return "health shown";
  }
  return null;
};

/**
 * DRAFT (after a reminder: that one) or DRAFT and a few words of a follow-up: the message the owner sends to close it, written in a run of
 * its own from the loop and what Pako knows of that person, and told in the chat. Nothing is sent: the owner copies it and presses send.
 */
export const onDraft: Handler = async (door, { command }) => {
  const { d, sendText, tx } = door;
  const m = /^draft(?: (?:for |to |a reply to |reply to )?(.{2,80}))?$/.exec(command);
  if (!m || !d.followups?.forDraft || !d.followups.draftFacts || !d.draftFor) return null;
  const found = await d.followups.forDraft(m[1] ?? "").catch(() => ({ none: true as const }));
  if ("none" in found) {
    await sendText(m[1] ? tx("draftNone", { words: m[1] }) : tx("draftNoneAny"));
    return "draft: none";
  }
  if ("many" in found) {
    await sendText(tx("draftMany", { list: found.many.map((x) => `• ${x}`).join("\n") }));
    return "draft: which";
  }
  const l = found.loop;
  const task = await draftLoop(door, l);
  await sendText(task && task.status !== "failed" ? tx("draftWorking", { title: l.title }) : tx("draftFailed"));
  return "draft asked";
};

/**
 * The draft for one loop: written in a run of its own from the loop, what Pako knows of that person and the day's facts (src/brief-v2.ts
 * draftFor). Used by DRAFT in the chat and by the phone's "Draft a reply" (src/mobile.ts). Null when it could not be asked for.
 */
export async function draftLoop(door: Door, l: Loop): Promise<{ id?: string; status: string } | null> {
  const { d, facts, lang } = door;
  if (!d.followups?.draftFacts || !d.draftFor) return null;
  // What the owner's memory says about that person (src/person-context.ts): who they are to the owner (the draft's tone), what was last
  // agreed, what else is open between them. Data for the draft, never sent anywhere; this loop itself is D1, so it is not repeated.
  const ctx = d.personContext
    ?? ((who: string, o?: { exclude?: string[] }) => createPersonContext({
      facts: () => facts.read(), graph: async () => (await door.idGraph.read()).persons, timeZone: d.timeZone, lang,
    }).about(who, o));
  const block = l.who ? await ctx(l.who, { exclude: [l.id] }).catch(() => null) : null;
  const about = block ? [{ label: `People · ${block.name}`, text: block.text }] : [];
  // A loop from an email: the draft remembers that email, so it can come back as a reply the owner sends with one press.
  const mailRef = l.sources.find((s) => s.kind === "mail" && s.ref)?.ref;
  // Whom and where it goes: what the owner then sends there is compared with the draft, and what they changed is learnt (src/lessons.ts).
  const to = { ...(l.who ? { who: l.who } : {}), where: l.where.label, ...(l.where.channel ? { channel: l.where.channel } : {}) };
  return d.draftFor({
    title: l.title, facts: [...d.followups.draftFacts(l), ...about], ...(mailRef ? { mailRef } : {}), about: to, ...(block?.own.length ? { allow: block.own } : {}),
  })
    .catch(() => null);
}

export const onFollowups: Handler = async (door, { command }) => {
  const { d, sendText } = door;
  if (d.followups && /^(pending|open|open loops)$/.test(command)) {
    await sendText(await d.followups.command());
    return "followups shown";
  }
  return null;
};

/**
 * Gentle mode's Parked list (src/gentle.ts): "what did I park?" lists it, "bring back <words>" puts one back on the open list. Read at once
 * by the server, like PENDING; a server without follow-ups lets the words go on to the assistant.
 */
export const onParked: Handler = async (door, { command }) => {
  const { d, sendText } = door;
  if (!d.followups?.parkedText || !d.followups.unpark) return null;
  if (/^(what did i park|what have i parked|what s parked|what is parked|parked|parked items|my parked items|show parked|show my parked items)$/.test(command)) {
    await sendText(await d.followups.parkedText());
    return "parked shown";
  }
  const back = /^(?:bring back|unpark)\s+(.{2,80})$/.exec(command);
  if (back) {
    const r = await d.followups.unpark({ words: back[1]! });
    await sendText(r.say);
    return r.ok ? "unparked" : "unpark asked";
  }
  return null;
};

/** "reopen <words>": a follow-up Pako closed on its own (listed in the brief as closed for you) back on the open list. */
export const onReopen: Handler = async (door, { command }) => {
  const { d, sendText } = door;
  if (!d.followups?.reopenByWords) return null;
  const m = /^(?:reopen|re open)\s+(.{2,80})$/.exec(command);
  if (!m) return null;
  const r = await d.followups.reopenByWords(m[1]!);
  // A close the owner undid: counted, so the beta report shows how often Pako closes on weak evidence.
  if (r.ok) await d.quality?.reopened?.(m[1]!).catch(() => undefined);
  await sendText(r.say);
  return r.ok ? "reopened" : "reopen asked";
};

/**
 * "you missed <what>": a promise Pako never caught. Kept as a miss (for the evals and the beta report) and put on the open list, so it is not
 * dropped twice. Read by the server, like PENDING.
 */
export const onMissed: Handler = async (door, { command, text }) => {
  const { d, sendText } = door;
  if (!d.quality?.missed) return null;
  const m = /^(?:pako )?(?:you missed|you forgot|you didn t catch|you did not catch)\s+(.{3,160})$/.exec(command);
  if (!m) return null;
  // The owner's own words, as typed (the command is folded): the loop's title.
  const raw = text.trim().replace(/^\s*(?:pako[\s,:]+)?(?:you\s+missed|you\s+forgot|you\s+didn['’]?t\s+catch|you\s+did\s+not\s+catch)\s*:?\s*/i, "").slice(0, 160);
  const what = raw.length >= 3 ? raw : m[1]!;
  const loop = d.followups?.fromChat ? await d.followups.fromChat({ title: what }).catch(() => null) : null;
  // With the follow-up it made: the beta's audit counts it as told, never as one Pako caught.
  await d.quality.missed(what, loop?.id);
  await sendText(d.quality.missedText ? d.quality.missedText(loop ? loop.title : null) : "Noted.");
  return "missed";
};

/** "park 2" after a weekly reset (src/gentle-reset.ts), where the chat shows three buttons: anything else goes on. */
export const onResetPark: Handler = async (door, { command }) => {
  const { d, sendText } = door;
  const m = /^park ([1-3])$/.exec(command);
  if (!m || !d.gentle?.resetTyped) return null;
  const say = await d.gentle.resetTyped(Number(m[1]));
  if (say === null) return null;
  await sendText(say);
  return "reset item parked";
};

export const onBookings: Handler = async (door, { command }) => {
  const { d, sendText } = door;
  if (d.booking && /^(bookings|my bookings)$/.test(command)) {
    await sendText(await d.booking.list());
    return "bookings shown";
  }
  return null;
};

export const onSlack: Handler = async (door, { command }) => {
  const { d, tx, sendText } = door;
  if (d.slack && /^slack$/.test(command)) {
    const lines = await d.slack.recent().catch(() => [] as string[]);
    await sendText(lines.length ? tx("slackRecent", { n: lines.length, list: lines.slice(-20).map((l) => `• ${l}`).join("\n") }) : tx("slackNone"));
    return "slack shown";
  }
  return null;
};

export const onLog: Handler = async (door, { command }) => {
  const { d, lang, tx, sendText } = door;
  if (d.control && /^log$/.test(command)) {
    await sendText(tx("logShown", { log: logText(await d.control.recent(15), d.timeZone, lang()) }));
    return "log shown";
  }
  return null;
};
