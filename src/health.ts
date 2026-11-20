// The health companion: a small diary the owner keeps on purpose (symptoms, mood, sleep, exercise, water, the medication they take as they
// state it), a summary of it for the doctor, the red-flag answer, and a gentle habit nudge the proactive check may offer.
//
// What it never does: diagnose, prescribe, or change a dose. A medication is kept in the owner's words exactly; its reminders are ordinary
// reminders (<remind every="day">) the assistant sets with those same words.
//
// Red flags (chest pain, not being able to breathe, signs of a stroke, heavy bleeding, thoughts of suicide…) are answered by the door at once,
// before anything else and before Claude: call the emergency number of the owner's country (the table HELP below; PAKO_COUNTRY, else the
// country of their time zone, src/region.ts), and for suicidal thoughts the crisis line too. A country Pako has no numbers for gets words
// that are right anywhere. The fixed words say "if it is happening now", so a message about someone else's past illness is not alarmed. They
// are English, like all of Pako's fixed texts; the red flags themselves are recognised in Spanish too, since a person in danger writes in
// their own language and must never be missed.
//
// Privacy: one key of its own in the store ("health"), kept a year after the last change, listed in docs/privacy.md, wiped by FORGET MY HEALTH
// (asked twice) or by deleting everything. It is never sent to anyone, never given to Claude as context, and never written to a log: the
// errors here name what failed, never what was in it.

import { locale, texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import { plainWords } from "./intents.ts";
import { today } from "./lists.ts";
import { ownerCountry, ownerTimeZone } from "./region.ts";
import { readJsonRecord } from "./json-record.ts";

type Env = Record<string, string | undefined>;

export const HEALTH_KEY = "health";
const TTL_SECONDS = 365 * 24 * 3600;
export const ENTRIES_MAX = 400;
export const ENTRY_MAX = 300;
export const MEDS_MAX = 20;
const DAY_MS = 24 * 3600_000;

export const HEALTH_KINDS = ["symptom", "mood", "sleep", "exercise", "water", "med", "appointment", "other"] as const;
export type HealthKind = (typeof HEALTH_KINDS)[number];

export interface HealthEntry {
  at: number;
  kind: HealthKind;
  /** In the owner's words. */
  text: string;
}

export interface HealthState {
  entries: HealthEntry[];
  /** The medication schedule as the owner stated it ("ibuprofeno 600 mg a las 8 y a las 20"), never reworded. */
  meds: { at: number; text: string }[];
  /** The last habit nudge offered (the owner's day "YYYY-MM-DD"): one a day at most. */
  nudged?: string;
}

const empty = (): HealthState => ({ entries: [], meds: [] });
const line = (s: unknown, max: number): string => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");
const isKind = (v: unknown): v is HealthKind => typeof v === "string" && (HEALTH_KINDS as readonly string[]).includes(v);

export function healthOf(raw: unknown): HealthState {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const entries = (Array.isArray(o.entries) ? o.entries : []).flatMap((e: unknown): HealthEntry[] => {
    const x = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
    const text = line(x.text, ENTRY_MAX);
    return text && Number.isFinite(x.at) && isKind(x.kind) ? [{ at: Number(x.at), kind: x.kind, text }] : [];
  });
  const meds = (Array.isArray(o.meds) ? o.meds : []).flatMap((e: unknown) => {
    const x = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
    const text = line(x.text, ENTRY_MAX);
    return text && Number.isFinite(x.at) ? [{ at: Number(x.at), text }] : [];
  });
  return {
    entries: entries.slice(-ENTRIES_MAX),
    meds: meds.slice(-MEDS_MAX),
    ...(typeof o.nudged === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.nudged) ? { nudged: o.nudged } : {}),
  };
}

// ---------- red flags ----------

export type RedFlag = "emergency" | "suicide";

