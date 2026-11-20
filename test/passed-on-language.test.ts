// The pieces that have no test file of their own: the language of a message passed on to a friend
// (src/language.ts passedOnLanguage, used by the call card in src/voice-tools.ts and the first line of a WhatsApp in src/whatsapp.ts), and a
// yes typed or said in English (src/voice-tools.ts isYes). The door's side of both is in test/i18n-door.test.ts.

import assert from "node:assert/strict";
import test from "node:test";
import type { Kv } from "../src/kv.ts";
import { passedOnLanguage } from "../src/language.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { isYes, loadVoiceTools, readBack } from "../src/voice-tools.ts";

const memKv = (): Kv => {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
};

/** English messages with none of the six words the old guess looked for (the, you, and, is, are, to). */
const ENGLISH = ["that John will be 10 minutes late", "Dinner moved, 9pm tomorrow", "happy birthday from John", "John can't make it tonight"];
const SPANISH = ["que John llega tarde", "llegaré tarde", "¿Quedamos mañana?", "feliz cumpleaños de parte de John", "la cena es a las nueve"];

test("passed-on language: a message is English unless it shows Spanish; one that shows no language is English, Pako's own", () => {
  for (const m of ENGLISH) assert.equal(passedOnLanguage(m), "en", m);
  for (const m of SPANISH) assert.equal(passedOnLanguage(m), "es", m);
  // Nothing that shows a language (a name, a time, an emoji): English, the language of Pako's texts.
  for (const m of ["Ana 9pm", "ok 👍", "21:00 Bar Luz"]) assert.equal(passedOnLanguage(m), "en", m);
  for (const m of ["that John is running late", "see you at nine", "tell her to call me"]) assert.equal(passedOnLanguage(m), "en", m);
  assert.equal(passedOnLanguage("the café is closed tonight"), "en", "an accent alone does not make an English sentence Spanish");
});

test("the call card is English whatever the message's language; the call itself goes out in the message's language", async () => {
  const placed: { message: string; language: string }[] = [];
  const tools = loadVoiceTools({
    memory: loadMemory(memKv()),
    actions: {
      contacts: () => ["Ana"],
      callContact: async (a) => {
        placed.push({ message: a.message, language: a.language });
        return { ok: true, text: "started: call_id=call_1" };
      },
      lookupCall: async () => "ok",
    },
  });
  let n = 0;
  /** Stages a call from the chat, says yes to its card, and gives the card's words. */
  const card = async (message: string): Promise<string> => {
    const callId = `wa_${++n}`;
    const staged = await tools.run({ callId, tool: "call_contact", args: { name: "Ana", message }, trusted: true });
    assert.equal(staged.verbatim, true);
    await tools.run({ callId, tool: "confirm_call", args: {}, readbackText: staged.say, answerText: "go ahead", trusted: true });
    return staged.say;
  };
  for (const message of ENGLISH) {
    assert.equal(await card(message), `I'll call Ana to tell them: ${message}. Shall I?`, message);
    assert.deepEqual(placed.at(-1), { message, language: "en" }, "the call's opening is English too");
  }
  for (const message of ["que John llega tarde", "llegaré tarde"]) {
    assert.equal(await card(message), readBack({ name: "Ana", message }));
    assert.equal(await card(message), `I'll call Ana to tell them: ${message}. Shall I?`, "Pako's words stay English");
    assert.equal(placed.at(-1)!.language, "es", "a Spanish message still goes out in Spanish");
  }
});

test("a yes in English: go ahead, do it, of course, call her and confirm count; anything with another word does not, and the Spanish words are no yes any more", () => {
  for (const yes of [
    "go ahead", "Go ahead!", "do it", "Do it.", "of course", "call", "call her", "Call him", "call them", "confirm", "yup", "yes, go ahead", "ok do it",
    "go ahead please", "sure, call her", "yes of course",
    // The single words that already counted.
    "ok", "yes", "yeah", "sure",
  ]) assert.equal(isYes(yes), true, yes);
  for (const no of [
    // Half a pair is no yes, and neither are its words in another order.
    "go", "ahead", "do", "it", "of", "course", "her", "ahead go", "it do", "course of",
    // Any other word makes it not one.
    "don't do it", "do not do it", "never do it", "of course not", "go ahead and wait", "call Pedro", "call her later", "don't call her", "call her?",
    "do it tomorrow", "go away", "send it", "send", "no", "no, go ahead", "",
    // The Spanish words that once counted: the card and the read-back they answer are English now, and so is the yes.
    "sí", "vale", "claro", "adelante", "hazlo", "llámala", "sí, por favor",
    // As before.
    "claro que no", "sí, pero espera", "llama a Pedro", "venga ya", "gracias", "¿sí?",
  ]) assert.equal(isYes(no), false, no);
});
