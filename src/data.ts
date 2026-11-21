// Your data, on a person's computer (local mode): what Pako keeps and where, what leaves the computer and to whom, an export of all of it,
// and a way to delete it all. The routes are in src/data-panel.ts, the panel's card in src/panel/privacy.js, the long form in docs/privacy.md.
//
// Everything here is read from the code, not written as a promise: DATA_KEYS is every key the modules keep in the store (test/data.test.ts
// reads the sources and fails when a module starts keeping a key that is not listed here), with how long the module keeps it.
//
// The export holds every key decoded, the choices in config.json and the names (never the values) of the connections. Secrets never go in it:
// Pako's own tokens, the connections' keys, Zoho's access, a Telegram pairing code, the one-time codes found in the mail. As a last guard every
// text in it is searched for the secret values this computer holds, and each one found is replaced.
//
// Deleting everything pauses first (nothing goes out while the store is emptied), empties the store and the chat, unpairs Telegram, forgets the
// choices and the connections set in the panel, leaves one line in the log and starts Pako again, which reads the empty files. What stays
// is said: the three secrets the server needs to run, ~/.pako/.env (the person's own file, which Pako never writes) and Claude Code's history.
// The background Pako's logs (~/.pako/logs) are emptied; autostart (a file, src/autostart.ts) stays as the person set it.

import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { autostartFile } from "./autostart.ts";
import { KEYS as CONNECTION_KEYS } from "./connections.ts";
import type { Control } from "./control.ts";
import { texts, type Lang } from "./i18n.ts";
import { icsHosts, loadIcsConfig } from "./ics.ts";
import type { Kv } from "./kv.ts";
import type { FileKv } from "./local.ts";
import { readSecrets, secretsWhere, writeSecrets } from "./secrets.ts";
import { createLog } from "./log.ts";

const log = createLog("data");

type Env = Record<string, string | undefined>;

/** The store as this module needs it: the file store at home lists its keys and can be emptied; a plain one can only be read key by key. */
export type DataStore = Kv & Partial<Pick<FileKv, "entries" | "wipe">>;

const DAY = 24 * 3600;

export interface KeyFact {
  /** The key, or for `prefix` the start of a family of keys (one per call, one per Telegram file). */
  key: string;
  prefix?: true;
  /** How long its module keeps it after the last change, in seconds (each module's own constant, copied here: see the module). */
  keep: number;
  /** "whole": a secret, never exported; "codes": exported without the one-time codes in it; "chat": without the messages marked secret. */
  secret?: "whole" | "codes" | "chat";
}

