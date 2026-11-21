// Fetch a restaurant's public homepage to see which booking platform it uses. Read-only, one page, polite:
// identifies itself, honours robots.txt, never logs in, never retries around a block.
//
// The URL comes from Google, but it is still outside input fetched by our server, so it must not reach our
// own network: only http(s) on the default ports, hostnames that resolve to public addresses only, redirects
// re-checked hop by hop, a size cap and a timeout. The default transport resolves each host once and connects
// to the address it checked (no second DNS lookup), so a DNS answer cannot switch to a private address between
// the check and the connection.

import { checkUrl, defaultResolver, pinnedFetch, type Resolver } from "../public-fetch.ts";

// The guard lives in core (src/public-fetch.ts); kept importable from here for the booking code and its tests.
export { checkUrl, guardedGet, isPrivateAddress, isPrivateHost, pinnedFetch, type Resolver } from "../public-fetch.ts";

export const USER_AGENT = "pako-booking-check/1.0 (finds a restaurant's public booking link; one request per visit)";
const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 6_000;
const MAX_REDIRECTS = 3;

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
    /* a charset TextDecoder does not know: UTF-8 instead */
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
      /* blocked, or no answer: no redirect */
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
      /* blocked, or no answer: no homepage */
      return undefined;
    }
  }
}
