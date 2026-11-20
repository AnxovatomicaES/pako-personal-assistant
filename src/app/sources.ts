// Wires the owner's name and the settings of what Pako reads: the mail (AgentMail, Resend, IMAP), Slack, Zoom, Teams, the meeting
// review, the calendars (Zoho, ICS links, this Mac, Google, the demo's) and the mailbox catch-up, with the refs their readers fill later.

import { type Backfill, loadBackfillConfig } from "../backfill.ts";
import type { CalendarChanges } from "../calendar-changes.ts";
import { createLocalCalendar, hasLocalCalendar } from "../calendar-local.ts";
import { type CalendarWrite, createCalendarWrites } from "../calendar-writes.ts";
import { type CalendarReader, loadCalendarConfig, loadCalendarTiming } from "../calendar.ts";
import { demoCalendar, demoSlack } from "../demo.ts";
import { loadGoogleCalendarConfig } from "../google-calendar.ts";
import { createIcsSource, icsHosts, loadIcsConfig } from "../ics.ts";
import { type ImapReader, loadImapConfig } from "../imap.ts";
import { createInviteStore } from "../invites.ts";
import { STAND_IN_NAME } from "../local.ts";
import { createLog } from "../log.ts";
import { createMailbox, loadMailConfig, loadMailFilters } from "../mail.ts";
import { loadReviewConfig, type MeetingReviewer, type ReviewDoor } from "../meeting-review.ts";
import { loadRelayClientConfig, type RelayClient } from "../relay-client.ts";
import { chooseSender, loadResendConfig } from "../resend.ts";
import { loadSlackConfig, type SlackReader } from "../slack.ts";
import { loadTeamsConfig, type TeamsReader } from "../teams.ts";
import { loadZoomConfig, type ZoomReader } from "../zoom.ts";
import type { OwnerCtx } from "./context.ts";

const logBackfill = createLog("backfill");
const logCalendar = createLog("calendar");
const logImap = createLog("imap");
const logMail = createLog("mail");
const logRelay = createLog("relay");
const logReview = createLog("review");
const logSlack = createLog("slack");
const logTeams = createLog("teams");
const logZoom = createLog("zoom");

