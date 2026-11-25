// The morning brief's live check of a site an uptime monitor says is down (src/brief-v2.ts gatherFacts): one GET, so the brief can say
// "still 503 this morning" or "it answers again", not only what last night's email said.
//
// Security: the address comes from an email, so it is other people's input. The check is kept as narrow as it can be:
// - Only emails from known uptime-monitoring services (MONITORS, by the sender's domain) are looked at, and only when they say a site is down.
// - https only, port 443 only, no user name or password in the address, no IP-literal hosts; the query and fragment are dropped.
// - The host is resolved once and EVERY address it resolves to must be public: loopback, private, link-local, carrier-grade NAT, unique-local,
//   multicast, unspecified, documentation and NAT64 ranges are refused. The request then goes to that very address (TLS still checks the
//   certificate against the host name), so a second DNS answer cannot point it inside the owner's network.
// - Redirects are not followed (a 3xx is the answer); a short timeout; only the status code is read, the body is never kept.

import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

/** Senders whose "down" emails are uptime alerts (the domain of the From address, or a parent of it). */
const MONITORS = [
  "uptimerobot.com", "betteruptime.com", "betterstack.com", "pingdom.com", "statuscake.com", "freshping.io", "hetrixtools.com", "cronitor.io",
  "healthchecks.io", "updown.io", "uptime.com", "site24x7.com", "uptimekuma.com", "statuspage.io", "checklyhq.com",
];
const TIMEOUT_MS = 6000;

export type SiteCheck = { status: number } | { error: "refused" | "timeout" | "unreachable" };

export interface MonitorAlert {
  /** The site the alert is about, as https://host/path (no query). */
  url: string;
  host: string;
  /** True: "down"; false: "up again". */
  down: boolean;
}

/** An uptime monitor's email about a site going down or coming back, or null. */
export function monitorAlert(m: { from: string; subject: string; summary?: string; preview?: string }): MonitorAlert | null {
  const domain = /@([a-z0-9.-]+)/i.exec(m.from)?.[1]?.toLowerCase().replace(/\.$/, "");
  const monitor = domain ? MONITORS.find((x) => domain === x || domain.endsWith(`.${x}`)) : undefined;
  if (!monitor) return null;
  const head = m.subject;
  const all = `${m.subject} ${m.summary ?? ""} ${m.preview ?? ""}`;
  const downWord = /\bdown\b|outage|unreachable|not responding|\b5\d\d\b/i;
  const upWord = /\bup\b|back online|recovered|resolved|is back/i;
  const down = downWord.test(head) ? !(upWord.test(head) && !/\bdown\b/i.test(head)) : upWord.test(head) ? false : downWord.test(all) ? true : null;
  if (down === null) return null;
  const url = siteUrl(all, monitor);
  return url ? { url: url.href, host: url.hostname, down } : null;
}

/** The first https address in the text, else the first host name that is not the monitor's own; http, credentials or another port: none. */
function siteUrl(text: string, monitor: string): URL | null {
  const own = (h: string) => h === monitor || h.endsWith(`.${monitor}`);
  const urls = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'()]+/gi;
  for (const raw of text.match(urls) ?? []) {
    const u = safeUrl(raw.replace(/[.,;:]+$/, ""));
    if (u && !own(u.hostname)) return u;
  }
  // A bare host name, outside any address already refused (an http one is never checked as https).
  for (const h of text.replace(urls, " ").match(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi) ?? []) {
    if (own(h.toLowerCase())) continue;
    const u = safeUrl(`https://${h}/`);
    if (u) return u;
  }
  return null;
}

function safeUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    /* not an address */
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443") || isIP(u.hostname.replace(/^\[|\]$/g, ""))) return null;
  u.search = "";
  u.hash = "";
  return u;
}

/** An address that is not on the public internet (or is reserved): never checked. */
export function privateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51) || (a === 203 && b === 0);
  }
  if (v !== 6) return true;
  const x = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x)?.[1];
  if (mapped) return privateAddress(mapped);
  // "::", "::1" and every other address starting "::" (IPv4-compatible, mapped forms not caught above) are refused.
  return x.startsWith("::") || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff") || x.startsWith("64:ff9b:") || x.startsWith("2001:db8:");
}

export interface SiteCheckDeps {
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  /** The GET itself, to that address with that host name: its status. Tests replace it. */
  get?: (address: string, family: number, url: URL) => Promise<number>;
  timeoutMs?: number;
}

/** One GET of a site an alert named: its status, or why there is none. Never throws. */
export async function checkSite(raw: string, d: SiteCheckDeps = {}): Promise<SiteCheck> {
  const url = safeUrl(raw);
  if (!url) return { error: "refused" };
  let addrs: { address: string; family: number }[];
  try {
    addrs = await (d.resolve ?? ((h: string) => lookup(h, { all: true, verbatim: true })))(url.hostname);
  } catch {
    /* the name does not resolve: the site cannot be reached */
    return { error: "unreachable" };
  }
  if (!addrs.length || addrs.some((a) => privateAddress(a.address))) return { error: "refused" };
  const first = addrs[0]!;
  try {
    return { status: await (d.get ?? getStatus)(first.address, first.family, url) };
  } catch (err) {
    // A timeout is said as such; anything else (refused connection, TLS failure, reset) as unreachable.
    return { error: (err as Error).message === "timeout" ? "timeout" : "unreachable" };
  }
}

function getStatus(address: string, family: number, url: URL, timeoutMs = TIMEOUT_MS): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: address, family, port: 443, servername: url.hostname, path: url.pathname || "/", method: "GET", agent: false,
      headers: { host: url.hostname, "user-agent": "Pako site check", accept: "*/*" }, timeout: timeoutMs,
    }, (res) => {
      resolve(res.statusCode ?? 0);
      res.destroy();
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}
