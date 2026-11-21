// Pako on the owner's phone, on the same Wi-Fi (Settings › General › "Use on my phone"; the page itself is src/mobile.ts). Off by default:
// until the owner turns it on, nothing listens anywhere but where Pako always did (127.0.0.1, src/server.ts).
//
// Turned on, a second small server listens on this computer's addresses on the home network (never 0.0.0.0, never a VPN's or a virtual
// machine's interface) and serves the phone's page and its few routes only: none of the panel's, the bridge's or the webhooks'. The
// network is treated as hostile: anyone on the same Wi-Fi can reach that port.
//   - A phone gets in once, by pairing: the owner makes a pairing code in Settings (shown as a QR code and as ten letters to type), which
//     works once and for 10 minutes. The newest code replaces the one before; five wrong tries burn it.
//   - Pairing gives the phone a long-lived device token (32 random bytes) in an httpOnly cookie. Only its SHA-256 is kept here, with the
//     phone's name and when it was last seen; each phone can be removed in Settings, and every request is checked against this list.
//   - Nothing is written to the log but names and counts: never a code, a token or a hash.

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import type { Kv } from "./kv.ts";
import { readJsonRecord } from "./json-record.ts";
import { createLog } from "./log.ts";

const log = createLog("mobile");

/** The record: whether it is on, and the phones paired (hashes only). */
export const MOBILE_KEY = "mobile-access";
const KEEP_S = 3650 * 24 * 3600;
/** A pairing code lives this long. */
export const PAIR_MS = 10 * 60_000;
/** Wrong tries a pairing code survives: the fifth burns it (a new one is made in Settings). */
export const PAIR_TRIES = 5;
/** At most this many phones; pairing one more forgets the one seen longest ago. */
export const MAX_DEVICES = 8;
/** "Last seen" is written at most this often per phone. */
const SEEN_EVERY_MS = 60_000;
/** The letters a code is made of: no 0/O, 1/I/L or U, so it can be typed from the screen without doubt. 30^10 is about 2^49. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 10;

export interface MobileDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeen: number;
}
interface Stored extends MobileDevice {
  /** SHA-256 of the device token, hex. */
  hash: string;
}
interface State {
  on: boolean;
  devices: Stored[];
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const sameHex = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** A code as the owner may type it: in capitals, without its spaces or dash. */
export const normalCode = (raw: string): string => raw.toUpperCase().replace(/[\s-]/g, "").slice(0, 40);

/** A code as it is shown: two groups of five. */
export const showCode = (code: string): string => `${code.slice(0, 5)}-${code.slice(5)}`;

/** A phone's name as kept and shown: one line, 40 characters at most; "Phone" for none. */
export const deviceName = (raw: unknown): string => {
  const s = (typeof raw === "string" ? raw : "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return s || "Phone";
};

export interface MobileAccess {
  enabled(): Promise<boolean>;
  setEnabled(on: boolean): Promise<void>;
  devices(): Promise<MobileDevice[]>;
  /** A new pairing code (the one before stops working): its letters and when it ends. */
  pair(): { code: string; expiresAt: number };
  /** Whether a code is waiting to be used now. */
  pairing(): { expiresAt: number } | null;
  /** Uses the code once: a new device and its token, or null (wrong, used, old, or burnt by wrong tries). */
  redeem(code: string, name: string): Promise<{ device: MobileDevice; token: string } | null>;
  /** The device a token belongs to, or null; its "last seen" moves on. */
  check(token: string): Promise<MobileDevice | null>;
  revoke(id: string): Promise<boolean>;
  revokeAll(): Promise<number>;
}

export function createMobileAccess(o: { kv: Kv | null; now?: () => number }): MobileAccess {
  const now = o.now ?? Date.now;
  let state: State | null = null;
  /** One change at a time, in order. */
  let chain: Promise<unknown> = Promise.resolve();
  let code: { hash: string; until: number; fails: number } | null = null;

  const load = async (): Promise<State> => {
    if (state) return state;
    const raw = o.kv ? ((await readJsonRecord(o.kv, MOBILE_KEY)) as Partial<State> | undefined) : undefined;
    const devices = Array.isArray(raw?.devices)
      ? raw.devices.filter((x): x is Stored => !!x && typeof x.id === "string" && typeof x.hash === "string" && /^[0-9a-f]{64}$/.test(x.hash))
      : [];
    state = { on: raw?.on === true, devices };
    return state;
  };
  const save = async (s: State): Promise<void> => {
    await o.kv?.set(MOBILE_KEY, JSON.stringify(s), KEEP_S);
  };
  const change = <T>(f: (s: State) => T | Promise<T>): Promise<T> => {
    const run = chain.then(async () => {
      const s = await load();
      const out = await f(s);
      await save(s);
      return out;
    });
    chain = run.catch(() => undefined);
    return run;
  };
  const shown = (d: Stored): MobileDevice => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen });

