// Handoff: a gate (a captcha, a code, a card, a sign-in, a bot check) is the owner's to clear, never Pako's. The window opens on the
// owner's screen at that step with everything Pako could fill already filled; the owner does the one human thing (and presses the last
// button when the gate is on it). Pako watches the page and verifies: when the confirmation shows, or when the owner says "done".

import type { Page, PagePool } from "./cdp.ts";
import type { Cartridge, Evidence, GateKind, Guest, Slot } from "./cartridge.ts";
import type { Ledger, LedgerEntry } from "./ledger.ts";

/** What stops an attempt and is the owner's: the cartridge's gates, or a bot wall (blocked), or an engine that only the owner may use. */
export type HandoffReason = GateKind | "blocked" | "handoff_only" | "timeout";

export type HandoffEnd =
  | { kind: "confirmed"; entry: LedgerEntry; evidence: Evidence }
  | { kind: "expired"; entry: LedgerEntry }
  | { kind: "closed"; entry: LedgerEntry };

export interface HandoffDeps {
  pool: PagePool;
  ledger: Ledger;
  /** Tells the owner how a Handoff ended when it ended by itself (the page changed to the confirmation, or the time ran out). */
  onEnd?: (end: HandoffEnd) => void | Promise<void>;
  /** How long the window is watched (ms). */
  watchMs?: number;
  everyMs?: number;
  shotPath?: (entryId: string) => string;
}

interface Open {
  entry: LedgerEntry;
  cartridge: Cartridge;
  page: Page;
  release: () => void;
  timer: NodeJS.Timeout | null;
  ended: boolean;
  reason: HandoffReason;
}

export function createHandoffs(d: HandoffDeps) {
  const open = new Map<string, Open>();
  const watchMs = d.watchMs ?? 15 * 60_000;
  const everyMs = d.everyMs ?? 2000;

  const finish = async (o: Open, end: HandoffEnd, tell: boolean): Promise<HandoffEnd> => {
    if (o.ended) return end;
    o.ended = true;
    if (o.timer) clearTimeout(o.timer);
    open.delete(o.entry.id);
    let entry = o.entry;
    if (end.kind === "confirmed") entry = (await d.ledger.confirm(o.entry.id, end.evidence)) ?? entry;
    else entry = (await d.ledger.fail(o.entry.id, end.kind === "expired" ? "handoff: no confirmation seen in time" : "handoff: the window was closed")) ?? entry;
    // The window stays on the owner's screen when it confirmed (they may want to read it); the browser closes later when idle.
    o.release();
    const out = { ...end, entry } as HandoffEnd;
    if (tell) await d.onEnd?.(out);
    return out;
  };

  const check = async (o: Open): Promise<Evidence | null> => {
    const ev = await o.cartridge.verify(o.page);
    if (ev && d.shotPath) ev.screenshot = await o.page.screenshot(d.shotPath(o.entry.id)).catch(() => undefined);
    return ev;
  };

  const watch = (o: Open, until: number): void => {
    o.timer = setTimeout(async () => {
      if (o.ended) return;
      try {
        const ev = await check(o);
        if (ev) {
          await finish(o, { kind: "confirmed", entry: o.entry, evidence: ev }, true);
          return;
        }
      } catch (err) {
        // The owner closed the tab or the browser: nothing more to watch.
        if (/went away|closed|No target|Session/i.test((err as Error).message)) {
          await finish(o, { kind: "closed", entry: o.entry }, true);
          return;
        }
      }
      if (Date.now() >= until) await finish(o, { kind: "expired", entry: o.entry }, true);
      else watch(o, until);
    }, everyMs);
    o.timer.unref?.();
  };

  return {
    /**
     * Opens the window for one attempt. `prepare` runs in it first (the cartridge filling everything up to the gate, or just the deep link
     * for a bot wall); whatever it returns, the window stays at that step for the owner.
     */
    async start(entry: LedgerEntry, cartridge: Cartridge, reason: HandoffReason, prepare: (page: Page) => Promise<unknown>): Promise<void> {
      const old = open.get(entry.id);
      if (old) await finish(old, { kind: "closed", entry: old.entry }, false);
      const w = await d.pool.openWindow();
      const o: Open = { entry, cartridge, page: w.page, release: w.release, timer: null, ended: false, reason };
      open.set(entry.id, o);
      try {
        await prepare(w.page);
      } catch {
        /* the page is where it stopped: still the owner's to finish */
      }
      watch(o, Date.now() + watchMs);
    },

    /** The owner said "done": verified now. Null when that Handoff is not open (it ended already). */
    async done(entryId: string): Promise<HandoffEnd | { kind: "not_yet"; entry: LedgerEntry } | null> {
      const o = open.get(entryId);
      if (!o) return null;
      const ev = await check(o).catch(() => null);
      if (ev) return finish(o, { kind: "confirmed", entry: o.entry, evidence: ev }, false);
      return { kind: "not_yet", entry: o.entry };
    },

    /** The owner gave up on it: the window is left, the attempt closed. */
    async drop(entryId: string): Promise<void> {
      const o = open.get(entryId);
      if (o) await finish(o, { kind: "closed", entry: o.entry }, false);
    },

    openIds: (): string[] => [...open.keys()],
    reasonOf: (entryId: string): HandoffReason | undefined => open.get(entryId)?.reason,
  };
}

export type Handoffs = ReturnType<typeof createHandoffs>;

/** What the owner is asked to do in the window, by reason. */
export type HandoffAsk = { reason: HandoffReason; slot: Slot; guest: Guest };