/** Every key Pako keeps in its store, from the modules that write them (src/<module>.ts named in each line). */
const KEY_LIST = [
  { key: "pako-local-chat", keep: 90 * DAY, secret: "chat" }, // local.ts CHAT_KEY
  { key: "owner-memory", keep: 365 * DAY }, // voice-memory.ts
  { key: "assistant-reminders", keep: 400 * DAY }, // whatsapp.ts
  { key: "assistant-reminders-fired", keep: 7 * DAY },
  { key: "assistant-lists", keep: 400 * DAY }, // lists.ts
  { key: "assistant-people", keep: 400 * DAY }, // people.ts
  { key: "memory-facts", keep: 400 * DAY }, // memory-facts.ts
  { key: "people-identities", keep: 400 * DAY }, // people-graph.ts
  { key: "assistant-autonomy-held", keep: 2 * DAY }, // autonomy.ts
  { key: "assistant-autonomy-settings", keep: 5 * 365 * DAY },
  { key: "assistant-routines", keep: 400 * DAY }, // routines.ts
  { key: "assistant-routine-run:", prefix: true, keep: 8 * DAY },
  { key: "assistant-undo", keep: 7 * DAY }, // undo.ts
  { key: "assistant-log", keep: 90 * DAY }, // control.ts
  { key: "assistant-paused", keep: 365 * DAY },
  { key: "assistant-paused-why", keep: 365 * DAY },
  { key: "assistant-inbox", keep: 2 * DAY }, // whatsapp.ts
  { key: "assistant-held-notices", keep: 7 * DAY },
  { key: "assistant-last-owner-at", keep: 3 * DAY },
  { key: "assistant-last-channel", keep: 365 * DAY },
  { key: "owner-language", keep: 365 * DAY },
  { key: "whatsapp-owner-bsuid", keep: 365 * DAY },
  { key: "assistant-mail", keep: 60 * DAY }, // mail.ts
  { key: "assistant-mail-body:", prefix: true, keep: 60 * DAY },
  { key: "mail-prefs", keep: 5 * 365 * DAY },
  { key: "assistant-mail-codes", keep: 30 * 60, secret: "codes" }, // codes.ts
  { key: "assistant-imap", keep: 60 * DAY }, // imap.ts
  { key: "mail-invites", keep: 60 * DAY }, // invites.ts
  { key: "mail-backfill", keep: 30 * DAY }, // backfill.ts
  { key: "slack-alerts", keep: 14 * DAY }, // slack.ts
  { key: "slack-held", keep: 2 * DAY },
  { key: "slack-poll", keep: 60 * DAY }, // slack-poll.ts
  { key: "teams-poll", keep: 60 * DAY }, // teams.ts
  { key: "imessage-poll", keep: 60 * DAY }, // imessage.ts
  { key: "apple-mail-poll", keep: 60 * DAY }, // apple-mail.ts
  { key: "zoom-state", keep: 60 * DAY }, // zoom.ts
  { key: "followups", keep: 60 * DAY }, // followups.ts
  { key: "lessons", keep: 400 * DAY }, // lessons.ts
  { key: "meeting-reviews", keep: 30 * DAY }, // meeting-review.ts
  { key: "zoho-refresh", keep: 3650 * DAY, secret: "whole" }, // calendar.ts
  { key: "calendar-state", keep: 30 * DAY },
  { key: "calendar-changes", keep: 30 * DAY }, // calendar-changes.ts
  { key: "meeting-prep", keep: 8 * DAY }, // meeting-prep.ts
  { key: "brief-state", keep: 30 * DAY }, // brief.ts
  { key: "brief-v2", keep: 7 * DAY }, // brief-v2.ts
  { key: "feedback", keep: 90 * DAY }, // quality.ts
  { key: "life", keep: 400 * DAY }, // proactive.ts
  { key: "life-health", keep: 400 * DAY },
  { key: "rehearsal", keep: 7 * DAY }, // rehearsal.ts
  { key: "telegram-owner", keep: 5 * 365 * DAY }, // telegram.ts
  { key: "telegram-pair", keep: 10 * 60, secret: "whole" },
  { key: "telegram-off", keep: 5 * 365 * DAY },
  { key: "mobile-access", keep: 3650 * DAY, secret: "whole" }, // mobile-access.ts (phone access: on or off, the paired phones' token hashes)
  { key: "telegram-file:", prefix: true, keep: 2 * DAY },
  { key: "whatsapp-computer-last-owner", keep: 3 * DAY }, // whatsapp-computer.ts
  { key: "pako-bookings", keep: 120 * DAY }, // booking.ts
  { key: "pako-booking-sent", keep: 2 * DAY },
  { key: "maitre-ledger", keep: 400 * DAY }, // maitre/ledger.ts
  { key: "maitre-passports", keep: 400 * DAY }, // maitre/planner.ts
  { key: "voice-result:", prefix: true, keep: 30 * DAY }, // voice-bridge.ts
  { key: "pako-store-id", keep: 3650 * DAY }, // store-guard.ts
  { key: "pako-store-era", keep: 3650 * DAY },
  { key: "watchdog", keep: 30 * DAY }, // watchdog.ts
  { key: "claude-keeper", keep: 400 * DAY }, // claude-connect.ts
  { key: "discovery", keep: 3650 * DAY }, // discovery.ts
  { key: "calendar-local", keep: 30 * DAY }, // calendar-local.ts
  { key: "calendar-writes", keep: 8 * DAY }, // calendar-writes.ts
  { key: "reminders-mirror", keep: 400 * DAY }, // reminders-local.ts
  { key: "time-to-do", keep: 15 * DAY }, // time-to-do.ts
  { key: "relay-state", keep: 31 * DAY }, // relay.ts (only on a host running as the relay)
  { key: "assistant-contacts", keep: 400 * DAY }, // contacts.ts
  { key: "people-hidden", keep: 400 * DAY }, // people-directory.ts
  { key: "zoom-local", keep: 60 * DAY }, // zoom-local.ts
  { key: "health", keep: 365 * DAY }, // health.ts
  { key: "learning", keep: 400 * DAY }, // learning.ts
  { key: "friend", keep: 400 * DAY }, // friend.ts
  { key: "jobs", keep: 8 * DAY }, // jobs.ts
  { key: "job-claim:", prefix: true, keep: 10 * 60 },
  { key: "corrupt:", prefix: true, keep: 180 * DAY, secret: "whole" }, // json-record.ts (a damaged record, kept aside as it was)
  { key: "places-ok", keep: 400 * DAY }, // app.ts (table booking)
  { key: "demo-seeded", keep: 90 * DAY }, // demo.ts (only in ~/.pako/demo)
  { key: "demo-calendar", keep: 90 * DAY },
  { key: "gentle-settings", keep: 5 * 365 * DAY }, // gentle.ts
  { key: "gentle-steps", keep: 7 * DAY },
  { key: "gentle-anchors", keep: 200 * DAY },
  { key: "brain-dumps", keep: 2 * DAY }, // door/dump.ts
  { key: "gentle-checkins", keep: 10 * DAY }, // gentle-checkins.ts
  { key: "gentle-reset", keep: 120 * DAY }, // gentle-reset.ts
  { key: "beta-audit", keep: 400 * DAY }, // beta-audit.ts
] as const satisfies readonly KeyFact[];

export const DATA_KEYS: readonly KeyFact[] = KEY_LIST;

/** The keys as the compiler knows them: ABOUT below must say what each one is. */
type AboutKey = (typeof KEY_LIST)[number]["key"];

