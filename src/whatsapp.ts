// The owner's WhatsApp gateway for the personal assistant. This server is only the door: it checks Meta's signature, accepts messages
// from the owner's number and nobody else, keeps them until the assistant on the owner's own computer fetches them, and sends the
// assistant's answers back to the owner (and only to the owner). The Meta token lives here and nowhere else; the computer that runs
// Claude holds a separate bridge token that can fetch the owner's messages and send messages to the owner, nothing more.
//
// Rules that do not depend on the model:
// - Only the owner's number is served; every other sender is dropped silently. Every request from Meta carries a signature that is checked.
// - Ringing a friend is never done on the model's say-so: the assistant can only propose a call. The owner is shown the exact message
//   (written by the server) with Confirm and Cancel buttons, and the call is placed only when the owner presses Confirm. The call itself
//   goes through the same tools as the voice line (contact list, caps, quiet hours, owner name).
// - Notes go into the same memory the voice line reads, with small limits per request. What the assistant's tags change in the notes,
//   reminders, lists and tasks (src/lists.ts) is told to the owner from here (what really changed, not what the model says), with an Undo
//   button (src/undo.ts).
// - A reminder that fires comes with buttons (Done, +10 min, Tomorrow); a repeating one sets its next time as it fires.
// - If the assistant's computer has not asked for messages for a while, the owner is told once instead of waiting in silence.
//
// Off unless WHATSAPP_ACCESS_TOKEN is set. A wrong or incomplete configuration turns it off and says why in the log.

import type { Express } from "express";
import type { WhatsappDeps } from "./door/deps.ts";
import type { Door } from "./door/door.ts";
import { mountCore } from "./door/core.ts";
import { mountOwner } from "./door/owner.ts";
import { mountLanguage } from "./door/language.ts";
import { mountSend } from "./door/send.ts";
import { mountCalls } from "./door/calls.ts";
import { mountAsks } from "./door/asks.ts";
import { mountMessages } from "./door/messages.ts";
import { mountDelivery } from "./door/delivery.ts";
import { mountAutonomy } from "./door/autonomy.ts";
import { mountHeld } from "./door/held.ts";
import { mountActions } from "./door/actions.ts";
import { mountCalendarCards } from "./door/calendar-cards.ts";
import { mountButtons } from "./door/buttons.ts";
import { mountReminders } from "./door/reminders.ts";
import { mountWindow } from "./door/window.ts";
import { mountReminderTexts } from "./door/reminder-texts.ts";
import { mountReminderCards } from "./door/reminder-cards.ts";
import { mountRemindersDue } from "./door/reminders-due.ts";
import { mountNotices } from "./door/notices.ts";
import { mountReceipts } from "./door/receipts.ts";
import { mountRevert } from "./door/revert.ts";
import { mountPeopleChanges } from "./door/people-changes.ts";
import { mountFacts } from "./door/facts.ts";
import { mountPeople } from "./door/people.ts";
import { mountWebhook } from "./door/webhook.ts";
import { mountInbound } from "./door/inbound.ts";
import { mountPapers } from "./door/papers.ts";
import { mountViews } from "./door/views.ts";
import { mountHelp } from "./door/help.ts";
import { mountNotes } from "./door/notes.ts";
import { mountBridge } from "./door/bridge.ts";
import { mountMedia } from "./door/media.ts";
import { mountContext } from "./door/context.ts";
import { mountFeeds } from "./door/feeds.ts";
import { mountDigests } from "./door/digests.ts";
import { mountHeldReplies } from "./door/held-replies.ts";
import { mountReply } from "./door/reply.ts";
import { mountTags } from "./door/tags.ts";
import { mountDump } from "./door/dump.ts";
import { doorApi } from "./door/api.ts";

export { loadWhatsappConfig } from "./door/config.ts";
export type { WhatsappConfig } from "./door/config.ts";
export { createInbox } from "./door/inbox.ts";
export type { Inbound, InboundFollowup, InboundMeeting, InboundEmail } from "./door/inbox.ts";
export { plainWhatsapp, replaceFormatting, callWords, cleanCallMessage } from "./door/format.ts";
export { buttonLabels, callOutcome } from "./door/texts.ts";
export { localToEpoch, localStamp, nextRepeat, firstRepeat, repeatAfter } from "./door/time.ts";
export { TELEGRAM_ID_PREFIX, TELEGRAM_MEDIA_ID } from "./door/deps.ts";
export type { WhatsappDeps, OwnerAsk, AskResult, OwnerChannel, WhatsappLine, TelegramDoor } from "./door/deps.ts";
export { PENDING_CALL_MS, chunkText } from "./door/shared.ts";

export function mountWhatsapp(app: Express, d: WhatsappDeps) {
  // The door is built in parts (src/door/), in the order it always set itself up: each adds its names to `door` for the parts after it.
  const door = { app, d } as Door;
  Object.assign(door, mountCore(door));
  Object.assign(door, mountOwner(door));
  Object.assign(door, mountLanguage(door));
  Object.assign(door, mountSend(door));
  Object.assign(door, mountCalls(door));
  Object.assign(door, mountAsks(door));
  Object.assign(door, mountMessages(door));
  Object.assign(door, mountDelivery(door));
  Object.assign(door, mountAutonomy(door));
  Object.assign(door, mountHeld(door));
  Object.assign(door, mountActions(door));
  Object.assign(door, mountCalendarCards(door));
  Object.assign(door, mountButtons(door));
  Object.assign(door, mountReminders(door));
  Object.assign(door, mountWindow(door));
  Object.assign(door, mountReminderTexts(door));
  Object.assign(door, mountReminderCards(door));
  Object.assign(door, mountRemindersDue(door));
  Object.assign(door, mountNotices(door));
  Object.assign(door, mountReceipts(door));
  Object.assign(door, mountRevert(door));
  Object.assign(door, mountPeopleChanges(door));
  Object.assign(door, mountFacts(door));
  Object.assign(door, mountPeople(door));
  Object.assign(door, mountWebhook(door));
  Object.assign(door, mountInbound(door));
  Object.assign(door, mountPapers(door));
  Object.assign(door, mountViews(door));
  Object.assign(door, mountHelp(door));
  Object.assign(door, mountNotes(door));
  Object.assign(door, mountBridge(door));
  Object.assign(door, mountMedia(door));
  mountContext(door);
  mountFeeds(door);
  mountDigests(door);
  Object.assign(door, mountHeldReplies(door));
  mountReply(door);
  Object.assign(door, mountTags(door));
  Object.assign(door, mountDump(door));
  const { routines, runReminders } = door;
  // Due reminders are looked at every half minute (and on every poll of the assistant's computer, which also keeps the free web service awake).
  // Routines due and the watches' look, on the same half-minute clock (src/routines.ts: one look at a time, never throws). With the durable
  // jobs (src/jobs.ts) its runner is that clock instead (app.ts defines both there), and it notices a wake.
  if (!d.jobs) {
    const timer = setInterval(() => void runReminders(), 30_000);
    timer.unref?.();
    const routineTimer = setInterval(() => void routines.tick(), 30_000);
    routineTimer.unref?.();
  }
  return doorApi(door);
}