/** On plainWords (no accents, lower case, no punctuation). Spanish and English; "no me duele el pecho" is not one. */
const SUICIDE = [
  /\b(?:quiero|quisiera|me quiero|voy a|pienso en|pensando en|ganas de) (?:morir(?:me)?|suicidar(?:me)?|matarme|quitarme la vida)\b/,
  /\bsuicid/,
  // "me quiero matar", "me voy a quitar la vida"; not the idiom "me voy a matar a estudiar".
  /\bme (?:quiero|voy a) (?:matar|quitar la vida)\b(?! a \w)/,
  /\b(?:acabar|terminar) con (?:mi vida|todo esto|todo)\b/,
  /\bno quiero (?:vivir|seguir viviendo|seguir aqui|despertar(?:me)?)\b/,
  /\b(?:hacerme dano|autolesion|cortarme las venas)\b/,
  /\bkill(?:ing)? myself\b/,
  /\b(?:want|wanna|going) to die\b/,
  /\bend (?:my life|it all)\b/,
  /\b(?:hurt|harm|cut)(?:ing)? myself\b/,
  /\bself harm/,
  /\bdon t want to (?:live|be alive|wake up)\b/,
  /\bno reason to live\b/,
  /\b(?:quiero|quisiera|ganas de|me gustaria) desaparecer (?:para siempre|del mundo|y no volver)\b/,
  /\b(?:want|wanna|wish i could) (?:to )?disappear (?:forever|for good)\b/,
];
const EMERGENCY = [
  // Chest.
  /(?<!\bno )\bme duele (?:mucho |muchisimo )?el pecho\b/,
  /(?<!\bsin )\b(?:dolor|opresion|presion) (?:(?:muy |mucho |muchisimo |bastante )?(?:fuerte|intens[oa]|agud[oa]|horrible) )?(?:en el|del|de) pecho\b/,
  /(?<!\bsin )\b(?:mucho|muchisimo) dolor (?:en el|del|de) pecho\b/,
  /(?<!\bno )\bme (?:aprieta|oprime) (?:mucho |muchisimo )?el pecho\b/,
  /(?<!\bno )\b(?:chest pain|pain in my chest|my chest (?:hurts|is tight|feels tight))\b/,
  // Heart attack: the one happening now ("me esta dando un infarto"), not one told of ("mi abuelo tuvo un infarto").
  /\b(?:me esta dando|me da|me ha dado|le esta dando|le ha dado|estoy teniendo|esta teniendo|creo que tengo|creo que es) un (?:infarto|ataque al corazon|ataque cardiaco)\b/,
  /\b(?:m|am|is|re|be|im) having a heart attack\b/,
  // A numb or sleeping left arm together with the chest.
  new RegExp(
    "(?=.*\\b(?:pecho|chest)\\b).*\\b(?:se me (?:duerme|ha dormido|esta durmiendo|adormece|entumece) el brazo izquierdo|brazo izquierdo dormido" +
      "|left arm (?:is )?(?:numb|tingling)|numb(?:ness in)? (?:my )?left arm)\\b",
  ),
  // Breathing.
  /\b(?:no puedo|no puede|apenas puedo|apenas puede|me cuesta (?:mucho )?|le cuesta (?:mucho )?) ?respirar\b/,
  /\b(?:me ahogo|me estoy ahogando|dificultad (?:para|al) respirar|falta de aire)\b/,
  /(?<!\bno )\bme falta (?:el )?aire\b/,
  /\b(?:can t|cant|cannot|can not|struggling to|hard to) breathe\b/,
  /\b(?:difficulty breathing|short(?:ness)? of breath)\b/,
  // Stroke.
  /\b(?:ictus|derrame cerebral|cara (?:torcida|caida)|boca torcida|hablo raro|habla arrastrada|no puedo hablar bien)\b/,
  /\bno (?:puedo|puede) mover (?:el|la|un|una|mi|su|medio) (?:brazo|pierna|lado|cuerpo|cara)\b/,
  /\bse me (?:ha )?(?:dormido|paralizado) (?:media cara|la mitad|medio cuerpo|un lado)\b/,
  /\b(?:(?:having|had|is having|signs of) a stroke|face (?:is )?drooping|slurred speech|can t (?:move|feel) (?:my|one|his|her) (?:arm|leg|side|face))\b/,
  /\bnumb(?:ness)? on one side\b/,
  // Bleeding.
  /\b(?:sangr(?:o|a|ando) (?:mucho|sin parar|a chorros)|no (?:para|deja) de sangrar|hemorragia)\b/,
  /\b(?:bleeding (?:heavily|a lot|badly|won t stop)|won t stop bleeding|can t stop (?:the )?bleeding)\b/,
  // Other emergencies.
  /\b(?:me he desmayado|ha perdido el conocimiento|he perdido el conocimiento|convulsion|convulsiones|anafilaxia|sobredosis|envenenad[oa])\b/,
  /\bse me (?:esta )?(?:hinchando|cerrando) la garganta\b/,
  /\b(?:is unconscious|lost consciousness|seizure|anaphyla|overdose|poisoned|throat (?:is )?(?:swelling|closing))\b/,
];

