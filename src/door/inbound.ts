// The owner's messages coming in, from WhatsApp, Telegram and the panel's chat: each one handled once, in order.

import { plainWords } from "../intents.ts";
import { healthTexts } from "../health.ts";
import { MAX_SEEN } from "./inbox.ts";
import type { OwnerChannel } from "./deps.ts";
import { PENDING_CALL_MS } from "./shared.ts";
import type { Door } from "./door.ts";
import type { Handler, Incoming } from "./incoming.ts";
import { isStop, onResume, onStop } from "./stop-resume.ts";
import {
  onAgenda, onBookings, onBrief, onDraft, onFollowups, onHealth, onLog, onMail, onMeetingTodos, onParked, onRehearsal, onReopen, onMissed, onResetPark, onSlack, onView, onZoom,
} from "./views.ts";
import { onChase } from "./chase.ts";
import { onDumpRemove } from "./dump.ts";
import { onCodes } from "./codes.ts";
import { onCompanion, onLifeTopics } from "./life.ts";
import { onPanel, onTelegram, onTelegramInPanel, onTelegramOff } from "./chats.ts";
import { onHelp } from "./help.ts";
import { onNotes } from "./notes.ts";
import { onPeople } from "./people.ts";
import { onWho } from "./facts.ts";
import { onReminders } from "./reminder-texts.ts";
import { onLists, onTasks } from "./lists.ts";
import { onRoutineChange, onRoutines, onWatches } from "./routines.ts";
import { onUndo } from "./revert.ts";
import { onNumbers } from "./messages.ts";
import { onBookingAnswer, onCallAnswer, onRepeatedAnswer, onSendAnswer } from "./confirmations.ts";
import { toAssistant } from "./assistant.ts";
import { onFindTime } from "./time-to-do.ts";

/**
 * The order the door answers a text message in. The first step that answers ends it; a message none of them answers goes to the assistant
 * (toAssistant). The order matters: STOP and RESUME before anything; a view in the owner's own words read as its command before the commands;
 * the owner's commands before a typed yes or no; the assistant last.
 */
const HANDLERS: readonly Handler[] = [
  onStop,
  onResume,
  onView,
  onMail,
  onCodes,
  onAgenda,
  onBrief,
  onZoom,
  onMeetingTodos,
  onRehearsal,
  onHealth,
  onLifeTopics,
  onFollowups,
  onParked,
  onReopen,
  onFindTime,
  onMissed,
  onResetPark,
  onDumpRemove,
  onDraft,
  onChase,
  onBookings,
  onSlack,
  onPanel,
  onTelegramInPanel,
  onTelegram,
  onTelegramOff,
  onLog,
  onHelp,
  onNotes,
  onPeople,
  onWho,
  onReminders,
  onLists,
  onRoutines,
  onWatches,
  onRoutineChange,
  onTasks,
  onUndo,
  onNumbers,
  onRepeatedAnswer,
  onCallAnswer,
  onSendAnswer,
  onBookingAnswer,
  onCompanion,
];

export function mountInbound(door: Door): Pick<Door, "handleMessage"> {
  const { via } = door;
  /**
   * Handles one message and says what became of it, for the log. Meta delivers at least once: a message already handled is not handled again (an old
   * STOP or RESUME replayed would change the pause, an old message would disarm a card's typed yes). One that failed half way is not marked, so Meta's retry works.
   */
  const handledIds = new Set<string>();
  const handleMessage = async (m: Record<string, unknown>, channel: OwnerChannel = "base"): Promise<string> => {
    const key = typeof m.id === "string" ? m.id : "";
    if (key && handledIds.has(key)) return "repeated";
    if (key) {
      handledIds.add(key);
      if (handledIds.size > MAX_SEEN) handledIds.delete(handledIds.values().next().value!);
    }
    try {
      return await via.run(channel, () => handleMessageOnce(door, m, channel));
    } catch (err) {
      if (key) handledIds.delete(key);
      throw err;
    }
  };

  return { handleMessage };
}

