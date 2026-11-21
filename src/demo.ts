// The demo week: Pako with a realistic invented week, to try before connecting anything.
//
// - How it starts: the panel's welcome ("Try with a demo week"), the Settings page, the Mac app's Connect window, PAKO_DEMO=1 or `npm start --
//   --demo`. Each makes the folder ~/.pako/demo with its mark (demo.json) and restarts Pako; src/server.ts then runs on that folder: its own
//   store (kv.db), its own name and welcome, its own Claude Code state. The real folder's notes, chat, mail and secrets are never read or written,
//   only its three run secrets (so the browser stays signed in) and its lock (one Pako at a time).
// - How it stops: "Leave demo" deletes ~/.pako/demo (and Claude Code's history of its folder) and restarts Pako on the real folder, as clean
//   as it was: the welcome asks again.
// - No network: every connection's setting is taken out of the environment (demoEnv), the connections set in the panel are not read, the
//   panel's connect routes answer "leave the demo first", and what would go out (an email, a calendar change) only says
//   "Demo: nothing was sent." The sources are read only and live in the demo's store: a calendar, Slack, mail.
// - Claude: signed in, the brief and the chat run on the demo week for real (a fresh brief is written once the bridge is up). Not signed in, the
//   recorded outputs show: a brief, a draft, a meeting prep, and a few recorded answers in the chat, under "Connect Claude to see it live".
// - Privacy: the demo's store is not the person's; the export says there is nothing of theirs to export while the demo runs, and nothing
//   learnt in the demo (lessons, memory, people) reaches the real folder.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import express, { type Express, type Request, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { chatText, gatherFacts, validateBrief, type BriefDoc, type Gathered } from "./brief-v2.ts";
import type { CalChange } from "./calendar-changes.ts";
import type { CalEvent, CalendarSource } from "./calendar.ts";
import { dayBounds } from "./calendar.ts";
import { localToEpoch } from "./door/time.ts";
import type { Loop } from "./followups.ts";
import type { Kv } from "./kv.ts";
import { createLessons } from "./lessons.ts";
import { createLists, today as dayOf } from "./lists.ts";
import type { RecentMail } from "./mail.ts";
import { createFacts } from "./memory-facts.ts";
import { createPeopleGraph, mailSightings, eventSightings, slackSightings, type Sighting } from "./people-graph.ts";
import { birthdaysBrief, createPeople, type Person } from "./people.ts";
import type { SlackAlert } from "./slack.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";

const log = createLog("demo");

type Env = Record<string, string | undefined>;

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** The demo's folder inside Pako's home, and the mark that says the demo is on. */
export const DEMO_FOLDER = "demo";
export const DEMO_MARK = "demo.json";
/** The store key that says the demo week was seeded (once: what the person changes afterwards stays). */
export const DEMO_SEEDED_KEY = "demo-seeded";
/** The demo's calendar and its Slack, kept in the demo's own store. */
export const DEMO_CALENDAR_KEY = "demo-calendar";
const SLACK_ALERTS_KEY = "slack-alerts";
/** The follow-ups' and the calendar changes' own keys (src/followups/store.ts, src/calendar-changes.ts), filled in their own shapes. */
const FOLLOWUPS_STORE = "followups";
const CHANGES_STORE = "calendar-changes";
const MAIL_KEY = "assistant-mail";
const mailBodyKey = (id: string): string => `assistant-mail-body:${id}`;
const CHAT_KEY = "pako-local-chat";
const BRIEF_KEY = "brief-v2";
const KEEP = 90 * 24 * 3600;

export const demoDir = (home: string): string => join(home, DEMO_FOLDER);

/** On: PAKO_DEMO=1, `--demo` among the arguments, or the mark in ~/.pako/demo (the panel's choice, kept across restarts). */
export function demoWanted(env: Env, argv: readonly string[], home: string): boolean {
  if ((env.PAKO_DEMO ?? "").trim() === "1" || argv.includes("--demo")) return true;
  return existsSync(join(demoDir(home), DEMO_MARK));
}

/** Makes the demo's folder and its mark: the next start runs the demo week. */
export function demoStart(home: string, now: number = Date.now()): void {
  const dir = demoDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, DEMO_MARK), JSON.stringify({ startedAt: now }), { mode: 0o600 });
}

/** Claude Code names a project's history folder after its path, with every character but letters and digits made a dash (src/data.ts). */
const claudeHistory = (stateDir: string, userHome: string): string => join(userHome, ".claude", "projects", stateDir.replace(/[^A-Za-z0-9]/g, "-"));

/** Deletes the demo's folder, and Claude Code's history of the demo's assistant folder: what is left is the real setup, as it was. */
export function demoLeave(home: string, userHome: string = homedir()): void {
  const dir = demoDir(home);
  for (const p of [dir, claudeHistory(join(dir, "assistant"), userHome)]) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch (err) {
      log.error(`could not delete ${p}: ${(err as Error).message}`);
    }
  }
}

/**
 * The settings that connect Pako to anything outside this computer, or to the person's own mail and Messages on it (Apple Mail, iMessage):
 * taken out of the environment for the demo, whoever set them (the shell, ~/.pako/.env, ./.env). Pako's own run settings (the port, the
 * name, the bridge) stay.
 */
const CONNECTION = new RegExp(
  "^(AGENTMAIL_|APPLE_MAIL|CALENDAR_ICS|IMESSAGE|GOOGLE_|IMAP_|LIVEKIT_|PAKO_GOOGLE_|PAKO_PLACE$|PERSONAL_AGENT_ID$|PERSONAL_CONTACT|PERSONAL_LIVE$"
  + "|PERSONAL_OWNER_NUMBER$|PUBLIC_URL$|RELAY_|RESEND_|RETELL_|SLACK_|TEAMS_|TELEGRAM_|VOICE_|WHATSAPP_|ZOHO_|ZOOM_)",
);

/** Takes every connection's setting out of `env` (in place) and turns off what would reach out by itself. Returns the names taken out. */
export function demoEnv(env: Env): string[] {
  const gone = Object.keys(env).filter((k) => CONNECTION.test(k)).sort();
  for (const k of gone) delete env[k];
  // Proactive Pako looks up the weather; booking writes to restaurants: neither has anything to do in an invented week.
  env.PROACTIVE = "off";
  env.BOOKING = "off";
  env.PAKO_DEMO = "1";
  return gone;
}

// ---------- the week ----------

