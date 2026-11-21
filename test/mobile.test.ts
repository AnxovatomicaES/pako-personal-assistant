// Pako on the owner's phone, on the same Wi-Fi (src/mobile-access.ts, src/mobile.ts, src/mobile-panel.ts, src/app/mobile.ts, src/panel/m*.js):
// pairing works once and for 10 minutes, is rate limited and can be revoked; every /m API call needs a device token; nothing listens on
// the home network until the owner turns it on; the page's model draws the brief and the nudges from a fixture; and the phone's buttons
// press the same follow-ups door the chat's buttons press.

import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import type { BriefV2 } from "../src/brief-v2.ts";
import { chatText } from "../src/brief-v2.ts";
import { createFollowups, FOLLOWUPS_KEY, followupsProxy } from "../src/followups.ts";
import type { Kv } from "../src/kv.ts";
import { createMobileAccess, createMobileListener, lanAddresses, MOBILE_KEY, PAIR_MS, PAIR_TRIES } from "../src/mobile-access.ts";
import { createMobileApp, PHONE_COOKIE, type MobileToday } from "../src/mobile.ts";
import { mountMobilePanel } from "../src/mobile-panel.ts";
import { mobileFeed, phonePort } from "../src/app/mobile.ts";

const model = (await import(new URL("../src/panel/m-model.js", import.meta.url).href)) as {
  phoneModel: (d: unknown, o?: unknown) => {
    now: Item[]; owe: Item[]; owed: Item[]; parked: Item[]; closed: Item[]; telegram: boolean; followups: boolean;
    brief: { none: boolean; asOf: number | null; opening: string; focus: { title: string; cites: Cite[] } | null; todos: { title: string; cites: Cite[] }[];
      updates: { title: string; cites: Cite[] }[]; day: { when: string; title: string; confirmed: boolean; cites: Cite[] }[] } | null;
  };
  mailtoFor: (item: { to?: string }, text: string) => string;
  dueText: (at: number, now: number, o?: unknown) => { text: string; late: boolean };
  readCache: (raw: string | null) => unknown;
};
interface Cite { id: string; kind: string; label: string }
interface Item { id: string; title: string; actions: string[]; due: { text: string; late: boolean } | null; canDraft: boolean; draft: { status: string; text: string } | null; to: string }

const MIN = 60_000;
const T0 = Date.parse("2026-11-16T09:00:00Z");

