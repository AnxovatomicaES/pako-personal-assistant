// CHASE and a few words: a reminder for someone who owes the owner something (src/followups/chase.ts), written now in a gentle and a firm
// tone and shown on a card to send or copy. Read by the server, like DRAFT; nothing is sent until the owner presses Send on that card.

import type { Handler } from "./incoming.ts";

export const onChase: Handler = async (door, { command }) => {
  const { d, sendText } = door;
  const m = /^chase (?:up )?(.{2,80})$/.exec(command);
  if (!m || !d.followups?.chaseNow) return null;
  const r = await d.followups.chaseNow(m[1]!).catch(() => ({ ok: false, say: "" }));
  if (!r.say) return null;
  await sendText(r.say);
  return r.ok ? "chase asked" : "chase: none";
};
