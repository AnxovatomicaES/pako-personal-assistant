// The front door of Pako on a person's own computer (local mode): before any route, a request must name this server and must not come from
// another website's page.
//
// Listening on 127.0.0.1 keeps the network out, but not the browser. Any page the person opens can make their browser send requests to
// http://127.0.0.1:8787 (a cross-site request), and with DNS rebinding a site points its own name at 127.0.0.1, so that its page talks to Pako
// as if Pako were its own server and reads the answers. So:
//   - The Host header must name this computer as Pako knows it: 127.0.0.1, localhost, [::1], or PAKO_HOST; and when PAKO_HOST is every
//     address (0.0.0.0 or ::), any address of this computer's network interfaces and its host name. A rebound name (evil.example:8787) is
//     answered 421 and nothing else. The port is not looked at: a browser cannot forge it (it is the one in the address bar), and a
//     forwarded port (ssh -L, a container's published port, an editor's) is not the one Pako listens on.
//   - A request the browser says another site's page made is refused with 403: by its Sec-Fetch-Site, or its Origin (or, for one that changes
//     something and has no Origin, its Referer). A link to the panel on another site still opens it (the panel's cookie is SameSite=Strict,
//     so it arrives signed out; a sign-in link signs in). Programs (the bridge, `npm run panel`, curl) send none of these headers.
// This also keeps other sites from using up the rate limits: on one computer every request comes from 127.0.0.1, so thirty refused requests
// from a page would otherwise lock the bridge, or `npm run panel`, out for a quarter of an hour.
//
// A server on the internet (hosted mode) does not use this: it is reached by its public name, through proxies, and has its own checks.
// The one exception on a computer: the WhatsApp webhook reached through the tunnel the person turned on (src/whatsapp-computer.ts).

import { hostname, networkInterfaces } from "node:os";
import type { RequestHandler } from "express";
import { npmCommand, texts, type Lang } from "./i18n.ts";

const T = texts(
  {
    host: `Pako only answers at its own address on this computer. To open the panel, run ${npmCommand()} run panel in the Pako folder.`,
    site: "Pako does not take requests from other websites.",
  },
);

/** The names a browser on this computer may use for Pako. */
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

/** A Host header as a name and a port (80 when it gives none), or null when it is anything but a plain name or address and a port. */
export function hostOf(value: string | undefined): { name: string; port: number } | null {
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/.exec((value ?? "").trim().toLowerCase());
  if (!m) return null;
  const port = m[2] === undefined ? 80 : Number(m[2]);
  return port > 0 && port < 65536 ? { name: m[1]!, port } : null;
}

const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    /* not a URL: no origin */
    return "";
  }
};

/**
 * What a link on another site may never open: the routes of programs (the bridge's, the phone connector's, the admin's, the webhooks) and
 * the panel's data and files. Their refusals count towards rate limits, and a page could open one again and again. In any case of letters:
 * Express sends /ASSISTANT/inbox to /assistant/inbox.
 */
const PROGRAMS = /^\/(?:(?:assistant|admin|whatsapp|slack|email|telegram)\/|personal(?:-voice)?\/|panel\/(?:api|assets)\/)/i;

export interface LocalGuardOptions {
  /** PAKO_HOST: the address local mode was told to listen on, accepted as a name too. */
  host?: string;
  /** The language of the two refusals (src/i18n.ts): always English now. */
  lang?: () => Lang;
  /** This computer's addresses and names on the network, as now (default: its network interfaces and its host name). */
  network?: () => string[];
}

/** An address as a Host header writes it: an IPv6 one in brackets (PAKO_HOST=::1 arrives as [::1]:8787), without its zone (fe80::1%en0). */
const asHostName = (address: string): string => {
  const a = address.trim().toLowerCase().replace(/%.*$/, "");
  return a.includes(":") && !a.startsWith("[") ? `[${a}]` : a;
};

/** The addresses of this computer's network interfaces, and its host name (as it is, without its domain, and as mDNS gives it: name.local). */
const thisComputer = (): string[] => {
  const name = hostname().toLowerCase();
  const short = name.split(".")[0] ?? "";
  const addresses = Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((i) => i.address));
  return [...addresses, name, short, `${short}.local`].filter(Boolean);
};

export function localGuard(o: LocalGuardOptions): RequestHandler {
  const own = asHostName(o.host ?? "");
  const names = new Set([...LOOPBACK, ...(own ? [own] : [])]);
  // Told to listen on every address (to reach the panel from a phone on the same network, or from outside a container): a request names
  // the address or the name it came by, never 0.0.0.0. Asked when a name is not one of the fixed ones: the addresses change with the network.
  const everywhere = own === "0.0.0.0" || own === "[::]";
  const onNetwork = (name: string): boolean => everywhere && (o.network ?? thisComputer)().some((n) => asHostName(n) === name);
  return (req, res, next) => {
    // A webhook request that came through the person's WhatsApp tunnel, already let through by src/whatsapp-computer.ts (its gate, which runs
    // first, is the only thing that sets this; it answers 404 to every other path that came that way).
    if (res.locals?.pakoPublic === true) return next();
    const refuse = (status: number, key: "host" | "site"): void => {
      res.status(status).set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }).type("text").send(T(o.lang?.() ?? "en")(key));
    };
    // The header itself, never req.hostname: with TRUST_PROXY_HOPS set, Express would read X-Forwarded-Host, which any program can send.
    const host = hostOf(req.headers.host);
    if (!host || !(names.has(host.name) || onNetwork(host.name))) return refuse(421, "host");
    const changes = req.method !== "GET" && req.method !== "HEAD";
    // Opening a page from a link on another site (a sign-in link tapped in Telegram's web app) changes nothing and carries no cookie.
    const opening = !changes && !PROGRAMS.test(req.path) && req.get("sec-fetch-mode") === "navigate" && (req.get("sec-fetch-dest") ?? "document") === "document";
    const site = req.get("sec-fetch-site");
    // "same-site" is another port of this computer: another program's page, not Pako's.
    if ((site === "cross-site" || site === "same-site") && !opening) return refuse(403, "site");
    // For a browser with no Sec-Fetch-Site: the page's Origin, which a browser sends with what changes something and with a script's read of
    // another site (never with opening a page); without one, the Referer, for what changes something only (opening a page from a link sends one).
    const referer = changes ? req.get("referer") : undefined;
    const from = req.get("origin") ?? (referer === undefined ? undefined : originOf(referer));
    // "null" (a sandboxed frame, a page that sends no referrer) is not this page either.
    if (from !== undefined && originOf(from) !== originOf(`http://${host.name}:${host.port}`)) return refuse(403, "site");
    next();
  };
}
