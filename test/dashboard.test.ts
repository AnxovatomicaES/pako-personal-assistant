import { readFileSync as readRepoFile } from "node:fs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createControl } from "../src/control.ts";
import { mountDashboard, overview, type PanelDeps } from "../src/dashboard.ts";
import { loadMemory } from "../src/voice-memory.ts";

function deps(over: Partial<PanelDeps> = {}): PanelDeps {
  return {
    secret: "bridge-token-for-tests-0123456789abcdef",
    publicUrl: "https://pako.example",
    ownerName: "Marta",
    timeZone: "Europe/Madrid",
    control: createControl(null),
    memory: loadMemory(null),
    wa: { reminders: async () => [], events: () => [], lastPoll: () => 0 },
    integrations: () => [{ key: "whatsapp", name: "WhatsApp", on: true, detail: "" }],
    ...over,
  };
}

async function rig(over: Partial<PanelDeps> = {}) {
  const app = express();
  const d = deps(over);
  const panel = mountDashboard(app, d);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { d, panel, base, close: () => (server.close(), server.closeAllConnections()) };
}

const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0]!;

test("panel: a one-time link signs a browser in for /panel only; the link works once; without the cookie only the sign-in page", async () => {
  const r = await rig();
  try {
    const page = await fetch(`${r.base}/panel`);
    assert.match(await page.text(), /type <b>PANEL<\/b> to Pako on WhatsApp/);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.equal((await fetch(`${r.base}/panel/api/overview`)).status, 401);

    const link = r.panel.link();
    assert.match(link, /^https:\/\/pako\.example\/panel\/login\/[A-Za-z0-9_-]{32}$/);
    const path = new URL(link).pathname;
    const first = await fetch(`${r.base}${path}`, { redirect: "manual" });
    assert.equal(first.status, 200, "a page that moves on by itself, not a redirect (a cross-site redirect would drop the strict cookie)");
    assert.match(await first.text(), /<meta http-equiv="refresh" content="0;url=\/panel">/);
    const setCookie = first.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /^pako_panel_443=\d+\.[A-Za-z0-9_-]+; Max-Age=2592000; Path=\/panel; Expires=.*; HttpOnly; Secure; SameSite=Strict$/);
    const cookie = cookieOf(first);
    const again = await fetch(`${r.base}${path}`, { redirect: "manual" });
    assert.equal(again.status, 401, "a link works once");

    const ok = await fetch(`${r.base}/panel/api/overview`, { headers: { cookie } });
    assert.equal(ok.status, 200);
    assert.match(await (await fetch(`${r.base}/panel`, { headers: { cookie } })).text(), /<main class="grid"/);
    const forged = cookie.replace(/\.[^.]+$/, ".AAAA");
    assert.equal((await fetch(`${r.base}/panel/api/overview`, { headers: { cookie: forged } })).status, 401);
    const other = await rig({ secret: "another-bridge-token-0123456789abcdef" });
    try {
      assert.equal((await fetch(`${other.base}/panel/api/overview`, { headers: { cookie } })).status, 401, "a new bridge token signs every browser out");
    } finally {
      other.close();
    }
  } finally {
    r.close();
  }
});

test("panel: an old link is refused; STOP needs the cookie and the custom header, and is logged", async () => {
  let clock = 1_800_000_000_000;
  const r = await rig({ now: () => clock });
  try {
    const old = new URL(r.panel.link()).pathname;
    clock += 11 * 60_000;
    assert.equal((await fetch(`${r.base}${old}`, { redirect: "manual" })).status, 401);
    const cookie = cookieOf(await fetch(`${r.base}${new URL(r.panel.link()).pathname}`, { redirect: "manual" }));
    const press = (headers: Record<string, string>) =>
      fetch(`${r.base}/panel/api/pause`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ on: true }) });
    assert.equal((await press({ cookie })).status, 401, "no custom header: another site cannot press it");
    assert.equal((await press({ "x-pako": "1" })).status, 401, "no cookie");
    const ok = await press({ cookie, "x-pako": "1" });
    assert.equal(ok.status, 200);
    assert.equal(await r.d.control.paused(), clock);
    assert.ok((await r.d.control.recent(5)).some((l) => l.text === "STOP from the panel: everything stopped"));
  } finally {
    r.close();
  }
});

