// Where the pieces of Phase 1 meet: the pause worded by why (src/control.ts) and told from a text passed on (src/voice-tools.ts), the answers
// after a friend call, the one-time code's mark in the mail (src/mail.ts), one source for the names of the door's buttons (src/whatsapp.ts),
// and PAKO_LANGUAGE, accepted and ignored (src/app.ts). Pako's own texts are English only, whatever language the owner writes in.

import assert from "node:assert/strict";
import test from "node:test";
import { languageIgnoredNote } from "../src/app.ts";
import { codeMark } from "../src/codes.ts";
import { PAUSED_TEXTS, PAUSED_WHY_EN, pauseLabel, pausedText, pauseWhyIn, type PauseWhy } from "../src/control.ts";
import type { Kv } from "../src/kv.ts";
import { createMailbox } from "../src/mail.ts";
import { askCard } from "../src/personal-caller.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { friendCallAnswer, loadVoiceTools, readBack } from "../src/voice-tools.ts";
import { buttonLabels } from "../src/whatsapp.ts";

const WHYS: PauseWhy[] = ["owner", "store-empty", "store-unknown"];

function memKv(): Kv {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

test("the pause, by why: English, and never the owner's STOP for Pako's own pause", () => {
  assert.equal(pausedText("owner"), "Pako is paused (STOP): no calls or messages go out until you type RESUME.");
  for (const why of WHYS) assert.equal(pausedText(why), PAUSED_TEXTS[why]);
  assert.equal(pausedText(null), pausedText("owner"), "no reason known: the owner's");
  for (const why of WHYS) assert.ok(pausedText(why).startsWith("Pako is paused"), `${why}: every wording starts alike`);
  // Only the owner's pause says they wrote STOP: the other two say it is for safety, and why.
  assert.match(pausedText("owner"), /\(STOP\)/);
  for (const why of ["store-empty", "store-unknown"] as const) {
    assert.match(pausedText(why), /to be safe/);
    assert.doesNotMatch(pausedText(why), /\(STOP\)/);
  }
  assert.equal(new Set(WHYS.map((why) => pausedText(why))).size, 3);
  assert.deepEqual(WHYS.map((why) => pauseLabel(why)), ["STOP", "store empty", "store not read"]);
  assert.equal(pauseLabel(null), "STOP");
  assert.equal(Object.keys(PAUSED_WHY_EN).length, 3, "the connector's own words, by why, are still there");
});

test("a refusal passed on inside another text is told as a pause, with its reason", () => {
  for (const why of WHYS) {
    assert.equal(pauseWhyIn(pausedText(why)), why);
    assert.equal(pauseWhyIn(`The call could not be placed: ${pausedText(why)}`), why, `${why}, inside an error's message`);
    assert.equal(pauseWhyIn(`Nothing was asked or called: ${pausedText(why)} request_id=abc`), why);
  }
  assert.equal(pauseWhyIn("Quiet hours: no calls between 22:00 and 09:00"), null);
  assert.equal(pauseWhyIn("Pako is paused"), null, "only a whole refusal counts");
  assert.equal(pauseWhyIn(""), null);
});

test("after a friend call: the owner's answer, with the pause said again with its reason", () => {
  for (const why of WHYS) {
    const refusal = { ok: false, text: `The call could not be placed: ${pausedText(why)}` };
    assert.equal(friendCallAnswer(refusal, "Ana").say, `${pausedText(why)} I didn't call Ana.`, why);
  }
  const started = { ok: true, text: "Call to Ana started: call_id=call_abc123, status=registered." };
  assert.deepEqual(friendCallAnswer(started, "Ana"), { say: "Done, I'm calling Ana now.", verbatim: true, placed: { name: "Ana", callId: "call_abc123" } });
  assert.deepEqual(friendCallAnswer({ ok: true, text: "call_id=dryrun_1" }, "Ana"), {
    say: "Simulated: I didn't call Ana (the phone is in test mode).", verbatim: true, simulated: true,
  });
  assert.deepEqual(friendCallAnswer({ ok: false, text: "?", unknown: true }, "Ana"), {
    say: "I don't know whether the call to Ana went out: the phone service didn't answer clearly. I won't try again, so they aren't called twice.",
    verbatim: true, unknown: true,
  });
  assert.equal(friendCallAnswer({ ok: false, text: "too soon", wait: 40 }, "Ana").say, "Calls need a gap between them: I didn't call Ana. Ask again in 40 s.");
  assert.equal(friendCallAnswer({ ok: false, text: "too soon", gap: 40 }, "Ana").say, "Calls need a gap between them: I didn't call Ana. Ask again in 40 s.");
  const quiet = { ok: false, text: "Quiet hours: no friend calls between 22:00 and 09:00." };
  assert.equal(friendCallAnswer(quiet, "Ana").say, "It's quiet hours now: I didn't call Ana. Ask again once they're over, if you still want to.");
  assert.equal(friendCallAnswer({ ok: false, text: "something else" }, "Ana").say, "I couldn't call Ana right now.");
});

test("the voice line's tools answer a confirmed call in English, also when the owner's message is in Spanish", async () => {
  const calls = { ok: true };
  const tools = loadVoiceTools({
    memory: loadMemory(memKv()),
    actions: {
      contacts: () => ["Ana"],
      callContact: async () => (calls.ok ? { ok: true, text: "started: call_id=call_1" } : { ok: false, text: `The call could not be placed: ${PAUSED_TEXTS["store-empty"]}` }),
      lookupCall: async () => "ok",
    },
  });
  const confirm = async (callId: string): Promise<string> => {
    // The message stays in the owner's words (Spanish here); the words around it are Pako's, English.
    const staged = await tools.run({ callId, tool: "call_contact", args: { name: "Ana", message: "que llego tarde" }, trusted: true });
    assert.equal(staged.say, readBack({ name: "Ana", message: "que llego tarde" }));
    assert.equal(staged.say, "I'll call Ana to tell them: que llego tarde. Shall I?");
    return (await tools.run({ callId, tool: "confirm_call", args: {}, readbackText: staged.say, answerText: "yes", trusted: true })).say;
  };
  assert.equal(await confirm("c1"), "Done, I'm calling Ana now.");
  calls.ok = false;
  assert.equal(await confirm("c2"), `${pausedText("store-empty")} I didn't call Ana.`, "a refusal, told with its reason");
});

test("mail: the mark that stands for a one-time code is English, and a text already hidden stays as it is", async () => {
  const box = createMailbox(memKv());
  const email = { id: "m1", at: Date.now(), from: "Bank <no-reply@bank.example>", subject: "Your verification code", text: "Your verification code is 583014.", preview: "" };
  const en = await box.conceal(email);
  assert.equal(en.text, `Your verification code is ${codeMark()}.`);
  assert.equal(codeMark(), "[code hidden · type CODE]");
  assert.deepEqual((await box.codes()).map((c) => c.codes), [["583014"]], "the code itself is kept for CODE, whatever the mark says");
  // An email in Spanish gets the same English mark.
  const es = await box.conceal({ ...email, id: "m2", text: "Tu código de verificación es 771204." });
  assert.equal(es.text, `Tu código de verificación es ${codeMark()}.`);
  // Hidden once, looked at again: nothing changes, and the mark's own words hide nothing new.
  assert.deepEqual(await box.conceal({ ...email, id: "m3", text: en.text }), { subject: email.subject, text: en.text, preview: "" });
});

test("the names of the door's buttons come from one place: the card for a friend call names the Cancel button as the door shows it", () => {
  assert.deepEqual(buttonLabels(), { call: "Call", send: "Send", cancel: "Cancel", undo: "Undo" });
  // WhatsApp cuts a button's title at 20 characters.
  for (const title of Object.values(buttonLabels())) assert.ok(title.length > 0 && title.length <= 20, title);
  // A call whose message is Spanish still gets Pako's English card around it.
  const card = askCard({ name: "Ana", message: "llego tarde", say: "", language: "es", direct: false });
  assert.ok(card.endsWith(`press ${buttonLabels().cancel}.`), card);
  assert.match(card, /llego tarde/);
});

test("PAKO_LANGUAGE is accepted and ignored: a note for the log, whatever its value", () => {
  for (const value of ["es", "en", "fr", "Spanish"]) assert.match(languageIgnoredNote({ PAKO_LANGUAGE: value }) ?? "", /PAKO_LANGUAGE is ignored/, value);
  assert.equal(languageIgnoredNote({}), null);
  assert.equal(languageIgnoredNote({ PAKO_LANGUAGE: " " }), null);
});