function memKv() {
  const m = new Map<string, string>();
  const kv: Kv = { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
  return { m, kv };
}

const listen = async (app: express.Express | ((req: unknown, res: unknown) => void)): Promise<{ server: Server; base: string; port: number }> => {
  const server = createServer(app as Parameters<typeof createServer>[0]);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}`, port };
};
const close = (s: Server) => new Promise<void>((r) => (s.close(() => r()), s.closeAllConnections()));
/** A request with headers fetch would not send as given (Host, Sec-Fetch-Mode): its status. */
const raw = (port: number, path: string, headers: Record<string, string>): Promise<number> =>
  new Promise((resolve, reject) => {
    const q = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    q.on("error", reject);
    q.end();
  });
/** A port nothing listens on now. */
const freePort = async (): Promise<number> => {
  const { server, port } = await listen(express());
  await close(server);
  return port;
};

// ---------- the fixture: loops both ways, and today's brief with its sources ----------

const loop = (id: string, kind: string, title: string, who: string, o: Record<string, unknown> = {}) => ({
  id, kind, title, detail: "", who, where: { type: "mail", label: `email from ${who}` }, whenSaid: T0 - 120 * MIN,
  check: { none: { reason: "email" } }, status: "open", nextCheckAt: T0 + 60 * MIN, nudges: 0, createdAt: T0 - 120 * MIN,
  sources: [{ kind: "mail", label: `email from ${who}`, at: T0 - 120 * MIN, ref: `m-${id}` }], ...o,
});

const LOOPS = [
  loop("a000000001", "owner_promise", "Send Ana the Q4 deck", "ana@example.com", { nudges: 1, dueAt: T0 + 30 * MIN }),
  loop("a000000002", "request_to_owner", "Review Omar's contract", "Omar", { dueAt: T0 + 3 * 24 * 60 * MIN }),
  loop("a000000003", "other_promise", "Vic sends the signed lease", "Vic"),
  loop("a000000004", "owner_promise", "Call the plumber", "", { status: "parked", parkedAt: T0 - 60 * MIN, nextCheckAt: 0 }),
  loop("a000000005", "owner_promise", "Book the dentist", "", { status: "done", closedAt: T0 - 30 * MIN, nextCheckAt: 0 }),
];

const DOC = {
  id: "b000000001", day: "2026-11-16", at: T0 - 60 * MIN, lang: "en", opening: "A light Monday.",
  focus: { title: "Finish the Q4 deck", story: "Ana needs it before Wednesday.", offer: "Draft the summary", sources: ["F1"] },
  todos: [
    { title: "Send Ana the Q4 deck", context: "She asked on Friday.", checked: "", sources: ["F1", "F9"], loopId: "a000000001" },
    { title: "Water the plants", context: "", checked: "", sources: ["F2"], taskId: "t1" },
  ],
  updates: [{ n: 1, title: "Omar replied", tag: "mail", text: "He is fine with Tuesday.", sources: ["F3"] }],
  dayItems: [{ time: "11:00", end: "11:30", title: "Call with AcmeCo", confirmed: false, note: "", sources: ["F4"] }],
  sourcesUsed: ["mail", "calendar"],
  refs: [
    { id: "F1", icon: "mail", label: "Ana Ruiz" },
    { id: "F2", icon: "tasks", label: "Tasks" },
    { id: "F3", icon: "mail", label: "Omar" },
    { id: "F4", icon: "calendar", label: "Work calendar" },
  ],
};

function feedRig(o: { drafted?: { id: string; status: string } | null } = {}) {
  const { m, kv } = memKv();
  m.set(FOLLOWUPS_KEY, JSON.stringify({ loops: LOOPS }));
  const engine = createFollowups({
    config: { delayMs: 10 * MIN, maxPerDay: 6, batchMs: 3 * MIN, quiet: { start: 23 * 60, end: 8 * 60 } },
    kv, timeZone: "Europe/London", now: () => T0, enqueue: async () => true, card: async () => true, notify: async () => undefined,
  });
  // The door the chat's buttons press (src/door/buttons.ts: d.followups.press), watched.
  const proxy = followupsProxy(() => engine);
  const presses: string[] = [];
  const door = { press: async (b: Parameters<typeof proxy.press>[0], id: string) => (presses.push(`${b}:${id}`), proxy.press(b, id)) };
  const tasks = new Map<string, { id: string; kind: string; status: string; text: string }>();
  const brief = {
    view: async () => ({ doc: { ...DOC, todos: DOC.todos.map((x) => ({ ...x, done: false })) }, latest: null, pending: false, tasks: [] }),
    task: async (id: string) => tasks.get(id) ?? null,
  } as unknown as Pick<BriefV2, "view" | "task">;
  const drafted: string[] = [];
  const feed = mobileFeed({
    engine: () => engine, door, brief: () => brief, timeZone: "Europe/London", name: () => "Theo", gentle: async () => false, telegram: () => true,
    now: () => T0,
    draftLoop: async (l) => {
      drafted.push(l.id);
      return o.drafted === undefined ? { id: "d000000001", status: "pending" } : o.drafted;
    },
  });
  const status = async () => Object.fromEntries((JSON.parse(m.get(FOLLOWUPS_KEY)!).loops as { id: string; status: string }[]).map((l) => [l.id, l.status]));
  return { feed, presses, status, tasks, drafted };
}

// ---------- 1. pairing ----------

test("pairing: a code works once, for 10 minutes; the newest replaces the one before; five wrong tries burn it", async () => {
  const clock = { now: T0 };
  const { kv } = memKv();
  const a = createMobileAccess({ kv, now: () => clock.now });
  assert.equal(a.pairing(), null);
  const first = a.pair();
  assert.match(first.code, /^[2-9A-HJKMNP-TV-Z]{10}$/, "ten letters a person can type, none that look alike");
  assert.equal(first.expiresAt, T0 + PAIR_MS);
  const second = a.pair();
  assert.equal(await a.redeem(first.code, "Old"), null, "a newer code replaced it");
  const got = await a.redeem(`${second.code.slice(0, 5).toLowerCase()}-${second.code.slice(5)}`, "Theo's iPhone");
  assert.ok(got, "typed in lowercase with its dash, it still works");
  assert.equal(got.device.name, "Theo's iPhone");
  assert.equal(await a.redeem(second.code, "Again"), null, "one use");
  // Expiry.
  const third = a.pair();
  clock.now += PAIR_MS;
  assert.equal(await a.redeem(third.code, "Late"), null, "ten minutes on, it is worth nothing");
  // Wrong tries.
  clock.now = T0;
  const fourth = a.pair();
  for (let i = 0; i < PAIR_TRIES; i++) assert.equal(await a.redeem("WRONGCODE2", "x"), null);
  assert.equal(a.pairing(), null, "burnt");
  assert.equal(await a.redeem(fourth.code, "Right but too late"), null);
  assert.equal((await a.devices()).length, 1);
});

test("devices: only a hash of the token is kept; a removed phone is shut out at once; names are one short line", async () => {
  const { m, kv } = memKv();
  const a = createMobileAccess({ kv, now: () => T0 });
  const one = (await a.redeem(a.pair().code, "  <b>Phone\nOne</b> "))!;
  const two = (await a.redeem(a.pair().code, ""))!;
  const kept = m.get(MOBILE_KEY)!;
  assert.ok(!kept.includes(one.token) && !kept.includes(two.token), "never the token itself");
  assert.match(kept, /"hash":"[0-9a-f]{64}"/);
  assert.equal(one.device.name, "b Phone One /b");
  assert.equal(two.device.name, "Phone");
  assert.equal((await a.check(one.token))?.id, one.device.id);
  assert.equal(await a.check("not-a-token"), null);
  assert.equal(await a.revoke(one.device.id), true);
  assert.equal(await a.check(one.token), null, "removed: shut out");
  assert.equal((await a.check(two.token))?.id, two.device.id);
  // A new start reads the same record.
  const again = createMobileAccess({ kv, now: () => T0 });
  assert.equal((await again.check(two.token))?.name, "Phone");
  assert.equal(await again.revokeAll(), 1);
  assert.equal(await again.check(two.token), null);
  assert.equal(await again.enabled(), false, "off unless turned on");
});

// ---------- 2. the phone's server ----------

async function phoneRig(today?: () => Promise<MobileToday>) {
  const { kv } = memKv();
  const access = createMobileAccess({ kv });
  const acts: string[] = [];
  const app = createMobileApp({
    access,
    hosts: () => ["127.0.0.1"],
    today: today ?? (async () => ({ now: T0, timeZone: "UTC", name: "", gentle: false, brief: null, loops: [], parked: [], closed: [], telegram: false, drafts: true })),
    act: async (id, action) => (acts.push(`${action}:${id}`), { ok: true, say: "Done." }),
    draft: async (id) => (acts.push(`draft:${id}`), { ok: true, say: "Writing." }),
  });
  const s = await listen(app);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${s.base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: s.base, "x-pako": "1", ...headers }, body: JSON.stringify(body) });
  const pair = async (): Promise<string> => {
    const r = await post("/m/api/pair", { code: access.pair().code, name: "Test phone" });
    assert.equal(r.status, 200);
    return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  return { ...s, access, acts, post, pair };
}

test("every /m API call needs a paired phone's token; the page, its files and the manifest do not, and carry no data", async () => {
  const r = await phoneRig();
  try {
    const routes: [string, string, unknown?][] = [["GET", "/m/api/today"], ["POST", "/m/api/loop", { id: "a000000001", action: "done" }],
      ["POST", "/m/api/draft", { id: "a000000001" }], ["POST", "/m/api/forget", {}]];
    for (const cookie of [undefined, `${PHONE_COOKIE}=forged-token`]) {
      for (const [method, path, body] of routes) {
        const res = method === "GET"
          ? await fetch(`${r.base}${path}`, { headers: cookie ? { cookie } : {} })
          : await r.post(path, body, cookie ? { cookie } : {});
        assert.equal(res.status, 401, `${method} ${path} ${cookie ? "with a forged token" : "without a token"}`);
      }
    }
    assert.deepEqual(r.acts, [], "nothing was pressed");
    const page = await fetch(`${r.base}/m`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'; script-src 'self'/);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    const html = await page.text();
    assert.match(html, /<link rel="manifest" href="\/m\/assets\/manifest\.webmanifest">/);
    assert.match(html, /apple-touch-icon/);
    assert.ok(!/https?:\/\//.test(html), "nothing from the network");
    const manifest = (await (await fetch(`${r.base}/m/assets/manifest.webmanifest`)).json()) as { display: string; start_url: string; icons: { sizes: string }[] };
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.start_url, "/m");
    assert.deepEqual(manifest.icons.map((i) => i.sizes), ["192x192", "512x512", "512x512"]);
    for (const [name, size] of [["icon-192.png", 192], ["apple-touch-icon.png", 180], ["icon-512.png", 512]] as const) {
      const png = Buffer.from(await (await fetch(`${r.base}/m/assets/${name}`)).arrayBuffer());
      assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47], `${name} is a PNG`);
      assert.equal(png.readUInt32BE(16), size);
    }
    for (const f of ["m.js", "m-model.js", "m.css"]) assert.equal((await fetch(`${r.base}/m/assets/${f}`)).status, 200, f);
    assert.equal((await fetch(`${r.base}/m/assets/app.js`)).status, 404, "none of the panel's files");
    assert.equal((await fetch(`${r.base}/panel`)).status, 404, "none of the panel's routes");
    assert.equal((await fetch(`${r.base}/assistant/inbox`)).status, 404, "nor the bridge's");
  } finally {
    await close(r.server);
  }
});

test("pairing over the network: the code once, then an httpOnly SameSite=Strict cookie for /m; the API works; Unpair and revoke shut it out", async () => {
  const r = await phoneRig();
  try {
    const code = r.access.pair().code;
    const ok = await r.post("/m/api/pair", { code, name: "Theo's iPhone" });
    assert.equal(ok.status, 200);
    const set = ok.headers.get("set-cookie") ?? "";
    assert.match(set, new RegExp(`^${PHONE_COOKIE}=[A-Za-z0-9_-]{43};`));
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Strict/);
    assert.match(set, /Path=\/m/);
    assert.ok(!JSON.stringify(await ok.clone().json()).includes(set.split(";")[0]!.split("=")[1]!), "the token is in the cookie only, never in the body");
    assert.equal((await r.post("/m/api/pair", { code, name: "Thief" })).status, 401, "the same code twice");
    const cookie = set.split(";")[0]!;
    const today = await fetch(`${r.base}/m/api/today`, { headers: { cookie } });
    assert.equal(today.status, 200);
    assert.equal(((await today.json()) as { device: string }).device, "Theo's iPhone");
    assert.match(today.headers.get("set-cookie") ?? "", /Max-Age=34560000/, "set again on each visit: 400 days from the last");
    assert.equal((await r.post("/m/api/loop", { id: "a000000001", action: "done" }, { cookie })).status, 200);
    assert.equal((await r.post("/m/api/loop", { id: "a000000001", action: "delete" }, { cookie })).status, 400, "only the five actions");
    assert.equal((await r.post("/m/api/draft", { id: "a000000001" }, { cookie })).status, 200);
    assert.deepEqual(r.acts, ["done:a000000001", "draft:a000000001"]);
    // Removed in Settings: shut out at the next request.
    const device = (await r.access.devices())[0]!;
    await r.access.revoke(device.id);
    assert.equal((await fetch(`${r.base}/m/api/today`, { headers: { cookie } })).status, 401);
    // Unpair from the phone itself.
    const other = await r.pair();
    assert.equal((await r.post("/m/api/forget", {}, { cookie: other })).status, 200);
    assert.equal((await fetch(`${r.base}/m/api/today`, { headers: { cookie: other } })).status, 401);
    assert.deepEqual(await r.access.devices(), []);
  } finally {
    await close(r.server);
  }
});

test("the home network is hostile: another name (DNS rebinding), another site's page, or a POST without the page's header is refused", async () => {
  const r = await phoneRig();
  try {
    const cookie = await r.pair();
    const wrongHost = await raw(r.port, "/m/api/today", { host: `evil.example:${r.port}`, cookie });
    assert.equal(wrongHost, 421);
    assert.equal((await r.post("/m/api/loop", { id: "a000000001", action: "done" }, { cookie, "x-pako": "" })).status, 403, "no x-pako header");
    assert.equal((await r.post("/m/api/loop", { id: "a000000001", action: "done" }, { cookie, origin: "http://192.168.1.66" })).status, 403, "another origin");
    assert.equal((await fetch(`${r.base}/m/api/today`, { headers: { cookie, "sec-fetch-site": "cross-site" } })).status, 403, "another site's script");
    assert.equal(await raw(r.port, "/m", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }), 200, "a link to the page still opens it");
    assert.equal(await raw(r.port, "/m/api/today", { cookie, "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }), 403, "but not its data");
    assert.deepEqual(r.acts, []);
  } finally {
    await close(r.server);
  }
});

test("pairing is rate limited: ten tries a quarter of an hour from one address, then 429 even with the right code", async () => {
  const r = await phoneRig();
  try {
    for (let i = 0; i < 10; i++) assert.equal((await r.post("/m/api/pair", { code: "WRONGCODE2", name: "x" })).status, 401);
    const code = r.access.pair().code;
    assert.equal((await r.post("/m/api/pair", { code, name: "x" })).status, 429);
  } finally {
    await close(r.server);
  }
});

// ---------- 3. listening on the home network ----------

test("the home network: nothing listens until it is turned on in Settings; on, the phone's page answers there; off, the port closes", async () => {
  const port = await freePort();
  const { kv } = memKv();
  const access = createMobileAccess({ kv });
  let signed = true;
  const listener = createMobileListener({
    port: () => port, addresses: () => ["127.0.0.1"],
    handler: createMobileApp({ access, hosts: () => listener.listening(), today: async () => { throw new Error("unused"); }, act: async () => ({ ok: true, say: "" }), draft: null }),
  });
  const panelApp = express();
  mountMobilePanel(panelApp, { signedIn: () => signed, access, listener, port: () => port, telegram: () => false });
  const panel = await listen(panelApp);
  const phone = `http://127.0.0.1:${port}/m`;
  const reachable = async () => fetch(phone).then((x) => x.status, () => 0);
  const post = (path: string, body: unknown, headers: Record<string, string> = { "x-pako": "1" }) =>
    fetch(`${panel.base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    // What the server does at its start (src/app/mobile.ts): it listens only when the owner turned it on.
    if (await access.enabled()) await listener.start();
    const first = (await (await fetch(`${panel.base}/panel/api/phone`)).json()) as { on: boolean; url: string | null; addresses: string[] };
    assert.deepEqual([first.on, first.url, first.addresses], [false, null, []], "off by default");
    assert.equal(await reachable(), 0, "nothing listens");
    assert.equal((await post("/panel/api/phone/pair", {})).status, 409, "no code while off");
    assert.equal((await post("/panel/api/phone", { on: true }, {})).status, 401, "the panel's header is needed");
    signed = false;
    assert.equal((await post("/panel/api/phone", { on: true })).status, 401, "and its session");
    signed = true;
    const on = (await (await post("/panel/api/phone", { on: true })).json()) as { on: boolean; url: string; addresses: string[] };
    assert.deepEqual([on.on, on.url, on.addresses], [true, phone, ["127.0.0.1"]]);
    assert.equal(await reachable(), 200);
    assert.equal(await access.enabled(), true, "kept for the next start");
    const pairing = (await (await post("/panel/api/phone/pair", {})).json()) as { link: string; code: string; qr: string; expiresAt: number };
    assert.match(pairing.link, new RegExp(`^http://127\\.0\\.0\\.1:${port}/m/pair#[2-9A-Z]{10}$`), "the code after the #, never in the path or query");
    assert.match(pairing.code, /^[2-9A-Z]{5}-[2-9A-Z]{5}$/);
    assert.match(pairing.qr, /^<svg/);
    const off = (await (await post("/panel/api/phone", { on: false })).json()) as { on: boolean; pairing: unknown };
    assert.deepEqual([off.on, off.pairing], [false, null]);
    assert.equal(await reachable(), 0, "off: the port is closed");
    assert.equal(access.pairing(), null, "and no code is left waiting");
  } finally {
    await listener.stop();
    await close(panel.server);
  }
});

