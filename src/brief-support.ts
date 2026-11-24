// Is a line of the brief supported by the facts it cites? Two checks written as code, run on every brief before the owner sees it and by
// the evals on what the model wrote: the people it names, and the clock times it writes. No model run: the facts are the only ground truth.

import { fold } from "./lists.ts";

/**
 * Capitalised words that are not people: days, months, the products and sources Pako names, time zones, and the few English words a
 * sentence capitalises mid-line. Folded (lower case, no accents).
 */
export const NOT_NAMES = new Set(("monday tuesday wednesday thursday friday saturday sunday january february march april may june july august"
  + " september october november december today tomorrow tonight yesterday morning afternoon evening noon midnight eastern pacific este"
  + " pako slack zoom teams gmail outlook google microsoft apple icloud whatsapp telegram calendar email mail inbox"
  + " utc gmt cet cest bst est edt pst pdt cst cdt mst mdt et pt ct mt am pm ok okay fyi asap eod eow re fwd"
  // The earlier Spanish facts and evals still carry these.
  + " lunes martes miercoles jueves viernes sabado domingo enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre"
  + " diciembre hoy manana madrid"
  // The cities time zones are named by, as the owner's language writes them (an opening in Spanish says "Londres"): places, not people.
  + " londres londra nueva york nova york lisboa lisbonne munich munchen pekin pequim tokio moscu moscou ginebra geneve bruselas bruxelles"
  + " viena wien varsovia praga atenas estambul roma rome milan milano paris berlin amsterdam dublin edimburgo copenhague estocolmo"
  + " singapur hong kong shanghai sidney sydney toronto chicago los angeles francisco mexico bogota lima santiago buenos aires dubai"
  // The same cities as Pako's English texts and the brief name them ("16:30 London time", "9:00 AM New York time").
  + " london new york tokyo lisbon beijing moscow geneva brussels vienna warsaw prague athens istanbul edinburgh copenhagen stockholm oslo"
  + " helsinki zurich singapore seoul mumbai delhi kolkata bangkok jakarta manila taipei melbourne brisbane perth auckland honolulu"
  + " anchorage denver phoenix vancouver montreal sao paulo cairo johannesburg lagos nairobi riyadh tehran karachi"
  // The zones of the owners Pako has outside Europe.
  + " ist aest aedt acst awst nzst nzdt hkt sgt jst").split(" "));

/**
 * Capitalised words of a mailbox, a calendar and Pako's own pages ("your Sent folder", "under Needs you", "pressed Not mine", "Mon 16/11"):
 * never people, but never a zone either, so kept apart from NOT_NAMES (which also tells a time's zone: "10:00 Standup" is the owner's time).
 * No word here is also a common first name (Will, Mark, Grace and Bill stay out). Folded.
 */
const UI_WORDS = new Set(("mon tue tues wed thu thur thurs fri sat sun jan feb mar apr jun jul aug sep sept oct nov dec"
  + " sent inbox outbox drafts draft spam junk trash bin archive archived starred flagged unread snooze snoozed undo reply forward forwarded"
  + " subject cc bcc attachment attached folder label labels settings notifications primary promotions updates needs later important"
  + " security receipt invoice brief focus todo todos tasks task notes note lists list reminders reminder people person contacts open done"
  + " not mine yes no new moved gone since agenda invite invitation accepted declined tentative busy free meet meeting meetings event events standup").split(" "));

/**
 * Names in what was written that the facts never had: capitalised words (not the first of a sentence) that appear nowhere in the facts,
 * case and accents aside. A heuristic: a person the model invented shows here; days, months and products never do.
 */
