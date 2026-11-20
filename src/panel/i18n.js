// The panel's words, English only (the owner's decision of 2026-11-18: Pako's own fixed texts are English everywhere; Claude's answers in
// the chat still follow the language each message is written in). index.html marks its fixed texts with data-i18n (and data-i18n-aria,
// -placeholder, -title for attributes); app.js builds the rest with t(key, vars). {name} is filled from vars; **text** is drawn bold.
// test/panel-i18n.test.ts checks that every key the page uses is here.
//
// A panel on a person's computer has the chat in it, and a few texts that name the place to write say so there: CHAT_WORDS, which win over
// WORDS on that panel.
//
// A plain module with no browser code: the page imports it, and so do the tests.

/**
 * The locale a page writes dates and times in: English as the owner's country writes it, from the country the server writes on <html
 * data-region> (the same rule as the server's, src/region.ts): "en-US" writes 3:05 PM and 11/3, "en-GB" 15:05 and 3/11. With no country, or
 * one this browser does not know, en-GB: day before month and a 24-hour clock, the form most of the world reads.
 */
export function localeFor(region) {
  const fallback = "en-GB";
  if (!region || !/^[A-Z]{2}$/.test(region)) return fallback;
  const tag = `en-${region}`;
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([tag]).length ? tag : fallback;
  } catch {
    /* an old browser: the fallback */
    return fallback;
  }
}

/**
 * A day's "HH:MM" (as the server keeps it) on the owner's clock: "2:00 PM" where the locale writes AM/PM (en-US), else as kept ("14:00").
 * The same rule as the chat's brief (src/brief-v2.ts chatText). "" stays "".
 */
export function clockOf(hm, locale) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm ?? "");
  if (!m) return hm ?? "";
  let twelve = false;
  try {
    const c = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
    twelve = c === "h12" || c === "h11";
  } catch {
    /* an old browser: a 24-hour clock */
    twelve = false;
  }
  if (!twelve) return hm;
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", hour: "numeric", minute: "2-digit" }).format(Date.UTC(2000, 0, 1, +m[1], +m[2]));
}

