// Slack with the user token alone: Pako looks for the owner's new messages itself, once a minute, so connecting Slack needs no app-level
// token (xapp-, which only Slack's app page can make) and no public address. What it finds goes into the same handler as Slack's live
// events (src/slack.ts), so a message reads the same whichever way it came.
//
// Two kinds of message matter for what the owner was asked or promised:
// - Direct messages and group DMs. The list of them comes from conversations.list (every ten rounds); each one's new messages come from
//   conversations.history, after the last one seen there (the owner's own too: src/slack.ts reads them for the owner's promises). At most
//   `perRound` conversations are read in a round: those with news in the last two days, then the rest in turn (a third of the round stays
//   for the quiet ones, and more busy ones than fit are read in turn too). With hundreds of DMs, a quiet one is read every few minutes and a
//   busy one every minute or two, well inside the limits of an app made by its own workspace (Slack's Tier 3, 50+ a minute). One
//   conversation Slack will not show is passed by; its rate limit ends the round's DMs, and that one is read first next round.
//   A conversation with more new messages than one call gives (Slack's own page, or the project's app's one call a minute) is read newest
//   first, and what is left unread is kept as a span (`backlog`: after what, before what) that is read before anything newer next time.
// - Mentions of the owner in channels, from search.messages (one call every other round), after a mark kept a few minutes behind the
//   newest one seen: Slack's search shows each channel's messages when it has indexed them, so one can show up after a newer one from
//   another channel. The ones taken in that stretch are remembered (channel and ts), so none is taken twice.
//
// Only what came after Slack was connected is taken: the first round marks where to start and nothing older is looked at, so a new
// connection never floods the follow-ups with last year's DMs. Where each conversation stands is kept in the store, so a restart picks up
// where it left off. Slack text is other people's words: information for the owner, never instructions.

import type { Kv } from "./kv.ts";
import type { SlackEvent } from "./slack.ts";
import { createLog } from "./log.ts";
import { readJsonRecord } from "./json-record.ts";

const log = createLog("slack");

const STATE_KEY = "slack-poll";
const HOT_MS = 2 * 24 * 3600_000;
const KEEP_DAYS = 60;
/** How far behind the newest mention the mark stays: search shows a channel's message late, and one late behind a newer one is still found. */
const MENTION_LAG_MS = 10 * 60_000;
/** The most mentions remembered as taken (those behind the mark are forgotten as it moves, so this is only a bound). */
const SEEN_MAX = 200;

interface PollState {
  /** Slack ts of the moment this started: no conversation is read from before it. */
  start: string;
  /** The last message ts seen in each DM or group DM. */
  after: Record<string, string>;
  /** The mark for mentions: those after it are looked at. It stays MENTION_LAG_MS behind the newest one taken, never before `start`. */
  mentions: string;
  /** The mentions taken since the mark, "channel:ts": the stretch behind the newest one is looked at again, and these are not taken twice. */
  seen: string[];
  /** When each conversation last had something new (ms): those read every round. */
  active: Record<string, number>;
  /**
   * The older messages of a conversation that a look could not reach (a later page Slack, or Pako's own gate, did not give): the span after
   * `oldest` and before `latest` (Slack ts, both left out), read first next time. One span a conversation: nothing newer is read until it is.
   */
  backlog: Record<string, Gap>;
}
interface Gap {
  oldest: string;
  latest: string;
}

export interface SlackPollDeps {
  /** Slack's Web API with the user token (src/slack.ts api): throws on any refusal. */
  api: (method: string, params: Record<string, string>) => Promise<Record<string, unknown>>;
  /** The owner's own Slack id (auth.test), or null when Slack cannot say. */
  self: () => Promise<string | null>;
  /** One message, as if Slack's events had sent it (src/slack.ts handle). */
  deliver: (e: SlackEvent) => Promise<void>;
  kv: Kv | null;
  now?: () => number;
  /** How often to look (a minute; the tests call round() themselves). */
  everyMs?: number;
  /** At most this many conversations read in one round (15). */
  perRound?: number;
}

/** A Slack ts ("1700000000.000100") for a time in ms. */
export const slackTs = (ms: number): string => (ms / 1000).toFixed(6);
const later = (a: string, b: string): boolean => Number(a) > Number(b);

/** The thread a search result belongs to, from its permalink (search results carry no thread_ts of their own). */
export const threadOf = (permalink: unknown): string | undefined => {
  if (typeof permalink !== "string") return undefined;
  const m = /[?&]thread_ts=(\d{1,12}\.\d{1,8})/.exec(permalink);
  return m?.[1];
};