/** The red flag in the owner's own words, or null. Suicide first: it has a line of its own. */
export function redFlag(text: string): RedFlag | null {
  if (!text) return null;
  const s = plainWords(text.slice(0, 2000));
  if (SUICIDE.some((re) => re.test(s))) return "suicide";
  if (EMERGENCY.some((re) => re.test(s))) return "emergency";
  return null;
}

/**
 * The language to answer a red flag in: English, whatever the message's language (the answer is one of Pako's fixed texts). Kept as a
 * function for the callers that still ask.
 */
export function redFlagLanguage(_text: string, _ui?: Lang): Lang {
  return "en";
}

/**
 * The help numbers by the owner's country (ISO 3166 two letters): the emergency number, and a crisis line for suicidal thoughts where a
 * national one is well known (`crisisNote`: a few words said after it, where the number alone says little). A country not here gets the
 * European emergency number when that is its number (ONE_ONE_TWO), and otherwise words that are right anywhere ("your local emergency
 * number", and findahelpline.com for a crisis line).
 */
const HELP: Record<string, { emergency: string; crisis?: string; crisisNote?: string }> = {
  ES: { emergency: "112", crisis: "024", crisisNote: "free, 24 hours, a person answers" },
  US: { emergency: "911", crisis: "988" },
  CA: { emergency: "911", crisis: "988" },
  GB: { emergency: "999", crisis: "116 123" },
  IE: { emergency: "112", crisis: "116 123" },
  MX: { emergency: "911", crisis: "800 911 2000" },
  AR: { emergency: "911", crisis: "135" },
  CO: { emergency: "123", crisis: "106" },
  CL: { emergency: "131", crisis: "*4141" },
  FR: { emergency: "112", crisis: "3114" },
  DE: { emergency: "112", crisis: "0800 111 0 111" },
  IT: { emergency: "112", crisis: "02 2327 2327" },
  PT: { emergency: "112", crisis: "808 24 24 24" },
  AU: { emergency: "000", crisis: "13 11 14" },
  NZ: { emergency: "111" }, VE: { emergency: "911" }, UY: { emergency: "911" }, EC: { emergency: "911" }, PE: { emergency: "105" },
  JP: { emergency: "119" }, CN: { emergency: "120" }, BR: { emergency: "192" }, ZA: { emergency: "10177" }, HK: { emergency: "999" },
  SG: { emergency: "995" },
};
/** Where the European emergency number (ONE_ONE_TWO_NUMBER) is the number: the rest of the European Union, and neighbours that use it too. */
const ONE_ONE_TWO = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "GR", "HU", "LV", "LT", "LU", "MT", "NL", "PL", "RO", "SK", "SI", "SE",
  "CH", "NO", "IS", "LI", "TR", "UA", "RS", "BA", "ME", "MK", "AL", "MD",
]);
/** A directory of crisis lines in most countries, for an owner whose own line is not in the table above. */
export const HELPLINE_DIRECTORY = "findahelpline.com";

/** The emergency number of a country, or null when Pako does not know it (the words then say "your local emergency number"). */
const ONE_ONE_TWO_NUMBER = "112";
export const emergencyNumber = (country: string): string | null => HELP[country]?.emergency ?? (ONE_ONE_TWO.has(country) ? ONE_ONE_TWO_NUMBER : null);
export const crisisLine = (country: string): string | null => HELP[country]?.crisis ?? null;

/**
 * The owner's country (src/region.ts): PAKO_COUNTRY, else the country of their time zone (PERSONAL_TIMEZONE, else this computer's), else the
 * system locale's region; "" when none of them tells (the help words then say "your local emergency number").
 */
export function loadCountry(env: Env): { country: string; problem?: string } {
  return ownerCountry(env, ownerTimeZone(env.PERSONAL_TIMEZONE).timeZone);
}

const HELP_WORDS = texts(
  {
    line: "{n} (for suicidal thoughts: {line})",
    unknown: "their local emergency number (crisis lines: {dir})",
    unknownLine: "{n} (crisis lines: {dir})",
  },
);