/** What each key holds, in the person's words. */
const ABOUT = texts<AboutKey | "unknown">(
  {
    "pako-local-chat": "The panel's chat: the last 300 messages",
    "owner-memory": "The notes about you (60 at most) and a summary of your last 8 calls",
    "assistant-reminders": "Your reminders, repeating ones too",
    "assistant-reminders-fired": "The reminders already sent (the last 40), so none is sent twice",
    "assistant-lists": "Your lists and tasks (done ones for 7 more days)",
    "assistant-people": "The people in your life you told me about (100 at most)",
    "memory-facts": "What I know, dated: since when each fact holds, when I learnt it, who said it and where, and what changed (a year of history)",
    "people-identities": "The people I've seen in Slack, the mail, the calendar and Zoom: their names, addresses and ids (never what they wrote), "
      + "when they last appeared, and the “same person?” questions",
    "assistant-autonomy-held": "The messages, emails and calls of the last 24 hours that waited a few seconds so you could undo them",
    "assistant-autonomy-settings": "What I do at once and what I ask you first (messages, emails, calls)",
    "assistant-routines": "Your routines and what I watch for you, and which emails and Slack alerts I already looked at for them",
    "assistant-routine-run:": "A routine or a heads-up already done, so none is done twice",
    "assistant-undo": "What UNDO can put back (the last 30 changes)",
    "assistant-log": "The activity log: one line per action (the last 300)",
    "assistant-paused": "Whether STOP is on, and since when",
    "assistant-paused-why": "Why the pause was set, when it wasn't you",
    "assistant-inbox": "Messages waiting for Claude's answer",
    "assistant-held-notices": "Notices kept to give you later",
    "assistant-last-owner-at": "When you last wrote",
    "assistant-last-channel": "Which chat you last wrote from",
    "owner-language": "The language you write in, as Pako heard it",
    "whatsapp-owner-bsuid": "Your WhatsApp user id (with WhatsApp only)",
    "assistant-mail": "Pako's inbox: a summary of the last 150 emails (with their To and Cc lines, list mark and thread hash) and the ids of the last 300 seen",
    "assistant-mail-codes": "One-time codes found in the mail (exported without the codes)",
    "assistant-mail-body:": "The words of one email (one-time codes hidden), for the panel's reader",
    "mail-prefs": "Your mail choices: the sender rules you taught with Move to…, and which categories notify you",
    "assistant-imap": "Your own mailbox (IMAP, read only): the account and, per folder, the last email already looked at (never the password)",
    "mail-backfill": "A new mailbox's catch-up: the emails of its last days waiting to be read, one a minute, and its progress",
    "mail-invites": "Invitations caught from your mail, shown on the dashboard until your calendar has them (title, time, organizer; never the mail)",
    "slack-alerts": "Slack messages it told you about (the last 100)",
    "slack-held": "Slack notices kept during quiet hours",
    "slack-poll": "Where Pako is in each Slack conversation it looks at (no message text)",
    "teams-poll": "Where Pako is in each Teams chat and channel it looks at, and the last read and error (no message text)",
    "apple-mail-poll": "Mail on this Mac: the last message already looked at (its number in Apple Mail's index), when it was turned on, the numbers "
      + "of messages Mail had not downloaded yet, and the last read and error (no message text, subject or address)",
    "imessage-poll": "Messages on this Mac: the last message already looked at (its number in Messages' history), when it was turned on, "
      + "and the last read and error (no message text, number or address)",
    "zoom-state": "Zoom meetings seen and the last 20 summaries",
    followups: "Open items Pako follows up (what you were asked or promised), the \"Not mine\" rules, today's reminders, and new emails waiting "
      + "a few minutes to be read for them (gone once read; the ids of those read, so none is read twice)",
    lessons: "What Pako learned from your corrections (60 at most), and its drafts of the last 3 days, to compare with what you sent",
    "meeting-reviews": "The last 40 Zoom meetings reviewed: their summary, your to-dos, what was promised and decided, the open questions",
    "zoho-refresh": "Access to Zoho Calendar (a secret: never exported)",
    "calendar-state": "Which meeting reminders were already sent",
    "calendar-changes": "Your next two weeks of meetings as last seen (title and time), and what was new, moved or gone in the last 3 days",
    "meeting-prep": "Which meetings already got their prep note (an id and a time per meeting, a week)",
    "brief-state": "The day the last daily brief was sent",
    "brief-v2": "Today's written brief (with the facts it comes from) and what you asked from its page",
    feedback: "Your 👍/👎 on the reminders and the brief (what, your answer, when, where from) and what you pressed on each reminder",
    life: "What Pako learnt of your tastes, plans, hobbies and goals, the topics you let it suggest about, and its suggestions of the last month",
    "life-health": "What you told it about your health and mood (apart, on this computer only; \"forget my health data\" deletes it)",
    rehearsal: "The last rehearsal: what Pako would have told you from the last 48 h, and the trial brief's facts",
    "telegram-owner": "The Telegram account paired with Pako",
    "telegram-pair": "A pairing code in use (a secret: never exported)",
    "telegram-off": "You wrote TELEGRAM OFF: Telegram stays unpaired",
    "mobile-access": "Whether Pako is on your phone (same Wi-Fi), and the phones paired: their names, when last seen, a hash of each one's key",
    "telegram-file:": "Where to fetch a voice note or photo you sent by Telegram",
    "whatsapp-computer-last-owner": "When you last wrote to Pako on WhatsApp (WhatsApp's 24 hours)",
    "pako-bookings": "The tables Pako asked a restaurant for",
    "pako-booking-sent": "Booking emails already sent, so none is sent twice",
    "maitre-ledger": "The bookings Pako made on a restaurant's website: state, proof and cancel link, so nothing is booked twice",
    "maitre-passports": "What Pako remembers about each restaurant it booked: its booking system, its page and how long it took",
    "voice-result:": "The result of a phone call (what was said and its summary)",
    "pako-store-id": "A random number that tells Pako its store wasn't emptied",
    "pako-store-era": "The same, for when two copies of Pako share one store",
    watchdog: "Which part of Pako is failing now and since when, and whether I told you",
    "claude-keeper": "Whether Claude has worked here and whether I already asked you to sign in again (never your address or a key)",
    discovery: "What Pako found on this Mac when you let it look: apps, calendar names, mail addresses, how many contacts",
    "calendar-local": "The events of the calendars on this Mac you picked (title, times, place and video-call link), 2 days back and 14 ahead",
    "calendar-writes": "The calendar changes you said yes to (move, add, delete: title and times), and what was there before, for Undo (a week)",
    "reminders-mirror": "Apple Reminders: whether it is on, \"waiting on\" too, and per follow-up its reminder's id and the title and time both sides last agreed on",
    "time-to-do": "Time to do it: the focus blocks offered (which follow-up, the proposed time, and whether you blocked it, asked for "
      + "another or said not needed; the last 100) and today's count of those cards",
    "relay-state": "On a host running as your relay only: your reminders of the week ahead (text and time) and which it sent (30 days)",
    "assistant-contacts": "The contacts you imported from this Mac: name, emails, phones and company (5000 at most)",
    "people-hidden": "The people you hid from the People list: only their addresses, numbers or ids, so they stay hidden (2000 at most)",
    "zoom-local": "Which Zoom recordings on this Mac were already reviewed (only a fingerprint of their folder)",
    health: "Your health diary and the medication you told me: on this computer only, never sent to anyone (FORGET MY HEALTH deletes it)",
    learning: "What you're learning: your goals, the review cards and when each one is due",
    friend: "Whether the weekly check-in is on, when it last went, and which birthdays I already mentioned the day before",
    jobs: "What was due at a time (the brief, each reminder sent) and whether it was done, so nothing is done twice or lost while the computer sleeps",
    "job-claim:": "A mark while something scheduled is being done, so it is not done twice at once (10 minutes at most)",
    "corrupt:": "A copy of one of the records above that was damaged and could not be read, kept aside as it was instead of being overwritten",
    "places-ok": "That your Google Places key has worked once (a fingerprint of the key, never the key)",
    "demo-seeded": "When the demo week was set up (only in the demo's own folder, ~/.pako/demo)",
    "demo-calendar": "The demo week's invented calendar (only in the demo's own folder, ~/.pako/demo)",
    "gentle-settings": "Gentle mode: whether it is on, its nudges a day and how long before a meeting it reminds you",
    "gentle-steps": "Gentle mode: the first tiny steps asked today, and for which follow-ups (the steps themselves stay with the follow-up)",
    "gentle-anchors": "Gentle mode: the meeting reminders already sent, and how long your past meetings took (by the words of their titles), "
      + "for “this usually takes you about”",
    "brain-dumps": "Your last brain dumps (10 at most): each item as it was sorted, and what it changed, so one can be removed or all undone",
    "gentle-checkins": "Your check-ins (“check on me at 10:30”): what each is about, its time, how many “Not yet” it had and how it ended, "
      + "and today's count (shared with the day's nudges)",
    "gentle-reset": "Gentle mode's weekly reset: the items each reset listed (by their follow-up), this week's focus, the parked items asked "
      + "“bring back or let go?”, and what was let go after a month (title, person, dates)",
    "beta-audit": "The beta's weekly check, only if you opted in: the conversations read in the last 8 days (where, who, their first two lines), "
      + "the week's questions, and your Yes/No answers (kept a year, as counts)",
    unknown: "A key this version of Pako doesn't know",
  },
);

