// Mail categories: the eight places an email can land (what the triage run says, what the panel's tabs show, what the notification switches
// are for), and everything decided about them without a run of Claude: the cheap pre-classification from headers and known senders, the
// sender rules the owner teaches by moving a mail, the reading of records kept before categories existed, the notification defaults, and the
// link that opens an email where it lives (Gmail, Apple Mail, Outlook).
//
// Pako's one job is that nothing promised gets dropped, so two categories feed the follow-ups: "Needs you" (the owner owes a reply, a decision
// or a task) and "Waiting on others" (someone owes the owner). Only "Needs you", "Suspicious" and security alerts tell the owner at once by
// default; "Waiting on others" and "Important" go to the morning brief instead, so the phone stays quiet.

import { zonedTime } from "./followups/time.ts";

export const CATEGORIES = ["needs_you", "waiting", "important", "personal", "updates", "read_later", "promotions", "suspicious"] as const;
export type MailCategory = (typeof CATEGORIES)[number];

export const isCategory = (v: unknown): v is MailCategory => typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);

/** The owner reads these words (English only, the owner's decision): the tabs, Move to…, the settings, the brief. */
export const CATEGORY_LABEL: Record<MailCategory, string> = {
  needs_you: "Needs you",
  waiting: "Waiting on others",
  important: "Important",
  personal: "Personal",
  updates: "Updates",
  read_later: "Read later",
  promotions: "Promotions",
  suspicious: "Suspicious",
};

/** The word the triage run writes on its first line for each category: fixed words, whatever language the summary is in. */
export const VERDICT_WORD: Record<MailCategory, string> = {
  needs_you: "NEEDS_YOU",
  waiting: "WAITING",
  important: "IMPORTANT",
  personal: "PERSONAL",
  updates: "UPDATES",
  read_later: "READ_LATER",
  promotions: "PROMOTIONS",
  suspicious: "SUSPICIOUS",
};

// ---------- notifications ----------

/** One switch per category, and one for the security alerts inside Updates (a new sign-in, a password changed). */
export type NotifyKey = MailCategory | "security";
export type NotifyPrefs = Record<NotifyKey, boolean>;
export const NOTIFY_KEYS: readonly NotifyKey[] = [...CATEGORIES, "security"];

/** Only what the owner must act on or be warned about now: everything else waits for the brief or the panel. */
export const NOTIFY_DEFAULTS: NotifyPrefs = {
  needs_you: true,
  waiting: false,
  important: false,
  personal: false,
  updates: false,
  read_later: false,
  promotions: false,
  suspicious: true,
  security: true,
};

/** The stored switches over the defaults: a key not stored (or stored wrong) keeps its default. */
export function notifyPrefsOf(v: unknown): NotifyPrefs {
  const out = { ...NOTIFY_DEFAULTS };
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const k of NOTIFY_KEYS) {
      const x = (v as Record<string, unknown>)[k];
      if (typeof x === "boolean") out[k] = x;
    }
  }
  return out;
}

/**
 * Whether an email is told to the owner now. A VIP sender always is (the owner asked for that by name); a security alert follows its own switch
 * even when Updates is off. No category (the run failed, or an older bridge said nothing): told, rather than lost.
 */
export function shouldNotify(r: { category?: MailCategory | undefined; security?: boolean | undefined; vip?: boolean | undefined }, prefs: NotifyPrefs): boolean {
  if (r.vip) return true;
  if (!r.category) return true;
  if (r.category === "updates" && r.security) return prefs.security || prefs.updates;
  return prefs[r.category];
}

// ---------- records kept before categories ----------

/** A summary that asks something of the owner: a question, or the words of an ask or a deadline (English and Spanish, as they were written). */
const ASK_WORDS = [
  "asks?", "asked", "asking", "needs? (?:you|your)", "please", "reply", "respond", "answer", "confirm", "approve", "sign", "decide", "deadline", "due",
  "by (?:mon|tue|wed|thu|fri|sat|sun|tomorrow|today)", "pide", "pregunta", "necesita", "responde", "contesta", "confirma", "aprueba", "firma",
  "plazo", "antes del?",
];
const ASKS = new RegExp(`\\?|\\b(?:${ASK_WORDS.join("|")})\\b`, "i");
export const hasAsk = (text: string): boolean => ASKS.test(text);

