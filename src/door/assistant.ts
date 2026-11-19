// The fallback: a message no step of the door answered goes to the assistant on the owner's computer, through the inbox the bridge reads.

import type { Door } from "./door.ts";
import type { Incoming } from "./incoming.ts";
import { OFFLINE_AFTER_MS, OFFLINE_NOTICE_EVERY_MS } from "./shared.ts";

/** Queued for the assistant, within the day's limit; the owner is told once in a while when the computer has not asked for a while. */
export const toAssistant = async (door: Door, { m, id, at, text }: Incoming): Promise<string> => {
  const { tx, inbox, sendText, hearLanguage, sawOutside, saidByOwner, dailyLimitReached } = door;
  if (dailyLimitReached()) {
    await sendText(tx("tooMuchToday"));
    return "over the daily limit";
  }
  hearLanguage(text, m);
  const fwd = m.context as { forwarded?: unknown; frequently_forwarded?: unknown } | undefined;
  const forwarded = fwd?.forwarded === true || fwd?.frequently_forwarded === true;
  if (!(await inbox.add({ id, at, text, ...(forwarded ? { forwarded: true } : {}) }))) return "repeated";
  // Provenance (src/autonomy.ts): the owner's own words, or someone else's they passed on.
  if (forwarded) sawOutside("forwarded", text);
  else saidByOwner(id, text);
  if (at - door.lastPollAt > OFFLINE_AFTER_MS && at - door.lastOfflineNoticeAt > OFFLINE_NOTICE_EVERY_MS) {
    door.lastOfflineNoticeAt = at;
    await sendText(tx("offline"));
  }
  return "queued";
};
