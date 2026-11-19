// WhatsApp's 24-hour window: when the owner last wrote there, and so whether Pako may write first.

import { WINDOW_MS } from "./shared.ts";
import type { Door } from "./door.ts";

const LAST_OWNER_KEY = "assistant-last-owner-at";

export function mountWindow(door: Door): Pick<Door, "touchOwner" | "windowOpen" | "windowOver"> {
  const { d } = door;
  door.lastOwnerAt = 0;
  /** The owner's last message on any chat (WhatsApp, Telegram, the panel's), in memory: when they are in a conversation. */
  door.lastHeardAt = 0;
  let lastOwnerSaved = 0;
  let ownerAtLoading: Promise<void> | null = null;

  /** Remembers when the owner last wrote: WhatsApp lets this server write first only for 24 hours after that. */
  const touchOwner = (at: number): void => {
    door.lastOwnerAt = at;
    if (d.kv && at - lastOwnerSaved > 5 * 60_000) {
      lastOwnerSaved = at;
      d.kv.set(LAST_OWNER_KEY, String(at), 3 * 24 * 3600).catch(() => undefined);
    }
  };
  const windowOpen = async (t: number): Promise<boolean> => {
    if (d.local) return true;
    if (d.kv) {
      // One read shared by everyone who asks while it is in flight (a second caller must not see "never wrote" and keep an urgent notice back).
      ownerAtLoading ??= (async () => {
        try {
          const v = Number(await d.kv!.get(LAST_OWNER_KEY));
          if (v > door.lastOwnerAt) door.lastOwnerAt = v;
        } catch {
          ownerAtLoading = null; // try again next time
        }
      })();
      await ownerAtLoading;
    }
    return door.lastOwnerAt > 0 && t - door.lastOwnerAt < WINDOW_MS;
  };
  /** The owner wrote, and WhatsApp's 24 hours since are over (never known to have written: not said to be over, an answer still goes). */
  const windowOver = async (t: number): Promise<boolean> => {
    if (d.local) return false;
    return !(await windowOpen(t)) && door.lastOwnerAt > 0;
  };

  return { touchOwner, windowOpen, windowOver };
}