export interface DemoPerson {
  name: string;
  email: string;
  relation: string;
  slack?: string;
  birthday?: string;
  likes?: string[];
  notes?: string[];
}

export interface DemoWeek {
  owner: { name: string; email: string };
  people: DemoPerson[];
  events: CalEvent[];
  changes: CalChange[];
  mail: (RecentMail & { body: string })[];
  slack: SlackAlert[];
  loops: Loop[];
  /** A task with its day. */
  tasks: { text: string; due: string }[];
  /** Today's meetings, placed around the moment the demo starts so some are still ahead: "HH:MM" in the owner's zone. */
  times: DemoTimes;
}

/** Today's times the texts name: the stand-up, the pilot review (and where it was before it moved), Sofia's drinks, the cancelled coffee. */
export interface DemoTimes { standup: string; bluefin: string; was: string; sofia: string; lukas: string }

/** The times a seed without them (or a test) uses: a day seen from the morning. */
export const MORNING_TIMES: DemoTimes = { standup: "09:30", bluefin: "15:00", was: "10:00", sofia: "18:30", lukas: "16:30" };

/** Loop ids, fixed so the recorded brief and the chat's card can name them. */
export const DEMO_LOOP = {
  deck: "d0d0000001", mockups: "d0d0000002", proposal: "d0d0000003", estimates: "d0d0000004", call: "d0d0000005",
  invoice: "d0d0000006", intro: "d0d0000007", metrics: "d0d0000008", offsite: "d0d0000009", dinner: "d0d000000a",
} as const;

const OWNER_EMAIL = "alex@northwind.example";

/**
 * The invented week around `now`, in the owner's zone: twelve people, a calendar with a meeting moved and one cancelled overnight, Slack
 * messages with promises both ways, eight emails (a newsletter, and one the owner already answered), follow-ups in every state, birthdays.
 * Names and addresses are invented; every domain is an example domain.
 */
