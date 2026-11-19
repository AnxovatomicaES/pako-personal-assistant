import assert from "node:assert/strict";
import { test } from "node:test";
import { createGemini, pickTextModel } from "../src/gemini.ts";

const names = (...n: string[]) => n.map((name) => ({ name: `models/${name}`, supportedActions: ["generateContent"] }));

test("pickTextModel: the newest plain flash text model, a stable name over a preview of the same version, nothing guessed", () => {
  assert.equal(pickTextModel(names("gemini-2.5-flash", "gemini-3.1-flash", "gemini-3.8-flash", "gemini-3.8-pro")), "gemini-3.8-flash");
  assert.equal(pickTextModel(names("gemini-3.8-flash-preview-11-2026", "gemini-3.8-flash")), "gemini-3.8-flash");
  assert.equal(pickTextModel(names("gemini-3.8-flash", "gemini-3.8-flash-preview-11-2026")), "gemini-3.8-flash");
  assert.equal(pickTextModel(names("gemini-3.8-flash-preview-11-2026", "gemini-3.1-flash")), "gemini-3.8-flash-preview-11-2026", "a newer preview beats an older stable");
  assert.equal(pickTextModel(names("gemini-10.1-flash", "gemini-9.9-flash")), "gemini-10.1-flash", "versions compare as numbers");
  // Not text models, or not plain flash.
  assert.equal(pickTextModel(names("gemini-3.8-live", "gemini-3.1-flash-tts-preview", "gemini-3.8-flash-lite", "gemini-3.8-flash-image", "gemini-3.8-pro", "embedding-001")), undefined);
  // Cannot generate content.
  assert.equal(pickTextModel([{ name: "models/gemini-3.8-flash", supportedActions: ["countTokens"] }]), undefined);
  assert.equal(pickTextModel([]), undefined);
  assert.equal(pickTextModel([{ name: "models/gemini-3.8-flash" }]), "gemini-3.8-flash", "no list of actions given: accepted");
});

/** A Gemini client that lists some models and answers from a script, recording every request. */
function fakeClient(o: { models?: { name: string; supportedActions?: string[] }[]; replies?: (string | Error)[] } = {}) {
  const calls: { model: string; contents: unknown; config: Record<string, unknown> }[] = [];
  let listed = 0;
  const replies = [...(o.replies ?? [])];
  const client = {
    models: {
      list: async () => {
        listed++;
        return (async function* () {
          for (const m of o.models ?? names("gemini-3.8-flash", "gemini-3.8-live")) yield m;
        })();
      },
      generateContent: async (p: { model: string; contents: unknown; config: Record<string, unknown> }) => {
        calls.push(p);
        const next = replies.shift() ?? "";
        if (next instanceof Error) throw next;
        return { text: next };
      },
    },
  };
  return { client: client as never, calls, listed: () => listed };
}

const make = (f: ReturnType<typeof fakeClient>, extra: { model?: string } = {}) =>
  createGemini({ apiKey: "k", timeZone: "America/Chicago", place: "Austin, Texas", client: f.client, ...extra });

test("lookUp: asks the discovered model with Google Search and a spoken-answer instruction; the answer is tidied", async () => {
  const f = fakeClient({ replies: ["  Mañana habrá sol\n y dieciocho grados.  "] });
  const g = make(f);
  assert.equal(await g.lookUp("¿Qué tiempo hace mañana en Madrid?"), "Mañana habrá sol y dieciocho grados.");
  assert.equal(f.calls[0]!.model, "gemini-3.8-flash", "the newest flash the key can list; not the live model");
  assert.deepEqual(f.calls[0]!.config.tools, [{ googleSearch: {} }]);
  assert.match(String(f.calls[0]!.config.systemInstruction), /said out loud/);
  assert.match(String(f.calls[0]!.config.systemInstruction), /Austin, Texas/);
  assert.ok((f.calls[0]!.config.maxOutputTokens as number) >= 1000, "room for thinking tokens");
  await g.lookUp("otra");
  assert.equal(f.listed(), 1, "the model is looked up once");
});

test("lookUp: when the search fails or comes back empty it tries once more from what the model knows", async () => {
  const f = fakeClient({ replies: [new Error("search grounding not supported"), "Marte, a veces; Júpiter está más lejos casi siempre."] });
  const g = make(f);
  assert.equal(await g.lookUp("¿Qué está más lejos, Júpiter o Marte?"), "Marte, a veces; Júpiter está más lejos casi siempre.");
  assert.deepEqual(f.calls[0]!.config.tools, [{ googleSearch: {} }]);
  assert.equal(f.calls[1]!.config.tools, undefined, "the second try has no search tool");
  assert.match(String(f.calls[1]!.config.systemInstruction), /answer from what you know/);
  // An empty answer (blocked or thought-only) counts the same.
  const f2 = fakeClient({ replies: ["", "Unos ocho minutos luz."] });
  assert.equal(await make(f2).lookUp("¿Cuánto tarda la luz del Sol?"), "Unos ocho minutos luz.");
  assert.equal(f2.calls.length, 2);
  // Both fail: an empty answer, never a throw.
  const f3 = fakeClient({ replies: [new Error("a"), new Error("b")] });
  assert.equal(await make(f3).lookUp("algo"), "");
});

test("lookUp: a model set by the owner is used without listing; an error or no model gives an empty answer, never a throw", async () => {
  const f = fakeClient({ replies: [new Error("quota")] });
  const g = make(f, { model: "gemini-9-flash" });
  assert.equal(await g.lookUp("algo"), "");
  assert.equal(f.calls[0]!.model, "gemini-9-flash");
  assert.equal(f.listed(), 0);
  const none = make(fakeClient({ models: names("gemini-3.8-live") }));
  assert.equal(await none.lookUp("algo"), "", "no usable model found");
  const f2 = fakeClient({ models: names("gemini-3.8-live") });
  const g2 = make(f2);
  await g2.lookUp("a");
  await g2.lookUp("b");
  assert.equal(f2.listed(), 1, "a failed discovery is not retried on every call");
});

test("summarize: one line of a call with at least two owner lines, no search tool, NONE and short calls give nothing", async () => {
  const f = fakeClient({ replies: ["Quiere cenar con Ana el viernes.", "NONE", "none, nada que guardar"] });
  const g = make(f);
  const call = "Agent: Hola.\nUser: Ceno con Ana el viernes.\nAgent: Genial.\nUser: Recuérdamelo.";
  assert.equal(await g.summarize(call), "Quiere cenar con Ana el viernes.");
  assert.equal(f.calls[0]!.config.tools, undefined, "a summary needs no web search");
  assert.match(String(f.calls[0]!.config.systemInstruction), /without naming anyone/);
  assert.equal(await g.summarize(call), "");
  assert.equal(await g.summarize(call), "");
  assert.equal(await g.summarize("Agent: Hola.\nUser: Dime."), "", "a call with one line of the owner is not worth a summary");
  assert.equal(f.calls.length, 3, "and it did not even ask");
});
