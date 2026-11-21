// Wires Pako on the owner's phone, on the same Wi-Fi (src/mobile-access.ts, src/mobile.ts, src/mobile-panel.ts): a computer only, off until
// the owner turns it on in Settings. What the phone's buttons do goes through the same calls as the chat's buttons (the follow-ups door's
// press, unpark and reopenClosed) and its "Draft a reply" through the same run as DRAFT; what it shows is what the panel reads.

import type { BriefV2 } from "../brief-v2.ts";
import type { Followups } from "../followups.ts";
import type { FollowupsDoor, Loop } from "../followups/types.ts";
import { createMobileAccess, createMobileListener } from "../mobile-access.ts";
import { createMobileApp, type MobileAction, type MobileLoop, type MobileToday } from "../mobile.ts";
import { mountMobilePanel, phoneUrl } from "../mobile-panel.ts";
import { createLog } from "../log.ts";
import type { AfterTelegram } from "./context.ts";

const logMobile = createLog("mobile");

/** Closed this recently, a loop is still offered back on the phone (Reopen). */
const CLOSED_SHOWN_MS = 2 * 24 * 3600_000;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

/** The phone's port: PAKO_PHONE_PORT, or the panel's port plus one. Never the panel's own. */
export function phonePort(env: Record<string, string | undefined>, port: number): number {
  const set = Number((env.PAKO_PHONE_PORT ?? "").trim());
  if (Number.isInteger(set) && set > 0 && set < 65536 && set !== port) return set;
  if ((env.PAKO_PHONE_PORT ?? "").trim()) logMobile.error("PAKO_PHONE_PORT must be a port number other than Pako's own: the default is used");
  return port + 1 < 65536 ? port + 1 : port - 1;
}

export interface MobileFeedDeps {
  /** The follow-ups engine, once it exists (null: follow-ups are off). */
  engine: () => Pick<Followups, "read" | "open" | "unpark" | "reopenClosed"> | null;
  /** The follow-ups door the chat's buttons press (src/door/buttons.ts: d.followups.press). */
  door: Pick<FollowupsDoor, "press">;
  /** The written brief, once it exists (null: it is off). */
  brief: () => Pick<BriefV2, "view" | "task"> | null;
  /** DRAFT's run for one loop (src/door/views.ts draftLoop). */
  draftLoop: (l: Loop) => Promise<{ id?: string; status: string } | null>;
  timeZone: string;
  name: () => string;
  gentle: () => Promise<boolean>;
  telegram: () => boolean;
  now?: () => number;
}

