// Wires the owner's panel (src/dashboard.ts) and its cards: what is connected, the chat's hello, lists and tasks, meetings, people,
// autonomy, gentle mode, routines, papers, memory, mail and health.

import { mountAutonomyPanel } from "../autonomy.ts";
import { mountBetaAuditPanel } from "../beta-audit.ts";
import { type CalendarFreshness, mountDashboard } from "../dashboard.ts";
import { demoTimes, recordedAnswer } from "../demo.ts";
import { mountGentlePanel } from "../gentle.ts";
import { icsWhyText } from "../ics.ts";
import { mountTasksPanel } from "../lists.ts";
import type { BridgeHealth } from "../local.ts";
import { createLog } from "../log.ts";
import { mountMailPanel } from "../mail-panel.ts";
import { mountMeetingsPanel } from "../meeting-review.ts";
import { mountMemoryPanel } from "../memory-panel.ts";
import { mountPaperUpload } from "../papers-panel.ts";
import { mountPeoplePanel } from "../people.ts";
import { mountRoutinesPanel } from "../routines.ts";
import { type BridgeCli, type BridgeUsage, type BridgeVersion, mountHealthPanel } from "../watchdog.ts";
import type { AfterDoor } from "./context.ts";
import { HELLO, PARTS, TG } from "./texts.ts";

const logChat = createLog("chat");