const T = texts(
  {
    minutes: "{n} minutes",
    hours: "{n} hours",
    day: "1 day",
    days: "{n} days",
    year: "1 year",
    years: "{n} years",
    keptFor: "{span} after the last change",
    secret: "[secret: not exported]",
    hidden: "[hidden]",
    logLine: "Everything deleted from the panel: notes, reminders, lists, chat, log, Telegram and connections",
    keptSecrets: "{where} keeps the three secrets Pako needs to run (the bridge's to Claude, the phone line's and the one that "
      + "signs your panel session): they say nothing about you.",
    keptEnv: "~/.pako/.env is left alone: it's your file, Pako never writes it. If you put keys there, delete them yourself.",
    keptClaude: "Claude Code keeps its own history of the conversations in {path}: it belongs to Claude Code, and Pako doesn't delete it.",
    keptShell: "Settings given in the terminal or in ./.env still apply.",
    keptAutostart: "Autostart stays as you set it ({path}); turn it off in the \"Start with this computer\" card.",
    restart: "To finish, stop Pako (Ctrl+C) and start it again: until then it keeps nothing new.",
    "file.config": "What you choose in the panel: your name, whether you saw the welcome",
    "file.secrets": "Pako's secrets and the connections set in the panel (only you can read it: mode 600)",
    "file.secretsMarker": "Only a marker: Pako's secrets and the connections set in the panel are in {where}, not in this file",
    "where.file": "~/.pako/secrets.json",
    "where.keychain": "the macOS keychain (service Pako)",
    "where.wincred": "the Windows Credential Manager",
    "where.libsecret": "your desktop's secret store (libsecret)",
    "file.env": "Your own settings and keys, if you wrote any (Pako never writes this file)",
    "file.kv": "The store: everything in the list below",
    "file.made": "A mark: this store existed, so if it goes missing Pako starts paused and says so",
    "file.bad": "A copy of a damaged store, if there ever was one",
    "file.migrated": "The earlier store (a JSON file), only if its copy into kv.db did not check out",
    "file.lock": "That Pako is running (its process number and port)",
    "file.state": "The conversation in progress with Claude (its id)",
    "file.claude": "Claude Code's history of those conversations (kept by Claude Code, not Pako)",
    "file.logs": "What Pako writes when it starts by itself or from the Mac app (its notices and errors, which may quote a message); deleting everything empties them",
    "file.papers": "The photos and PDFs you send Pako to read (30 days at most); deleting everything deletes them",
    "file.autostart": "Autostart: a file, not something in the store (deleting everything leaves it alone)",
    "out.claude": "What you write, what Pako needs to answer (notes, reminders, agenda, summaries you ask for) and voice notes already turned into "
      + "text. Through the claude command and your Claude plan; or with ANTHROPIC_API_KEY, paid by use.",
    "out.telegram": "Messages between Pako and your phone, and the voice notes and photos you send it.",
    "out.whatsapp": "Messages between Pako and your WhatsApp. From a computer they come through the Cloudflare tunnel you turn on in the WhatsApp card.",
    "out.mail": "Pako reads the inbox you gave it; it sends the booking emails you approve from it.",
    "out.resend": "The emails you approve, sent from your own domain: the recipient, the subject and the text. Resend never reads your mail.",
    "out.imap": "Your mail user name and password, to log in (TLS only). Pako only reads: it never marks, moves, deletes or sends anything.",
    "out.places": "Restaurant searches (what, where, when). None of your notes.",
    "out.slack": "What you search for in your Slack; Pako only reads.",
    "out.zoom": "Pako asks for your meetings and their summaries; it only reads.",
    "out.ics": "Pako fetches your calendar by its private link; it sends nothing of yours.",
    "out.zoho": "Pako reads your Zoho calendar; it doesn't write to it.",
    "out.phone": "On calls: your voice and the other person's, the numbers and what Pako should say, through their voice services.",
    connectedOn: "Connected",
    connectedOff: "Not connected",
    "never.files": "The files in ~/.pako as files: nothing uploads them anywhere.",
    "never.secrets": "The keys: each goes only to its own service, and Pako's own secrets to none.",
    "never.panel": "The panel: it opens from this computer only (unless PAKO_HOST says otherwise).",
    "never.reports": "Pako sends no statistics, usage or error reports to anyone.",
    "never.voice": "The audio of your voice notes: it's turned into text on this computer (when the bridge has whisper).",
    "how.export": "Export: a JSON file with everything above, without any secret.",
    "how.delete": "Delete everything: type DELETE EVERYTHING and press the button. Pako stops, empties it all, unpairs Telegram, forgets the "
      + "panel's connections and starts again as on the first day.",
  },
);

