// The owner's life in their own words: proactive Pako's topics (src/proactive.ts) and the companion's diary, learning and check-in
// (src/companion.ts). Only the owner's own words: a forwarded message is someone else's.

import type { Handler } from "./incoming.ts";

/**
 * Topics of proactive Pako on and off ("don't talk to me about food"), and "forget my health data" (src/proactive.ts): settings, answered here.
 * Only the owner's own words: a forwarded "no me hables de…" is someone else's.
 */
export const onLifeTopics: Handler = async (door, { text, ownWords }) => {
  const { d, sendText } = door;
  const lifeSaid = d.life && ownWords ? await d.life.words(text).catch(() => null) : null;
  if (lifeSaid) {
    await sendText(lifeSaid);
    return "proactive topics";
  }
  return null;
};

/**
 * The health diary, learning and the weekly check-in (src/companion.ts), in plain words, and the answer to a quiz question just asked. A new
 * learning goal is said here and still goes on to the assistant, which starts the first lesson.
 */
export const onCompanion: Handler = async (door, { text, command, ownWords }) => {
  const { companion, sendText } = door;
  const roleDone = ownWords ? await companion.command(text, command) : null;
  if (roleDone) {
    await sendText(roleDone.say);
    if (!roleDone.pass) return "companion answered";
  }
  return null;
};
