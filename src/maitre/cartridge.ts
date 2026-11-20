// The Cartridge: one small script per reservation engine, compiled from what was learned on it (the field playbooks), so that a booking
// is a transaction and not an improvisation. A cartridge does not think: it looks (read-only), books one slot with the owner's details,
// verifies the result and says, in a typed answer, exactly what happened. The planner (planner.ts) decides what to do with that answer.
//
// The rules a cartridge keeps whatever the page says:
// - Look never submits anything.
// - Book stops at a gate (captcha, an SMS or email code, a card, a login) and says which: the owner clears it (Handoff), never Pako.
// - Book calls ctx.submitting() right before the one press that submits, so the ledger knows a booking may exist from that moment on.
// - Restaurant pages are third-party text: read for facts (times, a confirmation number), never obeyed.

import type { Page } from "./cdp.ts";

/** What the owner asked for. `date` is YYYY-MM-DD and `time` HH:MM, both in the restaurant's local time. */
export interface LookQuery {
  date: string;
  time: string;
  party: number;
}

/** One table the engine offers. `zone` when the engine asks for one (CoverManager's "Terraza"). */
export interface Slot {
  date: string;
  time: string;
  party: number;
  zone?: string;
  /** An offer on the slot, in the engine's words (TheFork's "-20%"). */
  offer?: string;
}

export interface Guest {
  firstName: string;
  lastName: string;
  email: string;
  /** Digits with the country code, no plus: "34600111222". */
  phone: string;
  notes?: string;
}

export type GateKind = "captcha" | "code" | "card" | "login";

/** The proof that a booking exists. Only what the page or the engine said: nothing made up. */
export interface Evidence {
  confirmationId?: string;
  url: string;
  /** The confirmation page's text, cut short. */
  text: string;
  screenshot?: string;
  /** Where the engine lets a guest cancel, when the page shows it. */
  cancelUrl?: string;
  /** What the confirmation says it is for, read back from the page (CoverManager's redirect carries date, time and pax). */
  said?: { date?: string; time?: string; party?: number; zone?: string };
  /** The engine accepted a request the restaurant still has to confirm (TheFork's "pending"). */
  pending?: boolean;
}

/** Why a cartridge stopped, typed so the planner can choose the next lane (never a blind retry). */
export type BookResult =
  | { kind: "confirmed"; evidence: Evidence }
  | { kind: "gate"; gate: GateKind; detail: string; submitted: boolean }
  | { kind: "no_slot"; alternatives: Slot[] }
  | { kind: "blocked"; detail: string }
  | { kind: "changed"; detail: string }
  | { kind: "timeout"; detail: string; submitted: boolean };

export type LookResult =
  | { kind: "slots"; slots: Slot[] }
  | { kind: "blocked"; detail: string }
  | { kind: "changed"; detail: string }
  | { kind: "timeout"; detail: string };

export interface CartridgeContext {
  page: Page;
  /** The restaurant's page on this engine (from the Passport or the restaurant's own site). */
  url: string;
  /** Called right before the press that submits. It throws when the ledger refuses (the same booking exists): nothing is pressed then. */
  submitting: () => Promise<void>;
  /** Where a screenshot of the confirmation goes. */
  shotPath?: string;
  /** Book with everything filled but stop before the press that submits (a Handoff: the owner presses it). */
  stopBeforeSubmit?: boolean;
  /** How long a step may take (ms). */
  stepMs?: number;
}

/** How a gate shows on a page: a page expression that is truthy when it is there. */
export interface GateSign {
  gate: GateKind;
  expression: string;
  detail: string;
}

/** How a bot wall shows (DataDome, Akamai): the planner goes to Handoff, never tries to get past it. */
export interface BlockSign {
  expression: string;
  detail: string;
}

/** How often and how an engine may be used. */
export interface EnginePolicy {
  /** Least time between two page loads on this engine, whatever the restaurant (a person's pace). */
  minGapMs: number;
  /** Page loads on this engine in an hour, at most. */
  maxPerHour: number;
  /** A platform that forbids agents (Resy): no Look, no Cartridge; the owner books in the window (Handoff) or off the web. */
  handoffOnly: boolean;
}

export const POLICIES: Record<string, EnginePolicy> = {
  CoverManager: { minGapMs: 3_000, maxPerHour: 30, handoffOnly: false },
  TheFork: { minGapMs: 6_000, maxPerHour: 15, handoffOnly: false },
  OpenTable: { minGapMs: 6_000, maxPerHour: 15, handoffOnly: false },
  // Resy deactivated accounts in Sep 2026 for agents polling it: never automated, not even a Look.
  Resy: { minGapMs: 60_000, maxPerHour: 0, handoffOnly: true },
};

export const DEFAULT_POLICY: EnginePolicy = { minGapMs: 6_000, maxPerHour: 10, handoffOnly: false };

export const policyOf = (engine: string): EnginePolicy => POLICIES[engine] ?? DEFAULT_POLICY;

