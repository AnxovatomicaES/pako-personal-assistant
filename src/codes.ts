// One-time codes in the owner's mail (a sign-in or verification code). All their mail may be forwarded to Pako's inbox, and an email's subject,
// preview and summary reach the phone's lock screen (WhatsApp, Telegram), the panel, MAIL, the action log and the assistant's context. A code
// must never travel that way: src/mail.ts puts a mark in its place (codeMark) before anything keeps, logs or passes the email on, and the code
// is kept here for 30 minutes, the only place it lives on the server, until the owner asks for it on purpose (CODE).
//
// The codes are found in the mail's own language, whatever it is: the words that name a code are listed below in several languages, since
// the mail comes from anywhere. Only the mark Pako writes is English.
//
// What a code is, is decided by plain rules, never by a model: a short run of digits (or of letters and digits) next to words that name a
// one-time code, in the same sentence. Dates, times, amounts, phone and account numbers, years, postal codes and the numbers of orders, parcels,
// bookings, invoices and offers are left as they are. When in doubt a number stays: a missed code shows as it always did, while ordinary
// numbers hidden would make every notice useless.

import { texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";

const MARK = texts({ mark: "[code hidden · type CODE]" });
/** What stands where a code was: the same everywhere, and it says how to see the code. */
export const codeMark = (_l?: Lang): string => MARK()("mark");
/** The mark, for the callers that ask for it without a language. */
export const CODE_MARK = codeMark();
/**
 * The mark Pako wrote before it was English only. Emails and summaries kept since then still carry it: it is read as a mark (never as words
 * around a code), so a kept text looked at again stays as it is.
 */
export const OLD_CODE_MARK = "[c\u00f3digo oculto \u00b7 escribe C\u00d3DIGO]";
/** Every mark a kept text may carry. */
const MARKS = [CODE_MARK, OLD_CODE_MARK];
/** A kept text with each mark, old or new, as `to`. */
export const replaceMarks = (text: string, to: string): string => MARKS.reduce((s, mark) => s.split(mark).join(to), text);

/** How far (in characters, in the same sentence) a code may be from the words that name it. */
const NEAR = 60;
/** How far a label that makes a number something else ("Pedido nº 1234", "Referencia: AB12") may be from it. */
const LABEL_NEAR = 25;

// The words below are matched on the text in lowercase without accents ("Código" is "codigo"): Spanish, English, Catalan, French, German,
// Italian and Portuguese.

/** Words that name a one-time code by themselves. */
const STRONG = [
  "verification", "verify", "verificacion", "verificar", "verifica", "verifique", "verificacao", "verificacio", "verifier", "verifizierung\\w*",
  "bestatigungscode", "one[- ]?time", "otp", "un solo uso", "uso unico", "unico uso", "usage unique", "einmal(?:code|passwort|kennwort)", "monouso",
  "d['’]un sol us", "2fa", "mfa", "two[- ]factor", "(?:2|two)[- ]step", "dos pasos", "doble factor", "segundo factor", "autenticacion",
  "authentication", "authenticator", "autenticacao", "authentification", "authentifizierung", "autenticazione", "autenticacio",
  "sign[- ]?in", "log[- ]?in", "(?:inicio de|iniciar|inicia) sesion", "inici de sessio", "anmelde\\w*", "anmeldung", "connexion",
  "security code", "codigo de seguridad", "code de securite", "sicherheitscode", "codice di sicurezza", "codigo de seguranca", "codi de seguretat",
  "access code", "codigo de acceso", "code d['’]acces", "zugangscode", "codice di accesso", "codigo de acesso", "codi d['’]acces",
  "clave de (?:acceso|firma|operaciones)", "clave temporal", "contrasena (?:temporal|provisional)", "temporary password", "mot de passe temporaire",
  "password temporanea", "senha temporaria", "passcode", "pin", "(?:mobile|sms|push|photo|chip|m)tan", "magic[- ]?links?",
];
/** Words that name a one-time code or another kind of code: they count only when nothing nearer says it is another kind. */
const WEAK = ["codes?", "codigos?", "codis?", "codice", "claves?", "tokens?", "passwords?", "contrasenas?", "confirmacion", "confirmation", "confirmacao"];
/** Words that say the numbers near them are something else: an order, a parcel, a booking, an invoice, an offer, a product, a postal code. */
const NOT = [
  // Not "envío": without its accent it is also the verb ("te envío el código"). "Pedido" after "has" is the verb too ("si no lo has pedido"),
  // "order" in "in order to" is no order, and Booking.com sends codes of its own.
  "postale?", "zip", "postcode", "plz", "(?<!\\b(?:has|ha|he|hemos|han|haya|hayas|habias|hubieras) )pedidos?", "(?<!in )orders?", "orden",
  "tracking", "seguimiento", "shipments?", "shipping", "paquetes?", "packages?", "parcels?", "reservas?", "bookings?(?!\\.com)", "reservations?",
  "localizador", "referencias?", "references?", "facturas?", "invoices?", "recibos?", "receipts?", "albaran", "promos?", "promocion", "promocional",
  "promotional", "descuentos?", "discounts?", "dto", "\\d{1,3} ?% (?:off|dto)",
  "cupon(?:es)?", "coupons?", "vouchers?", "regalo", "gift", "billetes?", "vuelos?", "flights?", "tickets?", "productos?", "products?",
  "articulos?", "sku", "invitacion", "invitation", "invite", "referral", "referido", "barras", "barcode", "qr",
  "codigo (?:de |del )?(?:tu |su )?(?:area|pais|cliente|socio|amigo|empleado)", "codigo fuente", "(?:area|country|customer|member|friend|employee|source|dress) codes?",
  "(?:numero|n[º°o]?\\.?) de (?:confirmacion|cuenta)", "(?:confirmation|account) (?:number|no\\.?)",
];
/** Words that make the number right after them something else (a phone, an address, an ID, an account, a card's last digits): only right before it. */
const LABEL = [
  "telefonos?", "tel", "telf", "tlf", "tfno", "moviles?", "phones?", "mobiles?", "fax", "llama(?:nos)? al", "call(?: us)?(?: at| on)?",
  // An account only with its number straight after it ("cuenta 48291037"): "el código de tu cuenta: 482910" is a code.
  "cuentas?(?= (?:n[º°o]?\\.? ?)?\\d)", "accounts?(?= (?:no\\.? ?|#)?\\d)",
  "calle", "avenida", "avda", "plaza", "paseo", "carrer", "street", "road", "avenue", "rue", "strasse", "cp", "c\\.p\\.", "iban", "bic", "swift",
  "dni", "nif", "nie", "cif", "pasaporte", "passport", "id", "ref", "modelo", "model", "serie", "serial", "version", "expediente", "incidencia",
  "(?:terminad|acabad|finalizad)[ao] en", "ending (?:in|with)", "ends (?:in|with)",
];

type Kind = "strong" | "weak" | "not" | "label";
interface Hit {
  start: number;
  end: number;
  kind: Kind;
}
const words = (list: string[]): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.join("|")})(?![\\p{L}\\p{N}])`, "gu");
const KINDS: [Kind, RegExp][] = [["strong", words(STRONG)], ["weak", words(WEAK)], ["not", words(NOT)], ["label", words(LABEL)]];

/**
 * A possible code: G-482910 (Google's prefix), ABCD-EFGH (capital letters in groups of four), 48 29 10 (pairs of digits, three or four of
 * them, not a longer run like a French phone's), 123 456 or 123-456 (split once), or 4 to 10 letters and digits.
 */
const TOKEN = /(?<![\p{L}\p{N}_])(?:[A-Z]{1,2}-\d{4,8}|[A-Z]{4}(?:-[A-Z]{4}){1,2}|\d{2}(?:[ \u00a0]\d{2}){2,3}(?![ \u00a0]\d)|\d{3,5}[ \u00a0-]\d{3,5}|[A-Za-z0-9]{4,10})(?![\p{L}\p{N}_])/gu;
/** The shapes that are a code only with a word that names a one-time code by itself near them ("verification", "sign-in"): never a word alone. */
const STRONG_SHAPE = /^(?:[A-Z]{4}(?:-[A-Z]{4}){1,2}|\d{2}(?:[ \u00a0]\d{2}){2,3})$/;
/**
 * What may not come right before a code: a digit (one more group of a phone, a card or a date, a decimal), a word it hangs from (INV-2026),
 * a sign that makes it something else (#1234, +34, =, $, €), a masked card (•••• 1234) or a currency.
 */
const BEFORE_NOT = /(?:\d[ \u00a0.,:/]?|[\p{L}\p{N}][-/.]|[#+=/\\@&$€£¥₹]\s?|[•·x]{3,}[ \u00a0-]?|\b(?:eur|usd|gbp|chf|mxn|euros?)\s?)$/iu;
/** A US ZIP code after its state ("Seattle, WA 98101"), in an address under a sign-in alert. */
const AFTER_STATE = /,\s?[A-Z]{2}\s$/;
/** What may not come right after one: another group of digits, a decimal, a time or a date going on, an address (@), a currency, a unit. */
const AFTER_NOT = new RegExp(
  "^(?:[ \\u00a0-]\\d{3}|[.,:/]\\d|-[\\p{L}\\p{N}]|@|\\s?(?:[%‰°º€$£¥₹]|(?:eur|euros?|usd|gbp|chf|mxn|d[oó]lares?|libras?|pesos?|km|kg|mb|gb|kb|tb|mah|kwh|ml"
    + "|min|minutos?|minutes?|segundos?|seconds?|horas?|hours?|d[ií]as?|days?)(?![\\p{L}\\p{N}])))",
  "iu",
);
/**
 * Where a sentence ends (in the folded text): not at the point of an abbreviation that names the number after it ("Nº. 1234", "núm. 1234",
 * "Ref. 1234", "Tel. 600…"), which would cut the number off from the words that say what it is.
 */
const SENTENCE_END = /(?<!(?:^|[^\p{L}\p{N}])(?:n[º°o]?|nu?m|nr|ref|tel|tlf|telf|tfno))[.!?…](?=\s|$)/gu;
const WORDY = /[\p{L}\p{N}]/u;
/** A remark after a code on its line ("482910 (caduca en 10 minutos)") does not take it out of its line. */
const REMARK = /^[^\p{L}\p{N}]*?[(\[–—-].*$/u;
/** Between a label and its number: spaces, punctuation and a "number" word ("Pedido nº 1234", "Order #1234", "Referencia: AB12"). */
const LABEL_GAP = /^[\s:#=.()–—-]*(?:(?:n|no|num|nr|numero|number)[.º°ª]{0,2}[\s:#=.()–—-]*)?$/;
/** Between the words for a code and the code itself: "código: 2024", "code is 2024", "tu clave es 2024". */
const DIRECT_GAP = /^\s*(?:(?:is|es|est|ist|e|era|sera|lautet)\s*)?[:=–—-]?\s*$/;

/** Lowercase without accents, one character for one, so that a position in it is the same position in the text. */
const fold = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(/[^\x00-\x7f]/g, (c) => {
    const base = c.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
    return base.length === 1 ? base : c;
  });

/** Every word that matters here, in order. A generic word inside a longer phrase ("código" in "código de cliente") is that phrase. */
function hitsIn(folded: string): Hit[] {
  const all: Hit[] = [];
  for (const [kind, re] of KINDS) for (const m of folded.matchAll(re)) all.push({ start: m.index, end: m.index + m[0].length, kind });
  const covered = new Uint8Array(folded.length + 1);
  for (const h of all) if (h.kind !== "weak") covered.fill(1, h.start, h.end);
  return all.filter((h) => h.kind !== "weak" || !(covered[h.start] && covered[h.end - 1])).sort((a, b) => a.start - b.start);
}

/**
 * "plain": a code when the words around it say so. "weak": a year or a number as long as a phone's, a code only right after "código:" and the
 * like. "strong": pairs of digits or groups of capitals, a code only with a strong word near. null: never (a word with a number, 10h30, 10AM,
 * an ID's letter after its digits).
 */
function shapeOf(t: string): "plain" | "weak" | "strong" | null {
  if (STRONG_SHAPE.test(t)) return "strong";
  if (/^[A-Z]{1,2}-\d+$/.test(t) || /^\d+[ \u00a0-]\d+$/.test(t)) return "plain";
  if (/^\d+$/.test(t)) return t.length >= 9 || (t.length === 4 && Number(t) >= 1900 && Number(t) <= 2099) ? "weak" : "plain";
  if (t.replace(/\D/g, "").length < 2 || /^\d{1,2}h\d{2}$/i.test(t)) return null;
  const turns = (t.match(/[A-Za-z](?=\d)|\d(?=[A-Za-z])/g) ?? []).length;
  // With small letters only a well mixed run is a code (8f3K2Q9), never a word with a number (office365). In capitals, a short prefix and
  // digits (AB1234) too, but not a word and a number (VERANO25) nor digits and letters (10AM, 12345678Z).
  if (/[a-z]/.test(t)) return turns >= 2 ? "plain" : null;
  return turns >= 2 || /^[A-Z]{1,3}\d+$/.test(t) ? "plain" : null;
}

/** What one side of a number says, from the nearest word out: a code, something else, maybe a code (a generic word only), or nothing. */
function sideSays(hits: Hit[]): "code" | "not" | "weak" | "none" {
  let weak = false;
  for (const h of hits) {
    if (h.kind === "strong") return "code";
    if (h.kind === "not") return "not";
    if (h.kind === "weak") weak = true;
    // A label only counts right before its number (checked by the caller).
  }
  return weak ? "weak" : "none";
}

/**
 * Whether the words around a number name it as a one-time code. The side before it speaks first ("Tu código de verificación es 482910, pedido
 * 9999"), then the side after ("482910 es tu código"); a generic word alone ("Your code is 1234") is enough when neither side says otherwise.
 */
function saysCode(before: Hit[], after: Hit[]): boolean {
  const b = sideSays(before);
  if (b === "code" || b === "not") return b === "code";
  const a = sideSays(after);
  if (a === "code" || a === "not") return a === "code";
  return a === "weak" || b === "weak";
}

/**
 * The text with each one-time code replaced by the mark, and the codes found (each once, in order). Linear in the length of the text, whatever
 * it holds. Running it again on its own result (or on a text with the older Spanish mark) changes nothing.
 */
export function hideCodes(text: string, l: Lang = "en"): { text: string; codes: string[] } {
  if (!/\d|[A-Z]{4}-[A-Z]{4}/.test(text)) return { text, codes: [] };
  // The marks' own words ("code", and the older mark's) must not make a number next to one look like a code the next time a text is looked at.
  const folded = fold(MARKS.reduce((s, mark) => s.split(mark).join(" ".repeat(mark.length)), text));
  const hits = hitsIn(folded);
  const codes = new Set<string>();
  let out = "";
  let last = 0;
  let lo = 0;
  for (const m of text.matchAll(TOKEN)) {
    const token = m[0];
    const s = m.index;
    const e = s + token.length;
    const shape = shapeOf(token);
    const close = text.slice(Math.max(0, s - 8), s);
    if (!shape || BEFORE_NOT.test(close) || AFTER_STATE.test(close) || AFTER_NOT.test(text.slice(e, e + 12))) continue;
    // A star before it is a masked card (*1234), unless it is the emphasis of a plain-text email (**482910**).
    if (/\*\s?$/.test(close) && text[e] !== "*") continue;
    // The words that can name it: the same sentence, at most NEAR characters on each side, on its own line. A code alone on its line (often
    // under "Tu código es:") is named by the lines around it, and so is one that starts a line after a colon, or one on a line that goes on
    // with a sentence a line break cut ("…tu código de\nverificación es 482910"). An address in a footer under the text is not.
    const back = text.slice(Math.max(0, s - NEAR), s);
    const ahead = text.slice(e, e + NEAR);
    const nb = back.lastIndexOf("\n");
    const na = ahead.indexOf("\n");
    const head = back.slice(nb + 1);
    const alone = !WORDY.test(head) && !WORDY.test((na < 0 ? ahead : ahead.slice(0, na)).replace(REMARK, ""));
    let from = s - back.length;
    let to = e + ahead.length;
    if (!alone) {
      const introduced = !WORDY.test(head) && /:\s*$/.test(back.slice(0, Math.max(0, nb)));
      if (nb >= 0 && !introduced && !/^\s*\p{Ll}/u.test(head)) from = s - head.length;
      if (na >= 0) to = e + na;
    }
    const start = from;
    for (const end of folded.slice(start, s).matchAll(SENTENCE_END)) from = start + end.index + 1;
    const stop = folded.slice(e, to).search(SENTENCE_END);
    if (stop >= 0) to = e + stop;
    // Past words are dropped by s - NEAR, which only grows: `from` does not (a code cut to its own line can start later than the next one).
    while (lo < hits.length && hits[lo]!.end <= s - NEAR) lo++;
    const before: Hit[] = [];
    const after: Hit[] = [];
    for (let i = lo; i < hits.length && hits[i]!.start < to; i++) {
      const h = hits[i]!;
      if (h.start >= from && h.end <= s) before.push(h);
      // A generic word right after a number counts things ("1000 tokens", "2 códigos"): it does not name the number as a code.
      else if (h.start >= e && h.end <= to && !(h.kind === "weak" && /^\s*$/.test(folded.slice(e, h.start)))) after.push(h);
    }
    before.sort((a, b) => b.end - a.end);
    const near = before[0];
    const gap = near ? folded.slice(near.end, s) : "";
    if (near && (near.kind === "not" || near.kind === "label") && s - near.end <= LABEL_NEAR && LABEL_GAP.test(gap)) continue;
    if (shape === "weak" && !(near && (near.kind === "strong" || near.kind === "weak") && DIRECT_GAP.test(gap))) continue;
    if (!saysCode(before, after)) continue;
    // Pairs of digits and groups of capitals: only with a strong word near, and never a word of ours inside it (ONE-TIME, PASS-CODE).
    if (shape === "strong" && (![...before, ...after].some((h) => h.kind === "strong") || hits.some((h) => h.start < e && h.end > s))) continue;
    out += text.slice(last, s) + codeMark(l);
    last = e;
    codes.add(token);
  }
  return codes.size ? { text: out + text.slice(last), codes: [...codes] } : { text, codes: [] };
}

// ---------- the codes kept for the owner's CODE ----------

const CODES_KEY = "assistant-mail-codes";
/** How long a code is kept: longer than a code usually lasts, short enough that none piles up. */
export const CODE_KEEP_MS = 30 * 60_000;
const CODES_MAX = 10;
const CODES_PER_MAIL = 5;

/** The codes of one email, with what the owner needs to tell which email it was (its subject already hidden). */
export interface KeptCodes {
  /** The email's id: AgentMail may bring the same email twice, and its codes are kept once. */
  id: string;
  /** When the email arrived. */
  at: number;
  from: string;
  subject: string;
  codes: string[];
}

/**
 * Each code once. Google writes G-482910 in the subject and 482910 in the words, Instagram 123 456 where its subject says 123456: one code
 * each, kept in its shortest form, the way it is typed.
 */
function distinct(codes: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const c of codes) {
    const key = c.replace(/^[A-Z]{1,2}-(?=\d)/, "").replace(/[\s-]/g, "");
    const had = byKey.get(key);
    if (had === undefined || c.length < had.length) byKey.set(key, c);
  }
  return [...byKey.values()];
}

/**
 * The codes of the last 30 minutes (at most 10 emails), in the store so a restart keeps them. The store forgets the whole record 30 minutes
 * after the newest code; an older one past its time can stay in it until then, but it is never shown again.
 */
export function createCodeVault(kv: Kv | null) {
  let list: KeptCodes[] | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
  /** Throws when the store cannot be read: an empty list in its place would overwrite the codes kept there. */
  const load = async (): Promise<KeptCodes[]> => {
    if (list) return list;
    const raw = kv ? await kv.get(CODES_KEY) : null;
    if (list) return list;
    let p: unknown = [];
    try {
      p = raw ? JSON.parse(raw) : [];
    } catch {
      console.error("[mail] the kept codes are not valid JSON: starting again");
    }
    list = (Array.isArray(p) ? p : [])
      .filter((x): x is KeptCodes => !!x && typeof x.id === "string" && typeof x.at === "number" && typeof x.from === "string" && Array.isArray(x.codes))
      .map((x) => ({ id: x.id, at: x.at, from: x.from, subject: typeof x.subject === "string" ? x.subject : "", codes: x.codes.filter((c) => typeof c === "string") }));
    return list;
  };
  return {
    /** Keeps an email's codes (with any already kept for it); a code already past its 30 minutes is not kept. Throws when the store fails. */
    add: (e: KeptCodes, nowMs: number = Date.now()): Promise<void> =>
      locked(async () => {
        if (!e.codes.length || nowMs - e.at >= CODE_KEEP_MS) return;
        const live = (await load()).filter((x) => nowMs - x.at < CODE_KEEP_MS);
        const old = live.find((x) => x.id === e.id);
        const entry: KeptCodes = { ...(old ?? e), codes: distinct([...(old?.codes ?? []), ...e.codes]).slice(0, CODES_PER_MAIL) };
        const next = [...live.filter((x) => x.id !== e.id), entry].sort((a, b) => a.at - b.at).slice(-CODES_MAX);
        const newest = Math.max(...next.map((x) => x.at));
        if (kv) await kv.set(CODES_KEY, JSON.stringify(next), Math.ceil((newest + CODE_KEEP_MS - nowMs) / 1000));
        list = next;
      }),
    /** The codes of the last 30 minutes, newest first (they stay until their time is up). Throws when the store cannot be read. */
    recent: async (nowMs: number = Date.now()): Promise<KeptCodes[]> => {
      await chain; // a code being kept right now is in the answer
      return (await load()).filter((x) => nowMs - x.at < CODE_KEEP_MS).sort((a, b) => b.at - a.at);
    },
  };
}