/**
 * The help numbers in a few words, for the context line that tells Claude what to give in a red flag: "911 (for suicidal thoughts: 988)",
 * or, for a country Pako does not know, words that are right anywhere.
 */
export function helpLine(country: string, lang: Lang): string {
  const t = HELP_WORDS(lang);
  const n = emergencyNumber(country);
  const line = crisisLine(country);
  if (!n) return t("unknown", { dir: HELPLINE_DIRECTORY });
  return line ? t("line", { n, line }) : t("unknownLine", { n, dir: HELPLINE_DIRECTORY });
}

const RED = texts(
  {
    emergency: "🚨 If this is happening now, call {n} right away. Don't wait to see if it passes.",
    emergencyLocal: "🚨 If this is happening now, call your local emergency number right away. Don't wait to see if it passes.",
    suicide: "💙 If you are thinking about ending your life or hurting yourself, call {line} now. If you are in immediate danger, call {n}.",
    suicideNoLine: "💙 If you are thinking about ending your life or hurting yourself, call {n} now.",
    suicideDirectory: "There are free crisis lines at {dir}.",
    suicideLocal: "💙 If you are thinking about ending your life or hurting yourself, call your local emergency number now. There are free crisis lines at {dir}.",
    after: "I'm still here, but right now the important thing is to talk to a person.",
  },
);

/** The fixed answer to a red flag: the number first, nothing else before it. */
export function redFlagReply(flag: RedFlag, lang: Lang, country = ""): string {
  const t = RED(lang);
  const n = emergencyNumber(country);
  if (flag === "emergency") return n ? t("emergency", { n }) : t("emergencyLocal");
  const crisis = crisisLine(country);
  // A country with a number but no crisis line known here also gets the directory, after the number, so the number stays the first thing.
  const said = !n
    ? t("suicideLocal", { dir: HELPLINE_DIRECTORY })
    : crisis
      ? t("suicide", { line: HELP[country]?.crisisNote ? `${crisis} (${HELP[country]!.crisisNote})` : crisis, n })
      : `${t("suicideNoLine", { n })}\n${t("suicideDirectory", { dir: HELPLINE_DIRECTORY })}`;
  return `${said}\n${t("after")}`;
}

// ---------- the owner's commands ----------

export type HealthCommand =
  | { op: "show" }
  | { op: "doctor" }
  | { op: "forget"; sure: boolean }
  | { op: "sleep" }
  | { op: "log"; kind: HealthKind; text: string };

/** The kind of a health note by its words, or null when it is not about health ("log milk" is a list). */
export function kindOf(text: string): HealthKind | null {
  const s = plainWords(text);
  if (/\b(medicacion|medicamento|pastilla|comprimido|dosis|me tomo|tomo \w+ (?:mg|ml)|medication|medicine|pill|tablet|dose|mg)\b/.test(s)) {
    return "med";
  }
  if (/\b(cita (?:con el|del|de la) (?:medico|medica|doctor|doctora|dentista|enfermer)|appointment|medico|doctor|dentist)\b/.test(s)) return "appointment";
  if (/\b(dormid[oa]|dormi|duermo|sueno|insomnio|siesta|slept|sleep|insomnia|nap)\b/.test(s)) return "sleep";
  if (/\b(agua|vasos|litros?|water|glasses|hydrat)/.test(s)) return "water";
  if (/\b(corrido|correr|gimnasio|gym|caminado|andado|pasos|nadado|bici|yoga|entren|ejercicio|ran|run|walked|walk|swim|workout|exercise|steps)/.test(s)) {
    return "exercise";
  }
  if (/\b(me siento|estoy (?:triste|bien|mal|feliz|cansad|agobiad|ansios|content)|animo|estres|ansiedad|mood|i feel|feeling|stressed|anxious)\b/.test(s)) {
    return "mood";
  }
  if (/\b(me duele|dolor|fiebre|tos|mareo|nauseas|sintoma|alergia|migrana|resfriado|hurts|pain|fever|cough|dizzy|nausea|symptom|headache|cold)\b/.test(s)) {
    return "symptom";
  }
  return null;
}