const handleMessageOnce = async (door: Door, m: Record<string, unknown>, channel: OwnerChannel): Promise<string> => {
  const heard = await intake(door, m, channel);
  if (typeof heard === "string") return heard;
  const other = await notText(door, m, channel, heard.id, heard.at);
  if (other !== null) return other;
  const text = String((m.text as { body?: string } | undefined)?.body ?? "").trim();
  if (!text) return "empty";
  // The owner's controls are answered here, by the server, at once: they work even when the Mac is off.
  const msg: Incoming = { m, channel, text, command: plainWords(text), ...heard };
  // A forwarded message is someone else's words: never the owner's command (a RESUME, a yes to a card, an UNDO, a FORGET). It goes to the
  // assistant as outside text. Only STOP is still heard: it can only halt.
  for (const handler of heard.ownWords ? HANDLERS : [onStop]) {
    const outcome = await handler(door, msg);
    if (outcome === null) continue;
    if (heard.stopping) await door.flushHeld(); // what intake left for after the pause
    return outcome;
  }
  return toAssistant(door, msg);
};

type Heard = Pick<Incoming, "id" | "at" | "ownWords" | "waiting" | "waitingSend" | "waitingBooking"> & { stopping: boolean };

/**
 * What every message goes through first, whatever its kind: who sent it, the card it may answer in words, a red flag, a verdict on a
 * "Useful?", and the notices kept for the owner. Says what became of the message when it ends here.
 */
const intake = async (door: Door, m: Record<string, unknown>, channel: OwnerChannel): Promise<Heard | string> => {
  const { d, now, lang, companion, isOwner, via, setLastChannel, sendText, forwardReply, touchOwner, flushHeld } = door;
  // Anyone else is dropped, no answer; except a friend the assistant wrote to, whose answer is passed on to the owner. (A Telegram
  // message was checked by the Telegram channel, by the paired account: WhatsApp's own check would also change how it writes to the owner.)
  // A friend's answer is not the owner writing: it is passed on like any notice Pako starts (outside this message's chat).
  if (channel === "base" && !(await isOwner(m))) return via.exit(async () => (await forwardReply(m)) ?? "ignored (not the owner)");
  const id = typeof m.id === "string" ? m.id : "";
  if (!id) return "ignored (no id)";
  // A reaction (a thumbs up on a card, say) is not a message: it answers nothing and takes nothing away from a card waiting for a word.
  if (m.type === "reaction") return "reaction ignored";
  const at = now();
  door.lastHeardAt = at;
  // WhatsApp's 24-hour window opens only with a message on WhatsApp; the chat used last is where what Pako starts goes.
  if (channel === "base") touchOwner(at);
  setLastChannel(channel);
  // A proposed call or message can be answered in words only by the very next message, whatever kind it is.
  const waiting = door.pendingCall && door.pendingCall.typed && at - door.pendingCall.at < PENDING_CALL_MS ? door.pendingCall : null;
  const waitingSend = door.pendingSend && door.pendingSend.typed && at - door.pendingSend.at < PENDING_CALL_MS ? door.pendingSend : null;
  if (door.pendingCall) door.pendingCall.typed = false;
  if (door.pendingSend) door.pendingSend.typed = false;
  // The same for a table card or list: taken here, whatever kind of message this is, so a later "yes" can never confirm it.
  const waitingBooking = d.booking?.take() ?? null;
  // A yes or a no right after a card or a brief that asked "Useful?" (src/quality.ts), when nothing else waits for a word: its verdict. Taken
  // before the notices kept for later go (sending them forgets the question); anything else the owner sends forgets it too.
  const typed = m.type === "text" ? String((m.text as { body?: string } | undefined)?.body ?? "") : "";
  // A red flag in the owner's own words (src/health.ts): the emergency number at once, before anything else (before the notices kept
  // for later, before a thanks; paused too, over the day's limit too); then the message goes on as usual. A forwarded message is someone
  // else's words: not this. The log never holds the words.
  const flagFwd = m.context as { forwarded?: unknown; frequently_forwarded?: unknown } | undefined;
  const ownWords = !(flagFwd?.forwarded === true || flagFwd?.frequently_forwarded === true);
  const flagged = ownWords && typed.trim() ? companion.red(typed.trim()) : null;
  if (flagged) {
    await sendText(flagged.say);
    d.control?.log("health", healthTexts(lang())(flagged.flag === "suicide" ? "logCrisis" : "logEmergency"));
  }
  const thanks = d.quality && typed && !waiting && !waitingSend && !waitingBooking ? await d.quality.answerText(typed).catch(() => null) : null;
  if (!thanks) d.quality?.clearAsk();
  // A STOP is answered before anything else goes: the notices kept for later are given once it holds (handleMessageOnce).
  const stopping = !!d.control && m.type === "text" && isStop(plainWords(typed));
  if (!stopping) await flushHeld();
  if (thanks) {
    await sendText(thanks);
    return "feedback kept";
  }
  return { id, at, ownWords, waiting, waitingSend, waitingBooking, stopping };
};