  return {
    enabled: async () => (await load()).on,
    setEnabled: (on) =>
      change((s) => {
        s.on = on;
        // Off: no code left waiting.
        if (!on) code = null;
      }),
    devices: async () => (await load()).devices.map(shown).sort((a, b) => b.lastSeen - a.lastSeen),
    pair: () => {
      let c = "";
      for (let i = 0; i < CODE_LENGTH; i++) c += ALPHABET[randomInt(ALPHABET.length)];
      code = { hash: sha(c), until: now() + PAIR_MS, fails: 0 };
      return { code: c, expiresAt: code.until };
    },
    pairing: () => (code && code.until > now() ? { expiresAt: code.until } : null),
    redeem: async (raw, name) => {
      const c = code;
      if (!c || c.until <= now()) {
        code = null;
        return null;
      }
      if (!sameHex(sha(normalCode(raw)), c.hash)) {
        c.fails++;
        if (c.fails >= PAIR_TRIES) {
          code = null;
          log.warn(`a pairing code was burnt after ${PAIR_TRIES} wrong tries`);
        }
        return null;
      }
      // One use, whatever happens next.
      code = null;
      const token = randomBytes(32).toString("base64url");
      const t = now();
      const device: Stored = { id: randomBytes(5).toString("hex"), name: deviceName(name), hash: sha(token), createdAt: t, lastSeen: t };
      await change((s) => {
        s.devices.push(device);
        // One too many: the one seen longest ago goes.
        while (s.devices.length > MAX_DEVICES) s.devices.splice(s.devices.indexOf(s.devices.reduce((a, b) => (a.lastSeen <= b.lastSeen ? a : b))), 1);
      });
      log.info(`a phone was paired (${device.name})`);
      return { device: shown(device), token };
    },
    check: async (token) => {
      if (!token || token.length > 200) return null;
      const h = sha(token);
      const d = (await load()).devices.find((x) => sameHex(x.hash, h));
      if (!d) return null;
      if (now() - d.lastSeen >= SEEN_EVERY_MS) {
        await change((s) => {
          const x = s.devices.find((y) => y.id === d.id);
          if (x) x.lastSeen = now();
        }).catch((err: Error) => log.error(`last seen could not be kept: ${err.message}`));
      }
      return shown(d);
    },
    revoke: (id) =>
      change((s) => {
        const before = s.devices.length;
        s.devices = s.devices.filter((x) => x.id !== id);
        return s.devices.length < before;
      }),
    revokeAll: () =>
      change((s) => {
        const n = s.devices.length;
        s.devices = [];
        return n;
      }),
  };
}

// ---------- the home network ----------

/** Interfaces that are not the home network: VPNs, tunnels, containers, virtual machines, Apple's peer-to-peer links. */
const VIRTUAL = /^(utun|tun|tap|wg|ppp|ipsec|gif|stf|docker|br-|veth|virbr|vmnet|vboxnet|bridge|llw|awdl|anpi|zt|tailscale|ts\d)/i;
/** A private IPv4 address (RFC 1918): what a home router hands out. Never a public one, never link-local (169.254). */
const PRIVATE = /^(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}$/;

/** This computer's private IPv4 addresses on its real network interfaces (Wi-Fi, Ethernet), in the system's order. */
export function lanAddresses(nets: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(nets)) {
    if (VIRTUAL.test(name)) continue;
    for (const i of list ?? []) {
      if (i.family === "IPv4" && !i.internal && PRIVATE.test(i.address) && !out.includes(i.address)) out.push(i.address);
    }
  }
  return out;
}

export interface MobileListener {
  /** Listens on each address now (and looks again every minute: the network changes). */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Binds the addresses that came, closes the ones gone. */
  refresh(): Promise<void>;
  /** The addresses it listens on now. */
  listening(): string[];
  /** Why it could not listen on an address (the port is taken), or null. */
  problem(): string | null;
}

/** The phone's server: one per address of the home network, each answering with `handler` (src/mobile.ts's app) only. */
export function createMobileListener(o: {
  handler: RequestListener;
  port: () => number;
  addresses?: () => string[];
  every?: number;
}): MobileListener {
  const addresses = o.addresses ?? (() => lanAddresses());
  const servers = new Map<string, Server>();
  let timer: NodeJS.Timeout | null = null;
  let trouble: string | null = null;
  let running = false;

  const bind = (address: string): Promise<void> =>
    new Promise((resolve) => {
      const server = createServer(o.handler);
      // A slow phone never holds a connection for long.
      server.headersTimeout = 15_000;
      server.requestTimeout = 30_000;
      server.once("error", (err: NodeJS.ErrnoException) => {
        servers.delete(address);
        trouble = err.code === "EADDRINUSE" ? `port ${o.port()} is in use on ${address}` : `could not listen on ${address} (${err.code ?? "error"})`;
        log.error(trouble);
        resolve();
      });
      server.listen(o.port(), address, () => {
        servers.set(address, server);
        resolve();
      });
    });
  const close = (address: string): Promise<void> =>
    new Promise((resolve) => {
      const server = servers.get(address);
      servers.delete(address);
      if (!server) return resolve();
      server.close(() => resolve());
      server.closeAllConnections();
    });

  const refresh = async (): Promise<void> => {
    if (!running) return;
    const want = addresses();
    for (const a of [...servers.keys()]) if (!want.includes(a)) await close(a);
    const missing = want.filter((a) => !servers.has(a));
    if (missing.length) trouble = null;
    for (const a of missing) await bind(a);
    if (!want.length) trouble = "no home network found (is this computer on Wi-Fi?)";
  };

  return {
    start: async () => {
      if (running) return;
      running = true;
      await refresh();
      timer = setInterval(() => void refresh().catch((err: Error) => log.error(`the network look failed: ${err.message}`)), o.every ?? 60_000);
      timer.unref?.();
      log.info(`listening for the phone on ${servers.size} address${servers.size === 1 ? "" : "es"}`);
    },
    stop: async () => {
      running = false;
      if (timer) clearInterval(timer);
      timer = null;
      trouble = null;
      await Promise.all([...servers.keys()].map(close));
    },
    refresh,
    listening: () => [...servers.keys()],
    problem: () => trouble,
  };
}