export function demoWeek(now: number, timeZone: string, ownerName = "Alex"): DemoWeek {
  const day = (n: number): string => dayOf(now + n * DAY, timeZone);
  /** A local time `n` days from today, in the owner's zone (the next minute that exists, around a clock change). */
  const at = (n: number, hm: string): number => localToEpoch(`${day(n)} ${hm}`, timeZone) ?? localToEpoch(`${day(n)} 12:00`, timeZone) ?? now + n * DAY;
  const md = (n: number): string => day(n).slice(5);
  // Friday, as Priya and Kenji say it: this week's, or next week's from Friday on.
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(now));
  const friday = (5 - weekday + 7) % 7 || 7;
  // Today's meetings around now, on quarter hours, never before 08:00 nor after the day ends: whenever the demo starts, the agenda, the
  // "today's meetings" tile, the reminders and the meeting prep have something ahead.
  const { start: d0, end: d1 } = dayBounds(now, timeZone);
  const Q = 15 * 60_000;
  const slot = (minutes: number, room: number): number =>
    Math.max(d0 + 8 * HOUR, Math.min(Math.ceil((now + minutes * 60_000) / Q) * Q, d1 - room * 60_000));
  const hm = (t: number): string => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t);
  const tStandup = slot(-150, 240);
  const tBluefin = slot(60, 60);
  const tWas = Math.max(d0 + 8 * HOUR, tBluefin - 5 * HOUR) === tBluefin ? tBluefin - 2 * HOUR : Math.max(d0 + 8 * HOUR, tBluefin - 5 * HOUR);
  const tLukas = slot(120, 90);
  const tSofia = slot(180, 75);
  const times: DemoTimes = { standup: hm(tStandup), bluefin: hm(tBluefin), was: hm(tWas), sofia: hm(tSofia), lukas: hm(tLukas) };
  const span = (t: number, minutes: number) => ({ start: t, end: t + minutes * 60_000 });
  const people: DemoPerson[] = [
    { name: "Ana Lima", email: "ana.lima@northwind.example", relation: "my manager", slack: "D0DEMOANA",
      notes: ["Likes a PDF pre-read the day before a review", "Weekly 1:1 moved to Wednesdays"] },
    { name: "Kenji Watanabe", email: "kenji@northwind.example", relation: "engineering lead, in Tokyo", slack: "D0DEMOKENJI",
      notes: ["Best reached before 10:00 Tokyo time"] },
    { name: "Priya Raman", email: "priya.raman@bluefin.example", relation: "client, Bluefin Health", notes: ["Decides on the Bluefin pilot"] },
    { name: "Amara Okafor", email: "amara.okafor@bluefin.example", relation: "CFO at Bluefin Health", notes: ["Signs off the pilot budget"] },
    { name: "Tomás Ortega", email: "tomas@northwind.example", relation: "product designer", slack: "C0DEMODESIGN" },
    { name: "Mei Chen", email: "mei.chen@northwind.example", relation: "data analyst", slack: "C0DEMOMETRICS" },
    { name: "Daniel Cohen", email: "daniel@northwind.example", relation: "sales lead", slack: "C0DEMOSALES" },
    { name: "Lukas Becker", email: "lukas@brightline.example", relation: "friend, investor at Brightline Ventures" },
    { name: "Sofia Rossi", email: "sofia.rossi@example.com", relation: "close friend", birthday: md(0), likes: ["Negronis", "live jazz"] },
    { name: "Grace Mensah", email: "grace.mensah@example.org", relation: "my sister", birthday: md(3), likes: ["orchids", "crime novels"] },
    { name: "Omar Haddad", email: "billing@cloudnest.example", relation: "account manager at Cloudnest" },
    { name: "Liam O'Brien", email: "liam.obrien@example.net", relation: "former colleague", slack: "D0DEMOLIAM" },
  ];
  const p = (name: string): DemoPerson => people.find((x) => x.name.startsWith(name))!;
  const att = (...names: string[]) => names.map((n) => ({ email: p(n).email, name: p(n).name }));
  const ev = (id: string, title: string, n: number, from: string, to: string, more: Partial<CalEvent> = {}): CalEvent =>
    ({ id: `demo:${id}`, title, start: at(n, from), end: at(n, to), allDay: false, calendar: "Work (demo)", ...more });
  const events: CalEvent[] = [
    ev("metrics", "Metrics sync with Mei", -1, "15:00", "15:30", { attendees: att("Mei") }),
    ev("standup", "Daily stand-up", 0, "09:30", "09:45", {
      ...span(tStandup, 15), recurring: true, join: "https://meet.example.com/standup", attendees: att("Kenji", "Tomás", "Mei"),
    }),
    ev("sofia", "Birthday drinks with Sofia", 0, "18:30", "19:30", { ...span(tSofia, 60), calendar: "Personal (demo)", location: "Bar Verde" }),
    ev("bluefin", "Bluefin pilot review", 0, "15:00", "15:45", {
      ...span(tBluefin, 45), join: "https://meet.example.com/bluefin", attendees: att("Priya", "Amara", "Daniel"),
    }),
    ev("standup-1", "Daily stand-up", 1, "09:30", "09:45", { recurring: true, join: "https://meet.example.com/standup", attendees: att("Kenji", "Tomás", "Mei") }),
    ev("one-on-one", "1:1 with Ana", 1, "10:00", "10:30", { attendees: att("Ana") }),
    ev("design", "Design review: onboarding", 1, "14:00", "15:00", { attendees: att("Tomás", "Ana") }),
    ev("roadmap", "Q3 roadmap review", 2, "09:00", "10:00", { attendees: att("Ana", "Kenji", "Daniel") }),
    ev("grace", "Grace's birthday", 3, "00:00", "00:00", { calendar: "Personal (demo)", allDay: true, start: at(3, "00:00"), end: at(4, "00:00") }),
  ];
  const overnight = Math.min(now - 6 * HOUR, at(0, "02:10"));
  const changes: CalChange[] = [
    { kind: "moved", id: "demo:bluefin", title: "Bluefin pilot review", start: tBluefin, end: tBluefin + 45 * 60_000, was: tWas, at: overnight },
    { kind: "cancelled", id: "demo:lukas", title: "Coffee with Lukas Becker", start: tLukas, end: tLukas + 30 * 60_000, at: overnight + 20 * 60_000 },
  ];
  const mail = (
    id: string, who: string, subject: string, hoursAgo: number, body: string, more: Partial<RecentMail> = {},
  ): RecentMail & { body: string } => {
    const person = people.find((x) => x.name === who);
    const from = person ? `${person.name} <${person.email}>` : who;
    return { id: `demo-${id}`, at: now - hoursAgo * HOUR, from, subject, preview: body.replace(/\s+/g, " ").slice(0, 160), body, ...more };
  };
  const mails: (RecentMail & { body: string })[] = [
    mail("proposal", "Priya Raman", "Pilot proposal for Bluefin", 18,
      "Hi Alex,\n\nCould you send the pilot proposal by Friday? Amara needs it before she signs off the budget. Scope, timeline and price is enough.\n\n"
      + "Thanks,\nPriya", {
        category: "needs_you", why: "Priya asks you for the pilot proposal by Friday", ask: { action: "reply", text: "Send the pilot proposal by Friday" },
        due: day(friday), summary: "Priya asks for the Bluefin pilot proposal by Friday, for Amara's budget sign-off.",
      }),
    mail("moved", "Amara Okafor", `Moving our pilot review to ${times.bluefin}`, Math.max(1, (now - overnight) / HOUR - 0.5),
      `Hello,\n\nSorry for the shuffle: the Bluefin pilot review moves from ${times.was} to ${times.bluefin} today. Same link.\n\nAmara`, {
        category: "important", why: `The pilot review moved to ${times.bluefin} today`,
        summary: `Amara moved today's Bluefin pilot review from ${times.was} to ${times.bluefin}.`,
      }),
    mail("invoice", "Omar Haddad", "Invoice #4471 is due soon", 40,
      "Hi,\n\nA friendly reminder that Cloudnest invoice #4471 for the team plan is due in four days. Reply if you need a copy.\n\nOmar, Cloudnest", {
        category: "needs_you", why: "An invoice is due in four days", ask: { action: "do", text: "Pay Cloudnest invoice #4471" }, due: day(4),
        summary: "Cloudnest invoice #4471 for the team plan is due in four days.",
      }),
    mail("metrics", "Mei Chen", "October metrics", 22,
      "Hi Alex,\n\nThe October numbers are in the shared drive: activation is up 4 points and churn is flat. Happy to walk the team through them.\n\nMei", {
        category: "important", why: "The October numbers you asked for", repliedAt: now - 20 * HOUR,
        summary: "Mei shared the October metrics: activation up 4 points, churn flat. You already replied.",
      }),
    mail("lukas", "Lukas Becker", "Can't make coffee today", Math.max(1, (now - overnight) / HOUR - 0.2),
      "Alex, something came up and I have to cancel our coffee today. Rain check? Any morning next week works for me.\n\nLukas", {
        category: "personal", why: "Lukas cancelled today's coffee", summary: "Lukas cancelled today's coffee and offers any morning next week.",
      }),
    mail("sofia", "Sofia Rossi", "Still on for drinks?", 46,
      `Hey! Still on for drinks on my birthday? ${times.sofia} at Bar Verde. Don't bring anything, just you.\n\nS.`, {
        category: "personal", why: "Sofia confirms her birthday drinks", summary: `Sofia confirms her birthday drinks, ${times.sofia} at Bar Verde.`,
      }),
    mail("newsletter", "The Product Letter <news@productletter.example>", "Issue 112: the quiet power of follow-through", 9,
      "This week: why teams that close loops ship faster, three templates for meeting notes, and a reading list.", {
        category: "read_later", why: "A newsletter", summary: "A product newsletter about follow-through.",
      }),
    mail("liam", "Liam O'Brien", "Intro to Kenji?", 70,
      "Hi Alex, would you be up for introducing me to Kenji? I'd love his advice on our infra migration. No rush at all.\n\nLiam", {
        category: "waiting", why: "Liam asks for an intro to Kenji", summary: "Liam asks for an introduction to Kenji about an infra migration.",
      }),
  ];
  const slackAlert = (who: string, where: string, hoursAgo: number, text: string, channel: string, direct: boolean): SlackAlert => {
    const t = now - hoursAgo * HOUR;
    return { at: t, where, text, channel, ts: (t / 1000).toFixed(6), who, direct };
  };
  const slack: SlackAlert[] = [
    slackAlert("Liam O'Brien", "Liam O'Brien (private)", 69, "Sent you an email too: would you introduce me to Kenji? Only if it's easy.", "D0DEMOLIAM", true),
    slackAlert("Tomás Ortega", "Tomás Ortega in #design", 44,
      "Alex, could you review the onboarding mockups before the design review? The Figma link is in the thread.", "C0DEMODESIGN", false),
    slackAlert("Kenji Watanabe", "Kenji Watanabe (private)", 26, "I'll have the API estimates for the Bluefin pilot to you by Friday.", "D0DEMOKENJI", true),
    slackAlert("Mei Chen", "Mei Chen in #metrics", 22, "October metrics are in the drive. Activation is up 4 points.", "C0DEMOMETRICS", false),
    slackAlert("Ana Lima", "Ana Lima (private)", 16,
      "Can you send me the Q3 roadmap deck before the roadmap review? A PDF is perfect, I'll pre-read it.", "D0DEMOANA", true),
    slackAlert("Daniel Cohen", "Daniel Cohen in #sales", 3,
      "Priya wants a call with both of us next week to go over pricing. Can you find a time?", "C0DEMOSALES", false),
  ];
  const ago = (h: number) => now - h * HOUR;
  const loop = (id: string, l: Omit<Loop, "id" | "nudges" | "createdAt" | "nextCheckAt" | "check"> & Partial<Loop>): Loop => ({
    id, nudges: 0, createdAt: l.whenSaid, nextCheckAt: 0, check: { none: { reason: "demo week" } }, ...l,
  });
  const loops: Loop[] = [
    loop(DEMO_LOOP.deck, {
      kind: "owner_promise", title: "Send Ana the Q3 roadmap deck as a PDF", detail: "You replied “Sure, I'll send it the evening before”.",
      who: "Ana Lima", where: { type: "slack_dm", label: "Ana Lima (private)", channel: "D0DEMOANA" }, whenSaid: ago(15.5), dueAt: at(1, "18:00"),
      status: "open", lastCheck: "I don't see the deck in your conversation with Ana yet.", checkedAt: ago(1),
      sources: [{ kind: "slack", label: "Ana Lima (private)", at: ago(16) }],
    }),
    loop(DEMO_LOOP.mockups, {
      kind: "request_to_owner", title: "Review Tomás's onboarding mockups", detail: "Before the design review; the Figma link is in the thread.",
      who: "Tomás Ortega", where: { type: "slack_channel", label: "Tomás Ortega in #design", channel: "C0DEMODESIGN" }, whenSaid: ago(44), dueAt: at(1, "13:00"),
      status: "open", escalated: true, lastCheck: "No reply from you in the thread yet.", checkedAt: ago(2),
      sources: [{ kind: "slack", label: "Tomás Ortega in #design", at: ago(44) }],
    }),
    loop(DEMO_LOOP.proposal, {
      kind: "request_to_owner", title: "Send Priya the Bluefin pilot proposal", detail: "Scope, timeline and price; Amara needs it for the budget.",
      who: "Priya Raman", where: { type: "mail", label: "email from Priya Raman" }, whenSaid: ago(18), dueAt: at(friday, "17:00"),
      status: "open", lastCheck: "You haven't replied to Priya's email.", checkedAt: ago(1),
      sources: [{ kind: "mail", label: "Priya Raman", at: ago(18), ref: "demo-proposal" }],
    }),
    loop(DEMO_LOOP.estimates, {
      kind: "other_promise", title: "Kenji sends the API estimates for the Bluefin pilot", detail: "He said by Friday.",
      who: "Kenji Watanabe", where: { type: "slack_dm", label: "Kenji Watanabe (private)", channel: "D0DEMOKENJI" }, whenSaid: ago(26), dueAt: at(friday, "18:00"),
      tz: "Asia/Tokyo", status: "open", sources: [{ kind: "slack", label: "Kenji Watanabe (private)", at: ago(26) }],
    }),
    loop(DEMO_LOOP.call, {
      kind: "agreed_meeting", title: "Set up a pricing call with Priya and Daniel next week", detail: "No time agreed yet.",
      who: "Daniel Cohen", where: { type: "slack_channel", label: "Daniel Cohen in #sales", channel: "C0DEMOSALES" }, whenSaid: ago(3),
      status: "open", sources: [{ kind: "slack", label: "Daniel Cohen in #sales", at: ago(3) }],
    }),
    loop(DEMO_LOOP.invoice, {
      kind: "deadline", title: "Pay Cloudnest invoice #4471", detail: "The team plan.", who: "Omar Haddad",
      where: { type: "mail", label: "email from Cloudnest" }, whenSaid: ago(40), dueAt: at(4, "12:00"), status: "open",
      sources: [{ kind: "mail", label: "Omar Haddad", at: ago(40), ref: "demo-invoice" }],
    }),
    loop(DEMO_LOOP.intro, {
      kind: "request_to_owner", title: "Introduce Liam to Kenji", detail: "About an infra migration; Liam said no rush.", who: "Liam O'Brien",
      where: { type: "slack_dm", label: "Liam O'Brien (private)", channel: "D0DEMOLIAM" }, whenSaid: ago(70), status: "snoozed", nudges: 1,
      sources: [{ kind: "slack", label: "Liam O'Brien (private)", at: ago(70) }],
    }),
    loop(DEMO_LOOP.metrics, {
      kind: "owner_promise", title: "Share the October metrics with the team", detail: "", who: "Mei Chen",
      where: { type: "mail", label: "email from Mei Chen" }, whenSaid: ago(22), status: "done", closedAt: ago(20),
      lastCheck: "You replied to the email: “Thanks Mei, forwarded to the team.”", checkedAt: ago(20),
      sources: [{ kind: "mail", label: "Mei Chen", at: ago(22), ref: "demo-metrics" }],
    }),
    loop(DEMO_LOOP.offsite, {
      kind: "request_to_owner", title: "Book the offsite venue", detail: "Asked in #sales; it's the office manager's.", who: "Daniel Cohen",
      where: { type: "slack_channel", label: "Daniel Cohen in #sales", channel: "C0DEMOSALES" }, whenSaid: ago(50), status: "dismissed", closedAt: ago(48),
      sources: [{ kind: "slack", label: "Daniel Cohen in #sales", at: ago(50) }],
    }),
    loop(DEMO_LOOP.dinner, {
      kind: "owner_promise", title: "Confirm dinner with Lukas", detail: "", who: "Lukas Becker",
      where: { type: "chat", label: "you told Pako" }, whenSaid: ago(60), status: "done", closedAt: ago(55), lastCheck: "You said it's done.",
      sources: [{ kind: "chat", label: "You told Pako", at: ago(60) }],
    }),
  ];
  return {
    owner: { name: ownerName, email: OWNER_EMAIL },
    people,
    events,
    changes,
    mail: mails,
    slack,
    loops,
    tasks: [{ text: "Buy a birthday present for Grace (orchids?)", due: day(2) }],
    times,
  };
}