/** A message that is not text: a button pressed, a voice note, a photo or a PDF, the template's button, anything else. Null for text. */
const notText = async (door: Door, m: Record<string, unknown>, channel: OwnerChannel, id: string, at: number): Promise<string | null> => {
  const { d, tx, inbox, seenPresses, sendText, saidByOwner, pressed, dailyLimitReached } = door;
  if (m.type === "interactive") {
    const reply = (m.interactive as { button_reply?: { id?: string } } | undefined)?.button_reply;
    // A button press is handled here, never queued for the assistant; Meta may deliver it twice, so a press is handled once.
    if (reply?.id && !seenPresses.has(id)) {
      seenPresses.add(id);
      if (seenPresses.size > MAX_SEEN) seenPresses.delete(seenPresses.values().next().value!);
      await pressed(reply.id, id);
      return "button pressed";
    }
    return "button repeated";
  }
  if (m.type === "audio") {
    // A voice note: kept for the owner's computer, which listens to it (Whisper, on that computer) and answers the words.
    const a = m.audio as { id?: unknown; mime_type?: unknown } | undefined;
    const mediaId = typeof a?.id === "string" && /^[0-9A-Za-z_-]{5,64}$/.test(a.id) ? a.id : "";
    if (mediaId) {
      if (dailyLimitReached()) {
        await sendText(tx("tooMuchToday"));
        return "over the daily limit";
      }
      const mime = typeof a?.mime_type === "string" ? a.mime_type.slice(0, 60) : "audio/ogg";
      // A forwarded voice note is someone else's words: the bridge reads its transcription as outside text and marks the turn.
      const fwd = m.context as { forwarded?: unknown; frequently_forwarded?: unknown } | undefined;
      const forwarded = fwd?.forwarded === true || fwd?.frequently_forwarded === true;
      if (!(await inbox.add({ id, at, text: "", audio: { id: mediaId, mime }, ...(forwarded ? { forwarded: true } : {}) }))) return "repeated";
      // The words are heard on the owner's computer: the bridge sends them back with the answer (`heard`), for provenance.
      if (!forwarded) saidByOwner(id, "", true);
      return "voice note queued";
    }
  }
  // A photo or a PDF (src/papers.ts): WhatsApp's image or document, Telegram's photo or document, a file put in the panel's chat.
  if (m.type === "image" || m.type === "document" || (m.type === "paper" && d.local && channel === "base")) return door.takePaper(m, id, at);
  if (m.type === "button") {
    // The notice template's "See" button: the owner's tap opened WhatsApp's window, and flushHeld (above) gave what was waiting.
    return "template button";
  }
  if (m.type !== "text") {
    if (at - door.lastOtherNoticeAt > 60_000) {
      door.lastOtherNoticeAt = at;
      await sendText(tx("textOnly"));
    }
    return "not text";
  }
  return null;
};
