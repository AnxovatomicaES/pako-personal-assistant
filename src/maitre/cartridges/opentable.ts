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
  pressCancel,
  timesIn,
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

// ---------- what a details or confirmation page says about the day, the time and the party ----------

/** Month words by their first letters, English and Spanish (the pages of OpenTable's English and Spanish sites). Another language reads as "no date shown". */
const MONTH_WORDS: Record<string, number> = {
  jan: 1, january: 1, ene: 1, enero: 1, feb: 2, february: 2, febrero: 2, mar: 3, march: 3, marzo: 3, apr: 4, april: 4, abr: 4, abril: 4, may: 5, mayo: 5,
  jun: 6, june: 6, junio: 6, jul: 7, july: 7, julio: 7, aug: 8, august: 8, ago: 8, agosto: 8, sep: 9, sept: 9, september: 9, septiembre: 9, setiembre: 9,
  oct: 10, october: 10, octubre: 10, nov: 11, november: 11, noviembre: 11, dec: 12, december: 12, dic: 12, diciembre: 12,
};

/**
 * Every day, time and party size a page shows, as "YYYY-MM-DD", "HH:MM" and numbers. A day written without its year ("Saturday, November 28")
 * takes the year that puts it nearest to `anchor` (a YYYY-MM-DD: the day asked for, or today).
 */
export function factsOf(text: string, anchor: string): { dates: string[]; times: string[]; parties: number[] } {
  const t = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const near = (month: number, day: number): string | null => {
    const ay = Number(anchor.slice(0, 4));
    const days = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
    const options = [ay - 1, ay, ay + 1]
      .map((y) => new Date(Date.UTC(y, month - 1, day)))
      .filter((d) => d.getUTCMonth() === month - 1 && d.getUTCDate() === day)
      .map((d) => d.toISOString().slice(0, 10));
    return options.sort((a, b) => Math.abs(days(a) - days(anchor)) - Math.abs(days(b) - days(anchor)))[0] ?? null;
  };
  const dates: string[] = [];
  const add = (iso: string | null) => void (iso && !dates.includes(iso) && dates.push(iso));
  for (const m of t.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) add(Date.parse(m[0]) ? m[0] : null);
  // "Nov 27", "November 27th" (US) and "27 Nov", "27 de noviembre" (UK, Spain).
  for (const m of t.matchAll(/(?<![a-z])([a-z]{3,10})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?![\d:]|[.]\d|h\d)/g)) {
    if (MONTH_WORDS[m[1]!]) add(near(MONTH_WORDS[m[1]!]!, Number(m[2])));
  }
  for (const m of t.matchAll(/(?<!\d)(\d{1,2})(?:st|nd|rd|th|o)?\s+(?:de\s+)?([a-z]{3,10})(?![a-z])/g)) {
    if (MONTH_WORDS[m[2]!]) add(near(MONTH_WORDS[m[2]!]!, Number(m[1])));
  }
  const parties: number[] = [];
  // "2 people", "Table for 2", "party of 2", "Party size: 2".
  const sizes = [
    /(?<!\d)(\d{1,2})\s*(?:people|persons?|guests?|diners?|covers?|personas?|comensales|pax)(?![a-z])/g,
    /(?:table|party|mesa)\s+(?:for|of|para)\s+(\d{1,2})(?!\d)/g,
    /party size\s*:?\s*(\d{1,2})(?!\d)/g,
  ];
  for (const m of sizes.flatMap((re) => [...t.matchAll(re)])) {
    const n = Number(m[1]);
    if (!parties.includes(n)) parties.push(n);
  }
  return { dates, times: timesIn(t), parties };
}

/** What a page says it is for, to compare with what was asked: the asked value when the page shows it (a page may name other days too), else the first one shown. */
function saidBy(text: string, asked?: { date: string; time: string; party: number }): Evidence["said"] | undefined {
  const f = factsOf(text, asked?.date ?? new Date().toISOString().slice(0, 10));
  const date = asked && f.dates.includes(asked.date) ? asked.date : f.dates[0];
  const time = asked && f.times.includes(asked.time) ? asked.time : f.times[0];
  const party = asked && f.parties.includes(asked.party) ? asked.party : f.parties[0];
  const said = { ...(date ? { date } : {}), ...(time ? { time } : {}), ...(party ? { party } : {}) };
  return Object.keys(said).length ? said : undefined;
}

async function confirmation(page: Page, asked?: Slot): Promise<Evidence | null> {
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
  const said = saidBy(text, asked);
  return { url, text: text.slice(0, 1500), ...(id ? { confirmationId: id } : {}), ...(cancelUrl ? { cancelUrl } : {}), ...(said ? { said } : {}) };
}

const verify = (page: Page): Promise<Evidence | null> => confirmation(page);

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
      // The page must say the day, the time and the party that were asked for (a slot offered for another day is booked as that day).
      const text = await page.text(8000);
      const facts = factsOf(text, slot.date);
      const link = new URL(await page.url());
      const linked = /^\d{4}-\d{2}-\d{2}/.exec(link.searchParams.get("dateTime") ?? link.searchParams.get("datetime") ?? "")?.[0];
      const dayOk = (!linked || linked === slot.date) && (facts.dates.length ? facts.dates.includes(slot.date) : linked === slot.date);
      if (!dayOk || !facts.times.includes(slot.time) || !facts.parties.includes(slot.party)) {
        return { kind: "changed", detail: "the details page does not show the day, time and party asked for" };
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
        const ev = await confirmation(page, slot);
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
    return pressCancel(page, button, /cancel(l)?ed/i, stepMs);
  },
};

/** hhmm() as page code, so the slot is matched in the page exactly as Look read it. */
const hhmmInPage = `(s) => { const m = /(\\d{1,2})[:.h](\\d{2})\\s*([ap]\\.?m\\.?)?/i.exec(String(s).trim()); if (!m) return null; let h = Number(m[1]);
  const ap = (m[3] || '').toLowerCase().replace(/\\./g, ''); if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; return String(h).padStart(2, '0') + ':' + m[2]; }`;
