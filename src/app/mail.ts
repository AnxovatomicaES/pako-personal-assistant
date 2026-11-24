// Wires the mail readers: Pako's own inbox (AgentMail), the owner's mailbox by IMAP with its catch-up and sign-in tokens, the mail Apple
// Mail downloaded on this Mac, Teams, and Messages on this Mac.

import { createAppleMail, forgetAppleMail } from "../apple-mail.ts";
import { type BackfillChat, createBackfill } from "../backfill.ts";
import { runsInMacApp } from "../autostart.ts";
import { appliedAtStart, writeStored } from "../connections.ts";
import { createContactsStore } from "../contacts.ts";
import { createImapReader } from "../imap.ts";
import { createConnectorIntake } from "../connector-intake.ts";
import { createImessage, forgetImessage } from "../imessage.ts";
import { pakoHome } from "../local.ts";
import { createLog } from "../log.ts";
import { createTokenSource } from "../mail-oauth.ts";
import { mountMail } from "../mail.ts";
import { createTeams, engineSeen } from "../teams.ts";
import type { AfterProactive } from "./context.ts";

const logAppleMail = createLog("apple-mail");
const logImap = createLog("imap");
const logImessage = createLog("imessage");
const logConnectors = createLog("connectors");
const logMail = createLog("mail");
const logTeams = createLog("teams");