// ---------- the sources, read only ----------

/** The demo's calendar as a source of the calendar's core (src/calendar.ts): what the seed kept, the window the core reads. */
export function demoCalendar(kv: Kv): CalendarSource {
  return {
    label: "Demo calendar",
    events: async () => {
      const raw = await readJsonRecord(kv, DEMO_CALENDAR_KEY);
      const list = raw ? (raw as CalEvent[]) : [];
      return { events: Array.isArray(list) ? list : [], partial: false };
    },
  };
}

/** The demo's Slack, read only: the alerts the seed kept, as the Slack reader gives them (src/slack.ts). */
export function demoSlack(kv: Kv, now: () => number = Date.now) {
  const all = async (): Promise<SlackAlert[]> => {
    const raw = await readJsonRecord(kv, SLACK_ALERTS_KEY);
    const list = raw ? (raw as SlackAlert[]) : [];
    return Array.isArray(list) ? list : [];
  };
  const clock = (t: number) => new Date(t).toISOString().slice(11, 16);
  return {
    alerts: async (): Promise<SlackAlert[]> => (await all()).filter((a) => now() - a.at < 7 * DAY).reverse(),
    recent: async (): Promise<string[]> => (await all()).filter((a) => now() - a.at < DAY).map((a) => `${clock(a.at)} ${a.where}: ${a.text}`),
    search: async (q: string): Promise<string[]> => {
      const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      return (await all()).filter((a) => words.some((w) => `${a.where} ${a.text}`.toLowerCase().includes(w))).map((a) => `${a.where}: ${a.text}`);
    },
    brief: async (): Promise<string | null> => {
      const n = (await all()).filter((a) => now() - a.at < DAY).length;
      return n ? `💬 Slack: ${n} message${n === 1 ? "" : "s"} for you in the last day.` : null;
    },
  };
}

