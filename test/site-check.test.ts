// The brief's live check of a site an uptime monitor says is down (src/site-check.ts): which emails count, which addresses are never
// asked (private, local, http, credentials, other ports, IP literals), and the status read without following anything.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSite, monitorAlert, privateAddress } from "../src/site-check.ts";

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
});

test("privateAddress: loopback, private, link-local, CGNAT, unique-local, mapped and reserved ranges are refused", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "not an ip"]) {
    assert.equal(privateAddress(ip), true, ip);
  }
  for (const ip of ["93.184.216.34", "172.32.0.1", "2606:4700::6810:84e5", "8.8.8.8"]) assert.equal(privateAddress(ip), false, ip);
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
