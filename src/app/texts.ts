// The fixed texts the app's wiring writes itself (each module's own texts live in that module): the owner's notice of a Telegram pairing
// and the panel's line for it, the panel's list of what is connected, and the chat's first message on a computer.

import { texts } from "../i18n.ts";

/** What the server itself says about Telegram: the owner's notice of a new pairing, and the panel's line for it. */
export const TG = texts(
  {
    paired: "Telegram connected: the account {who} now talks to me. If that wasn't you, type TELEGRAM OFF here.",
    on: "Connected",
    pairChat: "Type TELEGRAM in the chat",
    pairQr: "Not connected: scan the QR code",
    none: "Not set up",
  },
);

/** The panel's list of what is connected: each part's name and its one line, in the language of Pako's own texts. */
export const PARTS = texts(
  {
    chat: "Chat",
    chatHere: "In this panel",
    brain: "Brain",
    brainMac: "Brain (Mac)",
    brainHere: "Claude on this computer",
    brainOnMac: "Claude on your Mac",
    phone: "Phone",
    none: "Not set up",
    live: "Live",
    dry: "Simulated",
    mail: "Mail",
    calendar: "Calendar",
    readOnly: "Read only",
    off: "Off",
    panelNotReady: "(the panel is not ready)",
  },
);

/** The first message in the panel's chat on a computer: who Pako is, what to try, and where to see the rest. */
export const HELLO = texts(
  {
    named: "Hi, {name}. I'm Pako, your assistant. Ask me anything in your own words: “what do I have today?”, “what am I forgetting?”, "
      + "“remind me to call Ana tomorrow”.\n\nNo commands to learn; if you'd like shortcuts, type HELP.",
    plain: "Hi, I'm Pako, your assistant. Ask me anything in your own words: “what do I have today?”, “what am I forgetting?”, "
      + "“remind me to call Ana tomorrow”.\n\nNo commands to learn; if you'd like shortcuts, type HELP.",
  },
);
