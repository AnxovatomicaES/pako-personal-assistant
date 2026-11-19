// One text message from the owner, as the door's handlers see it, and the shape of a handler (src/door/inbound.ts runs them in order).

import type { Door } from "./door.ts";
import type { OwnerChannel, WhatsappDeps } from "./deps.ts";

export interface Incoming {
  /** The message as it came (Meta's format; Telegram and the panel's chat write the same). */
  readonly m: Record<string, unknown>;
  readonly channel: OwnerChannel;
  readonly id: string;
  /** When it was heard. */
  readonly at: number;
  /** The words, trimmed. */
  readonly text: string;
  /** The words as a command (plainWords): no accents, punctuation or emoji. A read-only view in the owner's words becomes its command. */
  command: string;
  /** False for a forwarded message: someone else's words. */
  readonly ownWords: boolean;
  /** The proposed call, message, or table card this message may answer in words: only the very next message can (taken in intake). */
  readonly waiting: Door["pendingCall"];
  readonly waitingSend: Door["pendingSend"];
  readonly waitingBooking: ReturnType<NonNullable<WhatsappDeps["booking"]>["take"]> | null;
}

/** One step of the door's routing: what became of the message (for the log), or null when it is not this step's to answer. */
export type Handler = (door: Door, msg: Incoming) => Promise<string | null>;
