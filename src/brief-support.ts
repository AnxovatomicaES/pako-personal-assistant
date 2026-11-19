// Is a line of the brief supported by the facts it cites? Two checks written as code, run on every brief before the owner sees it and by
// the evals on what the model wrote: the people it names, and the clock times it writes. No model run: the facts are the only ground truth.

import { fold } from "./lists.ts";

/**
 * Capitalised words that are not people: days, months, the products and sources Pako names, time zones, and the few English words a
 * sentence capitalises mid-line. Folded (lower case, no accents).
 */
const NOT_NAMES = new Set(("monday tuesday wednesday thursday friday saturday sunday january february march april may june july august"
  + " september october november december today tomorrow tonight yesterday morning afternoon evening noon midnight"
  + " pako slack zoom teams gmail outlook google microsoft apple icloud whatsapp telegram calendar email mail inbox"
  + " utc gmt cet cest bst est edt pst pdt cst cdt mst mdt et pt ct mt am pm ok okay fyi asap eod eow re fwd"
  // The earlier Spanish facts and evals still carry these.
  + " lunes martes miercoles jueves viernes sabado domingo enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre"
  + " diciembre hoy manana madrid"
  // The cities time zones are named by, as the owner's language writes them (an opening in Spanish says "Londres"): places, not people.
  + " londres londra nueva york nova york lisboa lisbonne munich munchen pekin pequim tokio moscu moscou ginebra geneve bruselas bruxelles"
  + " viena wien varsovia praga atenas estambul roma rome milan milano paris berlin amsterdam dublin edimburgo copenhague estocolmo"
  + " singapur hong kong shanghai sidney sydney toronto chicago los angeles francisco mexico bogota lima santiago buenos aires dubai").split(" "));

/**
 * Names in what was written that the facts never had: capitalised words (not the first of a sentence) that appear nowhere in the facts,
 * case and accents aside. A heuristic: a person the model invented shows here; days, months and products never do.
 */