export function inventedNames(written: string, facts: string, labels = ""): string[] {
  // Every word of the facts, an address's too: "jose.garcia@acme.com" holds José García; and every word of the facts' labels, Pako's own.
  const known = ` ${fold(`${facts} ${labels}`).replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  const out = new Set<string>();
  // A sentence starts after its end mark, a line break, a bullet, or a dash that sets a clause off ("Thanks — Let me know", "Ok - Let's go"):
  // an em or en dash anywhere, a hyphen only with spaces around it (a hyphen inside a word joins a name, "Jean-Pierre").
  for (const sentence of written.split(/(?<=[.!?:;¿¡\n•—–])\s*|\s+-\s+/u)) {
    const words = sentence.trim().split(/\s+/).filter((w) => /\p{L}/u.test(w)); // a lone closing quote (…week." Nothing) starts nothing
    words.forEach((w, i) => {
      const clean = w.replace(/['’]s$/u, "").replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
      if (i === 0 || !/^\p{Lu}[\p{L}'’‐-]*$/u.test(clean)) return;
      // A name with an apostrophe or a hyphen (O'Brien, Jean-Pierre) is checked by its parts.
      const parts = clean.split(/['’‐-]/u).filter((p) => /^\p{Lu}\p{Ll}{2,}$/u.test(p));
      if (parts.every((p) => [fold(p), fold(p).replace(/s$/u, "")].some((q) => NOT_NAMES.has(q) || UI_WORDS.has(q) || known.includes(` ${q}`)))) return;
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
  for (const m of text.replace(AMPM, " ").matchAll(new RegExp(`(?<![\\d:/.])(\\d{1,2}):(\\d{2})(?!\\d|:\\d)(${LABEL})`, "gu"))) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) continue;
    (otherZone(m[3] ?? "", own) ? zoned : bare).push(h * 60 + min);
  }
  return { bare, ampm, zoned };
}

/** The few words after a time, where its zone or city is named ("16:30 Hong Kong", "16:30 (hora de Hong Kong)", "16:30 in HKT"). */
const LABEL = "(?:[\\s(]+(?:\\p{Ll}{1,5}|\\p{L}+)){0,4}";

/**
 * Whether the words after a time name another zone than the owner's (`own`, folded): the first capitalised word is a zone ("HKT"), a city
 * Pako knows, or is followed by "time" ("16:30 Lagos time"). The owner's own city, or no label, is the owner's.
 */
function otherZone(after: string, own: string): boolean {
  const words = after.split(/[\s(]+/).filter(Boolean);
  const i = words.findIndex((w) => /^\p{Lu}/u.test(w));
  if (i < 0) return false;
  const word = words[i]!;
  const label = fold(word);
  if (label === own) return false;
  return /^[A-Z]{2,5}$/.test(word) || NOT_NAMES.has(label) || ZONE_WORDS.test(label) || words.slice(i + 1).some((w) => ZONE_WORDS.test(fold(w)));
}

/**
 * The owner's times as other people write them in the facts, beyond "H:MM": "9am" with no other zone after it, "21h", "9h30". A fact may
 * hold them; a line written by the brief is not checked for "21h" (it writes "21:00", and "within 24h" is a span, not a time).
 */
function ownTimesInFacts(text: string, ownerPlace = ""): number[] {
  const own = fold(ownerPlace);
  const out: number[] = [];
  for (const m of text.matchAll(new RegExp(`${AMPM.source}(${LABEL})`, "giu"))) {
    const h = Number(m[1]);
    const min = Number(m[2] ?? "0");
    if (h < 1 || h > 12 || min > 59 || otherZone(m[4] ?? "", own)) continue;
    out.push(((h % 12) + (m[3]!.toLowerCase() === "p" ? 12 : 0)) * 60 + min);
  }
  for (const m of text.matchAll(/(?<![\d:/.])\b([01]?\d|2[0-3])h([0-5]\d)?\b/g)) out.push(Number(m[1]) * 60 + Number(m[2] ?? "0"));
  return out;
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
  const bare = new Set([...has.bare, ...ownTimesInFacts(ground.text, ground.place), ...ground.minutes, ...(ground.now !== undefined ? [ground.now] : [])]);
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
  // The same order in French, German, Portuguese and Italian.
  new RegExp("\\bignor\\w*\\s+(\\w+\\s+){0,2}((vorherigen|bisherigen|obigen)\\s+anweisungen|(instructions|consignes|instrucoes|istruzioni)\\s+"
    + "(precedentes|anterieures|anteriores|previas|precedenti|anteriori))\\b"),
  /\b(write|put|add|include|say)\s+(this\s+)?(in|on|into|to)\s+(the|my|his|her|their|your)?\s*(brief|summary|report|page|briefing)\b/,
  /\b(escribe|pon|anade|incluye)\s+(esto\s+)?en\s+el\s+(brief|resumen|informe)\b/,
  /\btell\s+(the\s+)?(owner|user|boss)\s+(to|that)\b/,
  /\bdile\s+al\s+(dueno|propietario|usuario|jefe)\b/,
  /\b(system|developer)\s+(prompt|message|instructions?)\s*:/,
  /\b(new|updated)\s+instructions\s*:/,
  /\bdo\s+not\s+(tell|mention|show)\s+(this\s+)?(to\s+)?(the\s+)?(owner|user)\b/,
];

/** Cyrillic and Greek letters drawn like Latin ones ("РАКО", "wrіte"), as the Latin letter; full-width letters too, and nothing invisible. */
const LOOK_ALIKE: Record<string, string> = Object.fromEntries([
  ..."аaвbеeкkмmнhоoрpсcтtуyхxіiјjѕsԁdАAВBЕEКKМMНHОOРPСCТTХXІIЈJЅS",
  ..."αaοoρpνvιiκkτtυuχxεeΑAΒBΕEΖZΗHΙIΚKΜMΝNΟOΡPΤTΥYΧX",
].join("").match(/../gu)!.map((pair) => [...pair] as [string, string]));
const lookAlikes = (text: string): string =>
  text.normalize("NFKC").replace(/[\u00AD\u034F\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, "").replace(/[\u0370-\u04FF\u0500-\u052F]/g, (c) => LOOK_ALIKE[c] ?? c);

/** Whether a text addresses Pako or an assistant with an instruction. */
export function instructsPako(text: string): boolean {
  const t = fold(lookAlikes(text));
  return INSTRUCTS.some((re) => re.test(t));
}

const PHONE = /(?<![\p{L}\d])\+?\d[\d\s().-]{5,}\d(?!\d)/gu;
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/g;
const LINK = /\b(?:https?:\/\/|www\.)\S+/gi;
/** A phone match that is a number (nine digits or more), never a date written 2026-11-20: its digits, or "" when it is not one. */
const phoneOf = (raw: string): string => (/^\d{4}-\d{2}-\d{2}/.test(raw.trim()) ? "" : raw.replace(/\D/g, "").length >= 9 ? raw.replace(/\D/g, "") : "");

/** Phone numbers (9 digits or more, as written), IBANs and links in a text: what a planted order would have the owner call, pay or open. */
export function payloads(text: string): string[] {
  const phones = [...text.matchAll(PHONE)].map((m) => phoneOf(m[0])).filter(Boolean);
  const ibans = [...text.matchAll(IBAN)].map((m) => m[0].replace(/\s/g, ""));
  const links = [...text.matchAll(LINK)].map((m) => m[0].toLowerCase());
  return [...phones, ...ibans, ...links];
}

/**
 * A text with every phone number, IBAN and link taken out (each replaced by `mark`), but those in `keep` (as payloads() gives them): what
 * came from other people's text never carries a number to call, an account to pay or a link to open that the owner's own data does not hold.
 */
export function stripPayloads(text: string, keep: ReadonlySet<string> = new Set(), mark = "[removed]"): string {
  return text
    .replace(LINK, (m) => {
      if (keep.has(m.toLowerCase())) return m;
      // A sentence's own full stop or bracket after a link stays.
      const tail = /[.,;:!?)\]]+$/.exec(m)?.[0] ?? "";
      return keep.has(m.slice(0, m.length - tail.length).toLowerCase()) ? m : `${mark}${tail}`;
    })
    .replace(IBAN, (m) => (keep.has(m.replace(/\s/g, "")) ? m : mark))
    .replace(PHONE, (m) => {
      const d = phoneOf(m);
      if (!d || keep.has(d)) return m;
      // The match may take a space before the number with it: kept, so the words around stay apart.
      return `${/^\s/.test(m) ? " " : ""}${mark}`;
    });
}

// ---------- a draft that claims an attachment its facts do not show ----------

/** Words that say a file goes with a message: "attached", "enclosed", "adjunto", "Anhang", "ci-joint". Folded before matching. */
const ATTACH = /\b(attach\w*|enclos\w*|adjunt\w*|anexo|anhang|angehangt|ci joint|piece jointe)\b/;
/** A follow-up whose own job is to send a thing: the draft that closes it is the message that carries it. */
const SENDS = /\b(send|share|forward|deliver|envia\w*|enviar|manda\w*|mandar|comparte|schick\w*|envoie\w*|envoyer)\b/;
/** Words of a title that never name the thing sent. */
const TITLE_STOP = new Set(("draft send share forward deliver with from that this your their them about before after the for and"
  + " envia enviar manda mandar comparte schick envoyer").split(" "));

/**
 * Words that hand a document over in the message itself, with no "attached": "Here is the revised quote", "please find the deck below",
 * "te paso el presupuesto". Only with a document's name in the same sentence ("here is my availability" hands nothing). Folded.
 */
const HANDS_OVER = /\b(here is|here s|heres|here are|please find|find (it |them )?below|you ll find|sending you|aqui (tienes|va|van)|te (envio|paso|mando)|os (envio|paso|mando)|anbei)\b/;
const DOCUMENT = new RegExp("\\b(quote|quotation|deck|slides?|file|document|doc|pdf|report|contract|proposal|model|spreadsheet|sheet|presentation|invoice"
  + "|agenda|plan|budget|figures|numbers|draft|summary|minutes|cotizacion|presupuesto|propuesta|contrato|informe|documento|archivo|fichero|factura"
  + "|presentacion|borrador|resumen)s?\\b");
const claimsFile = (f: string): boolean => ATTACH.test(f) || (HANDS_OVER.test(f.replace(/['’]/g, " ")) && DOCUMENT.test(f));

/** Whether a text (a draft's facts) says a file was attached or comes attached. */
export const mentionsAttachment = (text: string): boolean => ATTACH.test(fold(text));

/**
 * What a sentence of a draft says about a file going with it: "none" (nothing), "backed" (a fact shows an attachment), "sent" (the thing
 * the follow-up sends: the owner attaches it before sending), or "unbacked" (a file no fact shows).
 */
export function attachmentOf(sentence: string, o: { attached: boolean; title: string }): "none" | "backed" | "sent" | "unbacked" {
  const f = fold(sentence);
  if (!claimsFile(f)) return "none";
  if (o.attached) return "backed";
  const title = fold(o.title);
  const things = SENDS.test(title) ? title.split(" ").filter((w) => w.length >= 4 && !TITLE_STOP.has(w)) : [];
  return things.some((w) => ` ${f.replace(/[^\p{L}\p{N}]+/gu, " ")} `.includes(` ${w} `)) ? "sent" : "unbacked";
}

/**
 * A draft with every sentence that says something is attached taken out, unless that is backed: a fact shows an attachment (`attached`),
 * or the follow-up the draft closes is sending that very thing ("Send Mei the pricing model": "pricing model attached" is how the owner
 * sends it, the file going with the message they press send on). Any other attachment is one the facts never show: "the agenda is
 * attached" in a draft that proposes times. The first line (where the draft goes) is kept as it is; a message that would be left with
 * nothing keeps its words.
 */
export function dropUnbackedAttachments(draft: string, o: { attached: boolean; title: string }): string {
  if (o.attached) return draft;
  const backed = (sentence: string): boolean => attachmentOf(sentence, o) !== "unbacked";
  const lines = draft.split("\n");
  const head = lines.length > 1 ? lines[0]! : null;
  // A line left empty by it goes too; a line that was blank (between paragraphs) stays.
  const body = (head === null ? lines : lines.slice(1)).flatMap((l) => {
    const kept = l.split(/(?<=[.!?])\s+/u).filter(backed).join(" ");
    return kept.trim() || !l.trim() ? [kept] : [];
  });
  if (!body.join("").trim()) return draft;
  return [...(head === null ? [] : [head]), ...body].join("\n");
}
