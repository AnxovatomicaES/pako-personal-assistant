// What the assistant is told before it answers: the owner's notes, reminders, lists, people and the door's recent events.

import { locale } from "../i18n.ts";
import { memoryText } from "../voice-memory.ts";
import { contextLines } from "../lists.ts";
import { peopleContext } from "../people.ts";
import { helpLine } from "../health.ts";
import { localStamp } from "./time.ts";
import { EVENT_KEEP_MS } from "./shared.ts";
import type { Door } from "./door.ts";
import { createLog } from "../log.ts";

const log = createLog("facts");

export function mountContext(door: Door): void {
  const {
    app, d, now, lang, lists, people, companion, routines, paperSummaries, events, hhmm, ownerLanguage, chatLanguage, sawContext, reminderLines,
    withRecall, failed, bridge,
  } = door;
  /**
   * What the assistant needs to know to answer: the date, the contact names and the notes it keeps (the same ones the voice line reads).
   * `language` is the owner's (for summaries nobody asked for); `uiLanguage` is the one of Pako's own fixed texts, always "en": sent all the
   * same, because an older bridge writes its own lines in Spanish when it is missing.
   */
  app.get("/assistant/context", failed, bridge, async (_req, res) => {
    const at = now();
    const ctx = {
      // In English, like the lines the bridge writes around it (uiLanguage below), dated the way the owner's country writes English.
      now: new Intl.DateTimeFormat(locale(lang()), {
        timeZone: d.timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
      }).format(at),
      ownerName: d.ownerName,
      timeZone: d.timeZone,
      contacts: d.contacts(),
      memory: memoryText(await d.memory.read(), d.timeZone),
      events: events.filter((e) => at - e.at < EVENT_KEEP_MS).map((e) => `${hhmm(e.at)} ${e.text}`),
      nowLocal: localStamp(at, d.timeZone),
      reminders: await reminderLines(),
      // Briefly, so Claude can answer "what's on my shopping list" (an older bridge ignores them); left out when the store cannot be read.
      ...(await lists.read(true).then(contextLines, () => ({}))),
      // The people in the owner's life: names and relations (at most 30), and each record for the bridge to give Claude only when the
      // owner's message names that person. Never a contact's number. An older bridge ignores both; left out when the store cannot be read.
      // With what Pako knows now about each (src/memory-facts.ts), what changed in the last days, and that <know> is kept here.
      ...(await (async () => {
        const base = await people.read(true).then((list) => peopleContext(list, lang(), (name) => !!d.contactByName?.(name)), () => null);
        return withRecall(base).catch((err: Error) => (log.error(`no recall in the context: ${err.message}`), base ?? {}));
      })()),
      // Learning goals and the coming birthdays (src/companion.ts), and that this server keeps the diary, goals and cards; never the diary itself.
      // Without Labs (PAKO_LABS) the bridge drops those tags, and the assistant is told they are off so it never says it kept one.
      ...(companion.labs ? { companion: 1 } : { labsOff: 1 }),
      // Which labs are on (src/labs.ts): a newer bridge leaves table booking and phone calls out of the prompt and the tools when not listed.
      ...(d.labsOn ? { labsOn: [...d.labsOn] } : {}),
      ...(await companion.context().catch(() => ({}))),
      // The owner's routines and watches, and that this server makes them (a newer bridge drops <routine> and <watch> for a server without it).
      routinesOn: 1,
      // This server sorts a brain dump (<dump>, brain_dump: src/door/dump.ts); an older one does not say so, and a newer bridge then turns the
      // items into its ordinary tags instead.
      dumpOn: 1,
      // This server keeps check-ins (<checkin>, check_in: src/gentle-checkins.ts); an older one does not say so, and the bridge drops them.
      ...(d.gentle?.checkinAdd ? { checkinOn: 1 } : {}),
      ...((await routines.contextLines()) ?? {}),
      ...(d.mail ? { mailAddress: d.mail.address, emails: await d.mail.recent().catch(() => []) } : {}),
      ...(await (async () => {
        // `paused` as always (an older bridge reads only it), and why: a newer one does not tell Claude the owner wrote STOP when they did not.
        const pause = d.control ? await d.control.state() : null;
        return { paused: !!pause && pause.paused !== null, pauseWhy: pause?.why ?? null };
      })()),
      language: await ownerLanguage(),
      // This server holds the tags of a turn the bridge marks as outside text (src/quarantine.ts); a bridge that sees no such word drops them.
      // 2: it also takes `context` (new outside text in a turn's context lines) and holds only that reply's destructive and standing tags.
      quarantine: 2,
      // Which events carry someone else's words (Pako's own receipts do not): a newer bridge marks a turn only for those.
      outsideEvents: events.filter((e) => e.outside && at - e.at < EVENT_KEEP_MS).map((e) => `${hhmm(e.at)} ${e.text}`),
      // What the latest papers said (the bridge's isolated read), for the owner's next words about them; left out when there is none.
      ...(() => {
        const list = paperSummaries.filter((p) => at - p.at < 24 * 3600_000).map((p) => `${hhmm(p.at)} ${p.name ? `${p.name}: ` : ""}${p.summary}`);
        return list.length ? { papers: list } : {};
      })(),
      // The chat's fallback at the start of a conversation, for a message that shows no language ("ok 👍"): the one they write in, as heard.
      ...(await chatLanguage().then((code) => (code ? { chatLanguage: code } : {}))),
      uiLanguage: lang(),
      ...(d.booking ? { bookings: await d.booking.context().catch(() => [] as string[]) } : {}),
      ...(d.slack ? { slack: (await d.slack.recent().catch(() => [] as string[])).slice(-10) } : {}),
      ...(d.calendar ? { calendar: await d.calendar.context().catch(() => null) } : {}),
      // What Pako follows up (src/followups.ts), briefly, so Claude can answer "what am I forgetting"; an older bridge ignores it.
      ...(d.followups ? { followups: await d.followups.context().catch(() => [] as string[]) } : {}),
      // This Mac's app writes the calendar: a proposed change comes here (a card), not as a line for the owner to copy.
      ...(d.calendarWrites && (await d.calendarWrites.canWrite().catch(() => false)) ? { calendarWrites: 1 } : {}),
      // What the owner told about their tastes and plans (src/proactive.ts; never health), the emergency number, and that <fact> is kept here.
      ...(d.life ? { lifeOn: 1, ...(await d.life.context().catch(() => ({}))) } : {}),
      // The emergency number of the owner's country and its crisis line (src/health.ts), for the red-flag rule: always, also with proactive Pako off.
      emergency: helpLine(d.country ?? "", lang()),
      // The views the owner may ask for in any words ("what came out of my meetings?", "what's left from my brief?"), small, only when there is
      // something: what is still open from the week's meetings, and today's brief's to-dos not ticked yet. An older bridge ignores them.
      ...(await (d.reviews?.context?.() ?? Promise.resolve([])).catch(() => [] as string[]).then((l) => (l.length ? { meetingTodos: l } : {}))),
      ...(await (d.briefTodos?.() ?? Promise.resolve([])).catch(() => [] as string[]).then((l) => (l.length ? { briefTodos: l } : {}))),
      ...(d.zoom
        ? { zoom: { upcoming: (await d.zoom.upcoming().catch(() => [] as string[])).slice(0, 8), summaries: (await d.zoom.summaries().catch(() => [] as string[])).slice(0, 5) } }
        : {}),
      // This server decides by itself what goes at once (with a window to undo) and what asks (src/autonomy.ts); it takes <email> when it can
      // send mail, to the names here or an address. An older bridge ignores all three, and a newer one drops <email> without them.
      autonomy: 1,
      ...(d.sendEmail ? { emailOn: true, emailContacts: (d.contactEmails?.() ?? []).map((c) => c.name).slice(0, 50) } : {}),
    };
    sawContext(ctx);
    res.json(ctx);
  });
}
