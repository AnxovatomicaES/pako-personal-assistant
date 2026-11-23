// The owner's voice line (Gemini Live) acts through a few plain tools, run here on the main server: the owner's contacts, staging a call
// to a friend and confirming it, checking on a call, and notes to remember. There is no second AI in between and no AI key on this
// server: the live voice chooses the tool, this file does exactly what the tool says and nothing more. (Looking things up on the web is
// done by the worker, with Gemini, and never reaches this file.)
//
// Rules that do not depend on the model:
// - Ringing a friend never happens on the model's say-so. call_contact only stages the request and returns a read-back the server wrote
//   itself (the voice says it word for word, so the owner agrees to exactly what will be sent). confirm_call places the call only when the
//   worker reports that this exact read-back played out to the end and everything the owner said after that (the live transcript, which the
//   worker joins into one text) is a plain yes. Anything else drops it.
// - A call that is not verified (an inbound call on caller ID alone, which can be faked) gets none of these tools.
// - The friend call itself goes through the same function as the call_contact MCP tool: contact list, caps, quiet hours, owner name.

import type { MemoryStore } from "./voice-memory.ts";
import { pausedText, pauseWhyIn } from "./control.ts";
import { texts, type Lang } from "./i18n.ts";
import { passedOnLanguage } from "./language.ts";
import { createLog } from "./log.ts";

const log = createLog("voice-tools");

// What the owner is told once a friend call was tried (on the voice line, word for word, and in the chat): Pako's own fixed texts, English.
const T = texts(
  {
    pausedNoCall: "{paused} I didn't call {name}.",
    quiet: "It's quiet hours now: I didn't call {name}. Ask again once they're over, if you still want to.",
    notNow: "I couldn't call {name} right now.",
    gap: "Calls need a gap between them: I didn't call {name}. Ask again in {s} s.",
    unknown: "I don't know whether the call to {name} went out: the phone service didn't answer clearly. I won't try again, so they aren't called twice.",
    simulated: "Simulated: I didn't call {name} (the phone is in test mode).",
    calling: "Done, I'm calling {name} now.",
  },
);
export interface ToolActions {
  /** The names of the owner's approved contacts. */
  contacts(): string[];
  /**
   * Places a friend call now, the same way as a press on the card the call_contact MCP tool sends the owner. `unknown`: the phone service did
   * not answer clearly, so the call may or may not have gone out.
   */
  callContact(a: { name: string; message: string; language: "es" | "en"; direct: boolean }): Promise<{ ok: boolean; text: string; unknown?: boolean; wait?: number }>;
  /** What get_call would say about a call this feature placed. */
  lookupCall(callId: string): Promise<string>;
}

export const VOICE_TOOLS = ["list_contacts", "call_contact", "confirm_call", "check_call", "remember", "forget"] as const;
export type VoiceToolName = (typeof VOICE_TOOLS)[number];

export interface ToolCall {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  /**
   * Sent by the worker only when a server-written read-back played out to the end (not cut off): its exact text. And everything the owner
   * said after it finished, from the live transcript (not the committed lines: the model's turn is still open while a tool runs, so the
   * owner's last words are not committed yet), joined into one text.
   */
  readbackText?: string;
  answerText?: string;
  /** Verified call: the server dialled the owner, or the owner typed the PIN. Only then any of these tools. */
  trusted: boolean;
  now?: number;
}

export interface Answer {
  /** For a verbatim answer, the words to say; otherwise the result the voice puts in its own words. */
  say: string;
  /** The server wrote it (a read-back, a result): the voice must say it word for word. */
  verbatim: boolean;
  /** Set when confirm_call really placed a call: who, and the id check_call looks it up by (a chat uses it to report how the call went). */
  placed?: { name: string; callId: string };
  /** The phone service did not answer clearly: the call may or may not have gone out. */
  unknown?: true;
  /** The phone line is in dry run: nobody was rung. */
  simulated?: true;
  /** confirm_call found no call waiting, or another one than the read-back it was given: what was confirmed is no longer what is staged. */
  stale?: true;
}

export interface VoiceTools {
  run(c: ToolCall): Promise<Answer>;
}

interface Pending {
  name: string;
  message: string;
  language: "es" | "en";
  direct: boolean;
  at: number;
  /** The read-back the owner is to say yes to. */
  readback: string;
}

const PENDING_MS = 60_000;
/** A chat (call id "wa_...") waits for a button press, which takes longer than a spoken yes. */
const CHAT_PENDING_MS = 5 * 60_000;
const pendingMs = (callId: string): number => (callId.startsWith("wa_") ? CHAT_PENDING_MS : PENDING_MS);