test("the home network's addresses: private IPv4 on real interfaces only, never loopback, a public address, link-local, a VPN or a VM", () => {
  const ip = (address: string, o: Record<string, unknown> = {}) =>
    ({ address, family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null, ...o }) as never;
  assert.deepEqual(lanAddresses({
    lo0: [ip("127.0.0.1", { internal: true })],
    en0: [ip("192.168.1.20"), { address: "fe80::1", family: "IPv6", internal: false } as never],
    en1: [ip("10.0.0.7"), ip("169.254.3.3")],
    en5: [ip("203.0.113.9"), ip("172.20.1.2"), ip("172.32.0.1")],
    utun3: [ip("10.8.0.2")],
    bridge100: [ip("192.168.64.1")],
    docker0: [ip("172.17.0.1")],
  }), ["192.168.1.20", "10.0.0.7", "172.20.1.2"]);
});

test("the phone's port: PAKO_PHONE_PORT, else Pako's port + 1; never Pako's own", () => {
  assert.equal(phonePort({}, 8787), 8788);
  assert.equal(phonePort({ PAKO_PHONE_PORT: "9100" }, 8787), 9100);
  assert.equal(phonePort({ PAKO_PHONE_PORT: "8787" }, 8787), 8788);
  assert.equal(phonePort({ PAKO_PHONE_PORT: "nope" }, 8787), 8788);
});

