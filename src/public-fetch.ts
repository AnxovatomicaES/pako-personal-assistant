// Fetching from the public internet only: an address someone else gave (a calendar feed, a mail provider's settings, a restaurant's page)
// must not reach this computer, the local network or a cloud's metadata address. Only http(s), hosts whose every address is public,
// redirects checked hop by hop, and a transport that connects to the address it checked (no second DNS lookup), so a DNS answer cannot
// switch to a private address between the check and the connection. Core: src/ics.ts and src/mail-autoconfig.ts use it, and so does the
// booking lab's src/restaurants/website.ts.

import { lookup as lookupCb, type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

export type Resolver = (host: string) => Promise<string[]>;

export const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

// Everything that is not the ordinary public internet (RFC 6890 special-purpose ranges and friends).
const BLOCKED = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  // ::/96 covers "::", "::1" and IPv4-compatible forms. IPv4-mapped forms (::ffff:7f00:1, dotted or hex) need no
  // rule: BlockList checks them against the IPv4 rules above. (A ::ffff:0:0/96 rule would block every IPv4.)
  ["::", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
  // IPv4-translated (::ffff:0:a.b.c.d, RFC 2765), routed to IPv4 by SIIT/NAT64 translators.
  ["::ffff:0:0:0", 96],
] as const) BLOCKED.addSubnet(net, bits, "ipv6");

/** True for loopback, private, link-local, CGNAT, multicast, documentation, reserved, mapped and tunnel addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return BLOCKED.check(ip, "ipv4");
  if (v === 6) return BLOCKED.check(ip, "ipv6");
  return true;
}

/** dns.lookup that refuses to hand back any non-public address, used as the connection's resolver. */
function guardedLookup(hostname: string, options: { all?: boolean }, cb: (...args: unknown[]) => void): void {
  lookupCb(hostname, { all: true, verbatim: true }, (err, addrs: LookupAddress[]) => {
    if (err) return cb(err);
    if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) {
      return cb(Object.assign(new Error(`${hostname} is not a public address`), { code: "EPRIVATE" }));
    }
    if (options.all) return cb(null, addrs);
    cb(null, addrs[0]!.address, addrs[0]!.family);
  });
}

/** Minimal fetch over node:http(s) whose connection uses guardedLookup. Never follows redirects itself. */
export const pinnedFetch: typeof fetch = (input, init) =>
  new Promise<Response>((resolve, reject) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      { method: "GET", headers: init?.headers as Record<string, string>, lookup: guardedLookup as never, signal: init?.signal ?? undefined },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
        const status = res.statusCode ?? 500;
        const body = status === 204 || status === 304 ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
        resolve(new Response(body, { status: status < 200 || status > 599 ? 500 : status, headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });

/**
 * An http(s) address on the public internet: no credentials, a host whose every address is public, a standard port (`anyPort`: any port,
 * for a calendar feed on its own server). Throws otherwise, with a message that never repeats the address.
 */
export async function checkUrl(raw: string, resolve: Resolver = defaultResolver, o: { anyPort?: boolean } = {}): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("only http(s) URLs");
  if (!o.anyPort && u.port && u.port !== "80" && u.port !== "443") throw new Error("non-standard port");
  if (u.username || u.password) throw new Error("credentials in URL");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : await resolve(host);
  if (addrs.length === 0 || addrs.some(isPrivateAddress)) throw new Error("host is not a public address");
  return u;
}

/** A host that names this computer or the local network by itself, before any lookup: an IP literal that is not public, or localhost. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (isIP(host)) return isPrivateAddress(host);
  return host === "localhost" || host.endsWith(".localhost");
}

/**
 * GET with every hop checked (checkUrl), never following a redirect by itself: someone else's feed or config file cannot send Pako to this
 * computer, the local network or a cloud's metadata address, by its address or by a redirect. `https`: every hop must be https. The default
 * fetch is pinnedFetch (the address checked again at connect time). Returns the first answer that is not a redirect, and where it came from.
 */
export async function guardedGet(
  url: string,
  o: { fetch?: typeof fetch; resolve?: Resolver; headers?: Record<string, string>; signal?: AbortSignal; https?: boolean; anyPort?: boolean; maxRedirects?: number } = {},
): Promise<{ res: Response; url: URL }> {
  const f = o.fetch ?? pinnedFetch;
  const max = o.maxRedirects ?? 5;
  let current = await checkUrl(url, o.resolve, { anyPort: o.anyPort });
  for (let hop = 0; ; hop++) {
    if (o.https && current.protocol !== "https:") throw new Error("it was redirected to an address without https");
    const res = await f(current.href, { redirect: "manual", ...(o.signal ? { signal: o.signal } : {}), ...(o.headers ? { headers: o.headers } : {}) });
    if (res.status < 300 || res.status >= 400 || res.status === 304) return { res, url: current };
    const next = res.headers.get("location");
    await res.body?.cancel().catch(() => {});
    if (!next) throw new Error(`HTTP ${res.status} with no address to go to`);
    if (hop >= max) throw new Error("too many redirects");
    current = await checkUrl(new URL(next, current).href, o.resolve, { anyPort: o.anyPort });
  }
}
