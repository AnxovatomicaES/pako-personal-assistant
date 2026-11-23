// The quiet lines at the top of the dashboard (#notices): the connections' own (src/panel/connections.js) and the new mailbox's catch-up line
// (src/panel/app.js) share the box, and neither takes the other's away. Run against a stand-in document (test/helpers/fake-dom.ts).

import assert from "node:assert/strict";
import test from "node:test";
import { FakeElement, installDom } from "./helpers/fake-dom.ts";
import { eventually } from "./helpers/wait.ts";

test("the connections' lines leave the catch-up line in #notices alone, and are not added twice", async () => {
  const dom = installDom({ "settings-btn": "button", "settings-dot": "span", notices: "div" });
  try {
    const box = dom.el("notices");
    // app.js's renderCatchUp has put its line first in the box.
    const catchUp = new FakeElement("span");
    catchUp.setAttribute("id", "catch-up");
    catchUp.textContent = "Catching up on the last 14 days… 40%";
    box.prepend(catchUp);

    let status = [{ id: "telegram", state: "error" }];
    let asked = 0;
    dom.set("fetch", async (path: string) => {
      const body = path === "/panel/api/connections/status" ? (asked++, { connections: status }) : path === "/panel/api/demo" ? { on: false } : { connections: status, readable: true };
      return { ok: true, json: async () => body };
    });
    dom.set("window", {});
    dom.set("location", { href: "" });
    await import(new URL("../src/panel/connections.js?notices", import.meta.url).href);

    await eventually(() => box.querySelectorAll("a").length === 1);
    assert.equal(box.children[0], catchUp, "the catch-up line is still first");
    assert.equal(catchUp.textContent, "Catching up on the last 14 days… 40%");
    assert.match(box.querySelector("a")!.textContent, /Telegram stopped working/);

    // Back on the page: the lines are read again; the same one is not repeated, a new one is added, the catch-up stays.
    status = [{ id: "telegram", state: "error" }, { id: "whatsapp", state: "needsAction" }];
    await dom.doc.fire("visibilitychange");
    await eventually(() => asked >= 2 && box.querySelectorAll("a").length === 2);
    assert.deepEqual(box.querySelectorAll("a").map((a) => a.textContent.split(" ")[0]), ["Telegram", "WhatsApp"]);
    assert.equal(box.querySelectorAll("#catch-up").length, 1);
    assert.equal(box.children[0], catchUp);

    // Everything fixed: its lines go, the catch-up line stays while it runs.
    status = [];
    await dom.doc.fire("visibilitychange");
    await eventually(() => asked >= 3 && box.querySelectorAll("a").length === 0);
    assert.deepEqual(box.children, [catchUp]);
  } finally {
    dom.restore();
  }
});
