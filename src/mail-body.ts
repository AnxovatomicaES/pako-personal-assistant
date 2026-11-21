// An email made into what the follow-ups' extraction reads: the newest message of it in plain text (the quoted history, the reply headers,
// the signature and the legal footer taken out), cut to about 4,000 characters, and the key of the thread it belongs to.
//
// Pure and bounded: a hostile message can make it keep less, never loop or grow. Other people's words stay data: a line that addresses an
// assistant with an order (src/brief-support.ts instructsPako) is replaced by a note before anything reads it, and the result goes through
// src/quarantine.ts neutralise where the job is written.

import { createHash } from "node:crypto";
import { instructsPako } from "./brief-support.ts";

/** The most of one email's words an extraction reads. */
export const MAIL_BODY_MAX = 4000;

/** "On Mon, 16 Nov 2026 at 09:30, Ana <ana@x.com> wrote:" and its translations: where the quoted history starts. */
const ATTRIBUTION = new RegExp(
  "^(on\\b.{0,200}\\bwrote|el\\b.{0,200}\\bescribi[oó]|le\\b.{0,200}\\ba [ée]crit|am\\b.{0,200}\\bschrieb|il\\b.{0,200}\\bha scritto"
    + "|em\\b.{0,200}\\bescreveu|op\\b.{0,200}\\bschreef)\\s*:?\\s*$",
  "i",
);
/** Outlook's and others' separators above a copied message, which they do not mark with ">". */
const SEPARATOR = /^(-{2,}\s*(original message|mensaje original|message d'origine|urspr[üu]ngliche nachricht|messaggio originale)\s*-{2,}|_{10,})\s*$/i;
/** An Outlook header block: "From: …" then, within the next lines, "Sent:"/"Date:" and "To:"/"Subject:". */
const HEADER_FROM = /^\*?(from|de|von|da|van)\s*:\*?\s+\S/i;
const HEADER_NEXT = /^\*?(sent|date|enviado|fecha|envoy[ée]|gesendet|datum|inviato|data|to|para|[àa]|an|a|subject|asunto|objet|betreff|oggetto)\s*:\*?/i;
/** Where a signature or a footer starts: the "-- " line, a phone's tag line, a legal notice. */
const SIGNATURE = new RegExp(
  "^(--\\s*|sent from my \\w+.*|get outlook for .*|enviado desde mi .*|envoy[ée] de mon .*|von meinem .* gesendet"
    + "|(confidentiality|privacy) notice\\b.*|this (e-?mail|message) (and any attachments? )?(is|are|may be) confidential.*"
    + "|este (correo|mensaje) (y sus anexos )?(es|puede ser) confidencial.*)$",
  "i",
);
const LEFT_OUT = "(a line addressed to an assistant was left out)";

/**
 * The newest message of an email (its text, or its HTML already made text: src/mail.ts bodyText): lines quoted with ">" taken out (a reply
 * written below the quote stays: bottom-posting keeps the new words last); everything from a reply header ("On … wrote:", an Outlook "From:
 * … Sent: …" block, "-----Original Message-----") or a signature on; blank runs folded; cut at `max`, at a word.
 */
export function cleanMailBody(text: string, max: number = MAIL_BODY_MAX): string {
  let raw = typeof text === "string" ? text : "";
  // Bounded before the line work: a megabyte of quoted thread costs nothing.
  raw = raw.slice(0, 200_000).replace(/\r\n?/g, "\n");
  const lines = raw.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    // trimEnd, not /\s+$/: that regex tries every start, and a stranger's line of blanks took tens of seconds of CPU.
    const line = lines[i]!.trimEnd();
    const t = line.trim();
    if (/^>/.test(t)) continue;
    // "On Mon … Ana" / "<ana@x.com> wrote:" broken over two lines: the pair read as one.
    const pair = `${t} ${(lines[i + 1] ?? "").trim()}`;
    if (ATTRIBUTION.test(t)) {
      // Above quoted lines (Gmail, Apple Mail): only the header goes, a reply below the quote stays. Above an unquoted copy: the rest goes.
      if (quotedNext(lines, i + 1)) continue;
      break;
    }
    if (t && ATTRIBUTION.test(pair) && i + 1 < lines.length) {
      if (quotedNext(lines, i + 2)) {
        i++;
        continue;
      }
      break;
    }
    if (SEPARATOR.test(t)) break;
    if (HEADER_FROM.test(t) && lines.slice(i + 1, i + 5).filter((x) => HEADER_NEXT.test(x.trim())).length >= 2) break;
    if (SIGNATURE.test(t)) break;
    out.push(instructsPako(t) ? LEFT_OUT : line);
  }
  const body = out.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (body.length <= max) return body;
  const cut = body.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.8 ? cut.slice(0, space) : cut}…`;
}

/** The next line with words starts with ">": the attribution heads a quote, not an unquoted copy. */
function quotedNext(lines: string[], from: number): boolean {
  for (let j = from; j < lines.length && j < from + 3; j++) {
    const t = lines[j]!.trim();
    if (t) return t.startsWith(">");
  }
  return false;
}

/** Message-IDs in a header value, in their order, lower case, with their angle brackets. */
const idsIn = (v: string | undefined): string[] => (v ?? "").match(/<[^<>\s]{1,300}>/g)?.map((x) => x.toLowerCase()) ?? [];

/** A subject without its "Re:", "Fwd:", "RV:", "AW:" heads, folded: the last way to tell a thread when no header names one. */
export const threadSubject = (s: string): string =>
  s.replace(/^\s*((re|fwd?|fw|rv|aw|wg|tr|sv|vs|r)\s*(\[\d+\])?\s*:\s*)+/i, "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 200);

/**
 * The key of an email's thread (16 hex characters): the first Message-ID its References name (the thread's first email), else the one its
 * In-Reply-To names, else its own Message-ID, else its subject without the "Re:" heads. An email and the owner's reply to it have the same
 * key when their mail apps keep References, as they all do.
 */
export function mailThreadKey(h: { references?: string; inReplyTo?: string; messageId?: string; subject?: string }): string {
  const root = idsIn(h.references)[0] ?? idsIn(h.inReplyTo)[0] ?? idsIn(h.messageId)[0]
    ?? (h.messageId?.trim() ? `<${h.messageId.trim().replace(/^<|>$/g, "").toLowerCase()}>` : `subject:${threadSubject(h.subject ?? "")}`);
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

/** A thread key as kept: 16 lowercase hex characters. */
export const MAIL_THREAD = /^[0-9a-f]{16}$/;
