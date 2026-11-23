// Undo's cancel on the engines' own cancel pages, without a browser: a fake page that says what it shows before and after the press. A policy
// line that already says "cancelled", or an "are you sure?" step the press only opens, is not a cancellation (the owner gets the cancel link then).

import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "../src/maitre/cdp.ts";
import type { Cartridge } from "../src/maitre/cartridge.ts";
import { coverManager } from "../src/maitre/cartridges/covermanager.ts";
import { openTable } from "../src/maitre/cartridges/opentable.ts";

const POLICY = "Reservations cancelled less than 24 hours before the booking are charged 20 EUR per person.";
const HEAD = "Your reservation: Bar Mut, 20-11-2026 21:00, 2 people";

/** The subset of Page a cancel uses. `shown(n)` is the page's text the n-th time it is read after the press (0 = before). */
function fakePage(shown: (reads: number) => string) {
  let pressed = false;
  let reads = 0;
  const fake = {
    acceptDialogs: false,
    docStatus: 200,
    clicks: [] as string[],
    goto: async () => ({ status: 200 }),
    // CoverManager finds its button by text in the page and marks it: the answer is the selector. OpenTable only asks `visible`.
    evaluate: async () => '[data-maitre-cancel="1"]',
    visible: async () => true,
    click: async (selector: string) => void (fake.clicks.push(selector), (pressed = true)),
    text: async () => (pressed ? shown(++reads) : shown(0)),
    // Page.waitForText as it is: the page's text read again and again until it has the words, or a timeout error.
    waitForText: async (words: RegExp, ms: number) => {
      const end = Date.now() + ms;
      for (;;) {
        if (words.test(await fake.text())) return true;
        if (Date.now() > end) throw new Error("wait: timed out");
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
  return fake;
}

const CARTS: [string, Cartridge][] = [["CoverManager", coverManager], ["OpenTable", openTable]];
const EVIDENCE = { url: "", text: "", cancelUrl: "http://127.0.0.1/cancel/X" };
const cancel = (c: Cartridge, page: ReturnType<typeof fakePage>) => c.cancel!({ page: page as unknown as Page, url: "", submitting: async () => undefined, stepMs: 400 }, EVIDENCE);

for (const [name, cart] of CARTS) {
  test(`maitre cancel: ${name} does not take a "cancelled" that was on the page before the press for a cancellation`, async () => {
    // The press only opens the page's own "are you sure?" step: nothing is cancelled.
    const sure = fakePage((n) => `${HEAD}\n${POLICY}\nCancel reservation${n ? "\nAre you sure? This cannot be undone.\nYes, I am sure" : ""}`);
    assert.equal(await cancel(cart, sure), false);
    assert.equal(sure.clicks.length, 1, "the button was pressed once");
    assert.equal(sure.acceptDialogs, true);
    // A page that shows nothing new at all.
    assert.equal(await cancel(cart, fakePage(() => `${HEAD}\n${POLICY}\nCancel reservation`)), false);
  });

  test(`maitre cancel: ${name} says true only for a cancellation sign that appeared after the press, also one that comes a little later or replaces the page`, async () => {
    // The sign is added to a page that carried the policy line already.
    assert.equal(await cancel(cart, fakePage((n) => `${HEAD}\n${POLICY}${n ? "\nYour reservation has been cancelled." : ""}`)), true);
    // The engine takes a moment: the first looks after the press still show the old page.
    assert.equal(await cancel(cart, fakePage((n) => `${HEAD}\n${POLICY}${n >= 3 ? "\nYour reservation has been cancelled." : ""}`)), true);
    // The page is replaced by the engine's answer, and the policy line is gone.
    assert.equal(await cancel(cart, fakePage((n) => (n ? "Reservation cancelled. We hope to see you soon." : `${HEAD}\n${POLICY}`))), true);
    // A page with no policy line (as before): the sign appears.
    assert.equal(await cancel(cart, fakePage((n) => (n ? "Your reservation was cancelled" : HEAD))), true);
  });
}

test("maitre cancel: CoverManager's Spanish sign counts too, once it is new", async () => {
  assert.equal(await cancel(coverManager, fakePage((n) => `${HEAD}\nLas reservas anuladas con menos de 24 horas se cobran.${n ? "\nSu reserva ha sido cancelada." : ""}`)), true);
  assert.equal(await cancel(coverManager, fakePage(() => `${HEAD}\nSi se cancelada tarde, se cobra.`)), false);
});