export function wireSources(ctx: OwnerCtx) {
  const { config, env, local, uiLang, labs, demo, kv } = ctx;
  const friends = config.personalCaller.contacts;
  const plain = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
  const timeZone = config.personalCaller.timeZone;
  // The owner's name, read each time: on a computer the one given in the panel applies at once (src/local.ts settings, where PAKO_NAME
  // wins); without one, the name the server started with, unless that was only the stand-in.
  const startName = config.personalCaller.ownerName;
  const startedNameless = !!local && startName === STAND_IN_NAME;
  const givenName = (): string => local?.settings?.name() || (startedNameless ? "" : startName);
  const ownerName = (): string => givenName() || STAND_IN_NAME;
  // The assistant's own email inbox (src/mail.ts): off unless the three AgentMail values are set.
  const mail = loadMailConfig(env);
  if (mail.problems.length) logMail.error(`off, because: ${mail.problems.join("; ")}`);
  // Sending from Pako's own domain (src/resend.ts): when set, the emails the owner asks for go out through Resend instead of the
  // AgentMail inbox; inbound mail stays with AgentMail or IMAP.
  const resend = loadResendConfig(env);
  if (resend.problems.length) logMail.error(`Resend off, because: ${resend.problems.join("; ")}`);
  const outgoing = chooseSender({ resend: resend.config, agentmail: mail.config });
  if (outgoing) logMail.info(`emails the owner asks for go out through ${outgoing.via === "resend" ? "Resend" : "AgentMail"}`);
  // The owner's own mailbox, read only by IMAP (src/imap.ts): off unless IMAP_HOST, IMAP_USER and IMAP_PASSWORD are set. Its mail joins the
  // same mailbox state as the inbox's (MAIL, the brief, the panel, the codes), so either one turns that on.
  const imap = loadImapConfig(env);
  if (imap.problems.length) logImap.error(`off, because: ${imap.problems.join("; ")}`);
  if (imap.config && mail.config) {
    logImap.info("Pako's inbox is on too: if that mailbox is forwarded there, stop forwarding it (an email whose forward changes it could come twice)");
  }
  const imapRef: { reader: ImapReader | null } = { reader: null };
  // A reply of the owner's found in their Sent mail closes the loops of the mail it answers (the follow-ups are built later: looked up then).
  const repliedRef: { close: (ids: string[]) => void } = { close: () => undefined };
  const box = mail.config || imap.config || demo
    ? createMailbox(kv, { showCodes: loadMailFilters(env).showCodes, lang: uiLang, onReplied: (ids) => repliedRef.close(ids) })
    : null;
  // Both addresses when both are read: the assistant's context and the panel say which mail it is.
  const mailAddress = demo ? "alex@northwind.example (demo)" : [mail.config?.inbox, imap.config?.user].filter(Boolean).join(", ");
  // The owner's Slack, read only (src/slack.ts): off unless the app's user token and signing secret are set.
  const slack = loadSlackConfig(env);
  if (slack.problems.length) logSlack.error(`off, because: ${slack.problems.join("; ")}`);
  const slackRef: { reader: SlackReader | null } = { reader: null };
  // The demo's Slack, read only from its own store: what the brief, the panel and the chat read instead of a real workspace.
  const fakeSlack = demo && local ? demoSlack(local.kv) : null;
  // The owner's Zoom, read only (src/zoom.ts): off unless the Server-to-Server app's values and the owner's Zoom email are set.
  const zoom = loadZoomConfig(env);
  if (zoom.problems.length) logZoom.error(`off, because: ${zoom.problems.join("; ")}`);
  const zoomRef: { reader: ZoomReader | null } = { reader: null };
  // The owner's Microsoft Teams, read only (src/teams.ts): off unless connected from the panel's Teams card (src/teams-connect.ts).
  const teamsCfg = loadTeamsConfig(env);
  if (teamsCfg.problems.length) logTeams.error(`off, because: ${teamsCfg.problems.join("; ")}`);
  const teamsRef: { reader: TeamsReader | null } = { reader: null };
  // Every meeting reviewed (src/meeting-review.ts): with Zoom, unless ZOOM_REVIEW=off. Built once the door is; the door reaches it here.
  const reviewCfg = zoom.config ? loadReviewConfig(env) : { config: null, problems: [] };
  if (reviewCfg.problems.length) logReview.error(`${reviewCfg.problems.join("; ")}`);
  const reviewRef: { reviewer: MeetingReviewer | null } = { reviewer: null };
  const reviewsDoor: ReviewDoor = {
    result: (id, raw) => (reviewRef.reviewer ? reviewRef.reviewer.result(id, raw) : Promise.resolve({ ok: false, todos: 0, loops: 0 })),
    acked: (ids) => (reviewRef.reviewer ? reviewRef.reviewer.acked(ids) : Promise.resolve()),
    settle: (id, text) => (reviewRef.reviewer ? reviewRef.reviewer.settle(id, text) : Promise.resolve()),
    command: () => (reviewRef.reviewer ? reviewRef.reviewer.command() : Promise.resolve("")),
    context: () => (reviewRef.reviewer ? reviewRef.reviewer.context() : Promise.resolve([])),
  };
  // The owner's calendar, read only (src/calendar.ts): Zoho when the Self Client's values are set, any calendar by its secret ICS link
  // (src/ics.ts, CALENDAR_ICS_URL), or both together. Off with neither.
  const zoho = loadCalendarConfig(env);
  const icsLinks = loadIcsConfig(env);
  if (zoho.problems.length) logCalendar.error(`${icsLinks.config ? "Zoho " : ""}off, because: ${zoho.problems.join("; ")}`);
  if (icsLinks.problems.length) logCalendar.error(`the ICS link is off, because: ${icsLinks.problems.join("; ")}`);
  const timing = loadCalendarTiming(env);
  // A wrong CALENDAR_REMIND_MINUTES turns the ICS links off too: said for them, as Zoho's line says it for Zoho.
  if (icsLinks.config && !timing.timing) logCalendar.error(`the ICS link is off, because: ${timing.problems.join("; ")}`);
  // On a computer, this Mac's calendars too (src/calendar-local.ts), once the Mac app has pushed them: a first push restarts Pako to add them.
  const macCal = local && !demo ? createLocalCalendar({ kv: local.kv }) : null;
  // This Mac's calendar written by its app (src/calendar-writes.ts): the queue the owner's yes on a card goes into; the door tells the result.
  // LABS: relay. Off: no sync timer to a relay.
  const relayClientCfg = labs.on("relay") ? loadRelayClientConfig(env) : { config: null, problems: [] as string[] };
  if (relayClientCfg.problems.length) logRelay.error(relayClientCfg.problems.join("; "));
  const relayRef: { c: RelayClient | null } = { c: null };
  const calDoorRef: { result: ((w: CalendarWrite) => Promise<void>) | null } = { result: null };
  const calWrites = macCal && local ? createCalendarWrites({ kv: local.kv, onResult: (w) => (calDoorRef.result ? calDoorRef.result(w) : Promise.resolve()) }) : null;
  // Google Calendar, connected with one button (src/google-calendar.ts): one more source of the same calendar.
  const googleCal = loadGoogleCalendarConfig(env);
  if (googleCal.problems.length) logCalendar.error(`Google Calendar is off, because: ${googleCal.problems.join("; ")}`);
  const cal = {
    zoho: zoho.config, ics: timing.timing ? icsLinks.config : null, mac: macCal && timing.timing && hasLocalCalendar(local!.kv) ? macCal : null,
    google: timing.timing ? googleCal.config : null,
    demo: demo && local && timing.timing ? demoCalendar(local.kv) : null,
  };
  const calOn = !!(cal.zoho || cal.ics || cal.mac || cal.google || cal.demo);
  // What the panel says is connected: the ICS links by their host only (the rest of a link is its secret).
  const calLabel = [cal.zoho ? `Zoho (${cal.zoho.dc})` : "", cal.ics ? `ICS: ${icsHosts(cal.ics.urls).join(", ")}` : "", cal.mac ? "Mac" : "", cal.google ? "Google" : "",
    cal.demo ? "Demo calendar" : ""]
    .filter(Boolean).join(" + ");
  const calRef: { reader: CalendarReader | null } = { reader: null };
  const calChangesRef: { c: CalendarChanges | null } = { c: null };
  // The private links' source, once built: its rows on the connections page and a broken link's line in the brief.
  const icsRef: { source: ReturnType<typeof createIcsSource> | null } = { source: null };
  // The owner's own addresses: their answer to an invitation is read from their attendee line.
  const myAddresses = (): string[] => [env.IMAP_USER, env.ZOOM_USER].map((x) => (x ?? "").trim().toLowerCase()).filter((x) => x.includes("@"));
  // Invitations caught from the owner's mail (src/invites.ts): on the dashboard before the calendar has them.
  const invites = imap.config ? createInviteStore({ kv, timeZone, me: myAddresses }) : null;
  // A new mailbox's catch-up (src/backfill.ts): its last days, quiet and paced; built with the reader, below.
  const backfillCfg = loadBackfillConfig(env);
  if (backfillCfg.problems.length) logBackfill.error(`${backfillCfg.problems.join("; ")}`);
  const backfillRef: { b: Backfill | null } = { b: null };
  return {
    friends, plain, timeZone, startName, givenName, ownerName, mail, outgoing, imap, imapRef, repliedRef, box, mailAddress, slack, slackRef,
    fakeSlack, zoom, zoomRef, teamsCfg, teamsRef, reviewCfg, reviewRef, reviewsDoor, timing, macCal, relayClientCfg, relayRef, calDoorRef, calWrites,
    cal, calOn, calLabel, calRef, calChangesRef, icsRef, myAddresses, invites, backfillCfg, backfillRef,
  };
}
