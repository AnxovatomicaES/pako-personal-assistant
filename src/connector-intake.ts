// The owner's Slack and Notion read through the connectors they already set up in claude.ai, with no setup of Pako's own: every few hours
// the bridge runs one read-only job per source on the owner's computer (assistant/bridge/connectors.ts), checks what it found against what
// the tools really returned, and posts it to /assistant/connector. Slack messages go to the follow-ups as Slack's own do; Notion pages as a
// meeting's notes. Off unless PAKO_CONNECTORS names the sources; Slack is skipped when Slack is connected natively.

import { randomBytes } from "node:crypto";
import type { Inbound } from "./door/inbox.ts";
import { CHANNEL, TS } from "./followups/record.ts";
import type { FollowupsDoor, SlackSeen } from "./followups/types.ts";
import type { Kv } from "./kv.ts";
import { createLog } from "./log.ts";

const log = createLog("connectors");

export type ConnectorSource = "slack" | "notion";
export interface ConnectorConfig {
  sources: ConnectorSource[];
  everyMinutes: number;
}
/** Inbox ids of the connector jobs: cx:<source>:<hex10>. */
export const CONNECTOR_JOB = /^cx:(slack|notion):[0-9a-f]{10}$/;
const KEY = "connector-intake";
const KEEP_SECONDS = 60 * 24 * 3600;
/** A job the bridge never answered (the computer was off) is asked again after this. */
const STALE_MS = 12 * 3600_000;
const SEEN_MAX = 2000;
const NOTION_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export function loadConnectorConfig(env: Record<string, string | undefined>): { config: ConnectorConfig | null; problems: string[] } {
  const raw = (env.PAKO_CONNECTORS ?? "").trim().toLowerCase();
  if (!raw || raw === "off") return { config: null, problems: [] };
  const problems: string[] = [];
  const names = [...new Set(raw.split(/[\s,]+/).filter(Boolean))];
  const bad = names.filter((n) => n !== "slack" && n !== "notion");
  if (bad.length) problems.push(`PAKO_CONNECTORS takes slack and notion, not ${bad.join(", ")}`);
  const rawEvery = (env.PAKO_CONNECTORS_EVERY_MIN ?? "").trim();
  const everyMinutes = rawEvery ? Number(rawEvery) : 240;
  if (!Number.isInteger(everyMinutes) || everyMinutes < 30 || everyMinutes > 1440) problems.push("PAKO_CONNECTORS_EVERY_MIN must be a whole number from 30 to 1440");
  return problems.length ? { config: null, problems } : { config: { sources: names as ConnectorSource[], everyMinutes }, problems };
}

interface SourceState {
  /** Where the next look starts (ms): set by the first look, moved to the time of each answered job. */
  mark?: number;
  asked?: number;
  pending?: string;
  /** What was already passed on (channel:ts, or a page's id:edited), newest last. */
  seen: string[];
}
type State = Partial<Record<ConnectorSource, SourceState>>;

export interface ConnectorDeps {
  kv: Kv;
  config: ConnectorConfig;
  now: () => number;
  enqueue: (m: Inbound) => Promise<boolean>;
  observe: (m: SlackSeen) => Promise<unknown>;
  offer?: FollowupsDoor["offer"];
  /** Slack is connected natively (src/slack.ts): the connector is not asked for it. */
  nativeSlack: boolean;
}

const line = (s: unknown, max: number): string => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