test("panel: the STOP switch runs the whole STOP (held actions, cards), the same as a typed one; its RESUME only lifts the pause", async () => {
  let clock = Date.parse("2026-11-15T09:00:00Z");
  const stops: { at: number; line?: string }[] = [];
  const r = await rig({ now: () => clock, stop: async (at, line) => (stops.push({ at, line }), true) });
  try {
    const cookie = cookieOf(await fetch(`${r.base}${new URL(r.panel.link()).pathname}`, { redirect: "manual" }));
    const press = (on: boolean) =>
      fetch(`${r.base}/panel/api/pause`, { method: "POST", headers: { "content-type": "application/json", cookie, "x-pako": "1" }, body: JSON.stringify({ on }) });
    assert.equal((await press(true)).status, 200);
    assert.deepEqual(stops, [{ at: clock, line: "STOP from the panel: everything stopped" }]);
    clock += 1000;
    assert.equal((await press(false)).status, 200);
    assert.equal(stops.length, 1);
    assert.equal(await r.d.control.paused(), null);
  } finally {
    r.close();
  }
});

test("panel: the overview is what Pako really has (no sample data): calendar with overlaps, mail, Slack, reminders, notes, the log", async () => {
  const t = Date.parse("2026-11-15T09:00:00Z");
  const memory = loadMemory(null);
  await memory.addNote("café solo", t - 1000);
  const control = createControl(null);
  control.log("correo", "Correo de Ana", t - 500);
  const o = await overview(
    deps({
      now: () => t,
      control,
      memory,
      wa: { reminders: async () => [{ at: t + 3600_000, text: "llamar", held: false }], events: () => [{ at: t - 60_000, text: "llamada a Ana" }], lastPoll: () => t - 5_000 },
      mail: { address: "yo@agentmail.to", items: async () => [{ id: "1", at: t - 60_000, from: "Ana", subject: "Hola", preview: "hola", kind: "aviso" as const }] },
      slack: { alerts: async () => [{ at: t - 1000, where: "Ana (privado)", text: "¿hablamos?" }] },
      bookings: {
        list: async () => [
          { id: "b2", at: t, placeId: "p", name: "Bar Mut", address: "x", slot: t + 5 * 86400_000, party: 2, route: "link", status: "enlace", guest: "Marta" },
          { id: "b1", at: t, placeId: "p", name: "Cal Pep", address: "x", slot: t + 2 * 86400_000, party: 4, route: "email", status: "pedida", email: "a@b.es", guest: "Marta" },
          { id: "b0", at: t, placeId: "p", name: "Ayer", address: "x", slot: t - 86400_000, party: 2, route: "email", status: "pedida", guest: "Marta" },
          { id: "bx", at: t, placeId: "p", name: "Cancelada", address: "x", slot: t + 86400_000, party: 2, route: "email", status: "cancelada", guest: "Marta" },
        ],
      },
      calendar: {
        events: async () => [
          { id: "a", title: "Comité", start: t + 3600_000, end: t + 7200_000, allDay: false, calendar: "Trabajo" },
          { id: "b", title: "Llamada", start: t + 5400_000, end: t + 9000_000, allDay: false, calendar: "Trabajo", join: "https://x.zoom.us/j/1" },
          { id: "c", title: "Ayer", start: t - 48 * 3600_000, end: t - 47 * 3600_000, allDay: false, calendar: "Trabajo" },
        ],
      },
    }),
  );
  assert.equal(o.mac.online, true);
  assert.deepEqual(o.events.map((e) => [e.title, e.clash]), [["Comité", true], ["Llamada", true]], "old events dropped, overlaps marked");
  assert.equal(o.calendarOn && o.calendarOk, true);
  assert.equal(o.mail?.items[0]!.from, "Ana");
  assert.equal(o.slack?.[0]!.text, "¿hablamos?");
  assert.deepEqual(o.bookings?.map((b) => [b.name, b.party, b.status]), [["Cal Pep", 4, "pedida"], ["Bar Mut", 2, "enlace"]], "coming and not cancelled, soonest first, no email address or guest name sent to the page");
  assert.ok(!("email" in o.bookings![0]!) && !("guest" in o.bookings![0]!));
  assert.deepEqual(o.notes.map((n) => n.text), ["café solo"]);
  assert.equal(o.log[0]!.text, "Correo de Ana");
  assert.equal(o.happenings[0]!.text, "llamada a Ana");

  const broken = await overview(deps({ calendar: { events: async () => { throw new Error("zoho down"); } } }));
  assert.deepEqual([broken.calendarOn, broken.calendarOk], [true, false], "connected but unreadable is said so");
  const none = await overview(deps());
  assert.deepEqual([none.calendarOn, none.mail, none.slack, none.bookings], [false, null, null, null], "nothing connected: nothing invented");
});

