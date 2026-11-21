// The door's limits and timings, and the small helpers several parts of it use.

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * How a connector card stopped counting: answered; replaced by a newer request for the same friend; annulled by a pause; past its minutes;
 * renewed (a press came too soon after another friend call, and a fresh card for the same request took over); lost (that fresh card could not
 * be shown).
 */
export type CardEnd = "answered" | "replaced" | "stopped" | "expired" | "renewed" | "lost";

export const CALL_ID = "wa_owner";
export const SEND_DAILY = 10;
export const SEND_PER_NUMBER_DAILY = 3;
/** Emails Pako sends from its own inbox in a day, at most (src/autonomy.ts). */
export const EMAIL_DAILY = 20;
export const TYPED_NUMBER_MS = 6 * 3600_000;
export const REPLY_FORWARD_MS = 48 * 3600_000;
export const CALL_WATCH_POLLS = 24;
export const EVENT_KEEP = 10;
export const EVENT_KEEP_MS = 6 * 3600_000;
export const OFFLINE_AFTER_MS = 90_000;
export const OFFLINE_NOTICE_EVERY_MS = 30 * 60_000;
export const DAILY_MESSAGES = 300;
/** How long a card to confirm a call or a message can still be pressed (the connector's requests too: src/personal-caller.ts). */
export const PENDING_CALL_MS = 5 * 60_000;
/** A reminder due while the computer slept comes late up to this; later than this it is told as missed (src/jobs.ts). */
export const REMINDER_LATE_MAX_MS = 12 * 3600_000;
export const FIRED_KEEP = 40;
export const FIRED_KEEP_MS = 7 * 24 * 3600_000;
export const SNOOZE_MS = 10 * 60_000;
export const REMINDERS_MAX = 20;
export const HELD_NOTICES_MAX = 40;
/** What fits in the notice template's one variable (Meta's limit is higher; this keeps a phone notification readable). */
export const TEMPLATE_TEXT_MAX = 600;
/** While the window is closed, ordinary notices (an email, Slack) ping at most this often; urgent ones (a meeting soon, the brief) always do. */
export const PING_EVERY_MS = 30 * 60_000;
/** WhatsApp lets a business write freely for 24 hours after the person's last message; a margin is kept. */
export const WINDOW_MS = 23.5 * 3600_000;
export const MEDIA_MAX = 16 * 1024 * 1024;
/** Where WhatsApp media may be fetched from: the access token is sent along, so only Meta's own hosts. */
export const MEDIA_HOST = /(^|\.)(fbsbx\.com|facebook\.com|fbcdn\.net|whatsapp\.net)$/;
const WHATSAPP_TEXT_MAX = 4000;
/** How long after Meta stamped a message or a status its signed webhook may still teach the server about itself (onSigned). */
export const SIGNED_FRESH_MS = 10 * 60_000;

/** Whether a webhook body carries a message or a status that Meta stamped (in seconds) within `ms` of `t`. */
export function stampedNear(doc: unknown, t: number, ms: number): boolean {
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  for (const entry of list((doc as { entry?: unknown } | null)?.entry)) {
    for (const change of list((entry as { changes?: unknown } | null)?.changes)) {
      const v = (change as { value?: { messages?: unknown; statuses?: unknown } } | null)?.value;
      for (const item of [...list(v?.messages), ...list(v?.statuses)]) {
        const s = Number((item as { timestamp?: unknown } | null)?.timestamp);
        if (s > 0 && Math.abs(t - s * 1000) < ms) return true;
      }
    }
  }
  return false;
}

export const same = (a: string, b: string): boolean => {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
};

/** Splits long text for WhatsApp, preferably at a paragraph or line end. */
export function chunkText(text: string, max = WHATSAPP_TEXT_MAX): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    // Never between the two halves of one character (an emoji): half of one is refused, or shown as a broken sign.
    if (cut < max / 2) cut = /[\uD800-\uDBFF]/.test(rest[max - 1]!) ? max - 1 : max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