const RECEIPT_WORDS = [
  "receipt", "order", "invoice", "delivery", "delivered", "shipped", "shipping", "tracking", "booking", "reservation", "flight", "boarding",
  "payment", "statement", "bill", "subscription", "recibo", "pedido", "factura", "entrega", "envío", "envio", "reserva", "vuelo", "pago",
  "extracto", "suscripción",
];
const RECEIPTS = new RegExp(`\\b(?:${RECEIPT_WORDS.join("|")})\\b`, "i");

/**
 * The category of a stored email, whatever version kept it: its own when it has one, else read from the old verdict. Told (AVISAR) becomes
 * Needs you when its summary asks something, else Important; a scam becomes Suspicious; kept (GUARDAR) becomes Updates when it reads like a
 * receipt, an order or a booking, else Important; mass mail becomes Promotions. Mail still waiting for its summary is Important until then.
 * Never throws, whatever the record holds.
 */
export function categoryOf(r: { category?: unknown; kind?: unknown; scam?: unknown; summary?: unknown; subject?: unknown }): MailCategory {
  if (isCategory(r.category)) return r.category;
  const words = `${typeof r.subject === "string" ? r.subject : ""} ${typeof r.summary === "string" ? r.summary : ""}`;
  if (r.scam === true) return "suspicious";
  // A summary from a bridge that gave no verdict at all (scam unknown) says a scam by its Spanish warning, as the panel always read it.
  if (r.scam === undefined && r.kind === "aviso" && typeof r.summary === "string" && /\bestafa\b/i.test(r.summary)) return "suspicious";
  switch (r.kind) {
    case "aviso":
      return hasAsk(typeof r.summary === "string" ? r.summary : "") ? "needs_you" : "important";
    case "masivo":
      return "promotions";
    case "guardado":
      return RECEIPTS.test(words) ? "updates" : "important";
    default:
      return "important";
  }
}

// ---------- the triage run's answer ----------

export interface Verdict {
  category: MailCategory;
  /** One line: why it is in that category, shown under the mail in the panel. */
  why: string;
  /** An Updates mail that is a security alert (a sign-in, a password or a payment method changed). */
  security: boolean;
  /** For Needs you and Waiting on others: what is owed, by whom, by when (as the run wrote it), for the follow-ups. */
  loop?: { title: string; who: string; due: string };
  /** For Needs you: the ask in one plain line, from the run's own reading of that mail, and what kind of action it is. */
  ask?: { action: MailAction; text: string };
}

/** What a Needs you mail asks of the owner (the dashboard's tag); "read" is the tag of an Important mail not opened yet. */
export const ACTIONS = ["reply", "decide", "do"] as const;
export type MailAction = (typeof ACTIONS)[number];

const WORDS: Record<string, MailCategory> = Object.fromEntries(CATEGORIES.map((c) => [VERDICT_WORD[c], c]));
const FIRST_LINE =
  new RegExp(
    "^(NEEDS[ _-]YOU|WAITING(?:[ _-]ON[ _-]OTHERS)?|IMPORTANT|PERSONAL|UPDATES|READ[ _-]LATER|PROMOTIONS|SUSPICIOUS|AVISAR|GUARDAR)(?![A-Za-z])"
      + "(?:[ \\t]*[:-]?[ \\t]*(SECURITY|ESTAFA)[ \\t]*[:.]?[ \\t]*$)?[ \\t]*[:.-]*[ \\t]*(.*)$",
    "i",
  );
/** The run may write "NEEDS YOU", "Needs-you" or "needs_you": the same word. */
const wordKey = (s: string): string => s.toUpperCase().replace(/[\s-]+/g, "_");

/**
 * The first lines of the triage run's answer: the category word (with SECURITY after UPDATES for an alert), then WHY: and, for the two loop
 * categories, LOOP: title | who | due. Returns what it read and the rest of the text (the summary); null when the first line is not a
 * category. The old verdict words (AVISAR, AVISAR ESTAFA, GUARDAR) are read too: a bridge prompt from before is mapped, never lost.
 */