// A yes is a short answer made of yes-words only, with at least one real "yes" word in it. Anything with another word in it ("of course
// not", "yes, but wait", "call Peter") is not one, and neither is a question or a thanks on its own: no negation list to keep up to date,
// because an unknown word fails. English only, like the card or the read-back it answers.
const YES_CORE = new Set(["ok", "okay", "yes", "yeah", "yep", "yup", "sure", "call", "confirm", "confirmed", "correct", "exactly", "right"]);
const YES_EXTRA = new Set(["please", "go", "ahead", "do", "it", "of", "course"]);
// "Go ahead", "do it", "of course" and "call her" are a yes in two words, neither of which is a yes alone ("go", "do", "it", "of"; "her" is
// no word of a yes at all): the pair counts as one yes word, and its second word as part of it.
const YES_PAIRS = new Set(["go ahead", "do it", "of course", "call her", "call him", "call them"]);
const MAX_YES_WORDS = 5;

/** True when the owner's turn is a plain yes. A turn with a question mark is not (the owner asking, not agreeing). */
export function isYes(turn: string): boolean {
  if (/[?¿]/.test(turn)) return false;
  const words = turn.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}']+/gu, " ").trim().split(" ").filter(Boolean);
  const pairAt = (i: number): boolean => i >= 0 && i + 1 < words.length && YES_PAIRS.has(`${words[i]} ${words[i + 1]}`);
  return (
    words.length > 0 && words.length <= MAX_YES_WORDS
    && words.some((w, i) => YES_CORE.has(w) || pairAt(i))
    && words.every((w, i) => YES_CORE.has(w) || YES_EXTRA.has(w) || pairAt(i - 1))
  );
}

/**
 * Why a call was not placed, in words for the owner: the pause and the quiet hours are said (the gap between calls is said by
 * friendCallAnswer, from its number), the rest is "not now" (the detail is in the log).
 */
function spokenReason(text: string, name: string, l: Lang): string {
  const t = T(l);
  // The pause by why, as the refusal carried it: the owner's STOP, or a pause Pako set by itself (never put down to the owner).
  const why = pauseWhyIn(text);
  if (why) return t("pausedNoCall", { paused: pausedText(why, l), name });
  if (/^Quiet hours/i.test(text)) return t("quiet", { name });
  return t("notNow", { name });
}

/**
 * What the owner is told once a friend call was tried, from the result of the call function: placed (and its id, so the outcome can be
 * looked up and told later), simulated (the phone line's dry run rings nobody, and nobody must be said to be rung), not placed, or not known
 * (the phone service did not answer clearly).
 */
export function friendCallAnswer(r: { ok: boolean; text: string; unknown?: boolean; wait?: number; gap?: number }, name: string, l: Lang = "en"): Answer {
  const t = T(l);
  // Too soon after another friend call: nothing was placed, and the minimum gap says when it can be.
  const gap = r.ok ? undefined : (r.gap ?? r.wait);
  if (gap) return { say: t("gap", { name, s: gap }), verbatim: true };
  // Not "I couldn't": it may have rung. And not tried again, so the friend is not rung twice.
  if (r.unknown) return { say: t("unknown", { name }), verbatim: true, unknown: true };
  const callId = /call_id=([A-Za-z0-9_-]+)/.exec(r.text)?.[1];
  if (r.ok && callId?.startsWith("dryrun_")) return { say: t("simulated", { name }), verbatim: true, simulated: true };
  return r.ok
    ? { say: t("calling", { name }), verbatim: true, ...(callId ? { placed: { name, callId } } : {}) }
    : { say: spokenReason(r.text, name, l), verbatim: true };
}

/** What the owner is asked to say yes to: Pako's own words, English, around the message as the owner gave it. */
export function readBack(p: Pick<Pending, "name" | "message">): string {
  return `I'll call ${p.name} to tell them: ${p.message}. Shall I?`;
}