test("panel: the page and its libraries are served from this server only", async () => {
  const r = await rig();
  try {
    for (const name of ["app.js", "app.css", "orb.js", "gsap.min.js", "lucide.min.js", "three.module.js", "three.core.js", "inter.woff2"]) {
      const res = await fetch(`${r.base}/panel/assets/${name}`);
      assert.equal(res.status, 200, name);
      await res.arrayBuffer();
    }
    assert.equal((await fetch(`${r.base}/panel/assets/..%2F..%2Fpackage.json`)).status, 404);
    assert.equal((await fetch(`${r.base}/panel/assets/secret.env`)).status, 404);
    assert.equal((await fetch(`${r.base}/`, { redirect: "manual" })).headers.get("location"), "/panel");
  } finally {
    r.close();
  }
});


/** A file of the repository, as text. */
const repoText = (p: string): string => readRepoFile(new URL(`../${p}`, import.meta.url), "utf8");

// The chat's glow (.chat::before) reaches 20% past each side of the box; with overflow: hidden the box is still a scroll container, so a
// focus or scrollIntoView after "Skip" on the welcome scrolled it sideways (66px on a 330px box). overflow: clip cuts it and never scrolls.
test("the chat box cannot be scrolled sideways by its wider glow: overflow: clip, on the box and its header", () => {
  const css = repoText("src/panel/app.css");
  assert.match(css, /^\.chat::before \{[^}]*left: -20%; right: -20%/m, "the layer wider than the box");
  // After the rules that say overflow: hidden (kept for a browser without clip), so it wins.
  const clip = css.indexOf(".chat, .chat-head { overflow: clip; }");
  assert.ok(clip > css.indexOf(".chat { position: fixed;") && clip > css.indexOf(".chat-head { position: relative;"), "clip after hidden");
});

test("panel: Sign out everywhere ends every session made before (this one too); old sessions work until then; a failed save ends none", async () => {
  const m = new Map<string, string>();
  let fail = false;
  const kv = {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => {
      if (fail) throw new Error("disk full");
      m.set(k, v);
    },
  };
  const r = await rig({ kv });
  const signIn = async () => {
    const path = new URL(r.panel.link()).pathname;
    return cookieOf(await fetch(`${r.base}${path}`, { redirect: "manual" }));
  };
  const ok = (cookie: string) => fetch(`${r.base}/panel/api/overview`, { headers: { cookie } }).then((x) => x.status);
  const end = (cookie: string) => fetch(`${r.base}/panel/api/sessions/end`, { method: "POST", headers: { cookie, "x-pako": "1" } });
  try {
    await new Promise((res) => setTimeout(res, 20)); // the generation read from the store at start
    const a = await signIn();
    const b = await signIn();
    assert.match(a, /^pako_panel_443=\d+\.[A-Za-z0-9_-]+$/, "generation 0: the session as before (old ones go on)");
    assert.equal(await ok(a), 200);
    assert.equal((await fetch(`${r.base}/panel/api/sessions/end`, { method: "POST", headers: { cookie: a } })).status, 401, "x-pako needed");
    fail = true;
    assert.equal((await end(a)).status, 503);
    assert.equal(await ok(b), 200, "a failed save ends nothing");
    fail = false;
    const done = await end(a);
    assert.equal(done.status, 200);
    assert.match(done.headers.get("set-cookie") ?? "", /^pako_panel_443=;/);
    assert.equal(await ok(a), 401);
    assert.equal(await ok(b), 401, "every session made before ends");
    const c = await signIn();
    assert.match(c, /^pako_panel_443=\d+\.1\.[A-Za-z0-9_-]+$/);
    assert.equal(await ok(c), 200, "a new link starts a new one");
    assert.equal(await ok(c.replace(/\.1\./, ".0.")), 401, "its generation cannot be changed by hand");
    assert.deepEqual(JSON.parse(m.get("panel-sessions")!), { gen: 1 });
  } finally {
    r.close();
  }
});

