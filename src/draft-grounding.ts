// Is a draft held by its material? A check written as code, run on every draft Pako writes (src/brief-v2.ts result) before the owner sees
// it, the same idea as the brief's (src/brief-support.ts): a sentence that names a person, a clock time, a time zone, a date, a weekday, a
// number or a file its material never holds, or promises what someone else will do, is taken out. The material is the draft's own facts
// (the loop, the thread, what Pako knows of the person) and the owner's corrections; never the request Pako wrote, nor the "Now" line.
// When nothing of the message is left, the draft is kept as written and its first line says to check it before sending.

import { attachmentOf, clockTimes, inventedNames, NOT_NAMES, unsupported } from "./brief-support.ts";
import { fold, today as dayOf } from "./lists.ts";

/** What a draft may lean on. */
export interface DraftGround {
  /** The draft's facts (labels and texts) and the owner's corrections, as text. */
  text: string;
  /** When the draft was asked, and the owner's zone: the day it is may be named, and a weekday its facts name is that week's. */
  now: number;
  timeZone: string;
  /** The owner's name (their sign-off) and the person the draft goes to (their greeting): always allowed. */
  owner?: string;
  who?: string;
  /** The follow-up's title (what it sends) and whether a fact shows an attachment (src/brief-support.ts attachmentOf). */
  title: string;
  attached: boolean;
}

export interface Grounded {
  /** The draft the owner is shown. */
  text: string;
  /** What was taken out, and why ("Lena", "London time", "attachment"): for the log and the tests. */
  removed: string[];
  /** The first line says to check it before sending: nothing of the message was left, so it stays as written. */
  check: boolean;
}

const DAY = 86_400_000;

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
  enero: 1, ene: 1, febrero: 2, marzo: 3, abril: 4, abr: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, ago: 8, septiembre: 9, setiembre: 9,
  octubre: 10, noviembre: 11, diciembre: 12, dic: 12,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

/** Weekdays, Sunday 0, as a folded word: the full names in English and Spanish, and the short English ones of Pako's labels ("Tue 17/11"). */
const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6,
};
const SHORT_DAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Tues: 2, Wed: 3, Thu: 4, Thur: 4, Thurs: 4, Fri: 5, Sat: 6 };

/** Zone abbreviations, as written (upper case). */
const ZONE_ABBR = new Set(("UTC GMT CET CEST WET WEST EET EEST BST IST EST EDT CST CDT MST MDT PST PDT ET CT MT PT AEST AEDT ACST AWST"
  + " NZST NZDT HKT SGT JST KST").split(" "));
/** Words of NOT_NAMES that are no place: a day, a month, a moment, a product. What is left there is a city or a zone. */
const NO_PLACE = new Set([...Object.keys(MONTHS), ...Object.keys(WEEKDAYS), ...("today tomorrow tonight yesterday morning afternoon evening noon"
  + " midnight hoy manana pako slack zoom teams gmail outlook google microsoft apple icloud whatsapp telegram calendar email mail inbox ok okay"
  + " fyi asap eod eow re fwd am pm").split(" ")]);
/** Words that name a region's zone rather than a city ("Pacific time", "hora peninsular"). */
const ZONE_REGIONS = new Set("pacific eastern central mountain atlantic european greenwich coordinated universal peninsular canarias canary".split(" "));
const isPlace = (w: string): boolean => {
  const f = fold(w);
  return ZONE_REGIONS.has(f) || (NOT_NAMES.has(f) && !NO_PLACE.has(f));
};

/** Words a sentence starts with that are never a person ("Please can you…", "We will…"). Folded. */
const STARTERS = new Set(("please we you they he she it this that these those there here what who which when where how why everything"
  + " nothing someone anyone everyone all both either neither one each also then so but and or if as let happy glad thanks thank sorry just"
  + " any our your their my his her its both shall could would should can will may might must hope looking great perfect sure good fine").split(" "));
/** The word after a name that makes a sentence a claim or a promise about that person: "Lena can confirm", "Lena will pick". Folded. */
const MODALS = new Set(("can could will would should may might must shall is was has had says said confirmed asked wants needs knows mentioned"
  + " told suggested agreed puede podra podria va dice dijo confirmara confirmo").split(" "));
const PROMISE = /^(can|could|will|would|ll|is going to|will be able to|puede|podra|podria|va a|se encargara|confirmara|te confirmara)\b/;