/** Words about the owner's own body, on plainWords: the first person, a past tense with a measure, or a measure alone. */
const OWN_HEALTH = new RegExp(
  [
    "\\b(?:he|hemos) (?:dormido|bebido|corrido|caminado|andado|nadado|entrenado|hecho (?:yoga|ejercicio|deporte|pesas|pilates|\\d)|ido (?:al gimnasio|a (?:correr|nadar|caminar)))",
    "\\b(?:dormi|duermo|bebi|corri|camine|ande|nade|entrene)\\b",
    "\\bme (?:duele|duelen|siento|encuentro|mareo|he mareado|cuesta dormir)\\b",
    "\\bestoy (?:triste|bien|mal|feliz|cansad|agobiad|ansios|content|resfriad|enferm|malo|mala|baj)",
    "\\btengo (?:fiebre|tos|dolor|mareo|nauseas|migrana|alergia|ansiedad|estres|insomnio|el animo)",
    "\\bi (?:slept|drank|ran|walked|swam|did|feel|felt|have|had|m|am|cycled|worked out)\\b",
    "^(?:slept|drank|ran|walked|swam|cycled|feeling|felt|woke)\\b",
    "\\bmy \\w+ (?:hurts|aches)\\b",
    "^\\d+(?: \\d+)? (?:vasos?|litros?|horas?|h|km|kilometros|minutos|min|pasos|glasses|liters|litres|hours|miles|steps)\\b",
  ].join("|"),
);

/**
 * The health commands, on plainWords, in English like every command: MY HEALTH, DOCTOR SUMMARY, FORGET MY HEALTH (twice), and "log: slept
 * 5 hours" (only words about health: "log milk" is not one). `text` is the original.
 */
export function healthCommand(text: string, command: string): HealthCommand | null {
  if (/^(?:my health|my health log|health log|health diary)$/.test(command)) return { op: "show" };
  if (/^(?:doctor summary|summary for (?:my|the) doctor)$/.test(command)) return { op: "doctor" };
  // "How am I sleeping?": the owner's own sleep notes, read back; never an interpretation.
  const sleep = /^(?:pako )?(?:how am i sleeping|how have i been sleeping|how did i sleep|my sleep)(?: lately| this week)?$/;
  if (sleep.test(command)) return { op: "sleep" };
  const forget = /^(?:forget my health(?: log| data)?|delete my health data)(?: (confirm|yes))?$/.exec(command);
  if (forget) return { op: "forget", sure: !!forget[1] };
  if (!/^(?:log|note)\b/.test(command)) return null;
  // A list's item ("log water on the shopping list") is not a health note; an appointment or a medication goes to the assistant, which can
  // also set its reminder.
  if (/\b(?:list|shopping|tasks?)\b/.test(command)) return null;
  const words = text.trim().replace(/^\S+\s*(?:in my health (?:log|diary)|that)?\s*[:,-]?\s*/i, "");
  // Only the owner's own health: said so ("log in my health diary…"), or told in the first person or as a measure ("slept 5 hours", "my
  // head hurts", "8 glasses of water"). "note buy water", "note that the gym closes at 10pm" are notes for the assistant. The words after
  // LOG are read in Spanish too: they are the owner's own, in whatever language they write.
  const diary = /^(?:log|note) in my health (?:log|diary)\b/.test(command);
  if (!diary && !OWN_HEALTH.test(plainWords(words))) return null;
  const kind = kindOf(words);
  const said = line(words, ENTRY_MAX);
  return kind && kind !== "med" && kind !== "appointment" && said.length >= 3 ? { op: "log", kind, text: said } : null;
}

// ---------- the store ----------

export interface HealthStore {
  read(): Promise<HealthState>;
  add(entry: HealthEntry): Promise<HealthState>;
  /** The day a habit nudge was offered; false when one was already offered that day. */
  claimNudge(day: string): Promise<boolean>;
  /** Everything gone: the diary and the medication schedule. */
  forget(): Promise<void>;
}

export function createHealth(kv: Kv | null): HealthStore {
  let local = empty();
  const readStrict = async (): Promise<HealthState> => {
    if (!kv) return structuredClone(local);
    const raw = await readJsonRecord(kv, HEALTH_KEY);
    if (!raw) return empty();
    return healthOf(raw);
  };
  const write = async (s: HealthState): Promise<void> => {
    if (kv) await kv.set(HEALTH_KEY, JSON.stringify(s), TTL_SECONDS);
    local = structuredClone(s);
  };
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
  return {
    read: () => locked(readStrict),
    add: (e) =>
      locked(async () => {
        const s = await readStrict();
        const text = line(e.text, ENTRY_MAX);
        if (!text || !isKind(e.kind)) return s;
        s.entries.push({ at: e.at, kind: e.kind, text });
        s.entries = s.entries.slice(-ENTRIES_MAX);
        if (e.kind === "med" && !s.meds.some((m) => m.text.toLowerCase() === text.toLowerCase())) {
          s.meds.push({ at: e.at, text });
          s.meds = s.meds.slice(-MEDS_MAX);
        }
        await write(s);
        return s;
      }),
    claimNudge: (day) =>
      locked(async () => {
        const s = await readStrict();
        if (s.nudged === day) return false;
        s.nudged = day;
        await write(s);
        return true;
      }),
    forget: () => locked(() => write(empty())),
  };
}