/** What the phone reads and presses (GET /m/api/today, POST /m/api/loop, POST /m/api/draft), from the engines the panel and the chat use. */
export function mobileFeed(d: MobileFeedDeps) {
  const now = d.now ?? Date.now;
  /** The draft asked from the phone for each loop: its task in the written brief (src/brief-v2.ts). */
  const drafts = new Map<string, string>();

  const slim = (l: Loop): MobileLoop => {
    const to = EMAIL.exec(l.who)?.[0];
    return {
      id: l.id, kind: l.kind, title: l.title, who: l.who, where: l.where.label, status: l.status, nudges: l.nudges,
      ...(l.dueAt ? { dueAt: l.dueAt } : {}), ...(l.lastCheck ? { lastCheck: l.lastCheck } : {}), ...(l.step ? { step: l.step } : {}),
      ...(l.parkedAt ? { parkedAt: l.parkedAt } : {}), ...(l.closedAt ? { closedAt: l.closedAt } : {}), ...(to ? { to } : {}),
    };
  };

  const today = async (): Promise<MobileToday> => {
    const t = now();
    const engine = d.engine();
    const brief = d.brief();
    const view = brief ? await brief.view().catch(() => null) : null;
    // The drafts written for to-dos of today's brief, by their loop; then the ones asked from the phone.
    const written = new Map<string, { status: string; text: string }>();
    for (const task of view?.tasks ?? []) {
      const loopId = task.kind === "draft" && task.ref !== undefined ? view?.doc?.todos[task.ref]?.loopId : undefined;
      if (loopId) written.set(loopId, { status: task.status, text: task.text });
    }
    for (const [loopId, taskId] of drafts) {
      const task = brief ? await brief.task(taskId).catch(() => null) : null;
      if (task) written.set(loopId, { status: task.status, text: task.text });
      else drafts.delete(loopId);
    }
    const withDraft = (l: Loop): MobileLoop => {
      const w = written.get(l.id);
      return { ...slim(l), ...(w ? { draft: w } : {}) };
    };
    const all = engine ? (await engine.read()).loops : [];
    return {
      now: t,
      timeZone: d.timeZone,
      name: d.name(),
      gentle: await d.gentle().catch(() => false),
      brief: view ? { doc: view.doc, latest: view.latest, pending: view.pending } : null,
      loops: engine ? (await engine.open()).slice(0, 60).map(withDraft) : null,
      parked: all.filter((l) => l.status === "parked").sort((a, b) => (b.parkedAt ?? 0) - (a.parkedAt ?? 0)).slice(0, 30).map(slim),
      closed: all.filter((l) => l.status === "done" && l.closedAt && t - l.closedAt < CLOSED_SHOWN_MS)
        .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).slice(0, 15).map(slim),
      telegram: d.telegram(),
      drafts: !!brief,
    };
  };

  /**
   * The chat's buttons, by name: Done (f1), In 1 h (f2), Tomorrow (f6), Park (f7), through the follow-ups door as a press in the chat goes;
   * Reopen as the chat's "bring back" (a parked one) and its undo of a close (a done one) do it.
   */
  const act = async (id: string, action: MobileAction): Promise<{ ok: boolean; say: string }> => {
    const engine = d.engine();
    if (!engine) return { ok: false, say: "Follow-ups are off." };
    const l = (await engine.read()).loops.find((x) => x.id === id);
    if (!l) return { ok: false, say: "That is no longer on your list." };
    if (action === "reopen") {
      if (l.status === "parked") return engine.unpark({ id });
      if (l.status !== "done") return { ok: false, say: "That is open already." };
      const back = await engine.reopenClosed([{ id, title: l.title, status: "open", nextCheckAt: 0 }]);
      return back.length ? { ok: true, say: `Back on your open list: “${l.title}”.` } : { ok: false, say: "That could not be reopened." };
    }
    const button = action === "done" ? "1" : action === "snooze" ? "2" : action === "tomorrow" ? "6" : "7";
    const before = `${l.status}@${l.nextCheckAt}`;
    const say = await d.door.press(button, id);
    const after = (await engine.read()).loops.find((x) => x.id === id);
    return { ok: !!after && `${after.status}@${after.nextCheckAt}` !== before, say };
  };

  const draft = async (id: string): Promise<{ ok: boolean; say: string }> => {
    const engine = d.engine();
    const l = engine ? (await engine.open()).find((x) => x.id === id) : undefined;
    if (!l) return { ok: false, say: "That is no longer on your open list." };
    const task = await d.draftLoop(l);
    if (!task || task.status === "failed") return { ok: false, say: "I couldn't ask for a draft just now. Is the assistant's computer on?" };
    if (task.id) drafts.set(id, task.id);
    return { ok: true, say: "Writing a draft. It shows here in a minute or so." };
  };

  return { today, act, draft };
}

export function wireMobile(ctx: AfterTelegram) {
  const { app, env, local, config, kv, control, timeZone, givenName, gentleSettings, followupsRef, followupsDoor, smartRef, smartCfg, tgRef, door, panel } = ctx;
  if (!local) return { mobile: null, phoneLink: (): string | null => null };
  const port = phonePort(env, config.port);
  const access = createMobileAccess({ kv });
  const telegram = (): boolean => !!tgRef.channel && tgRef.channel.pairedNow();
  const feed = mobileFeed({
    engine: () => followupsRef.engine,
    door: followupsDoor,
    brief: () => smartRef.brief,
    draftLoop: (l) => door.draftLoop(l),
    timeZone,
    name: givenName,
    gentle: async () => (await gentleSettings.view()) !== null,
    telegram,
  });
  const listener = createMobileListener({
    port: () => port,
    handler: createMobileApp({
      access,
      hosts: () => listener.listening(),
      today: feed.today,
      act: feed.act,
      draft: smartCfg.config ? feed.draft : null,
      log: (text) => control.log("phone", text),
    }),
  });
  mountMobilePanel(app, { signedIn: panel.signedIn, access, listener, port: () => port, telegram, control });
  return {
    /** Started once the server listens, only when the owner turned it on; stopped on shutdown (src/app.ts). */
    mobile: {
      start: async () => {
        if (await access.enabled().catch(() => false)) await listener.start();
      },
      stop: () => listener.stop(),
    },
    /** The phone's page while it listens, for the brief's line in the chat; null otherwise. */
    phoneLink: (): string | null => phoneUrl(listener, port),
  };
}
