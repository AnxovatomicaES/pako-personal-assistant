// The phone's page (src/panel/m.js), run against a stand-in document (test/helpers/fake-dom.ts): it keeps refreshing after an answer that
// failed, and it says Unpair did not work when the server did not forget the phone.

import assert from "node:assert/strict";
import test from "node:test";
import { fakeTimers, installDom } from "./helpers/fake-dom.ts";
import { eventually } from "./helpers/wait.ts";

const TODAY = { now: 1_800_000_000_000, timeZone: "Europe/Madrid", loops: [], parked: [], closed: [], brief: null, telegram: false, drafts: false, device: "Ana's iPhone" };
const FAILED = "Couldn't reach Pako. Try again on your home Wi-Fi.";

type Answer = { status: number; body?: unknown } | "down";

let imports = 0;
/** The page loaded with `answer` as Pako's reply to each request; the requests it made are in `asked`. */
async function phonePage(answer: (path: string) => Answer) {
  const dom = installDom({ main: "main", status: "p", toast: "div", refresh: "button" });
  const timers = fakeTimers();
  timers.install(dom.set);
  const kept = new Map<string, string>();
  dom.set("localStorage", { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) });
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "iPhone", language: "en-GB" }, configurable: true });
  dom.set("location", { hash: "", pathname: "/m" });
  dom.set("history", { replaceState() {} });
  const asked: string[] = [];
  let confirmed = true;
  dom.set("confirm", () => confirmed);
  dom.set("fetch", async (path: string) => {
    asked.push(path);
    const a = answer(path);
    if (a === "down") throw new TypeError("Failed to fetch");
    return { status: a.status, json: async () => a.body ?? null };
  });
  await import(new URL(`../src/panel/m.js?page=${imports++}`, import.meta.url).href);
  return { dom, timers, kept, asked, confirmed: (v: boolean) => (confirmed = v), toast: () => dom.el("toast"), status: () => dom.el("status").textContent, main: () => dom.el("main") };
}

test("the phone page asks again after a refresh that failed: no answer, or an error from Pako, never leaves it without its next look", async () => {
  let mode: Answer = { status: 200, body: TODAY };
  const p = await phonePage(() => mode);
  try {
    await eventually(() => p.timers.waiting.length > 0);
    assert.deepEqual(p.timers.waiting, [60_000], "drawn: the next look in a minute");

    // The minute passes while Pako cannot be reached (the computer asleep, another Wi-Fi): the page already shows what it has.
    mode = "down";
    p.timers.fireLast();
    await eventually(() => /Can't reach Pako/.test(p.status()));
    assert.equal(p.timers.waiting.length, 1, "a refresh that could not reach Pako is tried again, not given up");

    // Pako answers, but with an error.
    mode = { status: 503, body: { error: "could not read" } };
    p.timers.fireLast();
    await eventually(() => p.status() === FAILED);
    assert.equal(p.timers.waiting.length, 1, "a refresh Pako answered with an error is tried again too");

    // And when it is back, the page is drawn and refreshes as before.
    mode = { status: 200, body: TODAY };
    p.timers.fireLast();
    await eventually(() => /^Updated /.test(p.status()));
    assert.deepEqual(p.timers.waiting, [60_000]);
  } finally {
    p.dom.restore();
  }
});

test("Unpair: only Pako's 200 (forgotten) or 401 (not paired) takes the phone out; an error or no answer says so and leaves the page as it was", async () => {
  let forget: Answer = { status: 500, body: { error: "could not" } };
  const p = await phonePage((path) => (path === "/m/api/forget" ? forget : { status: 200, body: TODAY }));
  try {
    await eventually(() => /^Updated /.test(p.status()));
    const unpair = () => p.main().querySelector("footer button")!;
    const shownPairing = () => p.main().querySelector("#pair-code") !== null;
    assert.ok(p.kept.size > 0, "the last answer is kept on the phone");

    // Pako answers with an error: still paired.
    await unpair().fire("click");
    assert.equal(p.toast().textContent, FAILED);
    assert.equal(p.toast().hidden, false);
    assert.equal(shownPairing(), false, "the page stays: this phone is still paired");
    assert.ok(p.kept.size > 0, "and its kept copy stays");

    // No answer at all (not on the home Wi-Fi): the same.
    forget = "down";
    p.toast().hidden = true;
    await unpair().fire("click");
    assert.equal(p.toast().hidden, false);
    assert.equal(shownPairing(), false);

    // Declined in the question: nothing is asked.
    p.confirmed(false);
    const before = p.asked.length;
    await unpair().fire("click");
    assert.equal(p.asked.length, before);
    p.confirmed(true);

    // Forgotten: out, the pairing form, the kept copy gone.
    forget = { status: 200, body: { ok: true } };
    await unpair().fire("click");
    assert.equal(shownPairing(), true);
    assert.equal(p.kept.size, 0);
  } finally {
    p.dom.restore();
  }
});

test("Unpair: a 401 (Pako did not know this phone) is out as well", async () => {
  const p = await phonePage((path) => (path === "/m/api/forget" ? { status: 401, body: { error: "pair this phone" } } : { status: 200, body: TODAY }));
  try {
    await eventually(() => /^Updated /.test(p.status()));
    await p.main().querySelector("footer button")!.fire("click");
    assert.ok(p.main().querySelector("#pair-code"), "the pairing form");
    assert.equal(p.kept.size, 0);
  } finally {
    p.dom.restore();
  }
});
