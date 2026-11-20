// Wires the mail readers: Pako's own inbox (AgentMail), the owner's mailbox by IMAP with its catch-up and sign-in tokens, and Teams.

import { type BackfillChat, createBackfill } from "../backfill.ts";
import { appliedAtStart, writeStored } from "../connections.ts";
import { createImapReader } from "../imap.ts";
import { pakoHome } from "../local.ts";
import { createLog } from "../log.ts";
import { createTokenSource } from "../mail-oauth.ts";
import { mountMail } from "../mail.ts";
import { createTeams } from "../teams.ts";
import type { AfterProactive } from "./context.ts";

const logImap = createLog("imap");
const logMail = createLog("mail");
const logTeams = createLog("teams");

export function wireMail(ctx: AfterProactive) {
  const {
    app, env, local, uiLang, dog, kv, control, mail, imap, imapRef, box, teamsCfg, teamsRef, invites, backfillCfg, backfillRef, followupsCfg,
    followupsRef, followupsDoor, mailFollowups, lessons, door,
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
        void followupsRef.engine?.observeSlack({ channel: m.channel, ts: m.ts, at: m.at, who: m.who, where: m.where, direct: m.direct, text: m.text });
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
}
