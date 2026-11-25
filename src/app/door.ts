// Wires the owner's door (src/whatsapp.ts mountWhatsapp) with every part it reaches, then what hangs on it: the person context, Pako
// Relay (both sides), the owner's notices for the store guard and the watchdog, and the bridge's health route on a server.

import { join } from "node:path";
import type { BriefV2 } from "../brief-v2.ts";
import { findLocalEvent } from "../calendar-local.ts";
import { pressSignIn } from "../claude-connect.ts";
import { demoCalendarWrites, demoSender } from "../demo.ts";
import { corruptNotice, onCorruptRecord } from "../json-record.ts";
import { labCode } from "../lab-code.ts";
import { pakoHome } from "../local.ts";
import { createLog } from "../log.ts";
import type { Verdict } from "../mail-categories.ts";
import { createPaperStore } from "../papers.ts";
import { createPersonContext } from "../person-context.ts";
import { mountBridgeHealth } from "../watchdog.ts";
import { mountWhatsapp } from "../whatsapp.ts";
import type { AfterChat } from "./context.ts";
import { PARTS } from "./texts.ts";

const logPanel = createLog("panel");
const logRelay = createLog("relay");
const logWhatsapp = createLog("whatsapp");

export function wireDoor(ctx: AfterChat) {
  const {
    app, env, local, uiLang, country, labs, waComputer, demo, dogRef, dog, kv, control, jobs, personal, wa, friends, plain, timeZone, givenName,
    ownerName, mail, outgoing, imap, imap2, box, mailAddress, slack, slackRef, fakeSlack, zoom, zoomRef, reviewCfg, reviewsDoor, macCal, relayClientCfg,
    relayRef, calDoorRef, calWrites, cal, calOn, calRef, backfillRef, briefCfg, briefNow, smartCfg, smartRef, followupsCfg, followupsRef, personRef,
    gentleRef, followupsDoor, mailFollowups, connectorsCfg, connectorsRef, proactiveCfg, lifeDoor, lessons, quality, rehearsalRef, judged, panelRef, booking, tgRef, usable, betaRef,
    fromEnv, learn, autonomyConfig, contactEmails, autonomySettings, claudeConnect, claudeKeeper, timeRef,
  } = ctx;
  const door = mountWhatsapp(app, {
    ...(claudeConnect ? { claudeSignIn: () => pressSignIn(claudeConnect, uiLang(), { refused: claudeKeeper?.refused() ?? false }) } : {}),
    jobs,
    autonomy: { config: autonomyConfig, settings: autonomySettings },
    contactEmails: () => contactEmails,
    // The emails the owner asks for: through Resend when it is set (src/resend.ts), else Pako's own AgentMail inbox (the API key needs
    // AgentMail's message_send permission).
    ...(outgoing ? { sendEmail: outgoing.send } : {}),
    // The demo week: an email the owner says yes to goes nowhere, and the chat says so.
    ...(demo && local ? { sendEmail: demoSender((text) => local.channel.push("pako", text)) } : {}),
    // The owner's country (read above): the emergency number and the crisis line a red flag gets (src/health.ts).
    country: country.country,
    // Health data local only: a server on the internet keeps the diary in memory (src/health.ts).
    healthOnDisk: !!local,
    // LABS: companion (the health diary, learning and the weekly check-in, src/companion.ts), and which labs the assistant is told are on.
    labs: labs.on("companion"),
    labsOn: labs.enabled(),
    lang: uiLang,
    ...(booking ? { booking } : {}),
    ...(waComputer ? { whatsapp: waComputer.line } : {}),
    // A getter, read by the door each time it needs Telegram: a channel set in the panel later is used at once, and until there is one the
    // door works exactly as with no Telegram set up (TELEGRAM is then words for the assistant, as before).
    get telegram() {
      return tgRef.channel ?? undefined;
    },
    // The photos and PDFs the owner sends (src/papers.ts): in ~/.pako/papers on a computer; a server on the internet keeps them in memory only.
    ...(local ? { local: local.channel, papers: createPaperStore({ dir: join(pakoHome(env), "papers") }) } : {}),
    config: wa.config,
    tools: personal.tools,
    memory: personal.memory,
    kv,
    control,
    panelLink: () => (panelRef.link ? panelRef.link() : PARTS(uiLang())("panelNotReady")),
    // Only a server on the internet that was given no address learns it, and only from what Meta signed.
    ...(!local && !fromEnv ? { onSigned: learn } : {}),
    ...(calOn
      ? {
          calendar: {
            day: (n: number) => (calRef.reader ? calRef.reader.day(n) : Promise.resolve("")),
            context: () => (calRef.reader ? calRef.reader.context() : Promise.resolve([])),
          },
        }
      : {}),
    brief: { now: briefNow, daily: briefCfg.at !== null },
    ...(followupsCfg.config ? { followups: followupsDoor } : {}),
    ...(connectorsCfg.config
      ? { connectors: { result: (id: string, items: unknown, e?: string) => connectorsRef.c ? connectorsRef.c.result(id, items, e) : Promise.resolve({ ok: false, kept: 0 }) } }
      : {}),
    gentle: {
      stepResult: (id: string, raw: string) => (gentleRef.steps ? gentleRef.steps.result(id, raw) : Promise.resolve({ ok: false })),
      anchorPressed: (id: string) => (gentleRef.anchors ? gentleRef.anchors.pressed(id) : Promise.resolve("👍")),
      // Check-ins (src/gentle-checkins.ts, for everyone) and the weekly reset (src/gentle-reset.ts), built with the jobs' clock below.
      checkinAdd: (o: { at?: string; inMin?: number; thing: string }) =>
        (gentleRef.checkins ? gentleRef.checkins.fromChat(o) : Promise.resolve({ ok: false, say: "" })),
      checkinForLoop: (id: string) => (gentleRef.checkins ? gentleRef.checkins.forLoop(id) : Promise.resolve("")),
      checkinButton: (id: string) =>
        (gentleRef.checkins ? gentleRef.checkins.loopButton(id, true) : Promise.reject(new Error("check-ins are not ready"))),
      checkinPressed: (b: "1" | "2" | "3", id: string) => (gentleRef.checkins ? gentleRef.checkins.pressed(b, id) : Promise.resolve("")),
      resetPressed: (what: string, id: string) => (gentleRef.reset ? gentleRef.reset.pressed(what, id) : Promise.resolve({ say: "" })),
      resetTyped: (n: number) => (gentleRef.reset ? gentleRef.reset.typedPark(n) : Promise.resolve(null)),
    },
    lessons,
    // The beta's audit questions (src/beta-audit.ts): Yes, No, Skip, then the next question.
    beta: {
      pressed: (a: "y" | "n" | "s", id: string) => (betaRef.audit ? betaRef.audit.pressed(a, id) : Promise.resolve(null)),
      next: () => (betaRef.audit ? betaRef.audit.next() : Promise.resolve(false)),
    },
    // Pako Relay, the laptop's side (src/relay-client.ts): built just below, once the door can list the reminders.
    ...(relayClientCfg.config
      ? { relay: { sync: () => (relayRef.c ? relayRef.c.sync() : Promise.resolve(false)), firedByRelay: (r: { id: string; at: number; text: string }) => relayRef.c?.firedByRelay(r) ?? false } }
      : {}),
    ...(demo && local
      ? {
          calendarWrites: demoCalendarWrites({
            events: () => (calRef.reader ? calRef.reader.load() : Promise.resolve([])),
            tell: (text) => local.channel.push("pako", text),
          }),
        }
      : {}),
    ...(macCal && calWrites
      ? {
          calendarWrites: {
            // A push in the last half hour from an app that writes: otherwise the change is a line for the owner to make.
            canWrite: async () => {
              const k = await macCal.read();
              return !!k?.writes && Date.now() - k.at < 30 * 60_000;
            },
            find: async (title: string, start: number) => {
              const k = await macCal.read();
              return k ? findLocalEvent(k, title, start) : null;
            },
            enqueue: (w: Parameters<typeof calWrites.enqueue>[0]) => calWrites.enqueue(w),
            get: (id: string) => calWrites.get(id),
            cancelQueued: () => calWrites.cancelQueued(),
          },
        }
      : {}),
    // Time to do it (src/time-to-do.ts): its card's buttons and "find time for <words>", once it is built with the jobs' clock.
    ...(followupsCfg.config
      ? {
          timeToDo: {
            pressed: (b: "b" | "a" | "n", id: string) => (timeRef.t ? timeRef.t.pressed(b, id) : Promise.resolve("")),
            findTime: (words: string) => (timeRef.t ? timeRef.t.findTime(words) : Promise.resolve("")),
            findTimeFor: (id: string) => (timeRef.t ? timeRef.t.findTimeFor(id) : Promise.resolve("")),
          },
          afterMeeting: {
            pressed: (what: "n" | "m", id: string) => (timeRef.after ? timeRef.after.pressed(what, id) : Promise.resolve("")),
          },
          shutdown: {
            pressed: (what: "p" | "d", n: number, id: string) => (timeRef.shutdown ? timeRef.shutdown.pressed(what, n, id) : Promise.resolve("")),
          },
        }
      : {}),
    ...(followupsCfg.config && smartCfg.config
      ? { draftFor: (o: Parameters<BriefV2["draftFor"]>[0]) => (smartRef.brief ? smartRef.brief.draftFor(o) : Promise.resolve(null)) }
      : {}),
    personContext: (who: string, o?: { exclude?: string[] }) => (personRef.c ? personRef.c.about(who, o) : Promise.resolve(null)),
    backfillAnswered: (id, o) => (backfillRef.b ? backfillRef.b.answered(id, o) : Promise.resolve(false)),
    ...(proactiveCfg.config ? { life: lifeDoor } : {}),
    ...(reviewCfg.config ? { reviews: reviewsDoor } : {}),
    // HEALTH / "how is Pako doing?": the Health card in words, and the Quality card's week when quality is on.
    status: { summary: async () => [dog.summary(), ...(quality ? [await quality.weekText(uiLang()).catch(() => "")] : [])] },
    ...(quality
      ? {
          quality: {
            press: (id: string) => quality.press(id, judged), answerText: (text: string) => quality.answerText(text), clearAsk: quality.clearAsk,
            missed: quality.missed, reopened: quality.reopened, missedText: (title: string | null) => quality.missedText(title),
          },
          rehearsal: {
            start: () => (rehearsalRef.r ? rehearsalRef.r.start() : Promise.resolve({ text: "" })),
            answer: (id: string, raw: string) => (rehearsalRef.r ? rehearsalRef.r.answer(id, raw) : Promise.resolve({ ok: false })),
            acked: (ids: string[]) => (rehearsalRef.r ? rehearsalRef.r.acked(ids) : Promise.resolve()),
          },
        }
      : {}),
    ...(smartCfg.config
      ? {
          briefTodos: () => (smartRef.brief ? smartRef.brief.openTodos() : Promise.resolve([])),
          briefJobs: {
            result: (id: string, raw: string) => (smartRef.brief ? smartRef.brief.result(id, raw) : Promise.resolve({ ok: false })),
            acked: (ids: string[], capable: boolean) => (smartRef.brief ? smartRef.brief.acked(ids, capable) : Promise.resolve()),
          },
        }
      : {}),
    ...(zoom.config
      ? {
          zoom: {
            upcoming: () => (zoomRef.reader ? zoomRef.reader.upcoming() : Promise.resolve([])),
            summaries: () => (zoomRef.reader ? zoomRef.reader.summaries() : Promise.resolve([])),
            annotate: (id: string, summary: string) => (zoomRef.reader ? zoomRef.reader.annotate(id, summary) : Promise.resolve(false)),
          },
        }
      : {}),
    ...(slack.config
      ? {
          slack: {
            search: (q: string) => (slackRef.reader ? slackRef.reader.search(q) : Promise.resolve([])),
            recent: () => (slackRef.reader ? slackRef.reader.recent() : Promise.resolve([])),
          },
        }
      : fakeSlack ? { slack: { search: fakeSlack.search, recent: fakeSlack.recent } } : {}),
    // Each send to Meta, for the watchdog (a computer has no WhatsApp).
    ...(!local ? { health: dog.reporter("whatsapp") } : {}),
    // What the watches look at (src/routines.ts): only what this server already has, read when they look (a part set up later counts).
    watchSources: () => ({
      ...(box ? { mail: () => box.items(60) } : {}),
      ...(calRef.reader ? { calendar: () => calRef.reader!.readAll() } : {}),
      ...(slackRef.reader ? { slack: () => slackRef.reader!.alerts() } : fakeSlack ? { slack: fakeSlack.alerts } : {}),
    }),
    get ownerName() {
      return ownerName();
    },
    timeZone,
    contacts: () => [...friends.values()].map((c) => c.name),
    contactByName: (name) => [...friends.values()].find((c) => plain(c.name) === plain(name)) ?? null,
    ...(box ? {
          mail: {
            address: mailAddress,
            recent: () => box.recent(timeZone),
            annotate: (id: string, kind: "aviso" | "guardado", summary: string, scam?: boolean, verdict?: Verdict) =>
              box.annotate(id, kind, summary, Date.now(), { ...(scam === undefined ? {} : { scam }), ...(verdict ? { verdict } : {}) }),
            notifies: (id: string) => box.notifies(id),
            replied: (id: string) => box.repliedById(id),
            get: (id: string) => box.get(id),
            ...(mailFollowups ? { followups: (id: string, o: Parameters<typeof mailFollowups.inbox>[1]) => mailFollowups.inbox(id, o) } : {}),
            digest: () => box.digest(timeZone),
          },
          // The one-time codes taken out of the mail (src/codes.ts), for the owner's CODE.
          codes: { recent: () => box.codes() },
        } : {}),
  });
  calDoorRef.result = (w) => door.calendarResult(w);
  // What the owner's memory says about a person (src/person-context.ts): one helper for the follow-up extraction, the drafts, the brief and
  // the meeting prep. Identities through the people graph; the open follow-ups once the engine is built (further down).
  personRef.c = createPersonContext({
    facts: () => door.facts.read(),
    graph: async () => (await door.peopleGraph.read()).persons,
    loops: () => (followupsRef.engine ? followupsRef.engine.open() : Promise.resolve([])),
    lessons: (q) => lessons.lines(q),
    timeZone, lang: uiLang,
    self: () => [givenName(), mail.config?.inbox, imap.config?.user, imap2.config?.user].filter((x): x is string => !!x),
  });
  if (relayClientCfg.config) {
    relayRef.c = labCode("relay").createRelayClient({ config: relayClientCfg.config, reminders: (until) => door.relayReminders(until) });
    relayRef.c.start();
    logRelay.info(`ON: reminders synced to ${new URL(relayClientCfg.config.url).host} every 2 min`);
  }
  // Relay mode (src/relay.ts): this server is the always-awake relay a laptop syncs to; it fires their reminders on Telegram.
  // LABS: relay. Off: this host is not a relay (no routes, no timer), and its code is not loaded (src/lab-code.ts).
  const relayCode = labs.on("relay") ? labCode("relay") : null;
  const relayCfg = relayCode ? relayCode.loadRelayConfig(env) : { config: null, problems: [] as string[] };
  if (relayCfg.problems.length) logRelay.error(relayCfg.problems.join("; "));
  if (relayCode && relayCfg.config) {
    const relay = relayCode.createRelay({ kv, send: relayCode.telegramSender(relayCfg.config) });
    relayCode.mountRelay(app, { relay, token: relayCfg.config.token });
    setInterval(() => void relay.tick().catch((err: Error) => logRelay.error(err.message)), 30_000).unref?.();
    logRelay.info("ON: relay mode, reminders fired on Telegram (POST /relay/sync, /relay/tick)");
  }
  const tellOwner = (text: string): Promise<unknown> => door.notifyOwner(text, { urgent: true });
  // A record of the store that no longer parses (src/json-record.ts): kept aside, then the owner told once, here.
  onCorruptRecord((c) => void door.notifyOwner(corruptNotice(c), { urgent: true }).catch(() => undefined));
  const tellAssistant: ((text: string) => void) | null = door.note;
  // The watchdog's notices: on Telegram first when it can reach the owner there (a server's WhatsApp may be the part that is down), else
  // as any urgent notice (a computer: Telegram when paired, with a copy in the panel's chat, which the Mac app notifies about).
  dogRef.tell = async (text) => {
    const tgUp = !local && !!tgRef.channel && (await tgRef.channel.reachable().catch(() => false));
    if (tgUp && (await door.tellOwner(text, "telegram"))) return;
    await door.notifyOwner(text, { urgent: true });
  };
  if (!local) {
    dogRef.lastPoll = () => door.lastPoll();
    dogRef.polled = () => door.polled();
    dog.watch("whatsapp");
    // The assistant's computer says how Claude is doing and which version it runs (on a computer the panel's own route takes it).
    mountBridgeHealth(app, { token: wa.config.bridgeToken, watchdog: dog });
  }
  // The store keeps Zoho's access (an ICS link keeps nothing there): only Zoho's can be lost with it.
  const parts = { mail: !!box, telegram: !!tgRef.channel, calendar: !!cal.zoho };
  // Local mode's terminal shows only its own banner (src/server.ts): these lines describe a server on the internet.
  if (!local) logWhatsapp.info("ON: the owner's messages are served at /whatsapp/webhook and /assistant/*");
  if (!local) {
    logPanel.info(`ON: sign-in links use ${fromEnv || "no address yet (the host of the first fresh webhook Meta signs, or set PUBLIC_URL)"}`);
    // PANEL tells the owner to set PUBLIC_URL: a value that is set but cannot be used must say why here.
    if ((env.PUBLIC_URL ?? "").trim() && !usable(env.PUBLIC_URL)) {
      logPanel.error("PUBLIC_URL is ignored: it must be this server's https address, like https://pako.example.com (no path, not localhost)");
    }
  }
  return { door, tellOwner, tellAssistant, parts };
}