export const DEMO_TEXTS = {
  banner: "Demo week: invented data.",
  leave: "Leave demo",
  live: "Connect Claude to see it live",
  sent: "Demo: nothing was sent. In your own setup this email would go to {to} (“{subject}”).",
  calendar: "Demo: nothing was changed. In your own setup this would {what} on your calendar.",
  call: "Demo: nothing was sent. In your own setup Pako would place this call.",
  welcome:
    "This is a demo week: everyone and everything here is invented, and nothing you do leaves this computer. Try asking “what did I promise Ana?”, "
    + "tick a to-do in the brief, or press Done, Not mine or Snooze on the card below. Leave the demo any time from the banner at the top.",
  nudge: "⏰ Due before the design review: Review Tomás's onboarding mockups (Tomás Ortega in #design). No reply from you in the thread yet.",
  recordedTail: "\n\n(Recorded demo answer. Connect Claude to see it live.)",
  recordedNone:
    "In the demo, without Claude connected, I can only answer a few recorded questions: “what did I promise Ana?”, “what's on today?” or "
    + "“what am I forgetting?”. Connect Claude to ask anything about this week.",
  noExport: "Demo week: there is nothing of yours to export. Leave the demo first.",
  noDelete: "Demo week: deleting here would empty the demo only, not your own data. Leave the demo first.",
  blocked: "This is the demo week: leave the demo to connect your own accounts.",
} as const;

const fill = (s: string, v: Record<string, string>): string => s.replace(/\{(\w+)\}/g, (_m, k: string) => v[k] ?? "");

/** An email Pako would send, in the demo: nothing goes; the chat says so. */
export function demoSender(tell: (text: string) => Promise<unknown>) {
  return async (m: { to: string; subject: string; text: string }): Promise<void> => {
    await tell(fill(DEMO_TEXTS.sent, { to: m.to, subject: m.subject }));
  };
}

/** This Mac's calendar written by its app (src/calendar-writes.ts), in the demo: nothing is queued for any app; the chat says so. */
export function demoCalendarWrites(o: { events: () => Promise<CalEvent[]>; tell: (text: string) => Promise<unknown> }) {
  return {
    canWrite: async () => true,
    find: async (title: string, start: number) => {
      const fold = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
      const e = (await o.events()).find((x) => Math.abs(x.start - start) < 60_000 && (fold(x.title).includes(fold(title)) || fold(title).includes(fold(x.title))));
      return e ? { eventId: e.id, at: e.start, start: e.start, end: e.end, title: e.title, calendarId: e.calendar } : null;
    },
    enqueue: async (w: { op: string; title?: string }): Promise<boolean> => {
      const what = w.op === "create" ? `add “${w.title ?? ""}”` : w.op === "move" ? `move “${w.title ?? ""}”` : `cancel “${w.title ?? ""}”`;
      await o.tell(fill(DEMO_TEXTS.calendar, { what }));
      return true;
    },
    get: async () => null,
  };
}

/**
 * A recorded answer for a question typed in the demo's chat while Claude is not connected; null when it is none of them (the chat then says
 * which ones there are). Never used once Claude is connected: the chat runs for real then.
 */
export function recordedAnswer(text: string, t: DemoTimes = MORNING_TIMES): string {
  const s = text.toLowerCase();
  let answer: string | null = null;
  if (/\bana\b/.test(s) && /promis|owe|told/.test(s)) {
    answer = "You promised Ana Lima the Q3 roadmap deck as a PDF, the evening before the roadmap review (on Slack, yesterday). "
      + "It's still open: I don't see it in your conversation with her yet. Want a draft of the note that goes with it?";
  } else if (/today|my day|on (?:for )?today|agenda|schedule/.test(s)) {
    answer = `Today: stand-up at ${t.standup}, the Bluefin pilot review, moved overnight from ${t.was} to ${t.bluefin} (Priya, Amara and Daniel), `
      + `and Sofia's birthday drinks at ${t.sofia}. Your ${t.lukas} coffee with Lukas was cancelled. Before the review: Priya is waiting for the pilot proposal.`;
  } else if (/forget|owe|open|pending|follow/.test(s)) {
    answer = "Yours: review Tomás's onboarding mockups (before tomorrow's design review), send Ana the roadmap deck, send Priya the pilot proposal, "
      + "pay Cloudnest invoice #4471, and set up the pricing call with Priya and Daniel. Waiting on others: Kenji's API estimates (Friday).";
  }
  return answer ? answer + DEMO_TEXTS.recordedTail : DEMO_TEXTS.recordedNone;
}

