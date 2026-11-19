// PANEL and TELEGRAM: the link to the owner's panel, and pairing or letting go of Telegram.

import type { Handler } from "./incoming.ts";

export const onPanel: Handler = async (door, { command }) => {
  const { d, tx, sendText } = door;
  if (d.panelLink && /^(panel|dashboard)$/.test(command)) {
    const link = d.panelLink();
    if (!link) {
      // A server on the internet that does not know its own address: no link at all, rather than one that leads somewhere else.
      await sendText(tx("panelNoAddress"));
      return "panel address unknown";
    }
    await sendText(tx("panelLink", { link }));
    d.control?.log("panel", tx("logPanel"));
    return "panel link sent";
  }
  return null;
};

/** On a computer with no bot yet there is no link to give: Telegram is set up in the panel's Telegram card (its token, then a QR code). */
export const onTelegramInPanel: Handler = async (door, { command }) => {
  const { d, tx, sendText } = door;
  if (!d.telegram && d.local && /^telegram$/.test(command)) {
    await sendText(tx("telegramInPanel"));
    return "telegram: set up in the panel";
  }
  return null;
};

/** On a server without Telegram set up these are ordinary words for the assistant, as before. */
export const onTelegram: Handler = async (door, { command }) => {
  const { d, tx, sendText } = door;
  if (d.telegram && /^telegram$/.test(command)) {
    const already = await d.telegram.paired().catch(() => false);
    const link = await d.telegram.pairLink();
    await sendText(link ? tx("telegramLink", { open: tx(already ? "telegramAgain" : "telegramNew"), link }) : tx("telegramNoLink"));
    d.control?.log("telegram", tx("logTelegramLink"));
    return "telegram link sent";
  }
  return null;
};

export const onTelegramOff: Handler = async (door, { command, channel }) => {
  const { d, tx, sendText, setLastChannel } = door;
  if (d.telegram && /^telegram (off|disconnect)$/.test(command)) {
    const was = await d.telegram.paired().catch(() => true);
    // Forgotten whatever its state: a pending link stops working too, and an account named in TELEGRAM_OWNER_ID does not come back by itself.
    const kept = await d.telegram.unpair();
    setLastChannel("base");
    const warn = kept ? "" : tx("telegramNotKept");
    const said = tx(was ? "telegramOff" : "telegramWasOff", { warn });
    // Written on Telegram: the answer goes there, to the account that was just let go.
    if (channel === "telegram") await d.telegram.farewell(said);
    else await sendText(said);
    d.control?.log("telegram", tx("logTelegramOff"));
    return "telegram unpaired";
  }
  return null;
};