/** `lang`: accepted for the callers that still pass it; the answers the owner hears or reads word for word are English (src/i18n.ts). */
export function loadVoiceTools(o: { memory: MemoryStore; actions: ToolActions; lang?: () => Lang }): VoiceTools {
  const pending = new Map<string, Pending>();

  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

  const run = async (c: ToolCall): Promise<Answer> => {
    const now = c.now ?? Date.now();
    // Belt and braces: the worker offers an unverified call none of these tools, but a made-up call must not get through either.
    if (!c.trusted) return { say: "Not allowed on this call: it has not been verified (no PIN). Say that this needs the PIN.", verbatim: false };
    const wait = pending.get(c.callId);
    if (wait && now - wait.at >= pendingMs(c.callId)) pending.delete(c.callId);
    switch (c.tool as VoiceToolName) {
      case "list_contacts": {
        const names = o.actions.contacts();
        return { say: names.length ? `Contacts: ${names.join(", ")}` : "No contacts are set up.", verbatim: false };
      }
      case "call_contact": {
        const wanted = str(c.args.name, 40).toLowerCase();
        const match = o.actions.contacts().find((n) => n.toLowerCase() === wanted);
        if (!match) return { say: `"${str(c.args.name, 40)}" is not in the contacts. Contacts: ${o.actions.contacts().join(", ")}`, verbatim: false };
        // One plain line: it is read back, said by the voice and sent to the friend, so no quotes or line breaks to break the read-back.
        // Invisible and direction-changing characters (tag characters, right-to-left overrides) would make the read-back say one thing and the call another.
        const message = str(c.args.message, 600).replace(/[\p{Cf}\p{Co}]/gu, "").replace(/[\r\n]+/g, " ").replace(/["“”«»]/g, "'").replace(/\s+/g, " ").trim().slice(0, 300);
        if (!message) return { say: "Say what the message is.", verbatim: false };
        // The friend hears the owner's message in the language it is written in (a Spanish message is spoken in Spanish): it is the owner's
        // free-form words, not a fixed text of Pako's. One that shows no language is spoken in English. The read-back to the owner is English.
        const language = passedOnLanguage(message, o.lang?.() ?? "en");
        const staged: Pending = { name: match, message, language, direct: c.args.direct === true, at: now, readback: "" };
        staged.readback = readBack(staged);
        pending.set(c.callId, staged);
        return { say: staged.readback, verbatim: true };
      }
      case "confirm_call": {
        const staged = pending.get(c.callId);
        if (!staged) return { say: "There is nothing waiting for a yes. Do not ring anyone.", verbatim: false, stale: true };
        // Decided here from the owner's own words, never by the model: the worker must report that this exact read-back played out to the
        // end, and everything the owner said after it must be a plain yes (all of it: a "no" or any other word anywhere makes it not one).
        // A "yes" said before the read-back finished is not part of it. Any confirm attempt uses the staged call up.
        pending.delete(c.callId);
        const answered = !!staged.readback && c.readbackText === staged.readback && isYes(c.answerText ?? "");
        if (!answered) {
          return {
            say: "The owner has not clearly said yes to the read-back, so nothing was done. Do not ring anyone; offer to prepare it again.", verbatim: false,
            ...(c.readbackText !== staged.readback ? { stale: true as const } : {}),
          };
        }
        const r = await o.actions.callContact({ name: staged.name, message: staged.message, language: staged.language, direct: staged.direct });
        // The reason stays out of the spoken words (it is in English and may carry an id).
        log.info(`confirm_call ${c.callId}: ${r.ok ? "placed" : "not placed"}: ${r.text.slice(0, 60).replace(/\s+/g, " ")}`);
        return friendCallAnswer(r, staged.name, o.lang?.() ?? "en");
      }
      case "check_call":
        return { say: await o.actions.lookupCall(str(c.args.call_id, 80)), verbatim: false };
      case "remember": {
        const m = await o.memory.addNote(str(c.args.text, 300), now);
        return { say: `Saved. ${m.notes.length} notes.`, verbatim: false };
      }
      case "forget": {
        const wanted = str(c.args.match, 80);
        // A word or two would match half the notes: it takes four letters to delete anything by words.
        if (wanted.length < 4) return { say: "Say a few more words of the note to forget: that is too short to be sure which one.", verbatim: false };
        const n = await o.memory.forgetNote(wanted);
        return { say: n ? `Deleted ${n} note(s).` : "No note matched.", verbatim: false };
      }
      default:
        return { say: `Unknown tool ${c.tool}.`, verbatim: false };
    }
  };

  // One tool call at a time per call: they are decided in the order they were made, and a slow one cannot be overtaken by the next.
  const tails = new Map<string, Promise<unknown>>();
  return {
    run(c) {
      const prev = tails.get(c.callId) ?? Promise.resolve();
      const next = prev.then(() => run(c), () => run(c));
      const tail = next.then(() => undefined, () => undefined);
      tails.set(c.callId, tail);
      void tail.then(() => {
        if (tails.get(c.callId) === tail) tails.delete(c.callId);
      });
      return next;
    },
  };
}
