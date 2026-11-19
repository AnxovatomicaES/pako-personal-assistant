// Links made of the owner's words (a WhatsApp message to write, a request to a restaurant).

/** `encodeURIComponent` leaves ! ' ( ) * as they are, and in a chat message those end a link: they are escaped too. */
export const encodeLinkText = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** A wa.me link that opens WhatsApp on `digits` with `words` written (nothing is sent: the person presses send). */
export const waLink = (digits: string, words: string): string => `https://wa.me/${digits}?text=${encodeLinkText(words)}`;
