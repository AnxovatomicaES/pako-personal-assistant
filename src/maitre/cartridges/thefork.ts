// TheFork (ElTenedor, LaFourchette), from the live playbook (.claude/booking-playbooks/thefork.md): a deep link opens the restaurant's
// booking steps with the date, time and party; the steps carry stable test ids. TheFork then asks who is booking (an account, an email
// code or a password): that step is always the owner's, so Book goes as far as the identification step and hands over there.
// TheFork runs DataDome: a bot check is reported as "blocked" and the owner gets the window (Handoff); Pako never tries to get past it.

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

const tid = (id: string): string => `[data-testid="${id}"]`;

const GATES: GateSign[] = [
  {
    gate: "login",
    detail: "TheFork sign-in",
    expression: `[...document.querySelectorAll('[data-testid="step-login-identification"], [data-testid="checkout-submit-email"], [data-testid="google-login"]')].some((e) =>` +
      ` e.getBoundingClientRect().width > 0)`,
  },
  ...COMMON_GATES,
];

/** The restaurant's page with the booking steps opened: `hour` left out for a Look (it stops on the times). */
export function forkLink(url: string, q: { date: string; party: number; time?: string }): string {
  const base = url.replace(/#.*$/, "");
  const hour = q.time ? `&hour=${encodeURIComponent(q.time)}` : "";
  return `${base}#booking=&date=${q.date}${hour}&partySize=${q.party}`;
}

/** Declines the cookie banner when it shows ("Continue Without Accepting"): the most private choice. */
async function declineCookies(page: Page): Promise<void> {
  await page.evaluate(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => /continue without accepting|continuar sin aceptar|continuer sans accepter|rifiuta|reject all|rechazar` +
      ` todo/i.test(x.textContent));
      if (b) b.click(); })()`,
  ).catch(() => undefined);
}

/** The times shown on the hour step, with their offer when there is one. */
async function shownSlots(page: Page, q: LookQuery): Promise<Slot[]> {
  const raw = await page.evaluate<{ id: string; offer: string }[]>(
    `[...document.querySelectorAll('[data-testid^="timeslot-"]')].filter((e) => !/timeslot-service-/.test(e.dataset.testid)).map((e) => ({ id: e.dataset.testid, offer:` +
      ` (document.querySelector('[data-testid="hour-slot-' + e.dataset.testid.slice(9) + '-offer"]') || {}).textContent || '' }))`,
  );
  return raw.flatMap((r) => {
    const time = hhmm(r.id.slice("timeslot-".length));
    return time ? [{ date: q.date, time, party: q.party, ...(r.offer.trim() ? { offer: r.offer.trim().slice(0, 40) } : {}) }] : [];
  });
}

/** The summary pill ("Fri Nov 20 · 2 Pers. · 19:45 · -20%"): the widget keeps the last choice of the session over the link, so it is read. */
const pill = (page: Page): Promise<string> =>
  page.evaluate<string>(`(document.querySelector('[data-testid^="reservation-summary-pill"]') || {}).textContent || ''`).catch(() => "");

const pillSays = (text: string, q: { date: string; party: number; time?: string }): { date: boolean; party: boolean; time: boolean } => ({
  date: new RegExp(`\\b0?${Number(q.date.slice(8, 10))}\\b`).test(text),
  party: new RegExp(`\\b${q.party}\\s*(pers|people|personas|couverts|persone|p\\b)`, "i").test(text),
  time: !q.time || text.includes(q.time),
});

/** Puts the steps on the date and party asked for when the pill says otherwise. False when the date cannot be picked. */
async function align(page: Page, q: { date: string; party: number }, stepMs: number): Promise<boolean> {
  const says = pillSays(await pill(page), q);
  if (!says.date) {
    if (await page.visible(tid("stepdate-button")).catch(() => false)) await page.click(tid("stepdate-button"), stepMs);
    if (!(await page.visible(tid(`date-slot-${q.date}`)).catch(() => false))) return false;
    await page.click(tid(`date-slot-${q.date}`), stepMs);
  }
  if (!says.party) {
    if (await page.visible(tid("steppax-button")).catch(() => false)) await page.click(tid("steppax-button"), stepMs);
    await page.click(tid(`pax-${q.party}`), stepMs);
  }
  return true;
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
  const done = /(reservation|booking) (is )?confirmed|your (reservation|booking) is confirmed|réservation (est )?confirmée|reserva (está )?confirmada|prenotazione confermata/i.test(text);
  const pending = /awaiting confirmation|pending confirmation|pendiente de confirmaci[oó]n|en attente de confirmation|in attesa di conferma/i.test(text);
  if (!done && !pending) return null;
  const id = /(?:booking|reservation|reserva|réservation) (?:id|number|n[ºo°]|ref(?:erence)?)\s*[:#]?\s*([A-Z0-9-]{4,20})/i.exec(text)?.[1];
  return { url, text: text.slice(0, 1500), ...(id ? { confirmationId: id } : {}), ...(pending && !done ? { pending: true } : {}) };
}

export const theFork: Cartridge = {
  engine: "TheFork",
  version: 1,
  matches: (url) => /(^|\/\/|\.)(thefork\.[a-z.]+|lafourchette\.com|eltenedor\.es)\/(restaurante?|ristorante|[a-z]{2}\/)/i.test(url) || /widget\.thefork\.com\//i.test(url),
  required: ["firstName", "lastName", "email", "phone"],
  gates: GATES,
  blocks: COMMON_BLOCKS,

  async look(ctx: CartridgeContext, q: LookQuery): Promise<LookResult> {
    const page = ctx.page;
    const stepMs = ctx.stepMs ?? 15_000;
    try {
      await page.goto(forkLink(ctx.url, { date: q.date, party: q.party }), stepMs * 2);
      const wall = await blockOn(page, COMMON_BLOCKS);
      if (wall) return { kind: "blocked", detail: wall.detail };
      await declineCookies(page);
      await page.waitFor(`!!document.querySelector('[data-testid^="reservation-summary-pill"], [data-testid^="timeslot-"], [data-testid^="date-slot-"]')`, { timeoutMs: stepMs });
      if (!(await align(page, q, stepMs))) return { kind: "slots", slots: [] };
      await page.waitFor(`!!document.querySelector('[data-testid^="timeslot-"], [data-testid="no-availability"]')`, { timeoutMs: stepMs }).catch(() => false);
      return { kind: "slots", slots: await shownSlots(page, q) };
    } catch (err) {
      const why = (err as Error).message;
      const wall = await blockOn(page, COMMON_BLOCKS).catch(() => null);
      if (wall) return { kind: "blocked", detail: wall.detail };
      return /timed out/i.test(why) ? { kind: "timeout", detail: why.slice(0, 200) } : { kind: "changed", detail: why.slice(0, 200) };
    }
  },

  async book(ctx: CartridgeContext, slot: Slot, _guest: Guest): Promise<BookResult> {
    const page = ctx.page;
    const stepMs = ctx.stepMs ?? 15_000;
    try {
      await page.goto(forkLink(ctx.url, slot), stepMs * 2);
      const wall = await blockOn(page, COMMON_BLOCKS);
      if (wall) return { kind: "blocked", detail: wall.detail };
      await declineCookies(page);
      await page.waitFor(`!!document.querySelector('[data-testid^="reservation-summary-pill"], [data-testid^="timeslot-"], [data-testid="step-login-identification"]')`, { timeoutMs: stepMs });
      let says = pillSays(await pill(page), slot);
      if (!says.date || !says.party) {
        if (!(await align(page, slot, stepMs))) return { kind: "no_slot", alternatives: [] };
        says = pillSays(await pill(page), slot);
      }
      if (!says.time) {
        if (await page.visible(tid("stephour-button")).catch(() => false)) await page.click(tid("stephour-button"), stepMs);
        await page.waitFor(`!!document.querySelector('[data-testid^="timeslot-"], [data-testid="no-availability"]')`, { timeoutMs: stepMs }).catch(() => false);
        const slots = await shownSlots(page, slot);
        if (!slots.some((s) => s.time === slot.time)) return { kind: "no_slot", alternatives: nearest(slots, slot.time) };
        await page.click(tid(`timeslot-${slot.time}`), stepMs);
      }
      // The offer step, when the restaurant has offers: its own button goes on with the offer the owner was shown.
      if (await page.visible(tid("book-button")).catch(() => false)) await page.click(tid("book-button"), stepMs);
      await page.waitFor(`!!document.querySelector('[data-testid="step-login-identification"], [data-testid="checkout-submit-email"]') ||` +
        ` ${GATES.slice(1).map((g) => `(${g.expression})`).join(" || ")}`, { timeoutMs: stepMs });
      const final = pillSays(await pill(page), slot);
      if (!final.date || !final.party || !final.time) return { kind: "changed", detail: "TheFork's summary does not show the date, time and party asked for" };
      // Who books is the owner's step on TheFork (an account, a code or a password): handed over here, with the slot chosen.
      const g = await gateOn(page, GATES);
      return { kind: "gate", gate: g?.gate ?? "login", detail: g?.detail ?? "TheFork sign-in", submitted: false };
    } catch (err) {
      const wall = await blockOn(page, COMMON_BLOCKS).catch(() => null);
      if (wall) return { kind: "blocked", detail: wall.detail };
      return failure(err, false);
    }
  },

  verify,
};
