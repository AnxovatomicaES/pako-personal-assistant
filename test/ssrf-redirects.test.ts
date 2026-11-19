// Someone else's calendar feed or mail config file cannot send Pako to this computer, the local network or a cloud's metadata address
// (security review F4): the ICS link is refused when it names one (src/ics.ts loadIcsConfig), and every hop of the ICS fetch and of the mail
// autoconfig lookup (src/mail-autoconfig.ts) is checked before it is asked, with redirects never followed blindly (src/restaurants/website.ts
// guardedGet). Local servers on free ports only.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createIcsSource, loadIcsConfig } from "../src/ics.ts";
import { createAutoconfig } from "../src/mail-autoconfig.ts";
import { guardedGet } from "../src/restaurants/website.ts";

const CAL = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\nEND:VCALENDAR\r\n";
/** example.org and friends are public; evil.example and its subdomains resolve to this computer (a name pointed at loopback). */
const dns = async (host: string): Promise<string[]> => (host === "evil.example" || host.endsWith(".evil.example") ? ["127.0.0.1"] : ["93.184.216.34"]);

/** An "internal" server on this computer that counts what reaches it. */
async function internal(): Promise<{ hits: string[]; port: number; close: () => Promise<void> }> {
  const hits: string[] = [];
  const s = createServer((req, res) => (hits.push(`${req.method} ${req.url}`), res.end("internal secret")));
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return { hits, port: (s.address() as AddressInfo).port, close: () => new Promise((r) => s.close(() => r())) };
}

test("loadIcsConfig: a link to this computer or the local network is refused; an internet calendar is taken", () => {
  for (const u of ["https://127.0.0.1:8787/cal.ics", "https://10.1.2.3/cal.ics", "https://192.168.1.5/x.ics", "https://169.254.169.254/x", "https://localhost/x.ics",
    "https://cal.localhost/x.ics", "https://[::1]/x.ics", "https://[::ffff:127.0.0.1]/x.ics", "webcal://127.0.0.1/x.ics"]) {
    const r = loadIcsConfig({ CALENDAR_ICS_URL: u });
    assert.equal(r.config, null, u);
    assert.match(r.problems.join(" "), /not this computer or the local network/, u);
    assert.ok(!r.problems.join(" ").includes(u), "the link is never repeated");
  }
  assert.deepEqual(loadIcsConfig({ CALENDAR_ICS_URL: "https://calendar.google.com/calendar/ical/x/basic.ics" }).problems, []);
});

test("ICS: a redirect to an internal address (plain http, metadata, a name pointing home) is never asked; a public https hop is followed", async () => {
  const inside = await internal();
  try {
    const asked: string[] = [];
    let target = "";
    // The feed's host is played here; anything else goes out for real (so a request to the internal server would be counted there).
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      asked.push(url);
      if (url === "https://cal.example.org/feed.ics") return new Response(null, { status: 302, headers: { location: target } });
      if (url === "https://cal2.example.org/feed.ics") return new Response(CAL, { status: 200 });
      return fetch(url, init);
    }) as typeof fetch;
    for (const to of [`http://127.0.0.1:${inside.port}/latest/meta-data/`, `https://127.0.0.1:${inside.port}/x`, "https://169.254.169.254/latest/meta-data/",
      `https://evil.example:${inside.port}/x`, `https://[::ffff:127.0.0.1]:${inside.port}/x`]) {
      target = to;
      asked.length = 0;
      const logs: string[] = [];
      const src = createIcsSource({ config: { urls: ["https://cal.example.org/feed.ics"] }, timeZone: "Europe/Madrid", fetch: fake, resolve: dns, log: (t) => logs.push(t) });
      await src.events().catch(() => undefined);
      assert.deepEqual(asked, ["https://cal.example.org/feed.ics"], `only the feed itself was asked (${to})`);
      assert.match(logs.join(" "), /without https|not a public address/, to);
    }
    assert.deepEqual(inside.hits, [], "nothing reached the internal server");
    target = "https://cal2.example.org/feed.ics";
    const ok = createIcsSource({ config: { urls: ["https://cal.example.org/feed.ics"] }, timeZone: "Europe/Madrid", fetch: fake, resolve: dns, log: () => undefined });
    assert.deepEqual((await ok.events()).events, [], "a calendar read through a public redirect");
  } finally {
    await inside.close();
  }
});

test("guardedGet: never follows a redirect itself; too many hops and a redirect with no address end it", async () => {
  let n = 0;
  const loop = (async () => new Response(null, { status: 302, headers: { location: `https://a.example.org/${++n}` } })) as typeof fetch;
  await assert.rejects(guardedGet("https://a.example.org/0", { fetch: loop, resolve: dns, maxRedirects: 3 }), /too many redirects/);
  assert.equal(n, 4);
  const empty = (async () => new Response(null, { status: 301 })) as typeof fetch;
  await assert.rejects(guardedGet("https://a.example.org/", { fetch: empty, resolve: dns }), /no address to go to/);
  const manual: RequestRedirect[] = [];
  const spy = (async (_u: string, init?: RequestInit) => (manual.push(init!.redirect!), new Response("x"))) as typeof fetch;
  await guardedGet("https://a.example.org/", { fetch: spy, resolve: dns });
  assert.deepEqual(manual, ["manual"]);
});

test("mail autoconfig: a domain's own file that redirects home, or a domain that resolves home, is never asked there", async () => {
  const inside = await internal();
  try {
    const asked: string[] = [];
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      asked.push(url);
      if (url.startsWith("https://autoconfig.thunderbird.net/")) return new Response("", { status: 404 });
      if (url === "https://autoconfig.firm.example/mail/config-v1.1.xml") {
        return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${inside.port}/admin` } });
      }
      return fetch(url, init);
    }) as typeof fetch;
    const auto = createAutoconfig({ fetch: fake, resolve: dns, resolveMx: async () => [] });
    const got = await auto("ana@firm.example", "en");
    assert.equal(got?.source, "guess", "nothing taken from the redirect");
    const home = await auto("ana@evil.example", "en");
    assert.equal(home?.source, "guess");
    assert.ok(!asked.some((u) => u.includes("127.0.0.1") || u.includes("autoconfig.evil.example")), asked.join(", "));
    assert.deepEqual(inside.hits, []);
  } finally {
    await inside.close();
  }
});