/** Words that only fill a message: no ask, no fact ("Let me know if you have any questions", "Hope you're well"). Folded, ' as '. */
const FILLER = new RegExp("^(please )?(do )?(let me know if (you have any|there are any|anything|you need|you'd like|you would like|you want|i can)"
  + "|(don't|do not) hesitate|feel free to|(i )?hope (you|this|all|your|the)|any questions|no dudes en|quedo a (tu|su|vuestra) disposicion"
  + "|espero que (estes|este|esteis|todo))");

/** A greeting that opens a line, set apart from the rest of its sentence ("Dear Sofia, for the call…"). */
const GREETING = /^((?:dear|hi|hello|hey|hola|buenos d[ií]as|buenas tardes|buenas|querid[oa]s?|estimad[oa]s?|good (?:morning|afternoon|evening))\b[^,!:\n]{0,40}[,!:])\s+(?=\S)/iu;

const words = (text: string): Set<string> => new Set(fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean));

/** The dates a text writes, each as its possible "M-D" (a "3/11" may be either), with what matched. Works on folded text. */
function datesIn(f: string): { keys: string[]; said: string }[] {
  const out: { keys: string[]; said: string }[] = [];
  const md = (m: number, d: number): string[] => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? [`${m}-${d}`] : []);
  for (const m of f.matchAll(/\b\d{4}-(\d{1,2})-(\d{1,2})\b/g)) out.push({ keys: md(Number(m[1]), Number(m[2])), said: m[0] });
  for (const m of f.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?(?![\d/])/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    out.push({ keys: [...md(b, a), ...md(a, b)], said: m[0] });
  }
  for (const m of f.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th|º|ª)?\\s+(?:de\\s+|of\\s+)?(${MONTH_RE})\\b\\.?`, "g"))) {
    out.push({ keys: md(MONTHS[m[2]!]!, Number(m[1])), said: m[0] });
  }
  for (const m of f.matchAll(new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?![:.]\\d)`, "g"))) {
    out.push({ keys: md(MONTHS[m[1]!]!, Number(m[2])), said: m[0] });
  }
  return out.filter((x) => x.keys.length).map((x) => ({ ...x, said: x.said.replace(/\.$/, "") }));
}

/** The weekdays a text names: full names in any case, the short ones only capitalised ("Fri", never "sat"). */
function weekdaysIn(text: string): { day: number; said: string }[] {
  const out: { day: number; said: string }[] = [];
  for (const w of text.split(/[^\p{L}]+/u)) {
    const full = WEEKDAYS[fold(w)];
    if (full !== undefined) out.push({ day: full, said: w });
    else if (SHORT_DAYS[w] !== undefined) out.push({ day: SHORT_DAYS[w]!, said: w });
  }
  return out;
}

/** The zones a text names: an abbreviation ("ET"), a place before "time" ("London time"), after "hora de", or right after a clock time. */
function zonesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b([A-Z]{2,5})\b/g)) if (ZONE_ABBR.has(m[1]!)) out.push(m[1]!);
  const placeRun = "((?:\\p{Lu}\\p{L}+\\s+){0,2}\\p{Lu}\\p{L}+)";
  const runs = [
    ...[...text.matchAll(new RegExp(`${placeRun}\\s+(?:time|timezone|time zone|zeit|heure)\\b`, "gu"))].map((m) => m[1]!),
    ...[...text.matchAll(new RegExp(`\\bhora\\s+(?:de\\s+|del\\s+)?${placeRun}`, "gu"))].map((m) => m[1]!),
    ...[...text.matchAll(new RegExp(`(?:\\d{1,2}[:.]\\d{2}|\\d{1,2}\\s*[aApP]\\.?[mM]\\.?)\\s*\\(?\\s*(?:in\\s+)?${placeRun}`, "gu"))].map((m) => m[1]!),
  ];
  for (const run of runs) {
    const place = run.split(/\s+/).filter(isPlace);
    if (place.length) out.push(place.join(" "));
  }
  for (const m of text.matchAll(/\bhora\s+(peninsular|canaria)\b/giu)) out.push(m[1]!);
  return out;
}