// ---------- 4. what the page shows ----------

test("the page draws the brief with its sources and the nudges both ways from the server's answer", async () => {
  const r = feedRig();
  const today = await r.feed.today();
  const m = model.phoneModel(today, { locale: "en-GB" });
  // Needs you now: the owner's, reminded once and due in half an hour.
  assert.deepEqual(m.now.map((x) => x.title), ["Send Ana the Q4 deck"]);
  assert.deepEqual(m.now[0]!.actions, ["done", "snooze", "tomorrow", "park"]);
  assert.equal(m.now[0]!.due!.text, "Today 9:30");
  assert.equal(m.now[0]!.to, "ana@example.com");
  assert.equal(m.now[0]!.canDraft, true);
  assert.deepEqual(m.owe.map((x) => x.title), ["Review Omar's contract"]);
  assert.deepEqual(m.owed.map((x) => x.title), ["Vic sends the signed lease"]);
  assert.equal(m.owed[0]!.canDraft, false, "nothing to answer for what others owe");
  assert.deepEqual(m.parked.map((x) => [x.title, x.actions.join()]), [["Call the plumber", "reopen"]]);
  assert.deepEqual(m.closed.map((x) => [x.title, x.actions.join()]), [["Book the dentist", "reopen"]]);
  // The brief, every item with the sources it cites (an id never given is left out).
  const b = m.brief!;
  assert.equal(b.asOf, null, "today's");
  assert.equal(b.opening, "A light Monday.");
  assert.deepEqual(b.focus!.cites, [{ id: "F1", kind: "Email", label: "Ana Ruiz" }]);
  assert.deepEqual(b.todos.map((x) => [x.title, x.cites.map((c) => `${c.kind} · ${c.label}`)]), [
    ["Send Ana the Q4 deck", ["Email · Ana Ruiz"]], ["Water the plants", ["Tasks · Tasks"]],
  ]);
  assert.deepEqual(b.updates[0]!.cites.map((c) => c.label), ["Omar"]);
  assert.deepEqual(b.day.map((x) => [x.when, x.title, x.confirmed, x.cites[0]!.kind]), [["11:00–11:30", "Call with AcmeCo", false, "Calendar"]]);
  assert.equal(m.telegram, true);
  // Before today's is written: the last one, "as of" its time.
  const older = model.phoneModel({ ...today, brief: { doc: null, latest: DOC, pending: false } });
  assert.equal(older.brief!.asOf, DOC.at);
  assert.equal(model.phoneModel({ ...today, brief: { doc: null, latest: null, pending: true } }).brief!.none, true);
  // Follow-ups off: said, not an empty page.
  assert.equal(model.phoneModel({ ...today, loops: null }).followups, false);
  // Gentle mode: a time passed is never red.
  assert.deepEqual(model.dueText(T0 - MIN, T0, { gentle: true }), { text: "Time passed", late: false });
  assert.deepEqual(model.dueText(T0 - MIN, T0, {}), { text: "Overdue", late: true });
  // The mail app gets the draft, to the address the loop names.
  assert.equal(model.mailtoFor({ to: "ana@example.com" }, "Hi Ana,\nhere it is & more"), "mailto:ana%40example.com?body=Hi%20Ana%2C%0Ahere%20it%20is%20%26%20more");
  assert.equal(model.mailtoFor({ to: "not an address" }, "x"), "mailto:?body=x");
  assert.equal(model.readCache("{bad"), null);
  assert.deepEqual(model.readCache(JSON.stringify({ at: 5, data: { a: 1 } })), { at: 5, data: { a: 1 } });
});