export function wireMail(ctx: AfterProactive) {
  const {
    app, env, local, uiLang, dog, kv, control, mail, imap, imapRef, appleMailCfg, appleMailRef, box, teamsCfg, teamsRef, imessageCfg, imessageRef, invites, backfillCfg, backfillRef, followupsCfg,
    connectorsCfg, connectorsRef, slack, followupsRef, followupsDoor, mailFollowups, lessons, door,
  } = ctx;
  if (mail.config && box) {
    mountMail(app, {
      config: mail.config, box, control, lang: uiLang, enqueue: (m) => door.inbox.add(m), health: dog.reporter("mail"),
      ...(mailFollowups ? { filed: (id, category) => mailFollowups.inbox(id, { category }) } : {}),
    });
    if (mail.config.pollMinutes > 0) dog.watch("mail");
    const every = mail.config.pollMinutes ? `listed every ${mail.config.pollMinutes} min` : "no listing";
    logMail.info(`ON: ${mail.config.inbox}, webhook at /email/webhook, ${every}`);
  }
  // A Teams catch-up's conversation goes to the follow-ups message by message, as Teams' live ones do.
  const backfillChat = async (c: BackfillChat): Promise<void> => {
    for (const m of c.msgs) await followupsRef.engine?.observeSlack({ channel: c.channel, ts: m.ts, at: m.at, who: m.who, where: c.where, direct: c.direct, text: m.text });
  };
  if (imap.config && box) {
    backfillRef.b = createBackfill({
      kv, config: backfillCfg.config, enqueue: (m) => door.inbox.add(m), lang: uiLang, notify: (text) => door.notifyOwner(text), chat: backfillChat,
      ...(followupsCfg.config ? { offer: (o) => (followupsRef.engine ? followupsRef.engine.offer(o) : Promise.resolve(false)) } : {}),
      ...(mailFollowups ? { sent: (m) => mailFollowups.sent(m) } : {}),
      keepUnread: (id, note) => box.annotate(id, "guardado", note),
    });
    backfillRef.b.start();
    const bf = backfillRef.b;
    // Signed in with Microsoft or Google (src/mail-oauth.ts): a fresh access token before each look; a refresh token the provider
    // replaces is kept where the panel keeps it, unless it was set in a file (then it is said, as for Zoom).
    const o = imap.config.oauth;
    const tokens = o
      ? createTokenSource({
          provider: o.provider, clientId: o.clientId, ...(o.clientSecret ? { clientSecret: o.clientSecret } : {}), refreshToken: o.refreshToken,
          keep: (t) => {
            if (!local || ((env.IMAP_REFRESH_TOKEN ?? "").trim() && !appliedAtStart().has("IMAP_REFRESH_TOKEN"))) {
              logImap.error("the provider gave a new refresh token, but IMAP_REFRESH_TOKEN is set outside the panel: sign in from the panel instead");
              return;
            }
            if (!writeStored(pakoHome(env), { IMAP_REFRESH_TOKEN: t })) logImap.error("could not keep the new refresh token");
          },
        })
      : null;
    imapRef.reader = createImapReader({
      backfill: { add: bf.add, addSent: bf.addSent, startLine: bf.startLine, days: backfillCfg.config.days },
      config: imap.config, kv, box, control, lang: uiLang, enqueue: (m) => door.inbox.add(m), health: dog.reporter("imap"),
      notify: (text) => door.notifyOwner(text),
      ownSent: (o) => lessons.ownSent(o),
      ...(mailFollowups ? { sentMail: (m) => mailFollowups.sent(m), filed: (id, category) => mailFollowups.inbox(id, { category }) } : {}),
      ...(invites ? { invites } : {}),
      ...(tokens ? { tokens: () => tokens.access(), forgetToken: () => tokens.forget() } : {}),
    });
    dog.watch("imap");
    imapRef.reader.start();
    logImap.info(`ON: ${imap.config.host}, read only, ${imap.config.folders.join(", ")}, every ${imap.config.pollMinutes} min`);
  }
  if (appleMailCfg.config && local && box) {
    // The same intake as IMAP's (src/mail-intake.ts): the mailbox, the triage, the follow-ups, the lessons and the invitations. No catch-up:
    // it starts from the moment it was turned on.
    appleMailRef.reader = createAppleMail({
      config: appleMailCfg.config, kv: local.kv, inApp: runsInMacApp(env), box, control, lang: uiLang, now: Date.now,
      enqueue: (m) => door.inbox.add(m), ownSent: (o) => lessons.ownSent(o),
      ...(mailFollowups ? { sentMail: (m) => mailFollowups.sent(m), filed: (id, category) => mailFollowups.inbox(id, { category }) } : {}),
      ...(invites ? { invites } : {}),
    });
    appleMailRef.reader.start();
    logAppleMail.info(`ON: read only, every ${appleMailCfg.config.pollMinutes} min${imap.config ? " (IMAP is on too: an email read both ways is taken once)" : ""}`);
  } else if (local) {
    void forgetAppleMail(local.kv).catch((err: Error) => logAppleMail.error(`could not forget where it was: ${err.message}`));
  }
  if (teamsCfg.config) {
    // The catch-up shares the mailbox's when there is one (one allowance, one pace); otherwise Teams gets its own.
    if (!backfillRef.b) {
      backfillRef.b = createBackfill({
        kv, config: backfillCfg.config, enqueue: (m) => door.inbox.add(m), lang: uiLang, notify: (text) => door.notifyOwner(text), chat: backfillChat,
      });
      backfillRef.b.start();
    }
    const bf = backfillRef.b;
    teamsRef.reader = createTeams({
      config: teamsCfg.config, kv, health: dog.reporter("teams"), notify: (text) => door.notifyOwner(text),
      observe: (m) => {
        void followupsRef.engine?.observeSlack(engineSeen(m));
      },
      ...(followupsCfg.config ? { offer: (o) => followupsDoor.offer(o) } : {}),
      catchUp: { days: backfillCfg.config.days, add: (c) => bf.addChat(c) },
      // Microsoft's new refresh token goes where the panel keeps it, unless it was set in a file (then it is said, as for Zoom).
      keep: (t) => {
        if (!local || ((env.TEAMS_REFRESH_TOKEN ?? "").trim() && !appliedAtStart().has("TEAMS_REFRESH_TOKEN"))) {
          logTeams.error("Microsoft gave a new refresh token, but TEAMS_REFRESH_TOKEN is set outside the panel: connect Teams from the panel instead");
          return;
        }
        if (!writeStored(pakoHome(env), { TEAMS_REFRESH_TOKEN: t })) logTeams.error("could not keep the new refresh token");
      },
    });
    dog.watch("teams");
    const teamsReader = teamsRef.reader;
    dog.probe(30 * 60_000, () => teamsReader.check());
    teamsReader.start();
    logTeams.info(`ON: ${teamsCfg.config.account || "connected"}, read only, every ${teamsCfg.config.pollMinutes} min`);
  }
  if (imessageCfg.config && local) {
    // Each new message of a chat goes to the follow-ups as a message of that conversation, the owner's own too (their promises, and what
    // closes an ask). Names come from the contacts imported from this Mac.
    const contacts = createContactsStore(local.kv);
    imessageRef.reader = createImessage({
      config: imessageCfg.config, kv: local.kv, inApp: runsInMacApp(env), paused: async () => (await control.paused()) !== null,
      contacts: async () => (await contacts.read()).people,
      observe: (m) => {
        void followupsRef.engine?.observeSlack({
          channel: m.channel, ts: m.ts, at: m.at, who: m.who, where: m.where, direct: m.direct, text: m.text, ...(m.mine ? { mine: true } : {}),
        });
      },
    });
    imessageRef.reader.start();
    logImessage.info(`ON: read only, every ${imessageCfg.config.pollMinutes} min`);
  } else if (local) {
    void forgetImessage(local.kv).catch((err: Error) => logImessage.error(`could not forget where it was: ${err.message}`));
  }
  if (connectorsCfg.config && followupsCfg.config && kv) {
    // Slack and Notion read through the owner's claude.ai connectors, by the bridge: messages go to the follow-ups as Slack's own do.
    connectorsRef.c = createConnectorIntake({
      kv, config: connectorsCfg.config, now: Date.now, enqueue: (m) => door.inbox.add(m), nativeSlack: !!slack.config,
      observe: (m) => followupsRef.engine ? followupsRef.engine.observeSlack(m) : Promise.resolve(),
      offer: (o) => followupsDoor.offer(o),
    });
    connectorsRef.c.start();
    logConnectors.info(`ON: ${connectorsCfg.config.sources.join(", ")} through claude.ai, read only, every ${connectorsCfg.config.everyMinutes} min`);
  }
}