// ---------- the seed ----------

const RECORDED_BRIEF = {
  opening: "Busy but clear: the Bluefin pilot review moved to this afternoon, and two promises are due before the roadmap review.",
  focus: {
    title: "Get the Bluefin pilot proposal to Priya before the review",
    story: "Priya asked for the pilot proposal by Friday so Amara can sign off the budget, and the pilot review is now at {bluefin} today. "
      + "Kenji's API estimates come Friday, so the proposal can go with a range now.",
    offer: "Draft the proposal email to Priya with scope, timeline and a price range",
  },
};

/** The recorded brief, from the demo week's own facts: what a written brief says when Claude is not connected. */
export function recordedBrief(g: Gathered, o: { now: number; timeZone: string; name: string; times?: DemoTimes }): BriefDoc | null {
  const t = o.times ?? MORNING_TIMES;
  const find = (pred: (f: Gathered["facts"][number]) => boolean): string | undefined => g.facts.find(pred)?.id;
  const loop = (id: string) => find((f) => f.kind === "loop" && f.ref === id);
  const ids = (...x: (string | undefined)[]): string[] => x.filter((s): s is string => !!s);
  const event = (title: string) => find((f) => f.kind === "event" && (f.title ?? "").startsWith(title));
  const mail = (subject: string) => find((f) => f.kind === "mail" && f.text.includes(subject));
  const change = (word: string) => find((f) => f.kind === "change" && f.text.includes(word));
  const raw = {
    opening: RECORDED_BRIEF.opening,
    focus: {
      ...RECORDED_BRIEF.focus, story: RECORDED_BRIEF.focus.story.replace("{bluefin}", t.bluefin),
      sources: ids(loop(DEMO_LOOP.proposal), mail("Pilot proposal"), event("Bluefin"), loop(DEMO_LOOP.estimates)),
    },
    todos: [
      { title: "Review Tomás's onboarding mockups", context: "Tomás asked in #design before tomorrow's design review.",
        checked: "No reply from you in the thread yet.", loopId: DEMO_LOOP.mockups, sources: ids(loop(DEMO_LOOP.mockups)) },
      { title: "Send Ana the Q3 roadmap deck as a PDF", context: "You promised it the evening before the roadmap review.",
        checked: "I don't see the deck in your conversation with Ana yet.", loopId: DEMO_LOOP.deck, sources: ids(loop(DEMO_LOOP.deck)) },
      { title: "Send Priya the Bluefin pilot proposal", context: "Priya needs it by Friday for Amara's budget sign-off.",
        checked: "You haven't replied to Priya's email.", loopId: DEMO_LOOP.proposal, sources: ids(loop(DEMO_LOOP.proposal), mail("Pilot proposal")) },
      { title: "Pay Cloudnest invoice #4471", context: "Due in four days.", checked: "", loopId: DEMO_LOOP.invoice, sources: ids(loop(DEMO_LOOP.invoice)) },
    ],
    updates: [
      { title: `Bluefin pilot review moved to ${t.bluefin}`, tag: "Moved overnight", text: `Amara moved it from ${t.was} to ${t.bluefin} today. Same link.`,
        sources: ids(change("MOVED"), mail("Moving our pilot review")) },
      { title: "Coffee with Lukas Becker cancelled", tag: "Cancelled overnight", text: "Lukas offers any morning next week instead.",
        sources: ids(change("GONE"), mail("Can't make coffee")) },
      { title: "October metrics are in", tag: "Closed", text: "Mei shared them and you already replied: activation is up 4 points.",
        sources: ids(mail("October metrics")) },
      { title: "Kenji's API estimates come Friday", tag: "Waiting on others", text: "Kenji said he'll send them by Friday.",
        sources: ids(loop(DEMO_LOOP.estimates)) },
    ],
    day: [
      { time: t.bluefin, title: "Bluefin pilot review", note: `Moved from ${t.was}.`, prep: true, sources: ids(event("Bluefin")) },
      { time: t.sofia, title: "Birthday drinks with Sofia", note: "It's her birthday today.", sources: ids(event("Birthday drinks")) },
    ],
  };
  return validateBrief(JSON.stringify(raw), g, { now: o.now, timeZone: o.timeZone, lang: "en", id: "d0d0b0b0b0", ownerName: o.name });
}

const PREP_TEXT = (t: DemoTimes): string =>
  `Bluefin pilot review, ${t.bluefin} (moved overnight from ${t.was}).\n\n`
  + "Who's coming: Priya Raman (decides on the pilot), Amara Okafor (CFO, signs off the budget), Daniel Cohen (your sales lead).\n\n"
  + "What's open with them: Priya is waiting for the pilot proposal (due Friday). Kenji's API estimates arrive Friday, so give a price range today. "
  + "Daniel wants a pricing call with Priya next week; no time agreed yet.\n\n"
  + "Ask for: Amara's budget window, and who else signs.";

const DRAFT_TEXT =
  "To Priya Raman (email, a reply to “Pilot proposal for Bluefin”):\n"
  + "Hi Priya,\n\nHere is the pilot proposal for Bluefin: a six-week pilot with two clinics, weekly check-ins, and a price range of 18,000 to 22,000 "
  + "depending on the integration work. Kenji will confirm the API estimate by Friday and I'll send the final number then.\n\n"
  + "Happy to walk Amara through it at today's review.\n\nBest,\nAlex";

const DO_TEXT =
  "To Priya Raman (email):\nSubject: Bluefin pilot: proposal and timeline\n\nHi Priya,\n\nAhead of today's review, a short outline: scope (two clinics, "
  + "six weeks), timeline (start in two weeks), and a price range of 18,000 to 22,000 until Kenji confirms the API estimate on Friday.\n\nBest,\nAlex";

/**
 * Fills the demo's store with the week, once (DEMO_SEEDED_KEY): the people and what Pako knows of them, the calendar and what changed overnight,
 * the mail, Slack, the follow-ups, a task, a lesson, the recorded brief with its draft and meeting prep, and the chat's first messages. False
 * when it was seeded before (what the person changed since stays).
 */
