// The brief's live check of a site an uptime monitor says is down (src/site-check.ts): which emails count, which addresses are never
// asked (private, local, http, credentials, other ports, IP literals), and the status read without following anything.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSite, getStatus, monitorAlert, privateAddress } from "../src/site-check.ts";

const PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];

test("monitorAlert: a monitor's down and up emails, the site's address; anyone else's email is not an alert", () => {
  const down = monitorAlert({ from: "UptimeRobot <alert@uptimerobot.com>", subject: "Monitor is DOWN: shop.example.org", summary: "503 Service Unavailable" });
  assert.deepEqual(down, { url: "https://shop.example.org/", host: "shop.example.org", down: true });
  const up = monitorAlert({ from: "alerts@mail.uptimerobot.com", subject: "Monitor is UP: shop.example.org", preview: "It was down for 2 hours" });
  assert.equal(up?.down, false);
  const withPath = monitorAlert({ from: "noreply@betterstack.com", subject: "Outage", summary: "https://api.example.org/health?token=abc is down" });
  assert.equal(withPath?.url, "https://api.example.org/health", "the query is dropped");
  assert.equal(monitorAlert({ from: "someone@example.com", subject: "Monitor is DOWN: shop.example.org" }), null, "not a monitor");
  assert.equal(monitorAlert({ from: "alert@uptimerobot.com", subject: "Your weekly report", summary: "all good" }), null, "not about a site's state");
  assert.equal(monitorAlert({ from: "alert@uptimerobot.com.evil.example", subject: "Monitor is DOWN: x.example.org" }), null, "a look-alike domain");
  assert.equal(monitorAlert({ from: "alert@uptimerobot.com", subject: "Monitor is DOWN", summary: "http://shop.example.org:8080/" }), null, "http and another port");
  assert.equal(monitorAlert({ from: '"alerts@uptimerobot.com" <x@evil.example>', subject: "Monitor is DOWN: shop.example.org" }), null, "a display name");
  assert.equal(monitorAlert({ from: "alert@uptimerobot.com", subject: "Monitor is DOWN: shop.example.org", scam: true }), null, "taken for a scam");
  for (const subject of ["[Resolved] Down: shop.example.org", "Incident resolved: shop.example.org is down", "Resolved: shop.example.org went down",
    "Monitor is UP: shop.example.org (was down 12 min)"]) {
    assert.equal(monitorAlert({ from: "alert@uptimerobot.com", subject })?.down, false, subject);
  }
  const tracked = monitorAlert({
    from: "alert@uptimerobot.com", subject: "Monitor is DOWN: shop.example.org", preview: "https://u123.ct.sendgrid.net/ls/click?upn=x https://shop.example.org/",
  });
  assert.equal(tracked?.host, "shop.example.org", "the host in the subject, never a tracking link");
  const body = monitorAlert({ from: "alert@uptimerobot.com", subject: "Monitor is DOWN: My shop", preview: "https://u1.ct.sendgrid.net/x https://shop.example.org/" });
  assert.equal(body?.host, "shop.example.org", "a mailing service's link is skipped");
});

test("privateAddress: loopback, private, link-local, CGNAT, unique-local, mapped and reserved ranges are refused", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "not an ip", "2002:a00:1::1", "fec0::1", "100::1",
    "2001:0:4136:e378::1", "2001::1"]) {
    assert.equal(privateAddress(ip), true, ip);
  }
  for (const ip of ["93.184.216.34", "172.32.0.1", "2606:4700::6810:84e5", "8.8.8.8", "2001:4860:4860::8888", "1000::1"]) assert.equal(privateAddress(ip), false, ip);
});

test("checkSite: refused before any request for unsafe addresses; one GET to the vetted address otherwise, its status only", async () => {
  const asked: string[] = [];
  const get = async (address: string, _f: number, url: URL) => (asked.push(`${address} ${url.hostname}${url.pathname}`), 503);
  for (const u of ["http://shop.example.org/", "https://user:pw@shop.example.org/", "https://shop.example.org:8443/", "https://127.0.0.1/", "not a url"]) {
    assert.deepEqual(await checkSite(u, { resolve: PUBLIC, get }), { error: "refused" }, u);
  }
  // A name that resolves to a private address (or to a public AND a private one) is never asked.
  assert.deepEqual(await checkSite("https://inside.example.org/", { resolve: async () => [{ address: "10.0.0.5", family: 4 }], get }), { error: "refused" });
  const both = async () => [{ address: "93.184.216.34", family: 4 }, { address: "::1", family: 6 }];
  assert.deepEqual(await checkSite("https://mixed.example.org/", { resolve: both, get }), { error: "refused" });
  assert.deepEqual(asked, []);
  assert.deepEqual(await checkSite("https://shop.example.org/health?x=1", { resolve: PUBLIC, get }), { status: 503 });
  assert.deepEqual(asked, ["93.184.216.34 shop.example.org/health"]);
  assert.deepEqual(await checkSite("https://gone.example.org/", { resolve: async () => Promise.reject(new Error("ENOTFOUND")), get }), { error: "unreachable" });
  assert.deepEqual(await checkSite("https://slow.example.org/", { resolve: PUBLIC, get: async () => Promise.reject(new Error("timeout")) }), { error: "timeout" });
});

test("getStatus: one deadline for the whole request, however slowly the server answers; checkSite passes its deadline on", async () => {
  const { createServer } = await import("node:net");
  // A server that takes the connection and never answers (the request sets no idle timeout): only the deadline ends it.
  const srv = createServer((sock) => void sock.on("error", () => {}));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const t0 = Date.now();
  await assert.rejects(getStatus("127.0.0.1", 4, new URL(`https://slow.example.org:${port}/`), 300, port), /^Error: timeout$/);
  assert.ok(Date.now() - t0 < 2000, "within the deadline");
  srv.close();
  let ms: number | undefined;
  await checkSite("https://shop.example.org/", { resolve: PUBLIC, timeoutMs: 1234, get: async (_a, _f, _u, t) => ((ms = t), 200) });
  assert.equal(ms, 1234);
});
