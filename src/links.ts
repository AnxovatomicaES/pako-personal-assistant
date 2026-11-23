// Links made of the owner's words (a WhatsApp message to write, a request to a restaurant).

/** Half of an emoji on its own (a text cut in the middle of one): it has no UTF-8 form, and `encodeURIComponent` throws on it. */
const LONE_HALF = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * `encodeURIComponent` leaves ! ' ( ) * as they are, and in a chat message those end a link: they are escaped too. A lone half of an emoji is
 * dropped first, so a link can never be the thing that throws.
 */
export const encodeLinkText = (s: string): string =>
  encodeURIComponent(s.replace(LONE_HALF, "")).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** A wa.me link that opens WhatsApp on `digits` with `words` written (nothing is sent: the person presses send). */
export const waLink = (digits: string, words: string): string => `https://wa.me/${digits}?text=${encodeLinkText(words)}`;