export function readVerdict(text: string): { verdict: Verdict; rest: string } | null {
  const lines = text.replace(/\r\n?/g, "\n").replace(/^\s+/, "").split("\n");
  const first = (lines[0] ?? "").replace(/[*`#]/g, "").trim();
  let category: MailCategory | undefined;
  let security = false;
  // The word, then a flag only when it ends the line (SECURITY, or the old ESTAFA), then whatever text an older answer put on the same line
  // ("AVISAR: Estafa piramidal en tu barrio" is a told email whose summary starts with that word, not a scam).
  const m = FIRST_LINE.exec(first);
  if (m) {
    const w = wordKey(m[1]!.trim()).replace(/^WAITING_ON_OTHERS$/, "WAITING");
    const flag = (m[2] ?? "").toUpperCase();
    if (WORDS[w]) {
      category = WORDS[w];
      security = category === "updates" && flag === "SECURITY";
    } else if (w === "AVISAR") category = flag === "ESTAFA" ? "suspicious" : "needs_you";
    else if (w === "GUARDAR") category = "important";
  }
  if (!category) return null;
  // Text on the word's own line is the summary's first line.
  const inline = (m?.[3] ?? "").trim();
  lines.splice(0, 1, "", ...(inline ? [inline] : []));
  let i = 1;
  let why = "";
  let loop: Verdict["loop"];
  let ask: Verdict["ask"];
  const owed = category === "needs_you" || category === "waiting";
  for (; i < lines.length && i < 5; i++) {
    const l = lines[i]!.trim();
    const w = /^\**why\**\s*:\s*(.*)$/i.exec(l);
    const p = /^\**loop\**\s*:\s*(.*)$/i.exec(l);
    const a = /^\**ask\**\s*:\s*(.*)$/i.exec(l);
    if (w) why = oneLine(w[1]!, 160);
    else if (p) {
      const [title = "", who = "", due = ""] = p[1]!.split("|").map((x) => oneLine(x, 160));
      if (title.length >= 3 && owed) loop = { title, who: who.slice(0, 80), due: /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?$/.test(due) ? due : "" };
    } else if (a) {
      // "reply | Ana asks you to approve the budget by Friday"; the line alone (no kind) is a "do".
      const parts = a[1]!.split("|").map((x) => oneLine(x, 200));
      const kind = (parts.length > 1 ? parts[0]! : "").toLowerCase();
      const text = parts.length > 1 ? parts.slice(1).join(" ").trim() : parts[0] ?? "";
      if (text.length >= 3 && category === "needs_you") ask = { action: (ACTIONS as readonly string[]).includes(kind) ? (kind as MailAction) : "do", text };
    } else if (l) break;
  }
  return { verdict: { category, why, security, ...(loop ? { loop } : {}), ...(ask ? { ask } : {}) }, rest: lines.slice(i).join("\n").trim() };
}

/**
 * The follow-up a verdict makes, as a candidate in the extraction's own shape (src/followups/answer.ts candidate reads it field by field):
 * Needs you is a request to the owner, Waiting on others a promise someone made them; nothing a check can see (it is mail), so it waits for
 * its date, the brief and PENDING. Null for every other category, or without a LOOP line.
 */
export function loopFromVerdict(v: Verdict, sender: string): Record<string, unknown> | null {
  if (!v.loop || (v.category !== "needs_you" && v.category !== "waiting")) return null;
  return {
    kind: v.category === "needs_you" ? "request_to_owner" : "other_promise",
    title: v.loop.title,
    who: v.loop.who || sender,
    detail: v.ask?.text ?? "",
    ...(v.loop.due ? { due: v.loop.due } : {}),
    check: "none",
    reason: "mail",
  };
}

const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const oneLine = (s: string, max: number): string => s.replace(INVISIBLE, "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

// ---------- before Claude: rules and headers ----------

/** A sender rule the owner taught by moving a mail: their address (or "@domain") always lands in that category. */
export interface SenderRule {
  from: string;
  category: MailCategory;
  at: number;
}

export const RULES_MAX = 300;

/** The address of a From header: the LAST <...> pair (the display name may itself look like an address), lowercased. */
export const senderAddress = (s: string): string => ([...s.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)].at(-1)?.[1] ?? s.trim()).toLowerCase();

/** The stored rules, each checked: a bad one is dropped, never a reason to fail. */
export function rulesOf(v: unknown): SenderRule[] {
  return (Array.isArray(v) ? v : []).flatMap((r): SenderRule[] => {
    const x = r as Partial<SenderRule> | null;
    return x && typeof x.from === "string" && /^[^\s@]*@[^\s@]+\.[^\s@]+$/.test(x.from) && isCategory(x.category) && typeof x.at === "number"
      ? [{ from: x.from.toLowerCase().slice(0, 200), category: x.category, at: x.at }]
      : [];
  }).slice(-RULES_MAX);
}

/**
 * The rule for a sender: their exact address only. A rule is a promise about one mailbox, so a neighbour on the same domain never borrows it
 * (and preClassify is only reached for a sender whose mail server proved the address, see trustedSender).
 */
export function ruleFor(from: string, rules: SenderRule[]): SenderRule | undefined {
  const a = senderAddress(from);
  if (!a.includes("@")) return undefined;
  return rules.find((r) => r.from === a);
}

// ---------- who really sent it: the gate before any filing without Claude ----------

/**
 * Second-level labels under which registrations sit (example.co.uk, example.me.uk, example.ltd.uk): the organisational domain keeps one more
 * label there. Too many only makes alignment stricter (the mail then gets Claude's full read); too few lets two strangers' domains align.
 */
const SHARED_SLD = new Set([
  "co", "com", "net", "org", "gov", "edu", "ac", "gob", "nom", "ne", "or", "go",
  "me", "ltd", "plc", "sch", "nhs", "police", "mod", "govt", "mil", "biz", "info", "asn", "id", "gen", "firm", "ind", "nic", "res", "lg", "gc",
]);
/** Registries sold under a generic domain (anything.uk.com, anything.us.com): each name under them is a stranger's. */
const SHARED_SUFFIX = new Set([
  "uk.com", "us.com", "eu.com", "gb.com", "gb.net", "uk.net", "cn.com", "de.com", "jpn.com", "br.com", "ru.com", "sa.com", "za.com", "kr.com",
  "hu.net", "se.net", "no.com", "us.org", "ae.org", "eu.org", "co.com",
]);

/** The organisational domain (the registrable one): mail.ups.com → ups.com, shop.example.co.uk → example.co.uk. Lowercase. */
export function orgDomain(domain: string): string {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const shared = (labels.at(-1)!.length === 2 && SHARED_SLD.has(labels.at(-2)!)) || SHARED_SUFFIX.has(labels.slice(-2).join("."));
  return labels.slice(shared ? -3 : -2).join(".");
}
/** Aligned as DMARC's relaxed mode has it: the same organisational domain. */
const aligned = (a: string, b: string): boolean => !!a && !!b && orgDomain(a) === orgDomain(b);

/**
 * Whether the owner's own mail server vouched for the From domain: the TOPMOST Authentication-Results (the one the receiving server wrote;
 * any further down may have been written by the sender) says dkim=pass with a signing domain (header.d, or header.i's) aligned with From, or
 * dmarc=pass for that From domain. No header, fail, softfail, none, or another domain: not authenticated.
 */
export function authenticated(from: string, authResults: string[]): boolean {
  const fromDomain = domainOf(senderAddress(from));
  const top = authResults[0];
  if (!fromDomain || typeof top !== "string") return false;
  // "mx.example; dkim=pass header.i=@ups.com header.s=s1; spf=pass ...; dmarc=pass (p=REJECT) header.from=ups.com"
  for (const part of top.replace(/\([^()]*\)/g, " ").split(";").slice(1)) {
    const p = part.trim().toLowerCase();
    const m = /^(dkim|dmarc)\s*=\s*([a-z]+)/.exec(p);
    if (!m || m[2] !== "pass") continue;
    if (m[1] === "dkim") {
      const d = /header\.d\s*=\s*([a-z0-9.-]+)/.exec(p)?.[1] ?? /header\.i\s*=\s*[^@\s]*@([a-z0-9.-]+)/.exec(p)?.[1] ?? "";
      if (aligned(d, fromDomain)) return true;
    } else {
      // DMARC's pass is about its header.from: when the result names one, it must be this mail's.
      const hf = /header\.from\s*=\s*([a-z0-9.-]+)/.exec(p)?.[1];
      if (!hf || aligned(hf, fromDomain)) return true;
    }
  }
  return false;
}

const MONEY_WORDS = new RegExp(`\\b(?:${[
  "pay", "payment", "paid", "invoice", "bill", "billing", "overdue", "refund", "bank", "card", "wire", "transfer", "password", "passcode",
  "sign[ -]?in", "log[ -]?in", "verify", "account", "factura", "pago", "pagar", "contraseña", "tarjeta", "transferencia", "cuenta",
].join("|")})\\b`, "i");
const URL_HOSTS = /\bhttps?:\/\/([a-z0-9.-]+)/gi;
const NAMED_DOMAIN = /(?:[a-z0-9._%+-]+@)?((?:[a-z0-9-]+\.)+[a-z]{2,})/gi;

/**
 * Cheap signs of a forgery, each enough for a full read by Claude even when the mail server vouched for the sender: the display name names
 * another domain or address than From; Reply-To goes to another domain; or money or password words with a link to another domain.
 * The reason, or "" when there is none.
 */
export function redFlag(m: { from: string; replyTo: string[]; subject: string; text: string; html?: string }): string {
  const address = senderAddress(m.from);
  const own = domainOf(address);
  if (!own) return "no sender address";
  const display = m.from.replace(/<[^<>]*>\s*$/, "");
  for (const x of display.matchAll(NAMED_DOMAIN)) if (!aligned(x[1]!, own)) return "the display name names another domain";
  for (const r of m.replyTo) {
    const d = domainOf(senderAddress(r));
    if (d && !aligned(d, own)) return "Reply-To goes to another domain";
  }
  // The HTML part too (its words may be all there is to read): tags out, roughly, which is enough to find a word.
  const words = `${m.subject}\n${m.text}\n${(m.html ?? "").replace(/<[^<>]{0,2000}>/g, " ")}`;
  if (MONEY_WORDS.test(words)) {
    const hosts = [...`${m.text}\n${m.html ?? ""}`.matchAll(URL_HOSTS)].map((x) => x[1]!);
    if (hosts.some((h) => !aligned(h, own))) return "money or password words with a link to another domain";
  }
  return "";
}

/** Whether mail may be filed without Claude: an authenticated sender with no red flag. Otherwise Claude reads it, Suspicious check included. */
export function trustedSender(m: { from: string; authResults: string[]; replyTo: string[]; subject: string; text: string; html?: string }): boolean {
  return authenticated(m.from, m.authResults) && !redFlag(m);
}

/** Carriers and shops whose mail is a receipt, an order or a delivery: Updates without a run. */
const UPDATE_DOMAINS = [
  "ups.com", "fedex.com", "dhl.com", "dhl.de", "usps.com", "correos.es", "seur.com", "mrw.es", "gls-spain.es", "nacex.es", "ctt.pt",
  "royalmail.com", "dpd.com", "dpd.co.uk", "chronopost.fr", "colissimo.fr", "postnl.nl", "inpost.es", "packlink.com",
];
/** The mailboxes shops send receipts and shipping notices from (the part before the @). */
const UPDATE_LOCAL = new RegExp(
  "^(?:receipts?|invoices?|billing|orders?|order-update|order-confirm(?:ation)?|auto-confirm|ship-confirm|shipment-tracking|shipping|delivery"
    + "|tracking|no-?reply-orders)(?:[+.-].*)?$",
);

/** Platforms newsletters are sent from: Read later rather than Promotions. */
const NEWSLETTER_DOMAINS = ["substack.com", "beehiiv.com", "buttondown.email", "ghost.io", "convertkit.com", "kit.com", "mailerlite.com", "revue.email"];
const NEWSLETTER_WORDS = /\b(?:newsletter|digest|weekly|daily brief|issue #?\d+|edition|bulletin|boletín|boletin)\b/i;

const domainOf = (address: string): string => (address.includes("@") ? address.split("@").pop()! : "");
const within = (domain: string, list: string[]): boolean => list.some((d) => domain === d || domain.endsWith(`.${d}`));

/**
 * What can be decided without a run of Claude, or null for a run. In order: a rule the owner taught; mail sent to a list (List-Unsubscribe,
 * List-Id or Precedence: bulk), Read later when it is a newsletter, else Promotions; a known carrier's or shop's receipt or shipping notice,
 * Updates. A VIP sender is never pre-classified (the caller skips it): they always reach the owner.
 */
export function preClassify(m: { from: string; subject: string; bulk: boolean; listId?: string }, rules: SenderRule[]): { category: MailCategory; why: string; rule?: true } | null {
  const rule = ruleFor(m.from, rules);
  if (rule) return { category: rule.category, why: `Your rule: mail from ${rule.from} goes to ${CATEGORY_LABEL[rule.category]}`, rule: true };
  const a = senderAddress(m.from);
  const domain = domainOf(a);
  if (m.bulk) {
    const newsletter = within(domain, NEWSLETTER_DOMAINS) || NEWSLETTER_WORDS.test(`${m.subject} ${m.from} ${m.listId ?? ""}`);
    return newsletter
      ? { category: "read_later", why: "A newsletter sent to a mailing list" }
      : { category: "promotions", why: "Sent to a mailing list (it has an unsubscribe link)" };
  }
  if (within(domain, UPDATE_DOMAINS)) return { category: "updates", why: "A delivery notice from a known carrier" };
  if (UPDATE_LOCAL.test(a.split("@")[0] ?? "")) return { category: "updates", why: "A receipt or order notice from a shop's own mailbox" };
  return null;
}

// ---------- open in the mail app ----------

export type MailProvider = "gmail" | "apple" | "outlook" | "office365";

/** Where the owner's mail lives, from the IMAP host or the address it was delivered to; undefined for any other provider. */
export function providerOf(host: string | undefined, addresses: string[]): MailProvider | undefined {
  const h = (host ?? "").toLowerCase();
  if (/(^|\.)gmail\.com$|(^|\.)googlemail\.com$/.test(h)) return "gmail";
  if (/(^|\.)mail\.me\.com$/.test(h)) return "apple";
  if (/(^|\.)office365\.com$|(^|\.)outlook\.office\.com$/.test(h)) return "office365";
  if (/(^|\.)outlook\.com$|(^|\.)hotmail\.com$|(^|\.)live\.com$/.test(h)) return "outlook";
  for (const raw of addresses) {
    const d = domainOf(senderAddress(String(raw)));
    if (d === "gmail.com" || d === "googlemail.com") return "gmail";
    if (d === "icloud.com" || d === "me.com" || d === "mac.com") return "apple";
    if (/^(?:outlook|hotmail|live|msn)\.[a-z.]{2,6}$/.test(d)) return "outlook";
  }
  return undefined;
}

/** A Message-ID as kept: without its angle brackets or spaces; "" when it does not look like one (an id has an @ in it). */
export function cleanMessageId(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/\s+/g, "").replace(/^<|>$/g, "").slice(0, 500) : "";
  return /^[^<>@]+@[^<>@]+$/.test(s) ? s : "";
}

export interface OpenLink {
  provider: MailProvider;
  label: string;
  url: string;
  /** Only works on a Mac (Mail.app opens message: links): the panel shows it only there. */
  macOnly?: true;
}

/**
 * The link that opens the original email in the owner's own mail app, or null (no Message-ID, or a provider with no such link: the panel's
 * reader is enough then). Gmail searches by Message-ID exactly; Apple Mail opens message:<id> itself; Outlook on the web has no documented
 * Message-ID link, so its search is given the subject, which usually finds it at the top.
 */
export function openLink(r: { provider?: MailProvider | undefined; messageId?: string | undefined; subject?: string | undefined }): OpenLink | null {
  const id = cleanMessageId(r.messageId);
  if (!id || !r.provider) return null;
  switch (r.provider) {
    case "gmail":
      return { provider: "gmail", label: "Open in Gmail", url: `https://mail.google.com/mail/u/0/#search/rfc822msgid%3A${encodeURIComponent(id)}` };
    case "apple":
      return { provider: "apple", label: "Open in Apple Mail", url: `message://%3C${encodeURIComponent(id).replace(/%40/g, "@")}%3E`, macOnly: true };
    case "outlook":
    case "office365": {
      const q = (r.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      if (!q) return null;
      const host = r.provider === "outlook" ? "https://outlook.live.com/mail/0" : "https://outlook.office.com/mail";
      return { provider: r.provider, label: "Open in Outlook", url: `${host}/search?q=${encodeURIComponent(q)}` };
    }
  }
}

// ---------- the dashboard's "Needs you" preview ----------

/** What the preview reads of a mail (src/mail.ts RecentMail with its category). */
export interface PreviewMail {
  id: string;
  at: number;
  from: string;
  subject: string;
  category: MailCategory;
  ask?: { action: MailAction; text: string } | undefined;
  due?: string | undefined;
  handledAt?: number | undefined;
  openedAt?: number | undefined;
  repliedAt?: number | undefined;
}

/** What the preview reads of a loop that came from a mail: whether it is still open, and its due time. */
export interface PreviewLoop {
  open: boolean;
  dueAt?: number | undefined;
}

export interface PreviewRow {
  id: string;
  from: string;
  subject: string;
  /** The triage's own one-line ask; absent when the triage gave none (the subject is all then: never an invented line). */
  ask?: string;
  tag: MailAction | "read";
  at: number;
  dueAt?: number;
  overdue?: true;
  today?: true;
}

/** How far back the preview looks: a Needs you mail stays until it is dealt with; a "to read" one only while it is fresh. */
export const NEEDS_DAYS = 30;
export const READ_DAYS = 7;
export const PREVIEW_ROWS = 5;

/** A display name from a From header: the name before the address, else the address. */
export const senderName = (from: string): string => from.replace(/\s*<[^>]*>\s*$/, "").replace(/^"|"$/g, "").trim() || senderAddress(from);

/**
 * The rows of the dashboard's preview: Needs you mail the owner has not dealt with (not marked done, not replied to, its loops not all closed),
 * and Important mail not opened yet ("to read"). Nothing else ever appears. Overdue first, then due today, then the oldest waiting first (what
 * needs an action before what is only to read).
 * `loops`: the loops each mail made, by mail id. A Needs you mail whose loops were all closed (by a check, a button, an answer) is dealt with.
 */
export function needsPreview(
  items: PreviewMail[],
  loops: (id: string) => PreviewLoop[],
  o: { now: number; timeZone: string; max?: number },
): { rows: PreviewRow[]; more: number } {
  const day = (t: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: o.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
  const today = day(o.now);
  const all: PreviewRow[] = [];
  for (const m of items) {
    if (m.handledAt || m.repliedAt) continue;
    if (m.category === "needs_you") {
      if (o.now - m.at > NEEDS_DAYS * 24 * 3600_000) continue;
      const mine = loops(m.id);
      if (mine.length && !mine.some((l) => l.open)) continue;
      const loopDue = mine.filter((l) => l.open && l.dueAt).map((l) => l.dueAt!).sort((a, b) => a - b)[0];
      const dueAt = loopDue ?? (m.due ? zonedTime(/^\d{4}-\d{2}-\d{2}$/.test(m.due) ? `${m.due} 23:59` : m.due, o.timeZone) ?? undefined : undefined);
      all.push({
        id: m.id, from: senderName(m.from), subject: m.subject, ...(m.ask?.text ? { ask: m.ask.text } : {}), tag: m.ask?.action ?? "do", at: m.at,
        ...(dueAt ? { dueAt } : {}), ...(dueAt && dueAt < o.now ? { overdue: true as const } : {}),
        ...(dueAt && dueAt >= o.now && day(dueAt) === today ? { today: true as const } : {}),
      });
    } else if (m.category === "important") {
      if (m.openedAt || o.now - m.at > READ_DAYS * 24 * 3600_000) continue;
      all.push({ id: m.id, from: senderName(m.from), subject: m.subject, tag: "read", at: m.at });
    }
  }
  // Overdue, due today, the rest of what needs the owner, and last what is only to read; the oldest first within each.
  const rank = (r: PreviewRow): number => (r.overdue ? 0 : r.today ? 1 : r.tag === "read" ? 3 : 2);
  all.sort((a, b) => rank(a) - rank(b) || (rank(a) < 2 ? a.dueAt! - b.dueAt! : a.at - b.at));
  const max = o.max ?? PREVIEW_ROWS;
  return { rows: all.slice(0, max), more: Math.max(0, all.length - max) };
}