export async function seedDemo(kv: Kv, o: { now: number; timeZone: string; name: string; briefUrl?: string | null }): Promise<boolean> {
  if (await kv.get(DEMO_SEEDED_KEY)) return false;
  const { now, timeZone: tz } = o;
  const week = demoWeek(now, tz, o.name);
  await kv.set(DEMO_CALENDAR_KEY, JSON.stringify(week.events), KEEP);
  await kv.set(SLACK_ALERTS_KEY, JSON.stringify(week.slack), KEEP);
  const mail: RecentMail[] = week.mail.map(({ body: _b, ...m }) => m);
  await kv.set(MAIL_KEY, JSON.stringify({ seen: mail.map((m) => m.id), recent: [...mail].sort((a, b) => a.at - b.at), primed: true }), KEEP);
  for (const m of week.mail) await kv.set(mailBodyKey(m.id), m.body, KEEP);
  await kv.set(FOLLOWUPS_STORE, JSON.stringify({
    loops: week.loops,
    rules: [{ at: now - 48 * HOUR, who: "Daniel Cohen", where: "Daniel Cohen in #sales", title: "Book the offsite venue" }],
    jobs: [], batches: [], mailBatches: [], mailRead: [], budget: { day: "", n: 0 }, mailBudget: { day: "", n: 0 },
  }), KEEP);
  // The snapshot is the calendar as it is now (the next reading finds nothing new); the log is what changed overnight.
  const snap = week.events.filter((e) => e.end > now).map((e) => ({ id: e.id, title: e.title, start: e.start, end: e.end }));
  await kv.set(CHANGES_STORE, JSON.stringify({ events: snap, log: week.changes }), KEEP);

  const people = createPeople(kv);
  for (const p of week.people) {
    await people.upsert({ name: p.name, relation: p.relation, ...(p.birthday ? { birthday: p.birthday } : {}), likes: p.likes ?? [], notes: p.notes ?? [] }, now - 10 * DAY);
  }
  const facts = createFacts(kv);
  const src = { who: "owner", where: "chat", at: now - 20 * DAY };
  await facts.add([{ subject: "Ana Lima", attribute: "weekly 1:1", value: "Tuesdays at 10:00", validFrom: now - 30 * DAY, source: src }], now - 20 * DAY, { judge: false });
  await facts.add([{ subject: "Ana Lima", attribute: "weekly 1:1", value: "Wednesdays at 10:00", source: { ...src, at: now - 8 * HOUR } }], now - 8 * HOUR, { judge: false });
  await facts.add([{ subject: "Priya Raman", attribute: "pilot budget", value: "Signed off by Amara Okafor", source: src }], now - 5 * DAY, { judge: false });
  // With the people kept above, so a name met in the mail or on Slack is the same person, not a second one.
  const graph = createPeopleGraph(kv, { people: () => people.read(true) });
  const sightings: Sighting[] = [
    ...mailSightings(week.mail),
    ...eventSightings(week.events),
    ...week.slack.flatMap((a) => slackSightings({ who: a.who ?? "", at: a.at, where: a.where })),
  ];
  await graph.observe(sightings, now);
  // "Is this the same person?" (a name met in the mail and one of the owner's people): in the demo week the owner already said yes.
  for (const q of (await graph.read()).questions) await graph.answer(q.id, true, now);
  const lists = createLists(kv, () => now);
  for (const t of week.tasks) await lists.addTask(t.text, t.due, now - 30 * HOUR);
  const lessons = createLessons({ kv, timeZone: tz, now: () => now - 48 * HOUR });
  await lessons.notMine({ title: "Book the offsite venue", who: "Daniel Cohen", where: "Daniel Cohen in #sales", channel: "C0DEMOSALES" });

  // The recorded brief, from the week's facts as the written brief gathers them, with a draft, a meeting's prep and the focus done.
  const kept = await people.read(true);
  const gathered = await gatherFacts({
    timeZone: tz, lang: "en", now,
    loops: async () => week.loops.filter((l) => l.status === "open" || l.status === "snoozed"),
    events: async () => week.events,
    mail: async () => mail,
    slack: async () => week.slack.map(({ at, where, text }) => ({ at, where, text })),
    tasks: async () => (await lists.read(true)).tasks,
    birthdays: async () => birthdaysBrief(kept, now, tz, "en"),
    calendarChanges: async (since) => week.changes.filter((c) => c.at > since),
    people: async (words) => personBlocks(kept, words),
    since: now - DAY,
  });
  const doc = recordedBrief(gathered, { now, timeZone: tz, name: o.name, times: week.times });
  if (doc) {
    const draftRef = doc.todos.findIndex((x) => x.loopId === DEMO_LOOP.proposal);
    const prepRef = doc.dayItems.findIndex((x) => x.title.startsWith("Bluefin"));
    const task = (id: string, kind: "do" | "prep" | "draft", ref: number | undefined, title: string, text: string) =>
      ({ id, kind, ...(ref !== undefined && ref >= 0 ? { ref } : {}), title, status: "done", text, at: now - 5 * 60_000 });
    const tasks = [
      ...(prepRef >= 0 ? [task("d0d0b0b0b1", "prep", prepRef, "For the meeting: Bluefin pilot review", PREP_TEXT(week.times))] : []),
      ...(draftRef >= 0 ? [{ ...task("d0d0b0b0b2", "draft", draftRef, "Draft: Send Priya the Bluefin pilot proposal", DRAFT_TEXT), mailRef: "demo-proposal" }] : []),
      ...(doc.focus ? [task("d0d0b0b0b3", "do", undefined, `Prepared: ${doc.focus.title}`, DO_TEXT)] : []),
    ];
    await kv.set(BRIEF_KEY, JSON.stringify({ doc, gathered, pending: null, tasks, done: [] }), KEEP);
  } else {
    log.error("the recorded brief did not hold against the demo's facts: the brief page waits for a written one");
  }

  // The chat: what the demo is, this morning's brief, and a follow-up's card to press.
  const chat: { n: number; at: number; who: "pako"; text: string; buttons?: { id: string; title: string }[]; started?: true }[] = [];
  const say = (text: string, buttons?: { id: string; title: string }[]) =>
    chat.push({ n: chat.length + 1, at: now - (3 - chat.length) * 1000, who: "pako", text, ...(buttons ? { buttons } : {}), started: true });
  say(DEMO_TEXTS.welcome);
  if (doc) say(chatText(doc, { name: o.name, timeZone: tz, url: o.briefUrl ?? null, lang: "en", now }));
  say(DEMO_TEXTS.nudge, [
    { id: `f1:${DEMO_LOOP.mockups}`, title: "Done" }, { id: `f2:${DEMO_LOOP.mockups}`, title: "Snooze 1h" }, { id: `f3:${DEMO_LOOP.mockups}`, title: "Not mine" },
  ]);
  await kv.set(CHAT_KEY, JSON.stringify(chat), KEEP);
  await kv.set(DEMO_SEEDED_KEY, JSON.stringify({ at: now, times: week.times }), KEEP);
  return true;
}