export const WORDS = {
  // ---------- header ----------
  "time": "Time",
  "refresh": "Refresh now",
  "settings": "Settings",
  "greet.late": "Hello",
  "greet.morning": "Good morning",
  "greet.afternoon": "Good afternoon",
  "greet.evening": "Good evening",
  "friend": "friend",
  "sum.meeting": "{n} meeting",
  "sum.meetings": "{n} meetings",
  "sum.ahead": " ahead today",
  "sum.noMeetings": "Nothing else on the agenda today",
  "sum.mail": " email to look at",
  "sum.mails": " emails to look at",
  "sum.slack": " on Slack",
  "sum.rem": " reminder",
  "sum.rems": " reminders",
  "sum.and": " and ",
  "sum.paused": "Paused{why}: ",
  "sum.pausedTail": "no calls, no messages. ",
  "why.storeEmpty": " because the store came back empty",
  "why.storeUnknown": " until the store answers",
  "switch.on": "On",
  "switch.off": "Paused",
  "switch.onAria": "Pako is on: press to stop calls and messages",
  "switch.offAria": "Pako is paused: press to resume",
  "stop.confirm": "Stop Pako? It won't call or message anyone until you resume it. Your chat with it, your reminders and your mail carry on.",
  "toast.paused": "⏸ Pako paused",
  "toast.running": "▶️ Pako running",
  "toast.cantChange": "Couldn't change it right now",
  "toast.updated": "Updated",
  "toast.loadFailed": "Couldn't refresh: trying again in a minute",
  "toast.sendFailed": "Couldn't send it: try again",

  // ---------- times ----------
  "ago.now": "just now",
  "ago.min": "{n} min ago",
  "ago.h": "{n} h ago",
  "ago.yesterday": "yesterday",
  "ago.days": "{n} days ago",
  "until.late": "overdue",
  "until.past": "time passed",
  "until.now": "now",
  "until.in": "in {span}",
  "until.tomorrow": "tomorrow",
  "span.min": "{n} min",
  "span.h": "{h} h",
  "span.hm": "{h} h {m} min",
  "span.days": "{n} days",

  // ---------- agenda ----------
  "agenda.title": "Agenda",
  "agenda.day": "Day",
  "agenda.today": "Today",
  "agenda.tomorrow": "Tomorrow",
  "agenda.week": "Week",
  "agenda.off": "The calendar isn't connected.",
  "agenda.unread": "I couldn't read your calendar just now. I'll try again at the next refresh.",
  "agenda.freeToday": "Nothing else today. Enjoy it.",
  "agenda.freeTomorrow": "Tomorrow is free, for now.",
  "agenda.freeWeek": "A free week.",
  "agenda.clash": "⚠ overlaps",
  "agenda.allDay": "all day",

  // ---------- mail ----------
  "mail.title": "Mail",
  "mail.ringAria": "Mail from the last 24 hours",
  "mail.ringCap": "in 24 h",
  "mail.sparkAria": "Emails per hour",
  "mail.sparkCap": "Per hour, last 24 h",
  "mail.off": "Mail isn't connected.",
  "mail.bar": "{n} email(s) {h} h ago",

  // ---------- the other cards ----------
  "act.title": "Activity",
  "act.live": "live",
  "act.empty": "No activity yet.",
  "slack.title": "Slack",
  "slack.readOnly": "read only",
  "slack.empty": "Nothing for you on Slack this week.",
  "rem.title": "Reminders",
  "rem.empty": "No reminders. Ask Pako for them on WhatsApp.",
  "rem.held": "waiting to be sent",
  "book.title": "Bookings",
  "book.hint": "ask for them on WhatsApp",
  "book.empty": "No bookings. Try: “book a table for 2 tomorrow at 9 pm at an Italian place”.",
  "book.pedida": "requested by email, waiting for an answer",
  "book.enlace": "link given: confirming is up to you",
  "book.line": "{day}, {time} · {n} people · {how}",
  "book.lineOne": "{day}, {time} · {n} person · {how}",
  "mem.title": "What Pako knows about you",
  "mem.calls": "Recent calls",
  "mem.empty": "You haven't asked it to remember anything yet.",
  "mem.noCalls": "No recent calls.",
  "sys.title": "System",
  "sys.updated": "updated {time}",
  "sys.hint": "On WhatsApp: **CALENDAR**, **MAIL**, **SLACK**, **BOOKINGS**, **LOG**, **STOP** / **RESUME**, **PANEL**.",
  "foot.private": "Private panel · read only except STOP",
  "foot.settings": "Your name",

  // ---------- chat ----------
  "chat.aria": "Chat with Pako",
  "chat.online": "online",
  "chat.typing": "typing…",
  "chat.typingAria": "Pako is typing",
  "chat.close": "Close the chat",
  "chat.placeholder": "Write to Pako…",
  "chat.input": "Message to Pako",
  "chat.send": "Send",
  "chat.viaTelegram": "Sent to your Telegram",
  "chat.viaWhatsapp": "Sent to your WhatsApp",

  // ---------- Telegram ----------
  "tg.lead": "Talk to Pako from your phone, wherever you are: write to it on Telegram, and it tells you things there.",
  "tg.setup": "Connect Telegram",
  "tg.step1": "Open **@BotFather** in Telegram: scan the code with your phone, or open it here.",
  "tg.step2": "Send it **/newbot** and answer its two questions: a name, then a username ending in “bot”.",
  "tg.step3": "Paste the token it gives you here:",
  "tg.connect": "Connect",
  "tg.connecting": "Connecting…",
  "tg.tokenBad": "That doesn't look like a token: it's a line like 123456789:AAH…",
  "tg.tokenFailed": "Couldn't connect that bot.",
  "tg.openBotFather": "Open @BotFather",
  "tg.qrBotFather": "QR code that opens @BotFather in Telegram",
  "tg.ready": "Your bot {bot} is ready. Scan the code with your phone to link your account:",
  "tg.readyPlain": "Your bot is ready. Scan the code with your phone to link your account:",
  "tg.showCode": "Show the code",
  "tg.qr": "QR code that links your Telegram to Pako",
  "tg.orLink": "Or open this link on your phone:",
  "tg.expires": "The code works once, for 10 minutes.",
  "tg.waiting": "Waiting for your phone…",
  "tg.expired": "The code has expired.",
  "tg.newCode": "New code",
  "tg.paired": "Connected: {account} talks to Pako on Telegram.",
  "tg.pairedBot": "Connected: {account} talks to Pako through {bot}.",
  "tg.pairedPlain": "Connected: your Telegram now talks to Pako.",
  "tg.off": "Disconnect",
  "tg.offConfirm": "Disconnect Telegram? Pako will stop answering there until you connect it again.",
  "tg.otherBot": "Use another bot",
  "tg.keepBot": "Keep this bot",
  "tg.offDone": "Telegram disconnected",
  "tg.pairedToast": "Connected! Write to your bot from your phone.",
  "tg.failed": "Couldn't reach Pako: try again",
  "tg.state.none": "not set up",
  "tg.state.unpaired": "phone not linked yet",
  "tg.state.paired": "connected",

  // ---------- the demo week (src/demo.ts) ----------
  "demo.banner": "Demo week: invented data.",
  "demo.live": "Connect Claude to see it live",
  "demo.leave": "Leave demo",
  "demo.leaving": "Leaving the demo… Pako is starting again.",
  "demo.starting": "Setting up the demo week… Pako is starting again.",
  "demo.failed": "That didn't work. Try again.",
  "demo.notBack": "Pako hasn't come back yet. Reload this page in a moment.",

  // ---------- the welcome (first visit on a computer) ----------
  "w.aria": "Welcome",
  "w.start.title": "How do you want to start?",
  "w.start.lead": "See Pako on a realistic week before you connect anything, or set it up with your own.",
  "w.start.demo": "Try with a demo week",
  "w.start.demoNote": "Invented people, mail and meetings. Nothing is sent.",
  "w.start.own": "Start with my own",
  "w.start.ownNote": "Your name first, then connect what you like.",
  "w.skip": "Skip",
  "w.close": "Close",
  "w.back": "Back",
  "w.next": "Continue",
  "w.done": "Done",
  "w.later": "Not now",
  "w.progress": "Step {n} of {total}",
  "w.name.title": "What should I call you?",
  "w.name.placeholder": "Your name",
  "w.name.lead": "Just so I can greet you. You can change it any time.",
  "w.try.title": "Nice to meet you, {name}. Try one:",
  "w.try.titlePlain": "Try one of these:",
  "w.try.lead": "It goes to the chat for real, and Pako answers.",
  "w.try.remind": "Remind me in 2 minutes to stretch my legs",
  "w.try.note": "Remember that my favourite coffee is a flat white",
  "w.try.web": "What are today's top news stories?",
  "w.try.you": "You",
  "w.try.thinking": "Pako is thinking… (the first answer takes a few seconds)",
  "w.try.waiting": "Your message is waiting: the chat says why.",
  "w.try.sent": "Sent",
  "w.phone.title": "Take Pako on your phone",
  "w.phone.lead": "With Telegram you can write to it from anywhere, and it tells you things there. It takes two minutes.",
  "w.doneToast": "All set! Pako is waiting in the chat.",
  "w.saveFailed": "Couldn't save it: try again",
};

/**
 * The same keys as WORDS, for a panel that has the chat in it (a person's computer): there is no WhatsApp there, and the panel also keeps
 * the person's own choices. Only the keys that differ are here.
 */
export const CHAT_WORDS = {
  "rem.empty": "No reminders. Ask Pako for one in the chat.",
  "book.hint": "ask for them in the chat",
  "sys.hint": "In the chat, ask in your own words (“what do I have today?”); **HELP** shows shortcuts; **STOP** stops it and **RESUME** starts it again.",
  "foot.private": "Private panel · just for you",
};
