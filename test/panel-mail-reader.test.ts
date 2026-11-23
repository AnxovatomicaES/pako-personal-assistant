// "Move to…" in the mail reader (src/panel/mail.js): the reader holds the server's copy of the mail and the list its own, so a move made from
// the reader must reach the list (tabs, counts) and the reader's own category line. Run against a stand-in document (test/helpers/fake-dom.ts).

import assert from "node:assert/strict";
import test from "node:test";
import { fakeTimers, installDom } from "./helpers/fake-dom.ts";
import { eventually } from "./helpers/wait.ts";

const AT = Date.UTC(2026, 10, 20, 9, 0);

test("moving a mail from the reader moves it in the list too, and the reader says where it is now", async () => {
  const dom = installDom({ "mail-filter": "div", "mail-list": "ul" });
  fakeTimers().install(dom.set); // the toast's own timer must not outlive the test
  try {
    const moves: unknown[] = [];
    let views = 0;
    dom.set("window", {});
    dom.set("fetch", async (path: string, init?: { body?: string }) => {
      let body: unknown = {};
      if (path === "/panel/api/mail/view") return { ok: true, json: async () => (views++, body) };
      if (path.startsWith("/panel/api/mail/item")) body = { item: { id: "m1", from: "Bea <bea@example.com>", subject: "Invoice 4471", category: "updates", at: AT, why: "" }, text: "Hi, the invoice is ready.", partial: false, link: null, loops: [] };
      else if (path === "/panel/api/mail/move") moves.push(JSON.parse(init!.body!));
      return { ok: true, json: async () => body };
    });
    const mail = (await import(new URL("../src/panel/mail.js?reader", import.meta.url).href)) as { setMail: (items: unknown[]) => void };
    mail.setMail([{ id: "m1", from: "Bea <bea@example.com>", subject: "Invoice 4471", category: "updates", at: AT }, { id: "m2", from: "Luis <luis@example.com>", subject: "Lunch?", category: "personal", at: AT }]);

    const counts = (): Record<string, string> => Object.fromEntries(dom.el("mail-filter").querySelectorAll("button").map((b) => [b.children[0]!.textContent, b.querySelector(".count")!.textContent]));
    assert.equal(counts()["Updates"], "1");
    assert.equal(counts()["Important"], "0");

    // Open it in the reader (from the list under the Updates tab), and move it from there.
    await dom.el("mail-filter").querySelectorAll("button").find((b) => b.children[0]!.textContent === "Updates")!.fire("click");
    await dom.el("mail-list").querySelector("li.item")!.fire("click");
    await eventually(() => dom.doc.getElementById("mail-reader")?.querySelector(".reader-cat") != null);
    const reader = dom.doc.getElementById("mail-reader")!;
    assert.match(reader.querySelector(".reader-cat")!.textContent, /Updates/);
    const select = reader.querySelector("select")!;
    select.value = "important";
    await select.fire("change");

    assert.deepEqual(moves, [{ id: "m1", category: "important" }]);
    assert.equal(counts()["Updates"], "0", "the list's own copy moved: its counts follow");
    assert.equal(counts()["Important"], "1");
    assert.match(reader.querySelector(".reader-cat")!.textContent, /Important · You moved it to Important/, "the reader's line");
    assert.ok(reader.querySelector(".reader-cat")!.classList.contains("k-important"));
    assert.equal(dom.el("mail-list").querySelectorAll("li.item").length, 0, "no longer under the Updates tab");
    // What the reader offers now: every category but the new one (the old one included), and the choice itself is cleared.
    assert.equal(select.value, "");
    const offered = select.children.map((o) => (o as unknown as { getAttribute(k: string): string }).getAttribute("value"));
    assert.ok(offered.includes("updates") && !offered.includes("important"), offered.join());
    // The page reads its view again after opening the mail and after the move: let both finish before the page is taken away.
    await eventually(() => views === 2, { then: 10 });
  } finally {
    dom.restore();
  }
});

test("a move that did not go through leaves the list and the reader as they were", async () => {
  const dom = installDom({ "mail-filter": "div", "mail-list": "ul" });
  fakeTimers().install(dom.set);
  try {
    let views = 0;
    dom.set("window", {});
    dom.set("fetch", async (path: string) => {
      if (path === "/panel/api/mail/move") return { ok: false, json: async () => ({}) };
      if (path === "/panel/api/mail/view") return { ok: true, json: async () => (views++, {}) };
      const body = path.startsWith("/panel/api/mail/item") ? { item: { id: "m1", from: "Bea", subject: "Invoice", category: "updates", at: AT }, text: "x", partial: false, link: null, loops: [] } : {};
      return { ok: true, json: async () => body };
    });
    const mail = (await import(new URL("../src/panel/mail.js?refused", import.meta.url).href)) as { setMail: (items: unknown[]) => void };
    mail.setMail([{ id: "m1", from: "Bea", subject: "Invoice", category: "updates", at: AT }]);
    await dom.el("mail-filter").querySelectorAll("button").find((b) => b.children[0]!.textContent === "Updates")!.fire("click");
    await dom.el("mail-list").querySelector("li.item")!.fire("click");
    await eventually(() => dom.doc.getElementById("mail-reader")?.querySelector(".reader-cat") != null);
    const reader = dom.doc.getElementById("mail-reader")!;
    const select = reader.querySelector("select")!;
    select.value = "important";
    await select.fire("change");
    assert.match(dom.doc.getElementById("mail-toast")!.textContent, /Couldn't move it right now/);
    assert.match(reader.querySelector(".reader-cat")!.textContent, /Updates/);
    assert.equal(dom.el("mail-list").querySelectorAll("li.item").length, 1, "still under Updates");
    assert.equal(select.value, "", "the choice is cleared, nothing moved");
    await eventually(() => views === 2, { then: 10 });
  } finally {
    dom.restore();
  }
});
