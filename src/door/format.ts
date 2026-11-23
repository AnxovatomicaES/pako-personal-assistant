// WhatsApp formatting and the clean-up of the words of a friend call: plain text, the marks WhatsApp draws, the owner's name.



/** WhatsApp takes three reply buttons at most: a card made for a chat with room for more (its 👍/👎) comes with its first three. */
export function threeButtons(body: Record<string, unknown>): Record<string, unknown> {
  const i = body.interactive as { action?: { buttons?: unknown[] } } | undefined;
  if (body.type !== "interactive" || !Array.isArray(i?.action?.buttons) || i.action.buttons.length <= 3) return body;
  return { ...body, interactive: { ...i, action: { ...i.action, buttons: i.action.buttons.slice(0, 3) } } };
}

// Code the assistant writes, which WhatsApp shows as it is (``` for a block, ` for a few words): nothing in it is turned into anything.
const CODE = /```[\s\S]*?```|`[^`\n]+`/g;
// Where the code was, while the rest is turned (private-use characters: the text's own are dropped first).
const KEPT = /\uE000(\d+)\uE001/g;

/**
 * WhatsApp shows plain text, not markdown: a [label](link) arrives as raw brackets, **bold** as asterisks and a heading as hashes. Turns what the
 * assistant tends to write into what WhatsApp renders (*bold*, a bare link it makes clickable). Code is left as it is, and so is a ** that is
 * not a pair of bold marks: they start a word and touch the text between them (a**2 + b**2, 2 ** 3, **kwargs).
 */
export function plainWhatsapp(text: string): string {
  const code: string[] = [];
  const plain = text
    .replace(/[\uE000\uE001]/g, "")
    .replace(CODE, (c) => `\uE000${code.push(c) - 1}\uE001`)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => (label.trim() === url ? url : `${label.trim()}: ${url}`))
    .replace(/(?<=^|[\s\p{P}\p{S}])\*\*(?!\s)([^*\n]*[^\s*])\*\*(?=$|[\s\p{P}\p{S}])/gu, "*$1*")
    .replace(/~~([^~\n]+)~~/g, "~$1~")
    .replace(/^#{1,6}[ \t]+/gm, "");
  return plain.replace(KEPT, (_m, i: string) => code[Number(i)]!).trim();
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Characters that show as nothing, or as blank space, in a WhatsApp message: padding made of them could push words out of sight.
const NOT_SHOWN = /[\u034f\u115f\u1160\u17b4\u17b5\u2800\u3164\uffa0\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;
// A pair of WhatsApp's formatting marks around some text (*bold*, _italic_, ~struck~, ```code```, `code`): the mark starts a word, the text
// inside has no such mark and does not start or end with a space, and the closing mark ends a word.
const FORMATTED = new RegExp(
  "(^|[\\s\\p{P}\\p{S}])(?:"
    + ["\\*", "_", "~", "```", "`"].map((m) => { const c = m.slice(-1); return `${m}(?=[^\\s${c}])([^${c}]*?[^\\s${c}])${m}`; }).join("|")
    + ")(?=$|[\\s\\p{P}\\p{S}])",
  "gu",
);

/** Each pair of WhatsApp's formatting marks in `s` (one pass), rewritten by `wrap` from its mark and the text inside it. */
export function replaceFormatting(s: string, wrap: (mark: "*" | "_" | "~" | "```" | "`", inner: string) => string): string {
  const marks = ["*", "_", "~", "```", "`"] as const;
  return s.replace(FORMATTED, (_all, before: string, ...groups: unknown[]) => {
    const i = groups.slice(0, marks.length).findIndex((x) => typeof x === "string");
    return i < 0 ? _all : before + wrap(marks[i]!, groups[i] as string);
  });
}

/**
 * A call's words as the owner's card shows them and as the call uses them: one text for both. One plain line without control or invisible
 * characters, without characters that show as blank space, without WhatsApp's formatting marks (a word struck through on the card would still
 * be said), with plain quotes (a « » or " " in the words could fake the card's own quoting), and cleaned by cleanCallMessage. Cleaning it again
 * later, when the call is placed, changes nothing. `orEmpty`: nothing is returned when nothing but a greeting or "soy <owner>" was there.
 */
export function callWords(s: string, ownerName: string, orEmpty = true): string {
  // Lone halves of a character go first: removing what stood between two of them could otherwise join them into a new, invisible character.
  const whole = s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  const once = (text: string): string => {
    let plain = text
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/[\p{Cf}\p{Co}]/gu, "")
      .replace(NOT_SHOWN, "")
      .replace(/["“”„«»‹›]/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    // Only a pair WhatsApp turns into formatting loses its marks; an email (marta_garcia@…), a sum (3*4) or a lone ~ is left as it is.
    for (let i = 0; i <= plain.length; i++) {
      const next = replaceFormatting(plain, (_mark, inner) => inner);
      if (next === plain) break;
      plain = next;
    }
    return cleanCallMessage(plain, ownerName, orEmpty);
  };
  // Until nothing changes: each pass can uncover more (removing "soy Marta" can make the next marks a pair). After the first pass, a pass that
  // changes the text makes it shorter, so the bound is never reached; if it were, nothing is better than words only half cleaned.
  let out = whole;
  for (let i = 0; i <= 2 * whole.length + 2; i++) {
    const next = once(out);
    if (next === out) return out;
    out = next;
  }
  return orEmpty ? "" : out;
}

/**
 * The words a proposed call carries to the friend. The call opens by saying it is the owner's AI assistant, so a message that also starts
 * with a greeting or says "soy Ana" would have the assistant claim to be the person: those parts are dropped, and the owner sees (and
 * approves) the cleaned text. Nothing else is rewritten; if nothing would be left, the message is kept as it was (or, with `orEmpty`, nothing
 * is returned, so the caller can refuse it).
 */
export function cleanCallMessage(message: string, ownerName: string, orEmpty = false): string {
  const owner = escapeRe(ownerName.trim());
  if (!owner) return message;
  // The name ends the phrase: "It's Marta's birthday", "I'm Marta-Luisa's friend" and "Soy Martina" are not the owner saying who they are.
  const me = new RegExp(`^(?:soy|me llamo|habla|i'?m|i am|this is|it'?s)\\s+(?:el |la )?${owner}(?![\\p{L}\\p{N}'’-])\\s*[,.:;!-]?\\s*`, "iu");
  // "Hola," / "Hola Belen," / "Hey Ana!": a greeting, at most one name, and the punctuation that ends it (so "hola que tal" is left alone).
  // Spanish too: the message is the owner's own words, in whatever language they write it.
  const hello = /^(?:hola|hey|buenas|hello|hi)\b(?:\s+[\p{L}'’-]{1,20})?\s*[,.!;:]\s*/iu;
  const once = (text: string): string => {
    const cleaned = text
      .trim()
      .replace(hello, "")
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.replace(me, "").trim())
      .filter((s) => /[\p{L}\p{N}]/u.test(s))
      .join(" ")
      .trim();
    return cleaned || (orEmpty ? "" : text);
  };
  // Until nothing changes ("Hola, hola Ana, …" takes two passes): cleaning it again later, when the call is placed, must not change what the owner
  // approved. A pass that changes the text makes it shorter or turns a line break into a space, so the loop always ends; the bound is a backstop.
  let out = message;
  for (let i = 0; i <= 2 * message.length + 1; i++) {
    const next = once(out);
    if (next === out) break;
    out = next;
  }
  return out;
}
