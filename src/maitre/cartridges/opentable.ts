// OpenTable, from the field guide (.claude/booking-engines.md): the restaurant's page takes the party and the time in its address
// (covers, dateTime); a slot leads to /booking/details, where a guest gives a name, phone and email and presses "Complete reservation".
// The selectors here are not mapped live yet (OpenTable answers scripts with Akamai): they follow the guide and the hand-made fixtures, and
// anything unexpected is "changed", so the planner hands over instead of guessing. A phone or email code, a card, or an Akamai wall: Handoff.

import type { Page } from "../cdp.ts";
import {
  COMMON_BLOCKS,
  COMMON_GATES,
  blockOn,
  failure,
  gateOn,
  hhmm,
  nearest,
  type BookResult,
  type Cartridge,
  type CartridgeContext,
  type Evidence,
  type GateSign,
  type Guest,
  type LookQuery,
  type LookResult,
  type Slot,
} from "../cartridge.ts";

const GATES: GateSign[] = [
  {
    gate: "code",
    detail: "OpenTable verification code",
    expression: `/enter the (verification )?code|we sent a code|introduce el código/i.test(document.body ? document.body.innerText : '') &&` +
      ` !!document.querySelector('input[inputmode="numeric"], input[autocomplete="one-time-code"]')`,
  },
  {
    gate: "card",
    detail: "card for the booking",
    expression: `[...document.querySelectorAll('#creditCardNumber, iframe[src*="spreedly"], iframe[src*="adyen"], iframe[src*="stripe"]')].some((e) => e.getBoundingClientRect().width > 0)`,
  },
  ...COMMON_GATES,
];

/** The restaurant's page with the party and the time, in the two shapes OpenTable takes (a profile, or the restaurant-ref widget). */
export function tableLink(url: string, q: { date: string; time: string; party: number }): string {
  const u = new URL(url);
  const at = `${q.date}T${q.time}`;
  if (/\/restref\/client/.test(u.pathname)) {
    u.searchParams.set("datetime", at);
    u.searchParams.set("covers", String(q.party));
  } else {
    u.searchParams.set("covers", String(q.party));
    u.searchParams.set("dateTime", at);
  }
  return u.toString();
}

const SLOT_SELECTOR = `[data-test="time-slot"], [data-testid="time-slot"], a[href*="/booking/details"], button[data-test*="slot"]`;