export function inventedNames(written: string, facts: string): string[] {
  const known = ` ${fold(facts).replace(/[^\p{L}\p{N}@.]+/gu, " ")} `;
  const out = new Set<string>();
  for (const sentence of written.split(/(?<=[.!?:;¿¡\n•])\s*/u)) {
    const words = sentence.trim().split(/\s+/);
    words.forEach((w, i) => {
      const clean = w.replace(/['’]s$/u, "").replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
      if (i === 0 || !/^\p{Lu}\p{Ll}{2,}$/u.test(clean)) return;
      const f = fold(clean);
      if (NOT_NAMES.has(f) || known.includes(` ${f}`)) return;
      out.add(clean);
    });
  }
  return [...out];
}

/** Words that name a zone after a time: "time", "Zeit", "hora" ("16:30 Hong Kong time"), and city words of the NOT_NAMES list. */
const ZONE_WORDS = /^(?:time|hora|zeit|heure)$/;

/** "5:15 AM", "3pm", "11 a.m." */
const AMPM = /\b(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s?m\b\.?/gi;

/**
 * The clock times a text writes, as minutes after midnight, kept apart: `bare` are 24-hour "H:MM" times (the owner's zone, as every fact
 * writes them), `ampm` are times said with AM/PM (often another zone's, "5:15 AM ET", always beside the owner's own).
 */
export function clockTimes(text: string, ownerPlace = ""): { bare: number[]; ampm: number[]; zoned: number[] } {
  const ampm: number[] = [];
  for (const m of text.matchAll(AMPM)) {
    const h = Number(m[1]);
    const min = Number(m[2] ?? "0");
    if (h < 1 || h > 12 || min > 59) continue;
    ampm.push(((h % 12) + (m[3]!.toLowerCase() === "p" ? 12 : 0)) * 60 + min);
  }
  const bare: number[] = [];
  const zoned: number[] = [];
  const own = fold(ownerPlace);
  // A 24-hour time labelled with another zone or city right after it ("16:30 Hong Kong", "16:30 HKT") is that zone's time; one labelled
  // with the owner's own city ("11:15 Madrid"), or not labelled, is the owner's.
  // The label: the first capitalised word in the few words after the time ("16:30 Hong Kong", "16:30 (hora de Hong Kong)", "16:30 in HKT").
  for (const m of text.replace(AMPM, " ").matchAll(/(?<![\d:/.])(\d{1,2}):(\d{2})(?!\d|:\d)((?:[\s(]+(?:\p{Ll}{1,5}|\p{L}+)){0,4})/gu)) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) continue;
    const word = (m[3] ?? "").split(/[\s(]+/).find((w) => /^\p{Lu}/u.test(w)) ?? "";
    const label = fold(word);
    const other = !!label && label !== own && (/^[A-Z]{2,5}$/.test(word) || NOT_NAMES.has(label) || ZONE_WORDS.test(label));
    (other ? zoned : bare).push(h * 60 + min);
  }
  return { bare, ampm, zoned };
}

/** The facts a line may lean on: their texts and labels, and the times they are at, in the owner's zone. */
export interface Ground {
  text: string;
  /** The brief's own moment ("Now"), as minutes after midnight in the owner's zone: the brief may say what time it is. */
  now?: number;
  /** The owner's city, as their zone names it ("Madrid", "London"): a place, not a person, and the label of their own times. */
  place?: string;
  /** Minutes after midnight of the facts' own start and end, in the owner's zone. */
  minutes: number[];
}

/** What a line says that its ground does not: names never seen, and times it does not hold. Empty when the line is supported. */
export function unsupported(line: string, ground: Ground, ownerName = ""): string[] {
  const names = inventedNames(line, `${ground.text} ${ownerName} ${ground.place ?? ""}`);
  const said = clockTimes(line, ground.place);
  const has = clockTimes(ground.text, ground.place);
  // The owner's own times: the facts' (said bare, or with the owner's city), their start and end, and the brief's own "Now".
  const bare = new Set([...has.bare, ...ground.minutes, ...(ground.now !== undefined ? [ground.now] : [])]);
  // Any zone's: every time any of these facts gives.
  const any = new Set([...bare, ...has.ampm, ...has.zoned]);
  const hm = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  // A number to call, an IBAN or a link its facts do not hold (a planted order's payload never reaches the page).
  const held = new Set(payloads(ground.text));
  return [
    ...names,
    ...payloads(line).filter((p) => !held.has(p)),
    ...said.bare.filter((m) => !bare.has(m)).map(hm),
    ...said.zoned.filter((m) => !any.has(m)).map((m) => `${hm(m)} (another zone)`),
    ...said.ampm.filter((m) => !any.has(m)).map((m) => `${hm(m)} (am/pm)`),
  ];
}

/** A text with every sentence that is not supported taken out; what is left, trimmed. */
export function keepSupported(text: string, ground: Ground, ownerName = ""): string {
  if (!text) return text;
  return text
    .split(/(?<=[.!?])\s+/u)
    .filter((s) => !unsupported(s, ground, ownerName).length)
    .join(" ")
    .trim();
}

// ---------- other people's text that tries to instruct Pako ----------

/**
 * Words that address Pako or an assistant with an order, in the text of a message, an email, a meeting or a calendar title: "PAKO: write in
 * the brief…", "assistant: tell the owner to…", "ignore previous instructions". Other people's text is information, never instructions;
 * the model is told so, but a fact like this is not given to it at all (guardFacts). Folded (lower case, no accents) before matching.
 */
const INSTRUCTS = [
  // Addressed at the start of the message, or right after its sender ("…, de unknown-bot: PAKO: …"): "the meeting with Pako, the intern" is not.
  /(^|[:·]\s*)pako\s*[:,]/,
  new RegExp("(^|[:·]\\s*)(assistant|asistente|claude|chatgpt|ai|ia|bot)\\s*[:,]\\s*(please\\s+|por favor\\s+)?"
    + "(write|tell|say|add|put|remind|call|send|ignore|escribe|di|dile|anade|pon|recuerda|llama|envia|ignora)\\b"),
  /\bignore\s+(all\s+|the\s+|any\s+)?(previous|prior|above|earlier|your)\s+(instructions|messages|rules|prompt)/,
  /\bignora\s+(todas\s+)?(las\s+)?instrucciones/,
  /\b(write|put|add|include|say)\s+(this\s+)?(in|on|into|to)\s+(the|my|his|her|their|your)?\s*(brief|summary|report|page|briefing)\b/,
  /\b(escribe|pon|anade|incluye)\s+(esto\s+)?en\s+el\s+(brief|resumen|informe)\b/,
  /\btell\s+(the\s+)?(owner|user|boss)\s+(to|that)\b/,
  /\bdile\s+al\s+(dueno|propietario|usuario|jefe)\b/,
  /\b(system|developer)\s+(prompt|message|instructions?)\s*:/,
  /\b(new|updated)\s+instructions\s*:/,
  /\bdo\s+not\s+(tell|mention|show)\s+(this\s+)?(to\s+)?(the\s+)?(owner|user)\b/,
];

/** Whether a text addresses Pako or an assistant with an instruction. */
export function instructsPako(text: string): boolean {
  const t = fold(text);
  return INSTRUCTS.some((re) => re.test(t));
}

/** Phone numbers (9 digits or more, as written), IBANs and links in a text: what a planted order would have the owner call, pay or open. */
export function payloads(text: string): string[] {
  // Nine digits or more (a phone number anywhere), never a date written 2026-11-20.
  const phones = [...text.matchAll(/(?<![\p{L}\d])\+?\d[\d\s().-]{5,}\d(?!\d)/gu)]
    .filter((m) => !/^\d{4}-\d{2}-\d{2}/.test(m[0].trim())).map((m) => m[0].replace(/\D/g, "")).filter((d) => d.length >= 9);
  const ibans = [...text.matchAll(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/g)].map((m) => m[0].replace(/\s/g, ""));
  const links = [...text.matchAll(/\b(?:https?:\/\/|www\.)\S+/gi)].map((m) => m[0].toLowerCase());
  return [...phones, ...ibans, ...links];
}