/** The numbers a text writes beyond its times and dates: "5,000", "€1.2k", "Q4". Works on folded text, with times and dates taken out. */
function numbersIn(f: string): { key: string; alnum: boolean; said: string }[] {
  const out: { key: string; alnum: boolean; said: string }[] = [];
  for (const m of f.matchAll(/[\p{L}\d][\p{L}\d.,%]*/gu)) {
    const t = m[0].replace(/[.,]+$/, "");
    if (!/\d/.test(t)) continue;
    const ordinal = /^(\d+)(?:st|nd|rd|th|º|ª)$/.exec(t);
    if (/\p{L}/u.test(t.replace(/%/g, "")) && !ordinal) out.push({ key: t, alnum: true, said: t });
    else out.push({ key: (ordinal ? ordinal[1]! : t).replace(/\D/g, "").replace(/^0+(?=\d)/, ""), alnum: false, said: t });
  }
  return out;
}

/** A folded text with what is no amount taken out: [blank]s, phone numbers, clock times, dates. */
function withoutTimesAndDates(f: string): string {
  // A phone number (nine digits or more) is no amount: payloads() in unsupported() checks it whole, against the owner's own.
  let s = f.replace(/\[[^\]]*\]/g, " ").replace(/\+?\d[\d\s().-]{5,}\d/g, (m) => (m.replace(/\D/g, "").length >= 9 ? " " : m))
    .replace(/\b\d{1,2}(?:[:.]\d{2})?\s*[ap]\.?\s?m\b\.?/g, " ")
    .replace(/(?<![\d.,])\d{1,2}[:.h]\d{2}(?![\d.,])/g, " ")
    .replace(/(?<![\d.,])\d{1,2}h\b/g, " ");
  for (const d of datesIn(s)) s = s.replace(d.said, " ");
  return s;
}

/** What the material holds, read once: its words, its numbers, the days it names (as "M-D") and the weekdays it names or falls on. */
interface Held { words: Set<string>; numbers: Set<string>; dates: Set<string>; weekdays: Set<number>; minutes: number[] }

function heldBy(g: DraftGround): Held {
  const f = fold(g.text);
  const numbers = new Set<string>();
  for (const n of numbersIn(f)) if (!n.alnum) numbers.add(n.key);
  for (const m of f.matchAll(/\d+/g)) numbers.add(m[0].replace(/^0+(?=\d)/, ""));
  const today = dayOf(g.now, g.timeZone);
  numbers.add(today.slice(0, 4));
  const dates = new Set<string>(datesIn(f).flatMap((d) => d.keys));
  const weekdays = new Set<number>(weekdaysIn(g.text).map((w) => w.day));
  // The day it is, and every day of the fortnight around it that falls on a weekday the material names ("by Friday": Friday 20 Nov).
  const md = (day: string): string => `${Number(day.slice(5, 7))}-${Number(day.slice(8, 10))}`;
  const weekdayOf = (day: string): number => new Date(`${day}T12:00:00Z`).getUTCDay();
  dates.add(md(today));
  weekdays.add(weekdayOf(today));
  for (let k = -7; k <= 7; k++) {
    const day = dayOf(g.now + k * DAY, g.timeZone);
    if (weekdays.has(weekdayOf(day))) dates.add(md(day));
  }
  // The weekdays the material's dates fall on, in the year nearest to now.
  const year = Number(today.slice(0, 4));
  for (const key of [...dates]) {
    const [m, d] = key.split("-").map(Number) as [number, number];
    const near = [year - 1, year, year + 1].map((y) => Date.UTC(y, m - 1, d, 12)).sort((a, b) => Math.abs(a - g.now) - Math.abs(b - g.now))[0]!;
    weekdays.add(new Date(near).getUTCDay());
  }
  // Every clock time the material gives, in any zone: a draft goes to someone who may write the time in theirs ("11:15 London" is 11:15).
  const t = clockTimes(g.text);
  return { words: words(g.text), numbers, dates, weekdays, minutes: [...t.bare, ...t.ampm, ...t.zoned] };
}

