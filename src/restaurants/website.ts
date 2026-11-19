// Fetch a restaurant's public homepage to see which booking platform it uses. Read-only, one page, polite:
// identifies itself, honours robots.txt, never logs in, never retries around a block.
//
// The URL comes from Google, but it is still outside input fetched by our server, so it must not reach our
// own network: only http(s) on the default ports, hostnames that resolve to public addresses only, redirects
// re-checked hop by hop, a size cap and a timeout. The default transport resolves each host once and connects
// to the address it checked (no second DNS lookup), so a DNS answer cannot switch to a private address between
// the check and the connection.

import { lookup as lookupCb, type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

export const USER_AGENT = "pako-booking-check/1.0 (finds a restaurant's public booking link; one request per visit)";
const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 6_000;
const MAX_REDIRECTS = 3;

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

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

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const bytes = Buffer.concat(chunks).subarray(0, MAX_BYTES);
  // Many restaurant sites are still Latin-1 or Windows-1252: read as UTF-8, "depósito" would turn into "dep�sito" and the deposit rules would miss it.
  const label = /charset\s*=\s*["']?([A-Za-z0-9_-]{2,30})/i.exec(res.headers.get("content-type") ?? "")?.[1]
    ?? /<meta[^>]{0,200}charset\s*=\s*["']?([A-Za-z0-9_-]{2,30})/i.exec(bytes.subarray(0, 4096).toString("latin1"))?.[1];
  try {
    return new TextDecoder(label ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/** GET with every hop checked. Returns undefined for anything but a 200 text response. */
/**
 * GET with every hop checked. `mayFetch` is asked before each hop (robots.txt of that hop's site), so a redirect
 * to another site or path is held to that site's rules too. Returns the final status, and the body for a 200
 * text response.
 */
async function safeFetch(url: string, fetchImpl: typeof fetch, resolve: Resolver, accept: string, mayFetch?: (u: URL) => Promise<boolean>): Promise<{ url: URL; status: number; body?: string } | undefined> {
  let current = await checkUrl(url, resolve);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (mayFetch && !(await mayFetch(current))) return undefined;
    const res = await fetchImpl(current, { redirect: "manual", signal, headers: { "user-agent": USER_AGENT, accept } });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!next) return undefined;
      current = await checkUrl(new URL(next, current).href, resolve);
      continue;
    }
    const type = res.headers.get("content-type") ?? "";
    if (res.status !== 200 || (type && !/text\/|application\/xhtml/i.test(type))) {
      await res.body?.cancel().catch(() => {});
      return { url: current, status: res.status };
    }
    return { url: current, status: 200, body: await readCapped(res) };
  }
  return undefined;
}

/** Is `path` allowed for us by this robots.txt? Uses the group for our agent if present, else "*". */
export function robotsAllows(robots: string, path: string, agent = "pako-booking-check"): boolean {
  type Group = { agents: string[]; rules: { allow: boolean; path: string }[] };
  const groups: Group[] = [];
  let cur: Group | undefined;
  let lastWasAgent = false;
  for (const line of robots.split(/\r?\n/)) {
    const m = line.replace(/#.*/, "").trim().match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && cur) {
      lastWasAgent = false;
      if (value) cur.rules.push({ allow: key === "allow", path: value });
    } else {
      lastWasAgent = false;
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && a !== "" && agent.toLowerCase().includes(a)));
  const rules = (mine.length > 0 ? mine : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
  // Longest matching rule wins; Allow wins a tie.
  let best: { allow: boolean; len: number } | undefined;
  for (const r of rules) {
    if (robotsMatch(r.path, path) && (!best || r.path.length > best.len || (r.path.length === best.len && r.allow))) best = { allow: r.allow, len: r.path.length };
  }
  return best?.allow ?? true;
}

/**
 * Does a robots.txt path rule match the start of `path`? "*" is any run of characters, a final "$" anchors the
 * end. Linear glob matching (no regex), so a hostile robots.txt cannot stall the server; overlong input is
 * treated as "matches", the cautious answer for a Disallow.
 */
export function robotsMatch(rule: string, path: string): boolean {
  if (rule.length > 500 || path.length > 2000) return true;
  const anchored = rule.endsWith("$");
  const p = anchored ? rule.slice(0, -1) : rule + "*";
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (j < path.length) {
    if (i < p.length && p[i] !== "*" && p[i] === path[j]) {
      i++;
      j++;
    } else if (i < p.length && p[i] === "*") {
      star = i++;
      mark = j;
    } else if (star >= 0) {
      i = star + 1;
      j = ++mark;
    } else {
      return false;
    }
  }
  while (i < p.length && p[i] === "*") i++;
  return i === p.length;
}

export interface PageFetcher {
  /** A public page's HTML (homepage or the site's reservations page), or undefined if it cannot or may not be read. Never throws. */
  fetchHomepage(url: string): Promise<string | undefined>;
  /** Where a short link (bit.ly and the like) redirects, read from one response without following it. Never throws. */
  resolveShortLink?(url: string): Promise<string | undefined>;
}

/** "blocked": robots.txt (or a redirect chain) kept us out, which says nothing about the page itself. */
export type PageProbe = { state: "ok"; html: string; finalUrl: string } | { state: "blocked" } | { state: "gone" | "error"; detail: string };

export class PublicPageFetcher implements PageFetcher {
  private fetchImpl: typeof fetch;
  private resolve: Resolver;

  constructor(fetchImpl: typeof fetch = pinnedFetch, resolve: Resolver = defaultResolver) {
    this.fetchImpl = fetchImpl;
    this.resolve = resolve;
  }

  async resolveShortLink(url: string): Promise<string | undefined> {
    try {
      let current = url;
      // A shortener may hop to itself first (www.bit.ly -> bit.ly); stop at the first address off the shortener.
      for (let hop = 0; hop < 3; hop++) {
        const u = await checkUrl(current, this.resolve);
        const res = await this.fetchImpl(u, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": USER_AGENT } });
        await res.body?.cancel().catch(() => {});
        const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
        if (!loc) return undefined;
        const next = new URL(loc, u);
        if (next.hostname.replace(/^www\./, "") !== u.hostname.replace(/^www\./, "")) return next.href.slice(0, 500);
        current = next.href;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * May we fetch this URL under its site's robots.txt (RFC 9309)? A missing robots.txt (4xx) allows everything;
   * a server error or no answer means "do not crawl now". Cached per origin for this fetcher.
   */
  private robotsCache = new Map<string, { at: number; body: string | null }>();
  private async robotsAllow(u: URL): Promise<boolean> {
    let hit = this.robotsCache.get(u.origin);
    if (!hit || Date.now() - hit.at > 3600_000) {
      const r = await safeFetch(`${u.origin}/robots.txt`, this.fetchImpl, this.resolve, "text/plain").catch(() => undefined);
      const body = !r ? null : r.status === 200 ? (r.body ?? "") : r.status >= 400 && r.status < 500 ? "" : null;
      hit = { at: Date.now(), body };
      this.robotsCache.set(u.origin, hit);
      if (this.robotsCache.size > 2000) this.robotsCache.delete(this.robotsCache.keys().next().value!);
    }
    return hit.body !== null && robotsAllows(hit.body, u.pathname || "/");
  }

  /**
   * One page, with what happened to the request spelled out (the route health check needs to tell "the page is gone"
   * from "we may not read it"). Same rules as fetchHomepage: public hosts only, robots.txt honoured. Never throws.
   */
  async probe(url: string): Promise<PageProbe> {
    try {
      const r = await safeFetch(url, this.fetchImpl, this.resolve, "text/html", (u) => this.robotsAllow(u));
      if (!r) return { state: "blocked" };
      if (r.status === 200) return { state: "ok", html: r.body ?? "", finalUrl: r.url.href };
      return { state: r.status === 404 || r.status === 410 ? "gone" : "error", detail: `HTTP ${r.status}` };
    } catch (err) {
      return { state: "error", detail: String((err as Error).message ?? err).slice(0, 120) };
    }
  }

  async fetchHomepage(url: string): Promise<string | undefined> {
    try {
      const r = await safeFetch(url, this.fetchImpl, this.resolve, "text/html", (u) => this.robotsAllow(u));
      return r?.status === 200 ? r.body : undefined;
    } catch {
      return undefined;
    }
  }
}