/** The phrase that confirms deleting everything. */
export const CONFIRM = "DELETE EVERYTHING";

/** Whether a typed confirmation is the phrase: spaces around and between the words, and capitals, do not count. */
export const confirmed = (typed: unknown): boolean => {
  if (typeof typed !== "string") return false;
  const v = typed.trim().replace(/\s+/g, " ").toUpperCase();
  return v === CONFIRM;
};

/** What a key holds, in the person's words (the export's own line for it). */
export const aboutKey = (key: string, l: Lang): string => ABOUT(l)((factFor(key)?.key ?? "unknown") as AboutKey);

/** The fact for a key: its own line, or its family's (prefix). */
export const factFor = (key: string): KeyFact | undefined =>
  DATA_KEYS.find((f) => (f.prefix ? key.startsWith(f.key) : key === f.key));

/** A time span as a person says it: minutes, hours, days, or years when it is a whole number of them. */
export function span(seconds: number, l: Lang): string {
  const t = T(l);
  if (seconds % (365 * DAY) === 0) {
    const n = seconds / (365 * DAY);
    return n === 1 ? t("year") : t("years", { n });
  }
  if (seconds >= DAY) {
    const n = Math.round(seconds / DAY);
    return n === 1 ? t("day") : t("days", { n });
  }
  if (seconds >= 3600) return t("hours", { n: Math.round(seconds / 3600) });
  return t("minutes", { n: Math.round(seconds / 60) });
}

// ---------- files ----------

function readObject(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    /* missing or not JSON: nothing */
    return null;
  }
}

/** Written whole to a new file and renamed over the old one, readable only by this user (as src/local.ts writes its files). */
function writeObject(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* a file system without modes */
  }
}

/** The secrets Pako needs to run (src/local.ts loadHome): the only things delete-all leaves in secrets.json. */
const RUN_SECRETS = ["bridgeToken", "callerToken", "panelSecret"] as const;

/** Settings whose value is a secret, by their name: a token, a key, a password, or an address that carries one (an ICS link, a store URL). */
const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|_URL$/;

/** The folder the claude command runs from (src/local.ts localEnv sets it in ~/.pako), and where Claude Code keeps its history of it. */
const stateDir = (dir: string, env: Env): string => (env.ASSISTANT_STATE_DIR ?? "").trim() || join(dir, "assistant");
/** Claude Code names a project's history folder after its path, with every character but letters and digits made a dash. */
const claudeHistory = (dir: string, env: Env): string =>
  join(homedir(), ".claude", "projects", stateDir(dir, env).replace(/[^A-Za-z0-9]/g, "-"));

