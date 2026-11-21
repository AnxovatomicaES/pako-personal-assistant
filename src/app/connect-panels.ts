// Wires the panel's connection pages: status and details, guided connects (mail, OAuth, Teams, Slack, Zoom), what the Mac found
// (discovery, contacts, its calendar and writes, Apple Reminders), the People directory, and the settings, labs, demo, autostart, data and move panels.

import { mountAutostartPanel } from "../autostart-panel.ts";
import { mountLocalCalendarPanel } from "../calendar-local.ts";
import { mountCalendarWrites } from "../calendar-writes.ts";
import { claudeStatusLine } from "../claude-connect.ts";
import { mountConnectSetup } from "../connect-setup.ts";
import { mountConnectionDetails } from "../connections-details.ts";
import { mountConnectionsPanel } from "../connections-panel.ts";
import { mountConnectionsStatus } from "../connections-status.ts";
import { createContactsStore, mountContactsPanel } from "../contacts.ts";
import { mountDataPanel } from "../data-panel.ts";
import { mountDemoPanel } from "../demo.ts";
import { createDiscoveryStore, mountDiscoveryPanel } from "../discovery.ts";
import type { Lang } from "../i18n.ts";
import { mountLabsPanel } from "../labs.ts";
import { pakoHome } from "../local.ts";
import { mountMailConnect } from "../mail-autoconfig.ts";
import { mountMailOAuth } from "../mail-oauth.ts";
import { mountMovePanel } from "../move.ts";
import { createRemindersStore, mountRemindersPanel } from "../reminders-local.ts";
import { createHiddenPeople, mountPeopleDirectory } from "../people-directory.ts";
import { mountAppleMailPanel } from "../apple-mail.ts";
import { mountImessagePanel } from "../imessage.ts";
import { mountSettingsPage } from "../settings-page.ts";
import { mountTeamsConnect } from "../teams-connect.ts";
import { createZoomLocal } from "../zoom-local.ts";
import type { AfterTelegram } from "./context.ts";