/** What one sentence says that its material does not hold; empty when it is held. */
function unheld(sentence: string, g: DraftGround, held: Held): string[] {
  const owner = g.owner ?? "";
  // People, clock times, numbers to call and links (src/brief-support.ts), with the owner's name allowed.
  const items = unsupported(sentence, { text: g.text, minutes: held.minutes }, owner);
  const lead = sentence.trim().split(/\s+/);
  const first = (lead[0] ?? "").replace(/['’]s$/u, "").replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
  // The first word of a sentence is a person when a claim follows it ("Lena can confirm"): inventedNames leaves the first word out.
  if (/^\p{Lu}\p{Ll}{2,}$/u.test(first) && !STARTERS.has(fold(first)) && (MODALS.has(fold(lead[1] ?? "")) || /['’]s$/u.test(lead[0] ?? ""))) {
    items.push(...inventedNames(`and ${first}`, `${g.text} ${owner}`));
  }
  // What someone other than the person it goes to will do: no fact says it ("Lena can pick whichever fits").
  if (g.who) {
    const own = words(`${g.who} ${owner}`);
    for (const m of sentence.matchAll(/(?<![\p{L}])(\p{Lu}\p{Ll}+)(?:\s+\p{Lu}\p{Ll}+)?(?:['’]ll|\s+(\p{L}+(?:\s+\p{L}+){0,3}))/gu)) {
      const name = fold(m[1]!);
      if (own.has(name) || STARTERS.has(name) || NOT_NAMES.has(name) || !held.words.has(name)) continue;
      if (/['’]ll/.test(m[0]) || PROMISE.test(fold(m[2] ?? ""))) items.push(`a promise about ${m[1]}`);
    }
  }
  for (const z of zonesIn(sentence)) if (!fold(z).split(" ").every((w) => held.words.has(w))) items.push(`${z} time`);
  const f = fold(sentence);
  for (const d of datesIn(f)) if (!d.keys.some((k) => held.dates.has(k))) items.push(d.said);
  for (const w of weekdaysIn(sentence)) if (!held.weekdays.has(w.day)) items.push(w.said);
  for (const n of numbersIn(withoutTimesAndDates(f))) {
    if (n.alnum ? !held.words.has(n.key) : !held.numbers.has(n.key)) items.push(n.said);
  }
  if (attachmentOf(sentence, g) === "unbacked") items.push("an attachment");
  return [...new Set(items)];
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A sentence with the details its material lacks left for the owner to fill, as the prompt asks: a clock time, a date, a weekday or a
 * number becomes a [blank], and a zone set off after a comma or in brackets (", London time") goes. A person, a file or a promise has no
 * blank: unheld() still finds them, and the sentence goes.
 */
function blankDetails(sentence: string, held: Held): string {
  const blank = (m: string): string => (/^\s/.test(m) ? " [blank]" : "[blank]");
  let s = sentence
    .replace(/(\s?)\b(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s?m\b\.?/gi, (m, _s: string, h: string, mm: string | undefined, ap: string) => {
      const min = ((Number(h) % 12) + (ap.toLowerCase() === "p" ? 12 : 0)) * 60 + Number(mm ?? "0");
      return held.minutes.includes(min) ? m : blank(m);
    })
    .replace(/(?<![\d:/.])(\d{1,2}):(\d{2})(?!\d)/g, (m, h: string, mm: string) => (held.minutes.includes(Number(h) * 60 + Number(mm)) ? m : "[blank]"));
  for (const z of zonesIn(s)) {
    if (!fold(z).split(" ").every((w) => held.words.has(w))) s = s.replace(new RegExp(`\\s*(?:,\\s*|\\(\\s*)(?:in\\s+)?${escape(z)}\\s+time\\)?`, "u"), "");
  }
  for (const d of datesIn(fold(s))) {
    if (!d.keys.some((k) => held.dates.has(k))) s = s.replace(new RegExp(`(?<![\\p{L}\\d])${escape(d.said)}\\.?(?![\\p{L}\\d])`, "iu"), "[blank]");
  }
  s = s.replace(/\p{L}+/gu, (w) => {
    const day = WEEKDAYS[fold(w)] ?? SHORT_DAYS[w];
    return day === undefined || held.weekdays.has(day) ? w : "[blank]";
  });
  for (const n of numbersIn(withoutTimesAndDates(fold(s)))) {
    if (n.alnum ? held.words.has(n.key) : held.numbers.has(n.key)) continue;
    s = s.replace(new RegExp(`(?<![\\p{L}\\d.,])${escape(n.said)}(?![\\p{L}\\d])`, "iu"), "[blank]");
  }
  return s.replace(/\[blank\](?:[\s,]+(?:on\s+|de\s+)?\[blank\])+/g, "[blank]");
}

/**
 * What a follow-up sends, from its title, as a line's start: "Draft: Send Sofia the revised quote" is "The revised quote"; "" when the
 * title names no thing (src/brief-support.ts attachmentOf only calls a claim "sent" when it does).
 */
function thingSent(title: string, who: string): string {
  const people = new Set(fold(who).split(" ").filter(Boolean));
  const rest = title.replace(/^[^:]{0,20}:\s*/u, "").replace(/^\S+\s+/u, "").split(/\s+/)
    .filter((w, i, all) => !people.has(fold(w).replace(/[^\p{L}]/gu, "")) && !(/^(to|a)$/i.test(w) && people.has(fold(all[i + 1] ?? ""))))
    .join(" ").replace(/[.\s]+$/, "");
  return rest ? `${rest[0]!.toUpperCase()}${rest.slice(1)}` : "";
}

/** A sentence that says nothing but hello or goodbye ("Kind regards", "Thanks!", "Best, Alex"). */
const SIGN_OFF = new RegExp("^(kind regards|best regards|regards|best|thanks|thank you|many thanks|cheers|saludos|un saludo|gracias|muchas gracias"
  + "|un abrazo|abrazos|atentamente)( so much| a lot| again| in advance)?\\b[\\s,!.]*(\\p{L}+)?[.!]?$", "iu");
const isSubstance = (s: string): boolean => !GREETING.test(`${s} x`) && !SIGN_OFF.test(s.trim()) && s.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length >= 3;

/**
 * A draft held by its material: a time, date, weekday or number it lacks left as a [blank], every other sentence that says something the
 * material does not hold taken out (and the "Let me know if…" kind of filler), the first line (where it goes) kept, without a clause
 * that names someone unknown ("…, copying Lena Park"). When nothing of
 * the message is left, the draft stays as written, marked to check before sending with what is not in the facts. The file the follow-up
 * sends, said to be attached or here with no fact showing it, becomes a line for the owner to fill ("The revised quote: [blank]").
 */
export function groundDraft(draft: string, g: DraftGround): Grounded {
  const held = heldBy(g);
  const lines = draft.split("\n");
  let head = lines.length > 1 ? lines[0]! : null;
  const removed: string[] = [];
  let handed = false;
  let substance = false;
  const body = (head === null ? lines : lines.slice(1)).flatMap((line) => {
    if (!line.trim()) return [line];
    const greet = GREETING.exec(line);
    const pieces = [...(greet ? [greet[1]!] : []), ...line.slice(greet ? greet[0].length : 0).split(/(?<=[.!?])\s+/u)];
    const kept = pieces.map((s) => {
      // The thing the follow-up sends, said to be attached or here when no fact shows it: a line for the owner to attach or paste it.
      if (attachmentOf(s, g) === "sent") {
        removed.push("an attachment");
        const thing = handed ? "" : thingSent(g.title, g.who ?? "");
        handed = true;
        return thing ? `${thing}: [blank].` : null;
      }
      const items = unheld(s, g, held);
      if (!items.length) return s;
      // A detail it lacks becomes a [blank]; what has no blank (a person, a file, a promise) takes the sentence with it.
      const filled = blankDetails(s, held);
      removed.push(...items);
      return filled !== s && !unheld(filled, g, held).length ? filled : null;
    }).filter((s): s is string => {
      if (s === null) return false;
      if (FILLER.test(fold(s).replace(/’/g, "'"))) return void removed.push(`filler: ${s.trim().slice(0, 40)}`), false;
      if (isSubstance(s)) substance = true;
      return true;
    });
    const text = kept.join(" ").trim();
    return text ? [text] : [];
  });
  if (head !== null) {
    const names = inventedNames(head, `${g.text} ${g.owner ?? ""}`);
    if (names.length) {
      const cut = head.split(/,\s+/)[0]!;
      removed.push(...names);
      head = inventedNames(cut, `${g.text} ${g.owner ?? ""}`).length ? head : cut;
    }
  }
  const facts = removed.filter((x) => !x.startsWith("filler: "));
  // Nothing of the message is left: it stays as written, for the owner to check (or as it was, when only filler went).
  if (!substance && !facts.length) return { text: draft, removed: [], check: false };
  if (!substance) {
    const mark = `Check before sending (not in the facts: ${facts.slice(0, 4).join(", ")})`;
    return { text: head === null ? `${mark}\n${draft}` : `${mark} · ${draft}`, removed, check: true };
  }
  const out = [...(head === null ? [] : [head]), ...body].join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: out, removed, check: false };
}
