// CODE: the one-time codes hidden from the mail's notices.

import type { Handler } from "./incoming.ts";
import { createLog } from "../log.ts";

const log = createLog("mail");

/**
 * The one-time codes hidden from the mail's notices: shown because the owner asked, and the log says so without the code itself. It answers
 * while paused too: reading the owner's own code is not an action STOP holds.
 */
export const onCodes: Handler = async (door, { command, at }) => {
  const { d, tx, sendText } = door;
  if (d.codes && /^(code|codes)$/.test(command)) {
    let kept: { at: number; from: string; codes: string[] }[];
    try {
      kept = await d.codes.recent();
    } catch (err) {
      log.error(`could not read the kept codes: ${(err as Error).message}`);
      await sendText(tx("codesUnread"));
      return "codes not read";
    }
    if (!kept.length) {
      await sendText(tx("codesNone"));
      return "no codes";
    }
    const ago = (t: number): string => (at - t < 60_000 ? tx("codeJustNow") : tx("codeMinutes", { n: Math.floor((at - t) / 60_000) }));
    const lines = kept.map((k) => tx("codeLine", { from: k.from, ago: ago(k.at), codes: k.codes.join(", ") })).join("\n");
    if (!(await sendText(lines, { secret: true }))) return "codes not sent";
    for (const k of kept) d.control?.log("mail", tx("logCodeShown", { from: k.from }));
    return "codes shown";
  }
  return null;
};