/** Every secret value this computer holds for Pako (at least 8 characters: a short one could match ordinary words). */
function secretValues(dir: string, env: Env): string[] {
  const found = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === "string" && v.trim().length >= 8) found.add(v.trim());
  };
  const secrets = readSecrets(dir) ?? {};
  for (const [k, v] of Object.entries(secrets)) {
    if (k === "settings") continue;
    add(v);
    // A connection kept as one object (whatsappComputer: Meta's app secret, access token, webhook token, set up in the panel): its secret
    // fields by their names, in any case (appSecret, accessToken). Defence in depth: the store should never hold them anyway.
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [f, x] of Object.entries(v as Record<string, unknown>)) if (SECRET_NAME.test(f.toUpperCase())) add(x);
    }
  }
  const settings = secrets.settings;
  if (settings && typeof settings === "object" && !Array.isArray(settings)) {
    for (const [k, v] of Object.entries(settings as Record<string, unknown>)) if (SECRET_NAME.test(k)) add(v);
  }
  for (const [k, v] of Object.entries(env)) if (SECRET_NAME.test(k)) add(v);
  // The longest first: one secret that contains another is replaced whole.
  return [...found].sort((a, b) => b.length - a.length);
}

/** A copy of `v` with every secret value in its texts replaced. */
function scrub(v: unknown, secrets: string[], mark: string): unknown {
  if (typeof v === "string") return secrets.reduce((s, x) => (s.includes(x) ? s.split(x).join(mark) : s), v);
  if (Array.isArray(v)) return v.map((x) => scrub(x, secrets, mark));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, secrets, mark)]));
  return v;
}

const decode = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    /* not JSON: kept as the text it is */
    return raw;
  }
};

/** A key's value as it may leave in the export: a secret as a mark, the mail's one-time codes hidden. */
function exportable(fact: KeyFact | undefined, raw: string, l: Lang): unknown {
  const t = T(l);
  if (fact?.secret === "whole") return t("secret");
  const v = decode(raw);
  if (fact?.secret === "codes" && Array.isArray(v)) {
    return v.map((x: unknown) =>
      x && typeof x === "object" && Array.isArray((x as { codes?: unknown }).codes)
        ? { ...(x as object), codes: (x as { codes: unknown[] }).codes.map(() => t("hidden")) }
        : x);
  }
  // The chat's copy of CODE's answer (src/whatsapp.ts) holds the codes: marked secret since this version, and found by its 🔑 lines before.
  if (fact?.secret === "chat" && Array.isArray(v)) {
    return v.map((x: unknown) => {
      if (!x || typeof x !== "object" || typeof (x as { text?: unknown }).text !== "string") return x;
      const m = x as { text: string; secret?: unknown; who?: unknown };
      if (m.secret === true) return { ...m, text: t("hidden") };
      if (m.who !== "pako" || !m.text.includes("🔑")) return x;
      return { ...m, text: m.text.split("\n").map((l) => (l.startsWith("🔑") ? l.replace(/\): .*$/, `): ${t("hidden")}`) : l)).join("\n") };
    });
  }
  return v;
}

/** The store's keys with their values: all of them from the file store; from another, the fixed keys only (a family cannot be listed). */
async function storeEntries(store: DataStore): Promise<{ key: string; value: string; expires: number | null }[]> {
  if (store.entries) return store.entries();
  const out: { key: string; value: string; expires: number | null }[] = [];
  for (const f of DATA_KEYS) {
    if (f.prefix) continue;
    const value = await store.get(f.key);
    if (value !== null) out.push({ key: f.key, value, expires: null });
  }
  return out;
}

export interface ExportDeps {
  store: DataStore;
  /** Pako's folder (~/.pako). */
  dir: string;
  env: Env;
  lang: Lang;
  now?: number;
  /**
   * A server's export (src/move.ts, for moving to a computer): there is no Pako folder, so no folder, files or choices; instead the server's
   * own settings that are not secrets (its owner's name, time zone, brief time...), for the computer to take over.
   */
  server?: { ownerName: string; timeZone: string; settings: Record<string, string> };
}

/** Everything Pako keeps about the person, as one JSON object, with no secret in it. */
export async function exportData(d: ExportDeps): Promise<Record<string, unknown>> {
  const l = d.lang;
  const at = d.now ?? Date.now();
  const store: Record<string, unknown> = {};
  for (const e of await storeEntries(d.store)) {
    const fact = factFor(e.key);
    store[e.key] = {
      what: ABOUT(l)((fact?.key ?? "unknown") as AboutKey),
      expires: e.expires === null ? null : new Date(e.expires).toISOString(),
      value: exportable(fact, e.value, l),
    };
  }
  const secrets = readSecrets(d.dir) ?? {};
  const panelSet = secrets.settings && typeof secrets.settings === "object" && !Array.isArray(secrets.settings)
    ? Object.keys(secrets.settings as object).filter((k) => CONNECTION_KEYS.has(k)).sort()
    : [];
  let files: string[] = [];
  try {
    files = readdirSync(d.dir).filter((f) => !f.endsWith(".tmp")).sort();
  } catch {
    /* no folder: nothing to list */
  }
  const out = {
    format: "pako-export",
    version: 1,
    exportedAt: new Date(at).toISOString(),
    ...(d.server ? { from: "server", server: d.server } : { from: "computer" }),
    folder: d.server ? null : d.dir,
    files: d.server ? [] : files,
    // The choices made in the panel, as config.json keeps them (it holds no secret; the scrub below runs over it anyway).
    settings: d.server ? {} : readObject(join(d.dir, "config.json")) ?? {},
    // Names only: what is connected, never with what.
    connections: {
      setInThePanel: panelSet,
      setOutside: [...CONNECTION_KEYS].filter((k) => (d.env[k] ?? "").trim() && !panelSet.includes(k)).sort(),
      telegramBotSetInThePanel: typeof secrets.telegramBotToken === "string" && secrets.telegramBotToken.trim() !== "",
    },
    store,
  };
  return scrub(out, secretValues(d.dir, d.env), T(l)("secret")) as Record<string, unknown>;
}

