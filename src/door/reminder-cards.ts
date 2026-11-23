// A reminder's card when it comes due (Done, +10 min, Tomorrow), the template outside the 24-hour window, and the answer to a card.

import { randomBytes } from "node:crypto";
import { whenText } from "../undo.ts";
import { localStamp, repeatAfter, localOrLater } from "./time.ts";
import { CARD_MAX, REMINDERS_MAX, TEMPLATE_TEXT_MAX, FIRED_KEEP_MS, FIRED_KEEP, SNOOZE_MS, cut } from "./shared.ts";
import type { Reminder, Fired, Door } from "./door.ts";
import { createLog } from "../log.ts";
import { readJsonRecord } from "../json-record.ts";

const log = createLog("whatsapp");

/** The reminders that fired with buttons: a press says which, and a second press finds it answered (a restart too). */
const FIRED_KEY = "assistant-reminders-fired";

export function mountReminderCards(door: Door): Pick<Door, "sendReminderTemplate" | "repeatNext" | "sendReminderCard" | "answerReminder"> {
  const { d, config, now, lang, tx, hhmm, graph, sendText, graphTo, loadReminders, saveReminders, counted, remLock } = door;
  /** The text as a template variable: one line (Meta allows no line breaks there), cut at TEMPLATE_TEXT_MAX. */
  const templateText = (text: string): string => cut(text.replace(/\s+/g, " ").trim(), TEMPLATE_TEXT_MAX);
  const sendReminderTemplate = async (text: string): Promise<boolean> =>
    (await graphTo(config.ownerDigits, {
      type: "template",
      template: {
        name: config.reminderTemplate,
        language: { code: config.templateLang },
        components: [{ type: "body", parameters: [{ type: "text", text: templateText(text) }] }],
      },
    })).ok;

  /** A repeat moved on to its first time after `t` (true); false for a reminder that does not repeat, or one whose next time cannot be said. */
  const repeatNext = (r: Reminder, t: number): boolean => {
    const next = r.every && r.anchor ? repeatAfter(r.at, r.every, r.anchor, d.timeZone, t) : null;
    if (next === null) return false;
    Object.assign(r, { at: next, held: false, tries: 0 });
    delete r.retryAt;
    return true;
  };
  let fired: Fired[] | null = null;
  /** Cards that fired while the store could not be read: never written over the record, joined to it once it reads. */
  const firedHere: Fired[] = [];
  const loadFired = async (): Promise<Fired[] | null> => {
    if (fired) return fired;
    let p: unknown;
    try {
      p = (d.kv ? await readJsonRecord(d.kv, FIRED_KEY) : undefined) ?? [];
    } catch (err) {
      log.warn(`the fired reminders could not be read: ${(err as Error).message}`);
      return null;
    }
    if (fired) return fired;
    const list = (Array.isArray(p) ? p : []).filter((x): x is Fired =>
      !!x && typeof x.id === "string" && typeof x.rid === "string" && typeof x.text === "string" && typeof x.at === "number" && typeof x.firedAt === "number");
    fired = [...list, ...firedHere.splice(0).filter((x) => !list.some((y) => y.id === x.id))];
    return fired;
  };
  const saveFired = async (): Promise<void> => {
    const list = await loadFired();
    if (!list) return;
    const t = now();
    fired = list.filter((x) => t - x.firedAt < FIRED_KEEP_MS).slice(-FIRED_KEEP);
    await d.kv?.set(FIRED_KEY, JSON.stringify(fired), FIRED_KEEP_MS / 1000).catch((err: Error) => log.error(`could not keep a fired reminder: ${err.message}`));
  };
  /** A reminder as a card with its three buttons. True when it went (as any message to the owner: see graph). */
  const sendReminderCard = async (r: Reminder, body: string): Promise<boolean> => {
    const f: Fired = { id: randomBytes(5).toString("hex"), rid: r.id, text: r.text, at: r.at, ...(r.every ? { every: r.every } : {}), firedAt: now() };
    const buttons = [["r1", "btnDone"], ["r2", "btnSnooze"], ["r3", "btnTomorrow"]] as const;
    const ok = await graph({
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: cut(body, CARD_MAX) },
        action: { buttons: buttons.map(([k, title]) => ({ type: "reply", reply: { id: `${k}:${f.id}`, title: tx(title) } })) },
      },
    });
    if (!ok) return false;
    const list = await loadFired();
    if (list) list.push(f);
    else firedHere.push(f);
    if (firedHere.length > FIRED_KEEP) firedHere.shift();
    await saveFired();
    return true;
  };
  /**
   * A press on a reminder's card. Done only says so (a repeat's next time is already set); +10 min and Tomorrow set a new reminder with the same
   * words. Each card is answered once: a second press, or the same press delivered again after a restart, changes nothing.
   */
  const answerReminder = (id: string, kind: "done" | "snooze" | "tomorrow"): Promise<void> =>
    remLock(async () => {
      const f = (await loadFired())?.find((x) => x.id === id) ?? firedHere.find((x) => x.id === id);
      if (!f) return void (await sendText(tx("reminderGone")));
      if (f.answered) return void (await sendText(tx("reminderAnswered")));
      const t = now();
      if (kind === "done") {
        // Nothing to change: a repeat's next time was set as it fired (named here when the store can say it).
        f.answered = "done";
        await saveFired();
        const series = f.every ? (await loadReminders().catch(() => [] as Reminder[])).find((x) => x.id === f.rid && x.every) : undefined;
        await sendText(series ? tx("reminderDoneNext", { when: whenText(series.at, d.timeZone, lang()) }) : tx("reminderDone"));
        return;
      }
      let list: Reminder[];
      try {
        list = await loadReminders();
      } catch (err) {
        log.error(`could not read the reminders for a press: ${(err as Error).message}`);
        return void (await sendText(tx("reminderNotSaved")));
      }
      let at: number | null = t + SNOOZE_MS;
      if (kind === "tomorrow") {
        // Tomorrow, at the hour it was for.
        const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(localStamp(t, d.timeZone))!;
        const hm = /(\d{2}):(\d{2})$/.exec(localStamp(f.at, d.timeZone))!;
        at = localOrLater(Number(day[1]), Number(day[2]), Number(day[3]) + 1, Number(hm[1]), Number(hm[2]), d.timeZone);
      }
      if (at === null) return void (await sendText(tx("reminderNotSaved")));
      const when = at;
      if (!list.some((x) => x.at === when && x.text.toLowerCase() === f.text.toLowerCase())) {
        if (counted(list) >= REMINDERS_MAX) return void (await sendText(tx("remindersFull", { n: REMINDERS_MAX })));
        const added: Reminder = { id: randomBytes(4).toString("hex"), at: when, text: f.text, held: false, tries: 0 };
        list.push(added);
        try {
          await saveReminders(list);
        } catch (err) {
          list.splice(list.indexOf(added), 1);
          log.error(`could not keep a snoozed reminder: ${(err as Error).message}`);
          return void (await sendText(tx("reminderNotSaved")));
        }
      }
      f.answered = kind;
      await saveFired();
      d.control?.log("reminder", tx("logReminderSet", { at: localStamp(when, d.timeZone), text: f.text }));
      await sendText(tx(kind === "snooze" ? "reminderSnoozed" : "reminderTomorrow", { time: hhmm(when) }));
    });

  return { sendReminderTemplate, repeatNext, sendReminderCard, answerReminder };
}
