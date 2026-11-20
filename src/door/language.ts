// The owner's language as heard from their own messages: it steers only what Claude writes freely (the summaries of an email or a meeting
// nobody asked for, the chat's fallback for a message that shows no language). Pako's own fixed texts are English whatever it is.

import { readLanguage } from "../language.ts";
import type { Door } from "./door.ts";
import { createLog } from "../log.ts";

const log = createLog("whatsapp");

export function mountLanguage(door: Door): Pick<Door, "hearLanguage" | "ownerLanguage" | "chatLanguage"> {
  const { d } = door;
  // ---------- the owner's language: heard from their own words (src/language.ts), for what Pako writes when they have not just written ----------

  const LANGUAGE_KEY = "owner-language";
  /** The language last heard for sure from the owner, and the one the store holds as far as this process knows (null: none yet, or not read). */
  let heardLanguage: string | null = null;
  let storedLanguage: string | null = null;
  let languageLoading: Promise<void> | null = null;
  const loadLanguage = (): Promise<void> =>
    (languageLoading ??= (async () => {
      try {
        const v = await d.kv?.get(LANGUAGE_KEY);
        if (v && /^[a-z]{2}$/.test(v)) {
          // A message heard while the store was being read is newer than what it held.
          storedLanguage ??= v;
          heardLanguage ??= v;
        }
      } catch { // the store did not answer: asked again next time
        languageLoading = null;
      }
    })());
  void loadLanguage();
  /**
   * Another language heard once in a clear message, not kept yet: only a second clear message in it makes it the owner's (one text they pasted
   * with a short line of their own, "Note: <French>", is not them switching). Any message of theirs that leans to the language kept, even
   * one too short to be clear ("thanks"), drops it.
   */
  let languageHeardOnce: string | null = null;
  /** A message the owner wrote: its language, when it is clear, is theirs from now on (kept only when it changes). A forwarded one is someone else's. */
  const hearLanguage = (text: string, m: Record<string, unknown>): void => {
    const context = m.context as { forwarded?: unknown; frequently_forwarded?: unknown } | undefined;
    if (context?.forwarded === true || context?.frequently_forwarded === true) return;
    const { clear, lean } = readLanguage(text);
    // Before any is heard, the one kept is English (what ownerLanguage answers then).
    const held = heardLanguage ?? "en";
    if (!clear) {
      if (lean === held) languageHeardOnce = null;
      return;
    }
    if (clear !== held && languageHeardOnce !== clear) {
      languageHeardOnce = clear;
      return;
    }
    languageHeardOnce = null;
    heardLanguage = clear;
    if (!d.kv || clear === storedLanguage) return;
    storedLanguage = clear; // claimed now: two messages in a row write it once
    d.kv.set(LANGUAGE_KEY, clear, 365 * 24 * 3600).catch((err: Error) => {
      if (storedLanguage === clear) storedLanguage = null; // not kept: the next clear message tries again
      log.error(`could not keep the owner's language: ${err.message}`);
    });
  };
  /**
   * The owner's language as a two-letter code, for Claude's summaries nobody asked for: the last one heard from them, else English (an owner
   * who has not written yet gets them in English, like the headings around them). PAKO_LANGUAGE no longer sets it (src/app.ts ignores it).
   */
  const ownerLanguage = async (): Promise<string> => {
    await loadLanguage();
    return heardLanguage ?? "en";
  };
  /** The language heard from the owner's own messages, null before any. */
  const chatLanguage = async (): Promise<string | null> => {
    await loadLanguage();
    return heardLanguage;
  };

  return { hearLanguage, ownerLanguage, chatLanguage };
}