/** The slots a page shows: the time slot buttons and booking links, read as HH:MM. */
async function shownSlots(page: Page, q: LookQuery): Promise<Slot[]> {
  const texts = await page.evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(SLOT_SELECTOR)})].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.textContent.trim())`);
  const seen = new Set<string>();
  return texts.flatMap((t) => {
    const time = hhmm(t);
    if (!time || seen.has(time)) return [];
    seen.add(time);
    return [{ date: q.date, time, party: q.party }];
  });
}

async function verify(page: Page): Promise<Evidence | null> {
  let url: string;
  let text: string;
  try {
    ({ url, text } = await page.snapshot(4000));
  } catch {
    /* the page is gone: no confirmation read */
    return null;
  }
  const done = /\/booking\/(view|confirmation)/i.test(url) || /you'?re all set|reservation (is )?confirmed|booking confirmed|reserva confirmada/i.test(text);
  if (!done) return null;
  const id = /confirmation\s*(?:#|number|no\.?)\s*:?\s*(\d{3,15})/i.exec(text)?.[1];
  const cancelUrl = await page.evaluate<string | null>(`(() => { const a = [...document.querySelectorAll('a[href]')].find((x) => /cancel/i.test(x.href + ' ' + x.textContent));
    return a ? a.href : null; })()`).catch(() => null);
  return { url, text: text.slice(0, 1500), ...(id ? { confirmationId: id } : {}), ...(cancelUrl ? { cancelUrl } : {}) };
}

export const openTable: Cartridge = {
  engine: "OpenTable",
  version: 1,
  matches: (url) => /opentable\.[a-z.]+\/(r\/|restref\/client|restaurant\/profile|[a-z0-9-]+-[a-z0-9-]+)/i.test(url),
  required: ["firstName", "lastName", "email", "phone"],
  gates: GATES,
  blocks: COMMON_BLOCKS,

  async look(ctx: CartridgeContext, q: LookQuery): Promise<LookResult> {
    const page = ctx.page;
    const stepMs = ctx.stepMs ?? 15_000;
    try {
      await page.goto(tableLink(ctx.url, q), stepMs * 2);
      const wall = await blockOn(page, COMMON_BLOCKS);
      if (wall) return { kind: "blocked", detail: wall.detail };
      const found = await page.waitFor<string>(
        `(() => { if (document.querySelector(${JSON.stringify(SLOT_SELECTOR)})) return 'slots'; const t = document.body ? document.body.innerText : '';
          return /no (online )?availability|no tables available|not available/i.test(t) ? 'none' : ''; })()`,
        { timeoutMs: stepMs },
      );
      return { kind: "slots", slots: found === "none" ? [] : await shownSlots(page, q) };
    } catch (err) {
      const wall = await blockOn(page, COMMON_BLOCKS).catch(() => null);
      if (wall) return { kind: "blocked", detail: wall.detail };
      const why = (err as Error).message;
      return /timed out/i.test(why) ? { kind: "timeout", detail: why.slice(0, 200) } : { kind: "changed", detail: why.slice(0, 200) };
    }
  },

  async book(ctx: CartridgeContext, slot: Slot, guest: Guest): Promise<BookResult> {
    const page = ctx.page;
    const stepMs = ctx.stepMs ?? 15_000;
    let submitted = false;
    try {
      const seen = await openTable.look(ctx, slot);
      if (seen.kind !== "slots") return seen.kind === "blocked" ? seen : seen.kind === "timeout" ? { ...seen, submitted: false } : seen;
      if (!seen.slots.some((s) => s.time === slot.time)) return { kind: "no_slot", alternatives: nearest(seen.slots, slot.time) };
      const mark = await page.evaluate<boolean>(
        `(() => { const e = [...document.querySelectorAll(${JSON.stringify(SLOT_SELECTOR)})].find((x) => x.getBoundingClientRect().width > 0 && ${JSON.stringify(slot.time)} ===` +
          ` (${hhmmInPage})(x.textContent));
          if (!e) return false; e.setAttribute('data-maitre-slot', '1'); return true; })()`,
      );
      if (!mark) return { kind: "no_slot", alternatives: nearest(seen.slots, slot.time) };
      await page.click('[data-maitre-slot="1"]', stepMs);
      await page.waitFor(`!!document.querySelector('#firstName, input[name="firstName"]') || ${GATES.map((g) => `(${g.expression})`).join(" || ")}`, { timeoutMs: stepMs * 2 });
      const early = await gateOn(page, GATES);
      if (early) return { kind: "gate", gate: early.gate, detail: early.detail, submitted: false };
      await page.type("#firstName", guest.firstName, stepMs);
      await page.type("#lastName", guest.lastName, stepMs);
      await page.type("#phoneNumber", `+${guest.phone}`, stepMs);
      await page.type("#email", guest.email, stepMs);
      if (guest.notes && (await page.visible("#specialRequest").catch(() => false))) await page.type("#specialRequest", guest.notes.slice(0, 300), stepMs);
      // Marketing opt-ins stay off.
      await page.evaluate(`document.querySelectorAll('input[type=checkbox][name*="optIn" i], input[type=checkbox][id*="marketing" i]').forEach((c) => { if (c.checked) c.click(); })`);
      const text = await page.text(8000);
      if (!text.includes(String(slot.party)) || !(text.includes(slot.time) || text.includes(twelve(slot.time)))) {
        return { kind: "changed", detail: "the details page does not show the party and time asked for" };
      }
      const gate = await gateOn(page, GATES);
      if (gate) return { kind: "gate", gate: gate.gate, detail: gate.detail, submitted: false };
      if (ctx.stopBeforeSubmit) return { kind: "gate", gate: "captcha", detail: "stopped before Complete reservation for the owner", submitted: false };
      const button = '[data-test="complete-reservation-button"], [data-testid="complete-reservation-button"]';
      await page.waitForSelector(button, stepMs);
      await ctx.submitting();
      submitted = true;
      await page.click(button, stepMs);
      const deadline = Date.now() + Math.max(stepMs * 2, 30_000);
      while (Date.now() < deadline) {
        const ev = await verify(page);
        if (ev) {
          if (ctx.shotPath) ev.screenshot = await page.screenshot(ctx.shotPath).catch(() => undefined);
          return { kind: "confirmed", evidence: ev };
        }
        const g = await gateOn(page, GATES);
        if (g) return { kind: "gate", gate: g.gate, detail: g.detail, submitted: false };
        await new Promise((r) => setTimeout(r, 500));
      }
      return { kind: "timeout", detail: "no confirmation after Complete reservation", submitted: true };
    } catch (err) {
      return failure(err, submitted);
    }
  },

  verify,

  async cancel(ctx: CartridgeContext, evidence: Evidence): Promise<boolean> {
    if (!evidence.cancelUrl) return false;
    const page = ctx.page;
    const stepMs = ctx.stepMs ?? 15_000;
    await page.goto(evidence.cancelUrl, stepMs * 2);
    const button = '[data-test="cancel-reservation-button"], [data-testid="cancel-reservation-button"]';
    if (!(await page.visible(button).catch(() => false))) return false;
    page.acceptDialogs = true;
    await page.click(button, stepMs);
    try {
      await page.waitForText(/cancel(l)?ed/i, stepMs);
      return true;
    } catch {
      /* no cancellation shown in time: not cancelled */
      return false;
    }
  },
};

/** "21:00" as OpenTable's US pages write it ("9:00 PM"). */
const twelve = (t: string): string => {
  const h = Number(t.slice(0, 2));
  return `${h % 12 === 0 ? 12 : h % 12}:${t.slice(3, 5)} ${h < 12 ? "AM" : "PM"}`;
};

/** hhmm() as page code, so the slot is matched in the page exactly as Look read it. */
const hhmmInPage = `(s) => { const m = /(\\d{1,2})[:.h](\\d{2})\\s*([ap]\\.?m\\.?)?/i.exec(String(s).trim()); if (!m) return null; let h = Number(m[1]);
  const ap = (m[3] || '').toLowerCase().replace(/\\./g, ''); if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; return String(h).padStart(2, '0') + ':' + m[2]; }`;