test("panel: Sign out everywhere holds when the store is emptied or another one takes over (Delete everything, the demo week); a link not used yet ends too", async () => {
  const memKv = () => {
    const m = new Map<string, string>();
    return { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v) };
  };
  // On a computer the generation is also kept with the run secrets (src/local.ts sessionGeneration), which both of those leave as they are.
  let kept = 0;
  const generation = { read: () => kept, write: (g: number) => void (kept = g) };
  const signInTo = async (r: Awaited<ReturnType<typeof rig>>) => cookieOf(await fetch(`${r.base}${new URL(r.panel.link()).pathname}`, { redirect: "manual" }));
  const status = (r: Awaited<ReturnType<typeof rig>>, cookie: string) => fetch(`${r.base}/panel/api/overview`, { headers: { cookie } }).then((x) => x.status);

  const first = await rig({ kv: memKv(), generation });
  let stolen: string;
  let owner: string;
  try {
    stolen = await signInTo(first);
    const unused = new URL(first.panel.link()).pathname;
    assert.equal(await status(first, stolen), 200);
    const end = await fetch(`${first.base}/panel/api/sessions/end`, { method: "POST", headers: { cookie: stolen, "x-pako": "1" } });
    assert.equal(end.status, 200);
    assert.equal(kept, 1, "kept apart from the store");
    assert.equal(await status(first, stolen), 401);
    assert.equal((await fetch(`${first.base}${unused}`, { redirect: "manual" })).status, 401, "a link made before is worth nothing now");
    owner = await signInTo(first);
    assert.equal(await status(first, owner), 200, "the owner signs in again with a new link");
  } finally {
    first.close();
  }
  // The store is empty (Delete everything keeps the run secrets, the demo week has a store of its own): same secret, no generation in it.
  const wiped = await rig({ kv: memKv(), generation });
  try {
    assert.equal(await status(wiped, stolen), 401, "the session ended by Sign out everywhere stays ended");
    assert.equal(await status(wiped, owner), 200, "the owner's own session goes on");
    const next = await signInTo(wiped);
    assert.match(next, /^pako_panel_443=\d+\.1\.[A-Za-z0-9_-]+$/, "new sessions carry the generation, so the next Sign out everywhere moves it on from there");
    const end = await fetch(`${wiped.base}/panel/api/sessions/end`, { method: "POST", headers: { cookie: next, "x-pako": "1" } });
    assert.equal(end.status, 200);
    assert.equal(kept, 2);
  } finally {
    wiped.close();
  }
  // The generation cannot be kept (the secrets cannot be written): nothing ends, and the owner is told.
  const stuck = await rig({ kv: memKv(), generation: { read: () => kept, write: () => { throw new Error("keychain locked"); } } });
  try {
    const c = await signInTo(stuck);
    assert.equal((await fetch(`${stuck.base}/panel/api/sessions/end`, { method: "POST", headers: { cookie: c, "x-pako": "1" } })).status, 503);
    assert.equal(await status(stuck, c), 200);
  } finally {
    stuck.close();
  }
});