export function wirePanel(ctx: AfterDoor) {
  const {
    app, config, env, local, uiLang, demo, dog, control, personal, wa, timeZone, givenName, ownerName, box, mailAddress, slack, slackRef, fakeSlack,
    zoom, reviewCfg, reviewRef, macCal, cal, calOn, calLabel, calRef, icsRef, invites, backfillRef, followupsCfg, followupsRef, gentleSettings,
    gentleRef, followupsDoor, panelRef, booking, betaRef, fromWindow, tgRef, publicUrl, autonomyConfig, autonomySettings, claudeDoor, claudeKeeper, door,
  } = ctx;
  // The owner's panel (src/dashboard.ts): PANEL on WhatsApp gives a one-time sign-in link.
  const telegramLine = () => {
    // On a computer, a bot that cannot be used here (Telegram refuses its token, or its news go to a server or another Pako) is as good
    // as none, as in the panel's Telegram card (src/telegram-panel.ts): never "connected", and no QR code to scan for nothing.
    const ch = local && tgRef.channel && (tgRef.channel.tokenRefused() || tgRef.channel.pollStopped()) ? null : tgRef.channel;
    const t = TG(uiLang());
    const on = !!ch && ch.pairedNow();
    return { key: "telegram", name: "Telegram", on, detail: !ch ? t("none") : on ? t("on") : t(local ? "pairQr" : "pairChat") };
  };
  const integrations = () => {
    const t = PARTS(uiLang());
    const brainOn = door.lastPoll() > 0 && Date.now() - door.lastPoll() < 90_000;
    return [
      local
        ? { key: "whatsapp", name: t("chat"), on: true, detail: t("chatHere") }
        : { key: "whatsapp", name: "WhatsApp", on: true, detail: "Meta Cloud API" },
      { key: "mac", name: t(local ? "brain" : "brainMac"), on: brainOn, detail: t(local ? "brainHere" : "brainOnMac") },
      local
        ? { key: "phone", name: t("phone"), on: false, detail: t("none") }
        : { key: "phone", name: t("phone"), on: true, detail: t(config.personalCaller?.live ? "live" : "dry") },
      { key: "mail", name: t("mail"), on: !!box, detail: box ? mailAddress : t("none") },
      { key: "calendar", name: t("calendar"), on: calOn, detail: calOn ? calLabel : t("none") },
      { key: "slack", name: "Slack", on: !!slack.config || !!fakeSlack, detail: t(slack.config || fakeSlack ? "readOnly" : "none") },
      { key: "zoom", name: "Zoom", on: !!zoom.config, detail: t(zoom.config ? "readOnly" : "off") },
      // On a computer Telegram is always listed: it is set up from the panel.
      ...(tgRef.channel || local ? [telegramLine()] : []),
    ];
  };
  // Local mode: the chat's first message, once, with the name given. On a first visit the panel's welcome asks for the name before
  // anything is tried, so the hello waits for its first save (the settings route calls it then).
  // One at a time, in order: two saves at once must not say it twice, nor the first one's early return lose the second.
  let saying: Promise<void> | null = null;
  const hello = (): Promise<void> => {
    // Each call after the one before (never joined to it): a run that waited for the name must not swallow the save that brings it.
    const run = (saying ?? Promise.resolve()).then(async () => {
      if (!local || (await local.channel.list(0)).length) return;
      const name = givenName();
      // The welcome is still asking for the name: a save without one (a second tab, an older page) does not say the hello before it.
      if (!name && local.settings && !local.settings.welcomed()) return;
      await local.channel.push("pako", HELLO(uiLang())(name ? "named" : "plain", { name }));
    }).catch((err: Error) => logChat.error(`the hello: ${err.message}`));
    saying = run;
    return run;
  };
  /** Claude signed in here (the bridge's word): the demo week runs live; otherwise its recorded outputs show. */
  const claudeLive = (): boolean => !!local && local.bridge.status().claude === "ok";
  const panel = mountDashboard(app, {
    secret: wa.config.bridgeToken,
    publicUrl,
    ...(local ? { demo: { on: !!demo, live: claudeLive } } : {}),
    get ownerName() {
      return ownerName();
    },
    lang: uiLang,
    ...(local?.settings
      ? {
          settings: {
            ...local.settings,
            name: givenName,
            // A setting decides these instead, and the panel does not ask for them.
            fixed: { name: /[^\s\u0000-\u001f\u007f]/.test(env.PAKO_NAME ?? "") },
            changed: hello,
          },
        }
      : {}),
    timeZone,
    control,
    stop: (at: number, line: string) => door.stop(at, line),
    memory: personal.memory,
    wa: { reminders: () => door.reminders(), events: () => door.events(), lastPoll: () => door.lastPoll() },
    ...(box ? { mail: { address: mailAddress, items: () => box.items() } } : {}),
    ...(booking ? { bookings: { list: () => booking.bookings() } } : {}),
    ...(local
      ? {
          chat: {
            list: (since: number) => local.channel.list(since),
            notices: (after: number) => local.channel.notices(after),
            status: () => local.bridge.status(),
            report: (claude: BridgeHealth) => {
              local.bridge.report?.(claude);
              void claudeKeeper?.reported(claude);
            },
            version: (v: BridgeVersion) => dog.bridgeReport({ version: v }),
            usage: (u: BridgeUsage) => dog.bridgeReport({ usage: u }),
            cli: (c: BridgeCli) => dog.bridgeReport({ cli: c }),
            ...(local.bridge.refresh ? { refresh: local.bridge.refresh } : {}),
            // What is typed in the window is a message from the owner, handled exactly like one that came by WhatsApp.
            send: async (text: string) => {
              await local.channel.push("you", text);
              // The demo week without Claude: a recorded answer, so the chat still shows what Pako would say.
              if (demo && local.bridge.status().claude !== "ok") return void (await local.channel.push("pako", recordedAnswer(text, await demoTimes(local.kv))));
              fromWindow({ type: "text", text: { body: text } });
            },
            press: async (id: string) => fromWindow({ type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: "" } } }),
          },
        }
      : {}),
    ...(slack.config ? { slack: { alerts: () => (slackRef.reader ? slackRef.reader.alerts() : Promise.resolve([])) } } : {}),
    ...(fakeSlack ? { slack: { alerts: fakeSlack.alerts } } : {}),
    ...(followupsCfg.config ? { loops: async () => (followupsRef.engine ? followupsRef.engine.open() : []) } : {}),
    gentle: async () => (await gentleSettings.view()) !== null,
    catchUp: async () => (backfillRef.b ? backfillRef.b.progress() : null),
    ...(calOn
      ? {
          calendar: {
            // The mail's invitations not yet on the calendar are shown too, tagged (src/invites.ts).
            events: async () => {
              const evs = calRef.reader ? await calRef.reader.load() : [];
              return invites ? invites.overlay(evs) : evs;
            },
            refresh: async () => {
              icsRef.source?.stale();
              if (calRef.reader) await calRef.reader.load(true);
            },
            sources: async () => {
              const out: CalendarFreshness[] = [];
              const mac = macCal && cal.mac ? await macCal.read().catch(() => null) : null;
              if (mac) out.push({ label: "Mac", lastSync: mac.at });
              for (const s of icsRef.source?.status() ?? []) {
                const google = /(^|\.)google\.com$/i.test(s.host);
                out.push({
                  label: google ? `Google link (${s.name})` : `${s.name} link`, lastSync: s.lastSync, ...(google ? { slow: true } : {}),
                  error: s.error ? icsWhyText(s.error, uiLang()) : null,
                });
              }
              return out;
            },
          },
        }
      : {}),
    integrations,
  });
  if (claudeKeeper) {
    claudeDoor.card = (body, buttons) => door.sendCard(body, buttons);
    claudeDoor.tell = (text) => door.notifyOwner(text, { urgent: true });
    // A look a minute after the start (the bridge settles first), then every three hours: the sign-in lasts weeks, so that is plenty to
    // catch one about to expire a day ahead.
    setTimeout(() => void claudeKeeper.tick(), 60_000).unref?.();
    setInterval(() => void claudeKeeper.tick(), 3 * 3600_000).unref?.();
  }
  // Lists and tasks in the panel: shown everywhere, ticked and removed only on a computer (a server's panel stays read only but STOP).
  mountTasksPanel(app, { signedIn: panel.signedIn, lists: door.lists, local: !!local, timeZone });
  // The meetings reviewed, with their summaries (a card only when Zoom is connected).
  mountMeetingsPanel(app, { signedIn: panel.signedIn, recent: reviewCfg.config ? () => (reviewRef.reviewer ? reviewRef.reviewer.recent() : Promise.resolve([])) : null });
  // The people in the owner's life: shown everywhere, corrected and forgotten only on a computer (with the chat's receipt and Deshacer).
  mountPeoplePanel(app, { signedIn: panel.signedIn, people: door.people, local: !!local });
  // Settings: whether messages, emails and calls go at once (with a window to undo) or ask first, and the window's seconds.
  mountAutonomyPanel(app, { signedIn: panel.signedIn, settings: autonomySettings, config: autonomyConfig });
  // Gentle mode's card in How Pako acts (src/panel/acts.js): the switch, the day's cap, the lead times and the Parked list.
  // The beta's audit opt-in (src/beta-audit.ts): its card in How Pako acts; built with the jobs' clock, so looked up when asked.
  mountBetaAuditPanel(app, { signedIn: panel.signedIn, audit: () => betaRef.audit });
  mountGentlePanel(app, {
    signedIn: panel.signedIn,
    settings: gentleSettings,
    standardMax: followupsCfg.config?.maxPerDay ?? 6,
    ...(followupsCfg.config
      ? {
          parked: async () => (await followupsDoor.parked!()).map((l) => ({ id: l.id, title: l.title, who: l.who, at: l.parkedAt ?? l.createdAt })),
          unpark: async (id: string) => (await followupsDoor.unpark!({ id })).ok,
          // What the weekly reset let go, and the store after 45 days parked (src/gentle-reset.ts): the Parked list's history.
          history: async () => (gentleRef.reset ? gentleRef.reset.history() : []),
        }
      : {}),
  });
  // Routines and watches the same way: listed everywhere, removed only on a computer.
  mountRoutinesPanel(app, { signedIn: panel.signedIn, routines: door.routines, local: !!local, timeZone });
  // A photo or a PDF put in the panel's chat (a computer only: a server's chat is WhatsApp, where the door takes them itself).
  if (local) mountPaperUpload(app, { signedIn: panel.signedIn, papers: door.papers, push: (t) => local.channel.push("you", t), ingest: fromWindow });
  // No address known yet: no link at all, and no one-time token made for nothing (PANEL says how to set PUBLIC_URL instead).
  const panelLink = (): string | null => (publicUrl() ? panel.link() : null);
  panelRef.link = panelLink;
  mountMemoryPanel(app, { signedIn: panel.signedIn, memory: personal.memory, editable: !!local, lang: uiLang, control });
  // The dashboard's "Needs you" preview, the Mail section's reader, Move to…, Done and the Mail settings (src/mail-panel.ts).
  mountMailPanel(app, {
    signedIn: panel.signedIn,
    box,
    timeZone,
    loops: () => {
      const engine = followupsRef.engine;
      return engine ? { all: async () => (await engine.read()).loops, doneFor: (ref) => engine.doneFor(ref), reopen: (ids) => engine.reopen(ids) } : null;
    },
    gentle: async () => (await gentleSettings.view()) !== null,
  });
  // The health of every part (src/watchdog.ts), for the Health card.
  mountHealthPanel(app, { signedIn: panel.signedIn, state: dog.state });
  return { hello, claudeLive, panel, panelLink };
}