// ---------- what the owner reads ----------

const T = texts(
  {
    none: "Your health diary is empty. Write for example “log: slept 6 hours” or “log: headache since yesterday”.",
    head: "🩺 Your health diary (last {days} days, on this computer only):",
    meds: "💊 Your medication, as you told me:",
    foot: "For the doctor: DOCTOR SUMMARY. To delete it all: FORGET MY HEALTH.",
    logged: "🩺 Logged in your health diary ({kind}). It stays on this computer; MY HEALTH to see it.",
    notDevice: "This diary is a personal notebook: it stores and summarizes what you write so you can remember it and show it to your doctor. "
      + "Pako is not a medical device and does not diagnose, assess, monitor or treat any condition. It does not replace a doctor. "
      + "If you think you may have an emergency, {call}.",
    forgetAsk: "Delete your whole health diary, the medication you told me and what you said about your health and mood? It cannot be undone. Write FORGET MY HEALTH CONFIRM to delete it.",
    forgotten: "🗑️ I deleted your health diary, your medication list and what you said about your health and mood. Your reminders stay: REMINDERS to see them.",
    unread: "I couldn't read your health diary right now. Try again in a moment.",
    unsaved: "I couldn't save that to your health diary right now. Try again in a moment.",
    doctorHead: "🩺 Summary for your doctor (last 30 days, from what you told me; not a diagnosis):",
    doctorNone: "I have nothing logged in the last 30 days. Tell me what you notice and since when, and I'll log it.",
    doctorFoot: "Also bring: your health card, the list of what you take and your questions. Shall I prepare the questions?",
    symptom: "symptom", mood: "mood", sleep: "sleep", exercise: "exercise", water: "water", med: "medication", appointment: "appointment", other: "note",
    nudgeWater: "💧 No water logged today. A glass now?",
    nudgeSleep: "🌙 You've slept little for a few nights. How about an earlier night today?",
    nudgeMove: "🚶 No exercise logged for a few days. A 15-minute walk today?",
    sleepNone: "I have nothing about your sleep in the last two weeks. If you like, tell me “log: slept 6 hours” each morning.",
    sleepHead: "🌙 Your sleep these two weeks, in your words:",
    sleepAvg: "Of {n} night(s) with hours: {avg} h on average.",
    sleepShort: "That's not much. If you often struggle to sleep or feel tired, mention it to your doctor.",
    sleepFoot: "Not a diagnosis, only what you told me. For the doctor: DOCTOR SUMMARY.",
    logEmergency: "Gave the emergency number to a message about an emergency",
    logCrisis: "Gave the crisis line to a message about self-harm",
  },
);
export const healthTexts = T;

const dayOf = (at: number, tz: string, l: Lang): string =>
  new Intl.DateTimeFormat(locale(l), { timeZone: tz, day: "numeric", month: "short" }).format(at);

export function healthText(s: HealthState, now: number, tz: string, l: Lang, days = 14): string {
  const t = T(l);
  const recent = s.entries.filter((e) => now - e.at < days * DAY_MS);
  if (!recent.length && !s.meds.length) return t("none");
  const parts = [t("head", { days }), ...recent.slice(-30).map((e) => `• ${dayOf(e.at, tz, l)} · ${t(e.kind)}: ${e.text}`)];
  if (s.meds.length) parts.push("", t("meds"), ...s.meds.map((m) => `• ${m.text}`));
  return [...parts, "", t("foot")].join("\n");
}