test("the page's scripts draw text, never HTML, and hold the pairing code out of the address", async () => {
  const { readFileSync } = await import("node:fs");
  const js = readFileSync(new URL("../src/panel/m.js", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../src/panel/mobile.js", import.meta.url), "utf8");
  for (const src of [js, settings]) assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src), "no HTML from data");
  assert.match(js, /history\.replaceState\(null, "", "\/m"\)/, "the #code leaves the address at once");
  assert.ok(!/\/m\/api\/[a-z]+\?/.test(js), "nothing in a query string");
});

// ---------- 5. the buttons ----------

test("the phone's buttons press the same follow-ups door as the chat's: Done f1, In 1 h f2, Tomorrow f6, Park f7; Reopen brings back", async () => {
  const r = feedRig();
  assert.equal((await r.feed.act("a000000001", "done")).ok, true);
  assert.equal((await r.status()).a000000001, "done");
  assert.equal((await r.feed.act("a000000002", "snooze")).ok, true);
  assert.equal((await r.status()).a000000002, "snoozed");
  assert.equal((await r.feed.act("a000000003", "tomorrow")).ok, true);
  assert.equal((await r.status()).a000000003, "snoozed");
  const park = await r.feed.act("a000000002", "park");
  assert.equal(park.ok, true);
  assert.equal((await r.status()).a000000002, "parked");
  assert.deepEqual(r.presses, ["1:a000000001", "2:a000000002", "6:a000000003", "7:a000000002"], "the chat's buttons, f1, f2, f6 and f7");
  // Reopen: a parked one and a done one come back on the open list.
  assert.equal((await r.feed.act("a000000002", "reopen")).ok, true);
  assert.equal((await r.feed.act("a000000005", "reopen")).ok, true);
  const after = await r.status();
  assert.deepEqual([after.a000000002, after.a000000005], ["open", "open"]);
  assert.equal((await r.feed.act("a000000002", "reopen")).ok, false, "open already");
  assert.equal((await r.feed.act("ffffffffff", "done")).ok, false, "gone");
  assert.equal((await r.feed.act("a000000001", "done")).ok, false, "a second Done changes nothing");
});