// ---------- delete everything ----------

export interface DeleteDeps {
  store: DataStore;
  dir: string;
  env: Env;
  control: Control;
  lang: Lang;
  /** The chat window's conversation in memory (src/local.ts createLocalChannel). */
  chat?: { forget: () => void };
  now?: number;
}

export type DeleteResult =
  /** `stored` false: the store's file still holds everything (neither written emptied nor removed); Pako must not start again onto it. */
  | { ok: true; stored: boolean; removed: string[]; kept: string[] }
  | { ok: false; why: "no-wipe" };

/**
 * Deletes everything Pako keeps about the person, except what the server needs to run. The caller starts Pako again afterwards (the
 * modules keep copies in memory, and the store takes no more writes until then).
 */
export async function deleteEverything(d: DeleteDeps): Promise<DeleteResult> {
  const wipe = d.store.wipe;
  if (!wipe) return { ok: false, why: "no-wipe" };
  const t = T(d.lang);
  const at = d.now ?? Date.now();
  // First the pause: nothing goes out (a reminder, a call) while things are being emptied, and nothing that comes in is acted on halfway.
  await d.control.setPaused(true, at);
  // The store keeps one line: the log of the fresh start says what happened. The log's own shape (src/control.ts LogLine).
  const logKeep = factFor("assistant-log")!.keep;
  const stored = wipe([{ key: "assistant-log", value: JSON.stringify([{ at, kind: "datos", text: t("logLine") }]), ttlSeconds: logKeep }]);
  d.chat?.forget();
  const removed: string[] = ["kv.db"];

  // The secrets: only the three the server runs with. The Telegram bot (unpaired with it) and the connections set in the panel go, from
  // the file or from the system's store (src/secrets.ts removes their entries there). Secrets that cannot be read are left as they are:
  // written blind, they would lose those three too (and sign every browser out).
  const secrets = readSecrets(d.dir);
  if (secrets) {
    const keep = Object.fromEntries(RUN_SECRETS.filter((k) => typeof secrets[k] === "string").map((k) => [k, secrets[k]]));
    if (Object.keys(secrets).some((k) => !Object.hasOwn(keep, k))) {
      try {
        writeSecrets(d.dir, keep);
        removed.push(secretsWhere(d.dir) === "file" ? "secrets.json (Telegram, connections)" : `${secretsWhere(d.dir)} (Telegram, connections)`);
      } catch (err) {
        log.error(`could not rewrite the secrets (${(err as NodeJS.ErrnoException).code ?? "error"})`);
      }
    }
  }
  // config.json: no choice left, as on the very first start.
  try {
    writeObject(join(d.dir, "config.json"), {});
    removed.push("config.json");
  } catch (err) {
    log.error(`could not rewrite config.json (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
  // What else holds the person's things: a damaged store kept aside, the conversation with Claude, a voice note being turned into text.
  const gone = (path: string, name: string): void => {
    if (!existsSync(path)) return;
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch (err) {
      log.error(`could not delete ${path} (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
  };
  for (const f of ["kv.db.bad", "kv.json.bad", "kv.json.migrated", "kv.json"]) gone(join(d.dir, f), f);
  gone(join(d.dir, "papers"), "papers"); // the photos and PDFs sent to be read (src/papers.ts)
  // Maître's confirmation screenshots and its browser profile (the owner's sign-ins to booking sites): the person's things too.
  gone(join(d.dir, "maitre"), "maitre");
  gone(join(d.dir, "browser"), "browser");
  // The copies an import kept of what it replaced (src/move.ts): the person's things too.
  try {
    for (const f of readdirSync(d.dir)) if (/^import-backup-.*\.json$/.test(f)) gone(join(d.dir, f), f);
  } catch {
    /* no folder */
  }
  const state = stateDir(d.dir, d.env);
  gone(join(state, "state.json"), "assistant/state.json");
  // The bridge's copy of the last turn for Pako's read tools (the message, the notes, reminders, lists and calendar), and the lines of
  // other people's text it has seen (by a hash).
  for (const f of ["tool-data.json", "tool-data.json.tmp", "outside-seen.json", "handled-unacked.json", "handled-unacked.json.tmp"]) gone(join(state, f), `assistant/${f}`);
  try {
    for (const f of readdirSync(state)) if (f.startsWith("voice-")) gone(join(state, f), `assistant/${f}`);
  } catch {
    /* no such folder */
  }
  // The background Pako's logs (src/autostart.ts) and the Mac app's (app.log, this very server's output when the app started it): emptied,
  // not removed, since launchd, systemd, Windows or the app may hold them open; the old and rotated ones go (app.log.1 to .3, desktop/mac).
  const logs = join(d.dir, "logs");
  for (let i = 1; i <= 3; i++) gone(join(logs, `app.log.${i}`), `logs/app.log.${i}`);
  for (const name of ["pako.log", "pako.err.log", "app.log"]) {
    const path = join(logs, name);
    if (!existsSync(path)) continue;
    try {
      truncateSync(path, 0);
      removed.push(`logs/${name}`);
    } catch (err) {
      log.error(`could not empty ${path} (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
    gone(`${path}.old`, `logs/${name}.old`);
  }
  // The log line in the store already says it; the terminal says it too (the only place left that a person might look at meanwhile).
  log.info(`everything deleted from the panel: ${removed.join(", ")}`);
  const autostartAt = autostartFile(process.platform, homedir(), d.dir);
  return {
    ok: true,
    stored,
    removed,
    kept: [
      t("keptSecrets", { where: t(`where.${secretsWhere(d.dir)}`) }), t("keptEnv"), t("keptShell"), t("keptClaude", { path: claudeHistory(d.dir, d.env) }),
      ...(autostartAt && existsSync(autostartAt) ? [t("keptAutostart", { path: autostartAt })] : []),
    ],
  };
}

/** What the answer adds when Pako cannot start again by itself. */
export const restartLine = (l: Lang): string => T(l)("restart");

// ---------- the privacy page ----------

export interface Privacy {
  folder: string;
  files: { name: string; what: string; there: boolean }[];
  keys: { key: string; what: string; kept: string; family: boolean }[];
  sends: { name: string; what: string; on: boolean; detail: string }[];
  never: string[];
  how: string[];
  /** The phrase to type; `phrases`: every one the server takes (just that one). */
  confirm: string;
  phrases: string[];
}

/** The facts the panel's Privacy card shows: from the code and from what this computer has set now. */
export function privacy(o: { dir: string; env: Env; lang: Lang }): Privacy {
  const t = T(o.lang);
  const about = ABOUT(o.lang);
  const set = (k: string): boolean => (o.env[k] ?? "").trim() !== "";
  const secrets = readSecrets(o.dir) ?? {};
  const tgPanel = typeof secrets.telegramBotToken === "string" && secrets.telegramBotToken.trim() !== "";
  const ics = loadIcsConfig(o.env).config;
  const state = stateDir(o.dir, o.env);
  const autostartAt = autostartFile(process.platform, homedir(), o.dir);
  const file = (name: string, path: string, key: Parameters<typeof t>[0]) => ({ name, what: t(key), there: existsSync(path) });
  const on = (b: boolean): string => t(b ? "connectedOn" : "connectedOff");
  const service = (name: string, key: Parameters<typeof t>[0], isOn: boolean, detail = "") => ({ name, what: t(key), on: isOn, detail: detail || on(isOn) });
  return {
    folder: o.dir,
    files: [
      file("config.json", join(o.dir, "config.json"), "file.config"),
      secretsWhere(o.dir) === "file"
        ? file("secrets.json", join(o.dir, "secrets.json"), "file.secrets")
        : { name: "secrets.json", what: t("file.secretsMarker", { where: t(`where.${secretsWhere(o.dir)}`) }), there: true },
      file(".env", join(o.dir, ".env"), "file.env"),
      file("kv.db", join(o.dir, "kv.db"), "file.kv"),
      file("kv.db.made", join(o.dir, "kv.db.made"), "file.made"),
      file("kv.db.bad", join(o.dir, "kv.db.bad"), "file.bad"),
      file("kv.json.migrated", join(o.dir, "kv.json.migrated"), "file.migrated"),
      file(".lock", join(o.dir, ".lock"), "file.lock"),
      file(join(state, "state.json"), join(state, "state.json"), "file.state"),
      file(claudeHistory(o.dir, o.env), claudeHistory(o.dir, o.env), "file.claude"),
      file(join(o.dir, "logs"), join(o.dir, "logs"), "file.logs"),
      file("papers", join(o.dir, "papers"), "file.papers"),
      ...(autostartAt ? [file(autostartAt, autostartAt, "file.autostart")] : []),
    ],
    keys: DATA_KEYS.map((f) => ({
      key: f.prefix ? `${f.key}…` : f.key,
      what: about(f.key as AboutKey),
      kept: t("keptFor", { span: span(f.keep, o.lang) }),
      family: !!f.prefix,
    })),
    sends: [
      service("Anthropic (Claude)", "out.claude", true, set("ANTHROPIC_API_KEY") ? "ANTHROPIC_API_KEY" : "claude"),
      service("Telegram", "out.telegram", set("TELEGRAM_BOT_TOKEN") || tgPanel),
      service("Meta (WhatsApp)", "out.whatsapp", set("WHATSAPP_ACCESS_TOKEN") || !!secrets.whatsappComputer),
      service("AgentMail", "out.mail", set("AGENTMAIL_API_KEY")),
      service("Resend", "out.resend", set("RESEND_API_KEY"), set("RESEND_FROM") ? (o.env.RESEND_FROM ?? "").trim().slice(0, 100) : ""),
      service("IMAP", "out.imap", set("IMAP_HOST") && set("IMAP_USER"), set("IMAP_HOST") ? (o.env.IMAP_HOST ?? "").trim().slice(0, 100) : ""),
      service("Google Places", "out.places", set("GOOGLE_PLACES_API_KEY")),
      service("Slack", "out.slack", set("SLACK_USER_TOKEN")),
      service("Zoom", "out.zoom", set("ZOOM_CLIENT_ID")),
      service("ICS", "out.ics", !!ics, ics ? icsHosts(ics.urls).join(", ") : ""),
      service("Zoho Calendar", "out.zoho", set("ZOHO_CLIENT_ID")),
      service("LiveKit / Retell", "out.phone", set("LIVEKIT_URL") || set("RETELL_API_KEY")),
    ],
    never: [t("never.files"), t("never.secrets"), t("never.panel"), t("never.reports"), t("never.voice")],
    how: [t("how.export"), t("how.delete")],
    confirm: CONFIRM,
    phrases: [CONFIRM],
  };
}