/** What the owner shows the doctor: their own words, grouped by kind, oldest first; never an interpretation. */
export function doctorSummary(s: HealthState, now: number, tz: string, l: Lang): string {
  const t = T(l);
  const recent = s.entries.filter((e) => now - e.at < 30 * DAY_MS && e.kind !== "appointment");
  if (!recent.length && !s.meds.length) return t("doctorNone");
  const parts = [t("doctorHead")];
  for (const kind of ["symptom", "mood", "sleep", "exercise", "water", "other"] as const) {
    const of = recent.filter((e) => e.kind === kind);
    if (of.length) parts.push("", `${t(kind)}:`, ...of.map((e) => `• ${dayOf(e.at, tz, l)}: ${e.text}`));
  }
  if (s.meds.length) parts.push("", t("meds"), ...s.meds.map((m) => `• ${m.text}`));
  return [...parts, "", t("doctorFoot")].join("\n");
}

export const loggedText = (kind: HealthKind, l: Lang): string => T(l)("logged", { kind: T(l)(kind) });
/** The diary's intended purpose (EU MDR, MDCG 2019-11): said with the first note, and in docs/features.md and the privacy notice. */
/** What the diary is not, ending with the owner's emergency number (their local one when Pako does not know it). */
export const notDeviceText = (l: Lang, country = ""): string => {
  const n = emergencyNumber(country);
  const call = n ? `call ${n}` : "call your local emergency number";
  return T(l)("notDevice", { call });
};

/**
 * "How am I sleeping?": the last two weeks of sleep notes in the owner's words (the diary's, and the passing remarks src/proactive.ts
 * kept), how many nights had hours and their average, and nothing more: no diagnosis. Short nights get the gentle line, never an alarm.
 */
export function sleepText(s: HealthState, more: { at: number; text: string }[], now: number, tz: string, l: Lang): string {
  const t = T(l);
  const notes = [
    ...s.entries.filter((e) => e.kind === "sleep"),
    ...more.filter((m) => kindOf(m.text) === "sleep"),
  ].filter((e) => now - e.at < 14 * DAY_MS && e.at <= now).sort((a, b) => a.at - b.at);
  if (!notes.length) return t("sleepNone");
  const hours = notes.map((e) => hoursOf(e.text)).filter((h): h is number => h !== null);
  const avg = hours.length ? Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10 : null;
  const parts = [t("sleepHead"), ...notes.slice(-10).map((e) => `• ${dayOf(e.at, tz, l)}: ${e.text}`)];
  if (avg !== null) parts.push("", t("sleepAvg", { n: hours.length, avg: new Intl.NumberFormat(locale(l), { maximumFractionDigits: 1 }).format(avg) }));
  if (avg !== null && avg < 6 && hours.length >= 3) parts.push(t("sleepShort"));
  return [...parts, "", t("sleepFoot")].join("\n");
}

// ---------- a habit nudge, for the proactive check ----------

/**
 * One gentle nudge at most a day, only from habits the owner logs themselves (water they log most days, sleep they log, exercise they
 * used to log), after 16:00 in their zone. Null when there is nothing worth saying: the proactive check's NO_REPLY.
 */
export function healthNudge(s: HealthState, now: number, tz: string, l: Lang): { key: string; text: string } | null {
  const day = today(now, tz);
  if (s.nudged === day) return null;
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(now));
  if (hour < 16 || hour >= 21) return null;
  const t = T(l);
  const days = (kind: HealthKind, n: number): Set<string> =>
    new Set(s.entries.filter((e) => e.kind === kind && now - e.at < n * DAY_MS).map((e) => today(e.at, tz)));
  const water = days("water", 7);
  if (water.size >= 4 && !water.has(day)) return { key: `health:water:${day}`, text: t("nudgeWater") };
  const shortNights = s.entries.filter((e) => e.kind === "sleep" && now - e.at < 4 * DAY_MS && hoursOf(e.text) !== null && hoursOf(e.text)! < 6);
  if (shortNights.length >= 3) return { key: `health:sleep:${day}`, text: t("nudgeSleep") };
  const moved = days("exercise", 21);
  if (moved.size >= 4 && !days("exercise", 4).size) return { key: `health:move:${day}`, text: t("nudgeMove") };
  return null;
}

/** "5 horas", "6h", "slept 7 hours", "5,5 h": the hours in a sleep note, or null. */
export function hoursOf(text: string): number | null {
  const m = /(\d{1,2}(?:[.,]\d)?)\s*(?:h\b|horas?\b|hours?\b|hrs?\b)/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]!.replace(",", "."));
  return n > 0 && n <= 24 ? n : null;
}
