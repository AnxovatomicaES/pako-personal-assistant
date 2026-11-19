// The look at the reminders that are due: sent, retried, or kept for the owner's next message.

import { randomBytes } from "node:crypto";
import { whenText } from "../undo.ts";
import { GRACE_MS } from "../jobs.ts";
import { REMINDER_LATE_MAX_MS } from "./shared.ts";
import type { Reminder, Door } from "./door.ts";
import { createLog } from "../log.ts";

const log = createLog("whatsapp");

export function mountRemindersDue(door: Door): Pick<Door, "runReminders"> {
  const {
    d, config, now, lang, tx, note, reachable, loadReminders, saveReminders, remLock, sendReminderTemplate, repeatNext, sendReminderCard,
  } = door;
  /**
   * One reminder's send as a durable slot (src/jobs.ts), "reminder:<id>@<time>": a send done before a crash is not done again on the retry
   * ("sent" without sending); "busy" while another run holds it. Without jobs (the tests), just the send.
   */
  const asSlot = async (r: Reminder, send: () => Promise<boolean>): Promise<"sent" | "unsent" | "busy"> => {
    if (!d.jobs) return (await send()) ? "sent" : "unsent";
    let sent = false;
    const out = await d.jobs.slot("reminder", `reminder:${r.id}@${r.at}`, r.at, async (c) => {
      sent = await c.once("send", send);
      return sent ? undefined : "retry";
    });
    if (out === "done") return "sent";
    if (out === "busy") return "busy";
    return sent ? "sent" : "unsent";
  };

  /** Sends the reminders that are due: free text inside the 24-hour window, the template outside it (if there is one), otherwise they wait for the owner's next message. */
  const runReminders = (): Promise<void> => remLock(runRemindersNow);
  const runRemindersNow = async (): Promise<void> => {
    if (door.runningReminders) return;
    door.runningReminders = true;
    try {
      const list = await loadReminders();
      const t = now();
      let changed = false;
      for (const r of [...list]) {
        if (r.held || r.at > t || (r.retryAt ?? 0) > t) continue;
        // Due while the computer slept (src/jobs.ts: only on a computer): late with a note, or told as missed past 12 hours.
        const late = d.jobs?.slept(r.at) ? t - r.at : 0;
        if (late > REMINDER_LATE_MAX_MS) {
          const told = await asSlot(r, () => door.notifyOwner(tx("reminderMissed", { when: whenText(r.at, d.timeZone, lang()), text: r.text }), { urgent: true })
            .then(() => true));
          if (told === "busy") continue;
          d.control?.log("reminder", tx("logReminderSent", { text: r.text }));
          if (!repeatNext(r, t)) list.splice(list.indexOf(r), 1);
          changed = true;
          continue;
        }
        const body = tx(late > GRACE_MS ? "reminderSlept" : "reminder", { text: r.text });
        const outcome = await asSlot(r, async () => {
          let ok = false;
          if (await reachable(t)) ok = await sendReminderCard(r, body);
          if (!ok && config.reminderTemplate) ok = await sendReminderTemplate(tx("reminderPing", { text: r.text }));
          return ok;
        });
        if (outcome === "busy") continue;
        const sent = outcome === "sent";
        changed = true;
        if (sent) {
          note(tx("noteReminderSent", { text: r.text }));
          d.control?.log("reminder", tx("logReminderSent", { text: r.text }));
          // A repeat stays, at its next time (its id too: the receipt's Undo still takes the whole series away); any other goes.
          if (!repeatNext(r, t)) list.splice(list.indexOf(r), 1);
        } else {
          // Tried again after 30 s, 1 min, 2 min... up to a quarter of an hour; kept for the owner's next message when the window closed or it is three hours late.
          r.tries++;
          r.retryAt = t + Math.min(30_000 * 2 ** (r.tries - 1), 15 * 60_000);
          if (!(await reachable(t)) || t - r.at > 3 * 3600_000) {
            // A repeat leaves this time's copy waiting for the owner's next message, and goes on to its next time. One copy per series:
            // a day missed again moves it to the latest time, so days of silence are one card later, not one card a day.
            const copy = r.every ? list.find((x) => x.held && x.of === r.id) : undefined;
            if (copy) Object.assign(copy, { at: r.at, tries: r.tries });
            else if (r.every) list.push({ id: randomBytes(4).toString("hex"), at: r.at, text: r.text, held: true, tries: r.tries, of: r.id });
            if (!repeatNext(r, t)) r.held = true;
          }
        }
      }
      if (changed) await saveReminders(list);
    } catch (err) {
      log.error(`could not run the reminders: ${(err as Error).message}`);
    } finally {
      door.runningReminders = false;
    }
  };

  return { runReminders };
}
