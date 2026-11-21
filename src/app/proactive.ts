// Wires proactive Pako (src/proactive.ts), the lessons and proactive panels, the rehearsal and the quality panel.

import { mountLessonsPanel } from "../lessons.ts";
import { createLog } from "../log.ts";
import { createProactive, mountProactivePanel } from "../proactive.ts";
import { mountQualityPanel } from "../quality.ts";
import { createRehearsal, mountRehearsalPanel } from "../rehearsal.ts";
import type { AfterFollowups } from "./context.ts";

const logProactive = createLog("proactive");

export function wireProactive(ctx: AfterFollowups) {
  const {
    app, local, uiLang, kv, control, timeZone, box, slack, slackRef, fakeSlack, zoom, zoomRef, calOn, calRef, smartCfg, smartRef, followupsCfg,
    followupsRef, gentleSettings, gentleRef, proactiveCfg, lifeRef, lessons, quality, rehearsalRef, door, panel, timeRef,
  } = ctx;
  if (proactiveCfg.config) {
    const pc = proactiveCfg.config;
    lifeRef.engine = createProactive({
      config: pc,
      kv,
      timeZone,
      local: !!local,
      control,
      lang: uiLang,
      ownerLanguage: () => door.language(),
      enqueue: (m) => door.inbox.add(m),
      card: (body, buttons, feedback) => door.sendCard(body, buttons, feedback),
      ...(quality ? { quality: quality.followups } : {}),
      lastOwner: () => door.lastOwner(),
      bridgeAlive: () => Date.now() - door.lastPoll() < 3 * 60_000,
      ...(calOn ? { calendar: () => (calRef.reader ? calRef.reader.load() : Promise.resolve([])) } : {}),
      ...(box ? { mail: () => box.items(40) } : {}),
      people: async () => (await door.people.store.read()).map((p) => p.name),
      fetch: globalThis.fetch,
      othersToday: async () => ((await followupsRef.engine?.spentToday?.()) ?? 0) + ((await gentleRef.checkins?.spentToday()) ?? 0)
        + ((await timeRef.t?.spentToday()) ?? 0),
      // Gentle mode's day: fewer in all, follow-ups' nudges and these together.
      cap: async () => (await gentleSettings.view())?.maxPerDay ?? null,
      addToList: async (name, item) => {
        const r = await door.lists.add(name, [item], Date.now());
        return r.added.length ? { ok: true, list: r.list } : { ok: false, list: r.list, why: r.full.length ? "full" : "already there" };
      },
      remind: (when, text) => door.remindAt(when, text),
      // The friend, health companion and teacher's candidates: the same check, budget, hours and topics (src/companion.ts).
      offers: () => door.companion.offers(),
    });
    lifeRef.engine.start();
    const where = pc.place ? "with the weather" : "no weather (PAKO_PLACE)";
    logProactive.info(`ON: every ${pc.everyMs / 60_000} min in its hours, at most ${pc.maxPerDay} a day, ${where}`);
  }
  mountProactivePanel(app, { signedIn: panel.signedIn, life: () => lifeRef.engine });
  mountLessonsPanel(app, { signedIn: panel.signedIn, lessons: () => lessons });
  if (quality) {
    rehearsalRef.r = createRehearsal({
      kv,
      timeZone,
      lang: uiLang,
      enqueue: (m) => door.inbox.add(m),
      drop: (ids) => door.inbox.ack(ids),
      bridgeAlive: () => Date.now() - door.lastPoll() < 3 * 60_000,
      followups: followupsCfg.config ? () => followupsRef.engine?.rehearse ?? null : null,
      brief: smartCfg.config ? () => smartRef.brief : null,
      ...(slack.config ? { slack: () => (slackRef.reader ? slackRef.reader.alerts() : Promise.resolve([])) } : {}),
      ...(fakeSlack ? { slack: fakeSlack.alerts } : {}),
      ...(box ? { mail: () => box.items(60) } : {}),
      ...(zoom.config ? { meetings: () => (zoomRef.reader ? zoomRef.reader.recent(2) : Promise.resolve([])) } : {}),
    });
  }
  mountRehearsalPanel(app, { signedIn: panel.signedIn, rehearsal: rehearsalRef.r });
  mountQualityPanel(app, {
    signedIn: panel.signedIn,
    quality,
    briefItem: async (doc, kind, i) => {
      const today = await smartRef.brief?.todayDoc();
      if (!today || today.id !== doc) return null;
      return (kind === "todo" ? today.todos[i]?.title : today.updates[i]?.title) ?? null;
    },
  });
}