/** The spans kept, read field by field (a value kept by an older version, or damaged, is left out). */
const gapsOf = (v: Record<string, unknown>): Record<string, Gap> => {
  const out: Record<string, Gap> = {};
  for (const [id, g] of Object.entries(v)) {
    const x = g as Partial<Gap> | null;
    if (/^[CDG][A-Z0-9]{2,30}$/.test(id) && typeof x?.oldest === "string" && typeof x.latest === "string" && later(x.latest, x.oldest)) out[id] = { oldest: x.oldest, latest: x.latest };
  }
  return out;
};

export function createSlackPoll(d: SlackPollDeps) {
  const now = d.now ?? Date.now;
  const perRound = d.perRound ?? 15;
  let state: PollState | null = null;
  let convs: { id: string; type: "im" | "mpim" }[] = [];
  let rounds = 0;
  let turn = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let first: ReturnType<typeof setTimeout> | null = null;
  let busy = false;

  const load = async (): Promise<PollState> => {
    if (state) return state;
    let s: PollState | null = null;
    try {
      const raw = d.kv ? await readJsonRecord(d.kv, STATE_KEY) : null;
      const p = raw ? (raw as Partial<PollState>) : null;
      if (p && typeof p.start === "string") {
        s = {
          start: p.start,
          after: p.after && typeof p.after === "object" ? (p.after as Record<string, string>) : {},
          mentions: typeof p.mentions === "string" ? p.mentions : p.start,
          seen: Array.isArray(p.seen) ? p.seen.filter((k): k is string => typeof k === "string").slice(-SEEN_MAX) : [],
          active: p.active && typeof p.active === "object" ? (p.active as Record<string, number>) : {},
          backlog: p.backlog && typeof p.backlog === "object" ? gapsOf(p.backlog as Record<string, unknown>) : {},
        };
      }
    } catch (err) {
      // The store did not answer (a damaged value is kept aside and reads as none, above): no round until it does. Starting from now
      // would skip everything that came while Pako was off, and the next save would write that over the place kept.
      log.error(`the poll's place could not be read, no look until it can: ${(err as Error).message}`);
      throw err;
    }
    const start = slackTs(now());
    state = s ?? { start, after: {}, mentions: start, seen: [], active: {}, backlog: {} };
    return state;
  };
  const save = async (): Promise<void> => {
    if (!state || !d.kv) return;
    // A conversation quiet for two months is forgotten: it is read from the start mark again, which is still before anything new in it.
    const cut = now() - KEEP_DAYS * 24 * 3600_000;
    for (const [id, at] of Object.entries(state.active)) if (at < cut) delete state.active[id];
    // The same for a span that old: it is not news any more, and one that can never be read must not stay for ever.
    for (const [id, g] of Object.entries(state.backlog)) if (Number(g.latest) * 1000 < cut) delete state.backlog[id];
    await d.kv.set(STATE_KEY, JSON.stringify(state), KEEP_DAYS * 24 * 3600).catch((err: Error) => log.error(`could not keep the poll's place: ${err.message}`));
  };

  const list = async (): Promise<void> => {
    const out: typeof convs = [];
    let cursor = "";
    for (let page = 0; page < 5; page++) {
      const j = await d.api("conversations.list", { types: "im,mpim", exclude_archived: "true", limit: "200", ...(cursor ? { cursor } : {}) });
      for (const c of (Array.isArray(j.channels) ? j.channels : []) as { id?: unknown; is_im?: unknown; is_mpim?: unknown }[]) {
        if (typeof c.id === "string" && /^[CDG][A-Z0-9]{2,30}$/.test(c.id)) out.push({ id: c.id, type: c.is_mpim === true ? "mpim" : "im" });
      }
      cursor = String((j.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor ?? "");
      if (!cursor) break;
    }
    convs = out;
  };

  /**
   * This round's conversations: every one with news in the last two days, then the others in turn, up to perRound. More busy ones than a
   * round reads are read in turn too, so none of them waits for the others to go quiet. `back(c)`: a conversation Slack did not let this
   * round read (its rate limit) is the first of the next round, instead of waiting for its turn to come round again.
   */
  let hotTurn = 0;
  const pick = (s: PollState): { chosen: typeof convs; back: (c: (typeof convs)[number]) => void } => {
    const t = now();
    // One or two a look (the project's app before it is in the Slack Marketplace): every conversation in turn, so a busy one cannot keep
    // the others from ever being read.
    if (perRound <= 2) {
      const chosen = convs.length ? Array.from({ length: Math.min(perRound, convs.length) }, (_, i) => convs[(turn + i) % convs.length]!) : [];
      turn = convs.length ? (turn + chosen.length) % convs.length : 0;
      return { chosen, back: (c) => void (turn = Math.max(0, convs.indexOf(c))) };
    }
    const busy = convs.filter((c) => t - (s.active[c.id] ?? 0) < HOT_MS);
    const cold = convs.filter((c) => !busy.includes(c));
    // A third of the round stays for the quiet ones while there are any, so a news in one of them is never held back by the busy ones.
    const cap = cold.length ? perRound - Math.max(1, Math.floor(perRound / 3)) : perRound;
    let hot = busy;
    if (busy.length > cap) {
      hot = Array.from({ length: cap }, (_, i) => busy[(hotTurn + i) % busy.length]!);
      hotTurn = (hotTurn + cap) % busy.length;
    } else hotTurn = 0;
    const room = perRound - hot.length;
    const chosen = [...hot];
    for (let i = 0; i < Math.min(room, cold.length); i++) chosen.push(cold[(turn + i) % cold.length]!);
    turn = cold.length ? (turn + Math.max(room, 0)) % cold.length : 0;
    return {
      chosen,
      back: (c) => {
        if (cold.includes(c)) turn = cold.indexOf(c);
        else if (busy.length > cap) hotTurn = busy.indexOf(c);
      },
    };
  };

  type Msg = SlackEvent & { bot_id?: string };
  /**
   * A conversation's messages after `after` (and before `latest`, when given). Slack gives the newest first, a page at a time: the pages after
   * the first are followed too. A later page Slack refuses (its rate limit, or Pako's own gate for the project's app), and a conversation of
   * more pages than are followed, leave what was read, so the newest ones are not held back for it; the span still unread comes back as `gap`
   * (after `after`, before the oldest message read), for the next look.
   */
  const historyAfter = async (channel: string, after: string, latest?: string): Promise<{ msgs: Msg[]; gap: Gap | null }> => {
    const out: Msg[] = [];
    let cursor = "";
    for (let page = 0; page < 5; page++) {
      let j: Record<string, unknown>;
      try {
        j = await d.api("conversations.history", { channel, oldest: after, ...(latest ? { latest } : {}), limit: "200", ...(cursor ? { cursor } : {}) });
      } catch (err) {
        if (!page) throw err;
        log.error(`the older messages of a conversation could not be read yet: ${(err as Error).message}`);
        break;
      }
      out.push(...((Array.isArray(j.messages) ? j.messages : []) as Msg[]));
      cursor = j.has_more === true ? String((j.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor ?? "") : "";
      if (!cursor) return { msgs: out, gap: null };
    }
    const oldestRead = out.reduce<string | null>((min, m) => (typeof m.ts === "string" && (min === null || later(min, m.ts)) ? m.ts : min), null);
    return { msgs: out, gap: oldestRead && later(oldestRead, after) ? { oldest: after, latest: oldestRead } : null };
  };
  /** Hands the messages on, oldest first as they were written; how many were someone else's. */
  const handOn = async (c: (typeof convs)[number], msgs: Msg[], self: string): Promise<number> => {
    msgs.sort((a, b) => Number(a.ts) - Number(b.ts));
    let found = 0;
    for (const m of msgs) {
      // The owner's own messages go too: src/slack.ts never tells them back, but reads them for what the owner promises.
      await d.deliver({ ...m, type: "message", channel: c.id, channel_type: c.type }).catch((err: Error) => log.error(`a message could not be handled: ${err.message}`));
      if (m.user !== self) found++;
    }
    return found;
  };
  const readDms = async (s: PollState, self: string): Promise<number> => {
    let found = 0;
    const { chosen, back } = pick(s);
    for (const c of chosen) {
      try {
        // What an earlier look could not reach comes first, and nothing newer is read until all of it is: a second span would have to be kept.
        const gap = s.backlog[c.id];
        if (gap) {
          const r = await historyAfter(c.id, gap.oldest, gap.latest);
          const older = r.msgs.filter((m) => typeof m.ts === "string" && later(m.ts, gap.oldest) && later(gap.latest, m.ts));
          found += await handOn(c, older, self);
          if (r.gap) s.backlog[c.id] = r.gap;
          else delete s.backlog[c.id];
          if (older.length) s.active[c.id] = now();
          if (r.gap) continue;
        }
        const after = s.after[c.id] ?? s.start;
        const r = await historyAfter(c.id, after);
        const msgs = r.msgs.filter((m) => typeof m.ts === "string" && later(m.ts, after));
        // Only the newest were read: the rest is kept to read next time, and the place moves to the newest as ever.
        if (r.gap) s.backlog[c.id] = r.gap;
        if (!msgs.length) continue;
        s.after[c.id] = msgs.reduce((newest, m) => (later(m.ts!, newest) ? m.ts! : newest), msgs[0]!.ts!);
        s.active[c.id] = now();
        found += await handOn(c, msgs, self);
      } catch (err) {
        const why = (err as Error).message;
        // Slack's rate limit: no more DMs this round, and this one first next round; the mentions are still looked at.
        if (/\bratelimited\b/.test(why)) {
          back(c);
          log.error("Slack asked to slow down: the next DM is read in the next look");
          break;
        }
        // One conversation this token may not read (closed, gone) is that one's: the others and the mentions go on.
        if (/\b(channel_not_found|not_in_channel|missing_scope|is_archived)\b/.test(why)) {
          log.error(`a conversation could not be read: ${why}`);
          delete s.backlog[c.id];
          continue;
        }
        throw err;
      }
    }
    return found;
  };

  const readMentions = async (s: PollState, self: string): Promise<number> => {
    const j = await d.api("search.messages", { query: `<@${self}>`, count: "20", sort: "timestamp", sort_dir: "desc" });
    type Match = { ts?: string; text?: string; user?: string; permalink?: string; type?: string; channel?: { id?: string; is_im?: boolean; is_mpim?: boolean } };
    const taken = new Set(s.seen);
    const matches = ((j.messages as { matches?: Match[] } | undefined)?.matches ?? [])
      .filter((m) => typeof m.ts === "string" && later(m.ts, s.mentions) && typeof m.channel?.id === "string" && !taken.has(`${m.channel.id}:${m.ts}`))
      // DMs are read on their own; a search result is only a channel's mention, and only one that really names the owner.
      .filter((m) => m.type !== "im" && !m.channel!.is_im && !m.channel!.is_mpim && (m.text ?? "").includes(`<@${self}>`) && m.user !== self)
      .sort((a, b) => Number(a.ts) - Number(b.ts));
    for (const m of matches) {
      const thread = threadOf(m.permalink);
      await d.deliver({ type: "message", channel: m.channel!.id!, channel_type: "channel", user: m.user!, text: m.text ?? "", ts: m.ts!, ...(thread ? { thread_ts: thread } : {}) })
        .catch((err: Error) => log.error(`a mention could not be handled: ${err.message}`));
      s.seen.push(`${m.channel!.id}:${m.ts}`);
    }
    const newest = matches.at(-1)?.ts;
    if (newest) {
      // Behind the newest, so a mention that search shows later than a newer one is still after the mark; the mark never goes back.
      const mark = slackTs(Number(newest) * 1000 - MENTION_LAG_MS);
      if (later(mark, s.mentions)) s.mentions = mark;
      s.seen = s.seen.filter((k) => later(k.slice(k.lastIndexOf(":") + 1), s.mentions)).slice(-SEEN_MAX);
    }
    return matches.length;
  };

  /** One look. Throws when Slack cannot be read (the caller logs it; the place is kept, so nothing is skipped). */
  const round = async (): Promise<{ dms: number; mentions: number }> => {
    const s = await load();
    const self = await d.self();
    if (!self) throw new Error("could not tell whose Slack this is (auth.test failed)");
    if (rounds % 10 === 0 || !convs.length) await list();
    const dms = await readDms(s, self);
    const mentions = rounds % 2 === 0 ? await readMentions(s, self) : 0;
    rounds++;
    await save();
    return { dms, mentions };
  };

  return {
    round,
    start(): void {
      if (timer) return;
      const tick = async (): Promise<void> => {
        if (busy) return;
        busy = true;
        try {
          await round();
        } catch (err) {
          log.error(`the look for new messages failed: ${(err as Error).message}`);
        } finally {
          busy = false;
        }
      };
      first = setTimeout(() => void tick(), 20_000);
      first.unref?.();
      timer = setInterval(() => void tick(), d.everyMs ?? 60_000);
      timer.unref?.();
    },
    stop(): void {
      if (first) clearTimeout(first);
      first = null;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export type SlackPoll = ReturnType<typeof createSlackPoll>;