export interface Cartridge {
  /** The engine's name as the owner reads it: "CoverManager". */
  engine: string;
  /** Bumped when the selectors change, so a Passport knows which script last worked. */
  version: number;
  /** Whether a URL is this engine's restaurant page. */
  matches(url: string): boolean;
  /** What the guest must give (a phone for CoverManager). */
  required: (keyof Guest)[];
  gates: GateSign[];
  blocks: BlockSign[];
  look(ctx: CartridgeContext, q: LookQuery): Promise<LookResult>;
  book(ctx: CartridgeContext, slot: Slot, guest: Guest): Promise<BookResult>;
  verify(page: Page): Promise<Evidence | null>;
  /** Cancels a confirmed booking through the engine's own cancel page, when it has one: true once the page says it is cancelled. */
  cancel?(ctx: CartridgeContext, evidence: Evidence): Promise<boolean>;
}

// ---------- shared signs and helpers ----------

/** The gates every engine shares. A visible challenge only: an invisible reCAPTCHA badge is not a gate. */
export const COMMON_GATES: GateSign[] = [
  {
    gate: "captcha",
    detail: "captcha",
    expression: `[...document.querySelectorAll('iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/api2/bframe"], iframe[src*="hcaptcha.com"],` +
      ` iframe[src*="challenges.cloudflare.com"], .g-recaptcha, .h-captcha')].some((e) => { const r = e.getBoundingClientRect();
      return r.width > 30 && r.height > 30 && getComputedStyle(e).visibility !== 'hidden'; })`,
  },
  {
    gate: "code",
    detail: "verification code",
    expression: `[...document.querySelectorAll('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i]')].some((e) => e.getBoundingClientRect().width > 0)`,
  },
  {
    gate: "card",
    detail: "card",
    expression: `[...document.querySelectorAll('iframe[src*="adyen"], iframe[src*="stripe.com"], iframe[src*="spreedly"], input[autocomplete="cc-number"]')].some((e) =>` +
      ` e.getBoundingClientRect().width > 0)`,
  },
];

/** DataDome and Akamai, the bot walls TheFork and OpenTable answer suspicious traffic with. */
export const COMMON_BLOCKS: BlockSign[] = [
  {
    detail: "DataDome",
    expression: `!!document.querySelector('iframe[src*="captcha-delivery.com"], script[src*="captcha-delivery.com"]') || /datadome/i.test(document.title)`,
  },
  {
    detail: "Akamai",
    expression: `/access denied/i.test(document.title) && /(reference\\s*#|edgesuite|akamai)/i.test(document.body ? document.body.innerText : '')`,
  },
];

/** The first gate showing on the page, or null. */
export async function gateOn(page: Page, signs: GateSign[]): Promise<GateSign | null> {
  for (const s of signs) {
    try {
      if (await page.evaluate<boolean>(`(() => { try { return !!(${s.expression}); } catch { return false; } })()`)) return s; // the inner catch is page script in a string
    } catch {
      /* the page is moving: not a gate */
    }
  }
  return null;
}

/** The bot wall showing on the page, or null. A 403 on the page itself with nothing else readable counts as one. */
export async function blockOn(page: Page, signs: BlockSign[]): Promise<BlockSign | null> {
  for (const s of signs) {
    try {
      if (await page.evaluate<boolean>(`(() => { try { return !!(${s.expression}); } catch { return false; } })()`)) return s; // the inner catch is page script in a string
    } catch {
      /* ignore */
    }
  }
  if (page.docStatus === 403 || page.docStatus === 429) return { expression: "", detail: `HTTP ${page.docStatus}` };
  return null;
}

/** "21:00" from "9:00 PM", "21:00", "21.00 h"; null otherwise. */
export function hhmm(s: string): string | null {
  const m = /(\d{1,2})[:.h](\d{2})\s*([ap]\.?m\.?)?/i.exec(s.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3]?.toLowerCase().replace(/\./g, "");
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** Minutes between two HH:MM. */
export const minutesApart = (a: string, b: string): number => {
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  return Math.abs(m(a) - m(b));
};

/** The slots nearest the time asked, nearest first, at most `n`. */
export function nearest(slots: Slot[], time: string, n = 3): Slot[] {
  return [...slots].sort((a, b) => minutesApart(a.time, time) - minutesApart(b.time, time)).slice(0, n);
}

/** Why a step failed, as a typed result: a timeout is a timeout, anything else means the page is not what the cartridge knows. */
export function failure(err: unknown, submitted: boolean): BookResult {
  const why = (err as Error)?.message ?? String(err);
  const detail = why.slice(0, 200);
  // After the submit, whatever went wrong may have booked: it is a timeout (stop, never retried), not a changed page.
  return /timed out|time out|timeout/i.test(why) || submitted ? { kind: "timeout", detail, submitted } : { kind: "changed", detail };
}