/** What the demo's memory says of the people a brief names: relation and notes, one block each, at most three. */
function personBlocks(people: Person[], words: string[]): { name: string; text: string }[] {
  const want = words.map((w) => w.toLowerCase());
  return people
    .filter((p) => want.some((w) => w.includes(p.name.toLowerCase()) || w.includes(p.name.split(" ")[0]!.toLowerCase())))
    .slice(0, 3)
    .map((p) => ({ name: p.name, text: [p.relation ? `relation: ${p.relation}` : "", ...p.notes].filter(Boolean).join(" · ") }));
}

// ---------- the panel's routes ----------

/** POST routes that connect an account, take data in or set up something lasting: "leave the demo first" while it runs. */
const BLOCKED = [
  "/panel/api/connections", "/panel/api/google/", "/panel/api/slack/", "/panel/api/zoom/", "/panel/api/teams/", "/panel/api/telegram/",
  "/panel/api/whatsapp/", "/panel/api/mail/connect", "/panel/api/mail/autoconfig", "/panel/api/mail/oauth", "/panel/api/calendar/local",
  "/panel/api/discovery", "/panel/api/people/import", "/panel/api/move", "/panel/api/autostart",
];

/**
 * Whether a request is one the demo refuses: a connection, an import, the export (nothing of the person's is here), and deleting everything
 * (it would empty the demo's folder only, and say the person's own data was gone).
 */
export function demoBlocks(method: string, raw: string): boolean {
  // As Express routes it: in any case of letters, with or without a slash at the end.
  const path = raw.toLowerCase().replace(/\/+$/, "");
  if (path === "/panel/api/export" || path === "/panel/api/move/export" || path === "/panel/api/delete-all") return true;
  if (method === "GET" || method === "HEAD") return false;
  return BLOCKED.some((p) => path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`) || path === p.replace(/\/$/, ""));
}

/** Guards the routes above while the demo runs; mounted before them. */
export function demoGuard(): RequestHandler {
  return (req, res, next) => {
    if (!demoBlocks(req.method, req.path)) return next();
    const path = req.path.toLowerCase().replace(/\/+$/, "");
    const error = path.endsWith("export") ? DEMO_TEXTS.noExport : path === "/panel/api/delete-all" ? DEMO_TEXTS.noDelete : DEMO_TEXTS.blocked;
    res.status(409).set("Cache-Control", "no-store").json({ error, demo: true });
  };
}

export interface DemoPanelDeps {
  signedIn: (req: Request) => boolean;
  /** The demo runs in this process. */
  on: boolean;
  /** Claude is signed in here (the bridge's word): the demo runs live. */
  live: () => boolean;
  /** Pako's real home (~/.pako): where the demo's folder is made and deleted. */
  home: string;
  /** Restarts Pako (src/server.ts app.locals.restart); `leaving`: the demo forced by PAKO_DEMO or --demo is not forced again. */
  restart?: (o?: { leaving?: boolean }) => boolean | void;
  now?: () => number;
}

/**
 *   GET  /panel/api/demo         -> { on, live }
 *   POST /panel/api/demo/start   -> { ok, restarting }   the demo's folder made, Pako starts again on it
 *   POST /panel/api/demo/leave   -> { ok, restarting }   the demo's folder deleted, Pako starts again on the real one
 * The panel's session and its x-pako header, as every change.
 */
export function mountDemoPanel(app: Express, d: DemoPanelDeps): void {
  const limiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });
  const auth = (change: boolean): RequestHandler => (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!d.signedIn(req) || (change && req.get("x-pako") !== "1")) return void res.status(401).json({ error: "sign in" });
    next();
  };
  const restartFn = (): ((o?: { leaving?: boolean }) => boolean | void) | null => {
    const r = d.restart ?? (app.locals.restart as unknown);
    return typeof r === "function" ? (r as (o?: { leaving?: boolean }) => boolean | void) : null;
  };
  const after = (res: express.Response, o: { leaving?: boolean }): boolean => {
    const r = restartFn();
    if (!r) return false;
    res.on("finish", () => setTimeout(() => {
      if (r(o) === false) log.error("Pako could not start again by itself: stop it and start it again");
    }, 200).unref?.());
    return true;
  };
  app.get("/panel/api/demo", auth(false), limiter, (_req, res) => {
    res.json({ on: d.on, live: d.on && d.live() });
  });
  app.post("/panel/api/demo/start", auth(true), limiter, (_req, res) => {
    if (d.on) return void res.json({ ok: true, restarting: false });
    try {
      demoStart(d.home, (d.now ?? Date.now)());
    } catch (err) {
      log.error(`could not start the demo: ${(err as Error).message}`);
      return void res.status(500).json({ error: "I couldn't start the demo week. Try again." });
    }
    res.json({ ok: true, restarting: after(res, {}) });
  });
  app.post("/panel/api/demo/leave", auth(true), limiter, (_req, res) => {
    demoLeave(d.home);
    res.json({ ok: true, restarting: d.on ? after(res, { leaving: true }) : false });
  });
}

/** The demo's mark, read: when it started (null: the demo is off). */
export function demoStartedAt(home: string): number | null {
  try {
    const v = JSON.parse(readFileSync(join(demoDir(home), DEMO_MARK), "utf8")) as { startedAt?: unknown };
    return typeof v.startedAt === "number" ? v.startedAt : null;
  } catch {
    /* no demo mark: not a demo */
    return null;
  }
}

/** Today's times the seed placed (for the chat's recorded answers); the morning's when the store has none. */
export async function demoTimes(kv: Kv): Promise<DemoTimes> {
  try {
    const v = ((await readJsonRecord(kv, DEMO_SEEDED_KEY)) ?? {}) as { times?: Partial<DemoTimes> };
    const t = v.times ?? {};
    return { ...MORNING_TIMES, ...Object.fromEntries(Object.entries(t).filter(([, x]) => typeof x === "string" && /^\d{2}:\d{2}$/.test(x))) };
  } catch {
    /* not JSON, or no store: the morning times */
    return MORNING_TIMES;
  }
}
