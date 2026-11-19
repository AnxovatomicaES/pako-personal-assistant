// Gemini text helpers of the worker, using the Google key it already holds: looking something up on the web (Gemini with Google Search) for
// the live voice's look_up tool, and a one-line summary of a finished call for the owner memory. Nothing here needs another key, and nothing
// here touches the main server: its answers come back to the live voice as text.

import { GoogleGenAI } from "@google/genai";
import { createLog } from "./log.ts";

const log = createLog("voice-worker");

export interface ModelInfo {
  name?: string;
  supportedActions?: string[];
}

const cmp = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

/**
 * The newest plain Gemini "flash" text model that can generate content (not live, tts, image, lite or embedding ones), taken from what the key
 * can list: no model name is guessed, so a newer release is picked up by itself. A stable name wins over a preview of the same version.
 */
export function pickTextModel(models: ModelInfo[]): string | undefined {
  let best: { v: number[]; stable: boolean; id: string } | undefined;
  for (const m of models) {
    const id = (m.name ?? "").replace(/^models\//, "");
    const match = /^gemini-(\d+(?:\.\d+)*)-flash(-preview[\w.-]*)?$/.exec(id);
    if (!match) continue;
    if (m.supportedActions && !m.supportedActions.includes("generateContent")) continue;
    const cand = { v: match[1]!.split(".").map(Number), stable: !match[2], id };
    if (!best || cmp(cand.v, best.v) > 0 || (cmp(cand.v, best.v) === 0 && cand.stable && !best.stable)) best = cand;
  }
  return best?.id;
}

const LOOKUP_SYSTEM = `You answer a question for someone on a phone call: the answer is said out loud. {search}\
One or two short spoken sentences, the answer first, in the language of the question (English when it shows none). No lists, no markdown, no links, \
no symbols; say numbers, dates and prices the way people say them. If you could not find it or are not sure, say so briefly. It is {now}.{place}`;
const WITH_SEARCH = "Use Google Search for anything current.";
const WITHOUT_SEARCH = "You cannot search the web now: answer from what you know, and say briefly if it may be out of date.";

const SUMMARY_SYSTEM = `Summarise this phone call between a person and their AI assistant in one short line, in English, in the third person and without naming \
anyone: what the person wanted, decided or asked to follow up. Leave out greetings and small talk. If nothing is worth remembering, answer with exactly NONE.`;

export interface Gemini {
  /** A short spoken answer from the web; "" when it could not be found. */
  lookUp(question: string): Promise<string>;
  /** One line about a finished call; "" when there is nothing worth keeping. */
  summarize(transcript: string): Promise<string>;
}

export function createGemini(o: {
  apiKey: string;
  /** Overrides the model discovery (GEMINI_TEXT_MODEL). */
  model?: string;
  timeZone: string;
  /** Where the person is ("Austin, Texas"), for "near me" questions; "" leaves it out of the prompt. */
  place: string;
  client?: Pick<GoogleGenAI, "models">;
}): Gemini {
  const ai = o.client ?? new GoogleGenAI({ apiKey: o.apiKey });
  let chosen: string | undefined = o.model?.trim() || undefined;
  let lastTry = 0;
  /** The model to use: the override, else the newest flash the key can list (retried at most once a minute when none was found). */
  const model = async (): Promise<string | undefined> => {
    if (chosen) return chosen;
    if (Date.now() - lastTry < 60_000) return undefined;
    lastTry = Date.now();
    try {
      const found: ModelInfo[] = [];
      const pager = await ai.models.list({ config: { pageSize: 100 } });
      for await (const m of pager) {
        found.push(m);
        if (found.length >= 300) break;
      }
      chosen = pickTextModel(found);
      log.error(`text model for lookups and summaries: ${chosen ?? "none found"}`);
    } catch (err) {
      log.error(`could not list Gemini models: ${(err as Error).message}`);
    }
    return chosen;
  };
  const nowText = () =>
    new Intl.DateTimeFormat("en-GB", { timeZone: o.timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(Date.now());
  const clean = (t: string | undefined, max: number) => (t ?? "").replace(/\s+/g, " ").trim().slice(0, max);

  return {
    async lookUp(question) {
      const m = await model();
      if (!m) return "";
      const ask = async (search: boolean): Promise<string> => {
        const res = await ai.models.generateContent({
          model: m,
          contents: question.slice(0, 1000),
          config: {
            systemInstruction: LOOKUP_SYSTEM.replace("{search}", search ? WITH_SEARCH : WITHOUT_SEARCH).replace("{now}", nowText()).replace("{place}", o.place ? ` The person is in ${o.place}.` : ""),
            ...(search ? { tools: [{ googleSearch: {} }] } : {}),
            temperature: 0.3,
            // Thinking models spend part of this on thinking: a small limit can leave no answer at all.
            maxOutputTokens: 1500,
            abortSignal: AbortSignal.timeout(search ? 12_000 : 8_000),
          },
        });
        return clean(res.text, 600);
      };
      // With Google Search first. If that fails or comes back empty (a model without search grounding, a blocked answer, a timeout), one more try
      // without it, from what the model knows: a plain fact ("which is farther, Mars or Jupiter") should not end in "I could not find it".
      try {
        const grounded = await ask(true);
        if (grounded) return grounded;
        log.error("lookup with search came back empty: trying without");
      } catch (err) {
        log.error(`lookup with search failed: ${(err as Error).message}: trying without`);
      }
      try {
        return await ask(false);
      } catch (err) {
        log.error(`lookup failed: ${(err as Error).message}`);
        return "";
      }
    },

    async summarize(transcript) {
      const t = transcript.trim();
      if (t.split("\n").filter((l) => l.startsWith("User:")).length < 2) return "";
      const m = await model();
      if (!m) return "";
      try {
        const res = await ai.models.generateContent({
          model: m,
          contents: t.slice(-6000),
          config: { systemInstruction: SUMMARY_SYSTEM, temperature: 0.2, maxOutputTokens: 1000, abortSignal: AbortSignal.timeout(15_000) },
        });
        const line = clean(res.text, 300);
        return /^none\b/i.test(line) ? "" : line;
      } catch (err) {
        log.error(`summary failed: ${(err as Error).message}`);
        return "";
      }
    },
  };
}