test("Draft a reply: DRAFT's run for that loop; the written draft then shows on its item", async () => {
  const r = feedRig();
  const asked = await r.feed.draft("a000000001");
  assert.equal(asked.ok, true);
  assert.deepEqual(r.drafted, ["a000000001"]);
  r.tasks.set("d000000001", { id: "d000000001", kind: "draft", status: "pending", text: "" });
  let item = (await r.feed.today()).loops!.find((l) => l.id === "a000000001")!;
  assert.deepEqual(item.draft, { status: "pending", text: "" }, "being written");
  r.tasks.set("d000000001", { id: "d000000001", kind: "draft", status: "done", text: "Hi Ana, here is the deck." });
  item = (await r.feed.today()).loops!.find((l) => l.id === "a000000001")!;
  assert.deepEqual(item.draft, { status: "done", text: "Hi Ana, here is the deck." });
  assert.equal((await r.feed.draft("ffffffffff")).ok, false);
  const failing = feedRig({ drafted: null });
  assert.equal((await failing.feed.draft("a000000001")).ok, false);
});

// ---------- 6. the chat's brief on a phone ----------

test("the brief in the chat never links to the computer's own address: the phone's page while it is on, else where the brief is", () => {
  const doc = { ...DOC, lang: "en" as const, todos: DOC.todos } as unknown as Parameters<typeof chatText>[0];
  const o = { name: "Theo", timeZone: "Europe/London", lang: "en" as const };
  assert.match(chatText(doc, { ...o, url: "https://pako.example.com" }), /📰 The full brief: https:\/\/pako\.example\.com\/panel\/brief$/);
  assert.match(chatText(doc, { ...o, url: "http://127.0.0.1:8787" }), /📰 The full brief is in Pako's panel on your computer\.$/);
  assert.match(chatText(doc, { ...o, url: "http://127.0.0.1:8787", phone: "http://192.168.1.20:8788/m" }),
    /📰 The full brief, on your phone at home \(same Wi-Fi\): http:\/\/192\.168\.1\.20:8788\/m$/);
  assert.match(chatText(doc, { ...o, url: null }), /type PANEL\)\.$/);
});