export function createConnectorIntake(d: ConnectorDeps) {
  const sources = d.config.sources.filter((s) => !(s === "slack" && d.nativeSlack));
  let timer: ReturnType<typeof setInterval> | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(f: () => Promise<T>): Promise<T> => {
    const p = chain.then(f, f);
    chain = p.catch(() => undefined);
    return p;
  };
  const read = async (): Promise<State> => {
    try {
      return JSON.parse((await d.kv.get(KEY)) ?? "{}") as State;
    } catch {
      // Unreadable: started again, and the next look only sets the mark.
      return {};
    }
  };
  const save = (s: State): Promise<void> => d.kv.set(KEY, JSON.stringify(s), KEEP_SECONDS);

  /** One look: each source with no job waiting, and whose time came, gets one. The first look only sets where the next one starts. */
  const look = (): Promise<number> =>
    locked(async () => {
      const s = await read();
      const t = d.now();
      let asked = 0;
      for (const src of sources) {
        const x: SourceState = s[src] ?? { seen: [] };
        s[src] = x;
        if (x.mark === undefined) {
          x.mark = t;
          continue;
        }
        if (x.pending && t - (x.asked ?? 0) < STALE_MS) continue;
        if (!x.pending && t - (x.asked ?? x.mark) < d.config.everyMinutes * 60_000) continue;
        const id = `cx:${src}:${randomBytes(5).toString("hex")}`;
        if (!(await d.enqueue({ id, at: t, text: "", connector: { source: src, since: x.mark } }).catch(() => false))) continue;
        x.pending = id;
        x.asked = t;
        asked++;
      }
      await save(s);
      return asked;
    });

  /**
   * The bridge's answer: what it found, already checked against the tools' own results there, taken again field by field here. An error
   * (not connected, over the budget) closes the job with nothing kept; the next one starts from the same mark.
   */
  const result = (id: string, items: unknown, error?: string): Promise<{ ok: boolean; kept: number }> =>
    locked(async () => {
      const src = CONNECTOR_JOB.exec(id)?.[1] as ConnectorSource | undefined;
      const s = await read();
      const x = src ? s[src] : undefined;
      if (!src || !x || x.pending !== id) return { ok: false, kept: 0 };
      const since = (x.mark ?? 0) - 60_000;
      const seen = new Set(x.seen);
      let kept = 0;
      for (const raw of Array.isArray(items) ? items.slice(0, 100) : []) {
        const m = (raw ?? {}) as Record<string, unknown>;
        if (src === "slack") {
          const channel = line(m.channel, 40);
          const ts = line(m.ts, 30);
          const text = typeof m.text === "string" ? m.text.slice(0, 4000) : "";
          const at = Math.round(Number(ts) * 1000);
          if (!CHANNEL.test(channel) || !TS.test(ts) || !text.trim() || at < since || seen.has(`${channel}:${ts}`)) continue;
          const thread = line(m.thread, 30);
          seen.add(`${channel}:${ts}`);
          await d.observe({
            channel, ts, at, who: line(m.who, 80) || "Slack", where: line(m.where, 120) || "Slack", direct: m.direct === true || channel.startsWith("D"), text,
            ...(TS.test(thread) && thread !== ts ? { thread } : {}), ...(m.mine === true ? { mine: true } : {}),
          });
          kept++;
        } else {
          const page = line(m.id, 40);
          const at = Date.parse(line(m.edited, 40));
          const text = typeof m.text === "string" ? m.text.trim().slice(0, 6000) : "";
          if (!NOTION_ID.test(page) || !Number.isFinite(at) || at < since || !text || seen.has(`${page}:${at}`) || !d.offer) continue;
          seen.add(`${page}:${at}`);
          if (await d.offer({ source: "meeting", ref: `notion:${page}`, label: `Notion · ${line(m.title, 100) || "page"}`, text, at })) kept++;
        }
      }
      if (error) log.info(`${src}: no look this time (${line(error, 80)})`);
      else x.mark = x.asked ?? x.mark;
      x.seen = [...seen].slice(-SEEN_MAX);
      delete x.pending;
      await save(s);
      if (kept) log.info(`${src}: ${kept} new for the follow-ups`);
      return { ok: true, kept };
    });

  return {
    look,
    result,
    start(): void {
      if (timer || !sources.length) return;
      void look().catch((err: Error) => log.error(`look failed: ${err.message}`));
      timer = setInterval(() => void look().catch((err: Error) => log.error(`look failed: ${err.message}`)), 5 * 60_000);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export type ConnectorIntake = ReturnType<typeof createConnectorIntake>;
