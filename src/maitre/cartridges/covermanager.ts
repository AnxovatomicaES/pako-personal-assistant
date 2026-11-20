// CoverManager, from the live playbook (.claude/booking-playbooks/covermanager.md) and a read-only look at a real module on 2026-11-18:
// one page with a jQuery UI calendar, the party and time selects, and a JSON call (update_hour_people) that answers with the free times
// for the chosen day and party. The details form opens after the first "Book"; "Reserve" (#btn-validate) submits. Bar Mut's real booking
// redirected to the restaurant's own thank-you page with date, time and pax in its address.

import type { Page } from "../cdp.ts";
import {
  COMMON_BLOCKS,
  COMMON_GATES,
  blockOn,
  failure,
  gateOn,
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

const lit = (s: string): string => JSON.stringify(s);

/** CoverManager's own gates, on top of the common ones (playbook, "Gates that need the owner"). */
const GATES: GateSign[] = [
  {
    gate: "captcha",
    detail: "reCAPTCHA",
    expression: `[...document.querySelectorAll('#recaptcha, .g-recaptcha, iframe[src*="recaptcha/api2/anchor"]')].some((e) => e.getBoundingClientRect().width > 30)`,
  },
  {
    gate: "code",
    detail: "email code for a returning customer",
    expression: `[...document.querySelectorAll('#email_client_code, #button_verify_code')].some((e) => e.getBoundingClientRect().width > 0)`,
  },
  {
    gate: "card",
    detail: "card guarantee",
    expression: `[...document.querySelectorAll('#insert-card, #pay_button, iframe[src*="adyen"]')].some((e) => e.getBoundingClientRect().width > 0)`,
  },
  ...COMMON_GATES,
];

/** The times a module's hour_box HTML offers ("<option value=\"21:00\">"), the disabled "Select" left out. */
export function hoursOf(hourBox: string): string[] {
  return [...hourBox.matchAll(/<option[^>]*value=["'](\d{2}:\d{2})["'][^>]*>/g)].filter((m) => !/disabled/.test(m[0])).map((m) => m[1]!);
}

/** The free times in an update_hour_people answer: the party's own list (hour_box) first, all hours only when it has none. */
export function freeTimes(json: string): string[] | null {
  let d: { hour_box?: unknown; hoursall?: unknown; close?: unknown };
  try {
    d = JSON.parse(json);
  } catch {
    /* not JSON: unreadable */
    return null;
  }
  if (!d || typeof d !== "object") return null;
  if (d.close === 1 || d.close === "1") return [];
  if (typeof d.hour_box === "string") return hoursOf(d.hour_box);
  if (d.hoursall && typeof d.hoursall === "object") return Object.keys(d.hoursall).filter((k) => /^\d{2}:\d{2}$/.test(k));
  return null;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Opens the module on the right month and picks the party and the day; returns the free times the module answered with. */
async function pickDay(page: Page, url: string, q: LookQuery, stepMs: number): Promise<string[] | { blocked: string } | { closed: true }> {
  await page.goto(url, stepMs * 2);
  const wall = await blockOn(page, COMMON_BLOCKS);
  if (wall) return { blocked: wall.detail };
  await page.waitForSelector("#people-box-select", stepMs);
  // The party first: the module recomputes the hours for the day that is picked afterwards.
  if (!(await page.select("#people-box-select", String(q.party), stepMs))) return { closed: true };
  const [y, m, d] = q.date.split("-").map(Number) as [number, number, number];
  // jQuery UI numbers months from 0; up to six "Next" presses (bookings open at most a few months ahead).
  const cell = `td[data-handler="selectDay"][data-month="${m - 1}"][data-year="${y}"] a[data-date="${d}"]`;
  for (let i = 0; i < 6; i++) {
    const shown = await page.evaluate<{ month: number; year: number } | null>(
      `(() => { const mo = document.querySelector('.ui-datepicker-month'); const yr = document.querySelector('.ui-datepicker-year'); if (!mo || !yr) return null;
        return { month: ${JSON.stringify(MONTHS)}.indexOf(mo.textContent.trim().toLowerCase()), year: Number(yr.textContent.trim()) }; })()`,
    );
    if (!shown) break;
    if (shown.year * 12 + shown.month >= y * 12 + (m - 1)) break;
    await page.click("a.ui-datepicker-next", stepMs);
    await page.waitFor(`!!document.querySelector('.ui-datepicker-month')`, { timeoutMs: stepMs });
  }
  // A day that cannot be picked (closed, past, too far) has no link: no table that day.
  const there = await page.evaluate<boolean>(`!!document.querySelector(${lit(cell)})`);
  if (!there) return { closed: true };
  page.clearResponses();
  await page.click(cell, stepMs);
  const r = await page.waitForResponse(/\/update_hour_people\b/, stepMs);
  const times = freeTimes(await r.body());
  // The page's own select is what a person can choose: read it too, and trust it when the JSON could not be read.
  await page.waitFor(`!!document.querySelector('#hour-box-select')`, { timeoutMs: stepMs });
  const shown = await page.evaluate<string[]>(`[...document.querySelectorAll('#hour-box-select option')].filter((o) => !o.disabled && /^\\d{2}:\\d{2}$/.test(o.value)).map((o) => o.value)`);
  return times ?? shown;
}

/** The thank-you page or the module's own confirmation: what it says, read from the page. */
async function verify(page: Page): Promise<Evidence | null> {
  let url: string;
  let text: string;
  try {
    ({ url, text } = await page.snapshot(4000));
  } catch {
    /* the page is gone: no confirmation read */
    return null;
  }
  const u = new URL(url);
  const thanks = /gracias|thank|confirm|reserva-confirmada|booking-confirmed/i.test(u.pathname);
  const says = new RegExp(
    "you will soon receive an e-?mail confirming|reservation (has been |is )?confirmed|reserva (ha sido )?confirmada|hemos recibido tu reserva"
      + "|booking confirmed|gracias por (su|tu) reserva|thank you for your reservation",
    "i",
  ).test(text);
  if (!thanks && !says) return null;
  const id = /(?:locator|localizador|booking (?:number|code|reference)|n[ºo°]\.? de reserva|reference)\s*[:#]?\s*([A-Z0-9-]{4,20})/i.exec(text)?.[1];
  const cancelUrl = await page.evaluate<string | null>(`(() => { const a = [...document.querySelectorAll('a[href]')].find((x) => /cancel|anular/i.test(x.href + ' ' + x.textContent));
    return a ? a.href : null; })()`).catch(() => null);
  const date = u.searchParams.get("date");
  const time = u.searchParams.get("time");
  const pax = u.searchParams.get("pax");
  const said = {
    // The redirect writes the day as DD-MM-YYYY.
    ...(date && /^\d{2}-\d{2}-\d{4}$/.test(date) ? { date: `${date.slice(6)}-${date.slice(3, 5)}-${date.slice(0, 2)}` } : {}),
    ...(time ? { time } : {}),
    ...(pax && /^\d+$/.test(pax) ? { party: Number(pax) } : {}),
  };
  return { url, text: text.slice(0, 1500), ...(id ? { confirmationId: id } : {}), ...(cancelUrl ? { cancelUrl } : {}), ...(Object.keys(said).length ? { said } : {}) };
}

export const coverManager: Cartridge = {
  engine: "CoverManager",
  version: 1,
  matches: (url) => /covermanager\.com\/(?:reservation|reserve)\/module_restaurant\//i.test(url),
  required: ["firstName", "lastName", "email", "phone"],
  gates: GATES,
  blocks: COMMON_BLOCKS,

  async look(ctx: CartridgeContext, q: LookQuery): Promise<LookResult> {
    const stepMs = ctx.stepMs ?? 15_000;
    try {
      const r = await pickDay(ctx.page, ctx.url, q, stepMs);
      if (Array.isArray(r)) return { kind: "slots", slots: r.map((time) => ({ date: q.date, time, party: q.party })) };
      if ("blocked" in r) return { kind: "blocked", detail: r.blocked };
      return { kind: "slots", slots: [] };
    } catch (err) {
      const why = (err as Error).message;
      return /timed out/i.test(why) ? { kind: "timeout", detail: why.slice(0, 200) } : { kind: "changed", detail: why.slice(0, 200) };
    }
  },

  async book(ctx: CartridgeContext, slot: Slot, guest: Guest): Promise<BookResult> {
    const page = ctx.page;
    const stepMs = ctx.stepMs ?? 15_000;
    let submitted = false;
    try {
      const day = await pickDay(page, ctx.url, slot, stepMs);
      if (!Array.isArray(day)) return "blocked" in day ? { kind: "blocked", detail: day.blocked } : { kind: "no_slot", alternatives: [] };
      if (!day.includes(slot.time)) return { kind: "no_slot", alternatives: nearest(day.map((time) => ({ date: slot.date, time, party: slot.party })), slot.time) };
      if (!(await page.select("#hour-box-select", slot.time, stepMs))) return { kind: "no_slot", alternatives: [] };
      // A zone may be asked for once the time is chosen (Bar Mut: only "Terraza" left). It is required; the one asked for, else the first.
      await new Promise((r) => setTimeout(r, 600));
      if (await page.visible("#extra-box-select").catch(() => false)) {
        const zones = await page.evaluate<{ v: string; t: string }[]>(`[...document.querySelectorAll('#extra-box-select option')].filter((o) => o.value && o.value !== '-1' &&` +
          ` !o.disabled).map((o) => ({ v: o.value, t: o.textContent.trim() }))`);
        const want = zones.find((z) => slot.zone && z.t.toLowerCase().includes(slot.zone.toLowerCase())) ?? zones[0];
        if (!want) return { kind: "no_slot", alternatives: [] };
        await page.select("#extra-box-select", want.v, stepMs);
        slot = { ...slot, zone: want.t };
      }
      await page.click("input.reservarButton.step1", stepMs);
      // The details form, or a gate instead of it (a returning customer's email code comes up here).
      await page.waitFor(`(() => { const e = document.querySelector('#user_first_name');
        return (e && e.getBoundingClientRect().width > 0) || ${GATES.map((g) => `(${g.expression})`).join(" || ")}; })()`, { timeoutMs: stepMs });
      const early = await gateOn(page, GATES);
      if (early) return { kind: "gate", gate: early.gate, detail: early.detail, submitted: false };
      await page.type("#user_first_name", guest.firstName, stepMs);
      await page.type("#user_last_name", guest.lastName, stepMs);
      await page.type("#user_email", guest.email, stepMs);
      // The phone is required even without a marker: an empty one blocks Reserve silently (learned on the first real booking).
      const cc = guest.phone.startsWith("34") ? "34" : guest.phone.startsWith("44") ? "44" : guest.phone.startsWith("1") ? "1" : "";
      if (cc) await page.select("#int_call_code", cc, stepMs).catch(() => false);
      await page.type("#user_phone", cc ? guest.phone.slice(cc.length) : guest.phone, stepMs);
      if (await page.visible("#no_food_restrictions").catch(() => false)) await page.check("#no_food_restrictions", true, stepMs);
      if (guest.notes && (await page.visible("#commentary").catch(() => false))) await page.type("#commentary", guest.notes.slice(0, 300), stepMs);
      await page.check("#consentimiento_legal", true, stepMs);
      // The newsletter stays off whatever the page ticked for us.
      if (await page.evaluate<boolean>(`!!document.querySelector('#subscribe_newsletter')`)) await page.check("#subscribe_newsletter", false, stepMs);
      // The module's own summary ("20-11-2026 | 21:00 hrs | 2 people at Terraza") must say what the owner asked for, right before Reserve.
      const dmy = `${slot.date.slice(8, 10)}-${slot.date.slice(5, 7)}-${slot.date.slice(0, 4)}`;
      const summary = await page.text(8000);
      if (!summary.includes(dmy) || !summary.includes(slot.time)) return { kind: "changed", detail: "the module's summary does not show the date and time asked for" };
      const gate = await gateOn(page, GATES);
      if (gate) return { kind: "gate", gate: gate.gate, detail: gate.detail, submitted: false };
      if (ctx.stopBeforeSubmit) return { kind: "gate", gate: "captcha", detail: "stopped before Reserve for the owner", submitted: false };
      await ctx.submitting();
      submitted = true;
      await page.click("#btn-validate", stepMs);
      // The answer: the confirmation (often on the restaurant's own site), a gate the press brought up, or the module saying the form expired.
      const deadline = Date.now() + Math.max(stepMs * 2, 30_000);
      while (Date.now() < deadline) {
        const ev = await verify(page);
        if (ev) {
          if (slot.zone) ev.said = { ...ev.said, zone: slot.zone };
          if (ctx.shotPath) ev.screenshot = await page.screenshot(ctx.shotPath).catch(() => undefined);
          return { kind: "confirmed", evidence: ev };
        }
        const g = await gateOn(page, GATES);
        // A gate that came up on the press: the module did not take the booking (no confirmation), the owner finishes it.
        if (g) return { kind: "gate", gate: g.gate, detail: g.detail, submitted: false };
        const text = await page.text(3000).catch(() => "");
        if (/your time to complete the reserve is up|se ha agotado el tiempo/i.test(text)) return { kind: "changed", detail: "the form expired before Reserve" };
        await new Promise((r) => setTimeout(r, 500));
      }
      return { kind: "timeout", detail: "no confirmation after Reserve", submitted: true };
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
    const button = await page.evaluate<string | null>(
      `(() => { const b = [...document.querySelectorAll('button, input[type=button], input[type=submit], a')].find((x) => /^(cancel(ar)?( (la |my |the` +
        ` )?(reserva|reservation|booking))?|anular( reserva)?)$/i.test((x.value || x.textContent || '').trim()));
        if (!b) return null; b.setAttribute('data-maitre-cancel', '1'); return '[data-maitre-cancel="1"]'; })()`,
    );
    if (!button) return false;
    // The owner pressed Undo: the engine's "are you sure?" is answered yes for this one press.
    page.acceptDialogs = true;
    await page.click(button, stepMs);
    try {
      await page.waitForText(/cancel(l)?ed|cancelada|anulada/i, stepMs);
      return true;
    } catch {
      /* no cancellation shown in time: not cancelled */
      return false;
    }
  },
};