export function wireConnectPanels(ctx: AfterTelegram) {
  const {
    app, env, local, uiLang, labs, demo, dog, kv, control, timeZone, startName, givenName, mail, imap, imapRef, appleMailRef, box, slackRef, zoomRef, teamsRef, imessageRef,
    reviewRef, macCal, calWrites, cal, calOn, calRef, icsRef, smartCfg, smartRef, followupsCfg, followupsRef, placesRef, tgRef, claudeConnect, door,
    claudeLive, panel,
  } = ctx;
  // What a running reader says is wrong now: the mailbox's refused login, Messages without Full Disk Access.
  const imapProblem = (l: Lang) => ({
    imap: imapRef.reader?.problem(l) ?? null, applemail: appleMailRef.reader?.problem(l) ?? null, imessage: imessageRef.reader?.problem(l) ?? null,
  });
  // A calendar link and a Places key have no live check when saved: "connected" only once they have answered (the calendar's health part
  // read once; a Places search worked).
  const checked = () => ({
    calendar: (dog.state().parts.find((p) => p.key === "calendar")?.okAt ?? null) !== null,
    tables: placesRef.ok,
  });
  const saver = mountConnectionsPanel(app, local ? { signedIn: panel.signedIn, env, lang: uiLang, control, problems: imapProblem, checked } : null);
  // What the Mac found when the person said yes, and the guided connections built on it (src/discovery.ts and the modules it names).
  // The Mac app's own requests carry the bridge token it already has; the panel's carry its session.
  const discovery = local ? createDiscoveryStore(local.kv) : null;
  const contacts = local ? createContactsStore(local.kv) : null;
  const reminders = local ? createRemindersStore(local.kv) : null;
  const zoomLocal = local && discovery
    ? createZoomLocal({
        discovery, kv: local.kv, timeZone, control, lang: uiLang, enqueue: (m) => door.inbox.add(m),
        review: (m) => (reviewRef.reviewer ? reviewRef.reviewer.transcript(m) : Promise.resolve(null)),
      })
    : null;
  zoomLocal?.start();
  const appAuth = local ? { signedIn: panel.signedIn, appToken: local.bridgeToken } : null;
  mountDiscoveryPanel(app, appAuth && discovery && contacts && macCal
    ? {
        ...appAuth, store: discovery, lang: uiLang, control,
        forgetAlso: [() => macCal.forget(), () => contacts.forget(), () => zoomLocal?.forget() ?? Promise.resolve(), () => reminders?.forget() ?? Promise.resolve()],
      }
    : null);
  mountCalendarWrites(app, appAuth && calWrites ? { ...appAuth, writes: calWrites } : null);
  mountLocalCalendarPanel(app, appAuth && macCal && discovery
    ? {
        ...appAuth, calendar: macCal, timeZone, lang: uiLang, control, discovery,
        inUse: () => !!cal.mac,
        restart: () => (typeof app.locals.restart === "function" ? (app.locals.restart as () => boolean)() !== false : false),
        changed: () => void calRef.reader?.load(true).catch(() => undefined),
      }
    : null);
  // Apple Reminders as the phone-side copy of the follow-ups (src/reminders-local.ts): the engine looked up at each push, so one started
  // later counts. A completion there is the Done button's own press.
  mountRemindersPanel(app, appAuth && reminders
    ? {
        ...appAuth, store: reminders, timeZone, lang: uiLang, control,
        loops: () => {
          const e = followupsRef.engine;
          return e
            ? { loops: async () => (await e.read()).loops, done: (id) => e.press("1", id), reopen: (id) => e.reopen([id]), moveDue: (id, at) => e.moveDue(id, at) }
            : null;
        },
      }
    : null);
  mountContactsPanel(app, appAuth && contacts ? { ...appAuth, store: contacts, lang: uiLang, control } : null);
  // The People directory (src/people-directory.ts): computed from what Pako already holds here (the imported contacts, the identities met
  // in the mail, calendar, Slack and Zoom, the calendar's attendees, the stored mail, the open loops, the owner's own records and facts).
  mountPeopleDirectory(app, {
    signedIn: panel.signedIn, local: !!local, timeZone, hidden: createHiddenPeople(kv),
    sources: {
      ...(contacts ? { contacts: async () => (await contacts.read()).people } : {}),
      graph: async () => (await door.peopleGraph.read()).persons,
      ...(calOn ? { events: () => (calRef.reader ? calRef.reader.load() : Promise.resolve([])) } : {}),
      ...(box ? { mail: () => box.items(150) } : {}),
      ...(followupsCfg.config ? { loops: () => (followupsRef.engine ? followupsRef.engine.open() : Promise.resolve([])) } : {}),
      people: () => door.people.store.read(true),
      facts: () => door.facts.read(),
      self: () => [mail.config?.inbox, imap.config?.user].filter((x): x is string => !!x),
    },
    ...(smartCfg.config
      ? {
          prep: (o) => (smartRef.brief ? smartRef.brief.prepPerson(o) : Promise.resolve(null)),
          prepTask: (id) => (smartRef.brief ? smartRef.brief.task(id) : Promise.resolve(null)),
        }
      : {}),
  });
  mountMailConnect(app, appAuth ? { ...appAuth, lang: uiLang, saver } : null);
  // Microsoft and Google mail by signing in with the provider (OAuth with PKCE, the browser back to this computer).
  mountMailOAuth(app, appAuth ? { ...appAuth, env, saver } : null);
  // Teams with the same Microsoft app: one button, Teams' permissions added to the Microsoft sign-in (src/teams-connect.ts).
  mountTeamsConnect(app, appAuth ? { ...appAuth, env, saver, status: async () => (teamsRef.reader ? teamsRef.reader.status() : null) } : null);
  // "Connected as …" on the Slack and Zoom cards comes from the running readers (looked up when asked: they are built further down).
  mountConnectSetup(app, appAuth
    ? {
        ...appAuth, lang: uiLang, saver, env, claude: claudeConnect, ...(discovery ? { discovery } : {}),
        slackAccount: () => slackRef.reader?.account() ?? null,
        zoomAccount: () => zoomRef.reader?.account() ?? null,
      }
    : null);
  mountConnectionsStatus(app, appAuth
    ? {
        ...appAuth, env, lang: uiLang, dir: pakoHome(env), problems: imapProblem, health: dog.state,
        ...(claudeConnect ? { claude: (l: Lang) => claudeStatusLine(claudeConnect.view(), l) } : {}),
        ...(discovery ? { discovery } : {}),
        telegram: async () => {
          const ch = tgRef.channel;
          if (!ch || ch.tokenRefused() || ch.pollStopped()) return "no-token";
          return (await ch.paired().catch(() => false)) ? "paired" : "unpaired";
        },
        ...(macCal
          ? { macCalendar: async () => {
              const k = await macCal.read();
              return k ? { at: k.at, calendars: k.calendars.length, events: k.events.length } : null;
            } }
          : {}),
        ...(contacts ? { contacts: async () => (await contacts.read()).people.length } : {}),
      }
    : null);
  // Which account, server and calendars each connection is, never a secret (src/connections-details.ts).
  mountConnectionDetails(app, appAuth
    ? {
        ...appAuth, env, lang: uiLang, dir: pakoHome(env), timeZone, saver, ...(local?.icsNet ? { icsNet: local.icsNet } : {}),
        imap: (l) => imapRef.reader?.info(l) ?? null,
        checkMail: () => (imapRef.reader ? imapRef.reader.poll() : Promise.resolve(null)),
        ics: () => icsRef.source?.status() ?? [],
        ...(macCal
          ? { mac: async () => {
              const k = await macCal.read();
              return k ? { at: k.at, calendars: k.calendars, events: k.events.length } : null;
            } }
          : {}),
        slack: async () => (slackRef.reader ? slackRef.reader.identity() : null),
        teams: async () => (teamsRef.reader ? teamsRef.reader.status() : null),
        zoom: async () => {
          const last = zoomRef.reader ? (await zoomRef.reader.recent(30))[0] : undefined;
          return last ? { topic: last.topic, at: last.at } : null;
        },
        telegram: async () => {
          const ch = tgRef.channel;
          if (!ch) return null;
          const [bot, owner] = await Promise.all([ch.username().catch(() => null), ch.account().catch(() => null)]);
          return { bot, owner, paired: ch.pairedNow() };
        },
      }
    : null);
  // Mail on this Mac (src/apple-mail.ts): its card's state, and one look now after Full Disk Access was turned on.
  mountAppleMailPanel(app, appAuth ? {
    ...appAuth, lang: uiLang, mac: process.platform === "darwin", reader: () => appleMailRef.reader, imapOn: () => !!imapRef.reader,
  } : null);
  // Messages on this Mac (src/imessage.ts): its card's state, and one look now after Full Disk Access was turned on.
  mountImessagePanel(app, appAuth ? { ...appAuth, lang: uiLang, mac: process.platform === "darwin", reader: () => imessageRef.reader } : null);
  // The connections page the gear opens (src/panel/settings.*): a computer only.
  mountSettingsPage(app, { signedIn: panel.signedIn, lang: uiLang, local: !!local });
  // LABS: the panel's switches (Settings › Labs).
  if (local) mountLabsPanel(app, { signedIn: panel.signedIn, labs, dir: pakoHome(env) });
  if (local) mountDemoPanel(app, { signedIn: panel.signedIn, on: !!demo, live: claudeLive, home: local.demo?.home ?? pakoHome(env) });
  mountAutostartPanel(app, local ? { signedIn: panel.signedIn, env, lang: uiLang, control } : null);
  mountDataPanel(app, local ? { signedIn: panel.signedIn, env, lang: uiLang, control, store: local.kv, chat: local.channel } : null);
  // Moving from a server to a computer (src/move.ts): a server's panel gives the file, a computer's panel takes it in.
  mountMovePanel(app, {
    signedIn: panel.signedIn, env, lang: uiLang, control, dir: pakoHome(env),
    ...(local
      ? {
          mode: "computer" as const, store: local.kv,
          ...(local.settings ? { settings: { name: givenName, setName: local.settings.setName } } : {}),
        }
      // A server with no store (VOICE_RESULTS_URL unset) keeps everything in memory only: its file then has nothing to carry.
      : { mode: "server" as const, store: kv ?? { get: async () => null, set: async () => undefined }, server: { ownerName: startName, timeZone } }),
  });
}
