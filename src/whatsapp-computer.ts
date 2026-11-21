// The owner's own WhatsApp on a person's computer (local mode), set up from the panel in five steps, with Meta's official WhatsApp Cloud API
// only. Unofficial WhatsApp Web libraries are against WhatsApp's terms and can get the number banned: Pako never uses them.
//
// The Cloud API delivers messages to a public https webhook, which a computer does not have. With the person's yes, Pako opens Cloudflare's
// official quick tunnel (src/tunnel.ts) and lets through it ONLY the webhook: /whatsapp/webhook, and the phone line's /personal-voice/result,
// /tool and /inbound when the LiveKit voice line is set up. Any other path that came through the tunnel (told by Cloudflare's cf-connecting-ip
// or cf-ray header, or by the tunnel's host name) is answered 404 here, before anything else sees it; the panel and /assistant/* are never
// public. Each time the tunnel's address changes, Pako registers the webhook with Meta again (Graph API: POST /{app-id}/subscriptions with the
// app's own access token) and checks that Meta's verification request arrived.
//
// The guided setup (src/panel/whatsapp.js draws it), with the same protection as the other panel routes (the signed-in session, and x-pako
// on a POST):
//   GET  /panel/api/whatsapp/setup -> { step, done[], tunnel: { state, url, why? }, meta: { appId?, phoneNumberId?, testNumber?, ... },
//                                       phone: { on, url }, problems[] }
//   POST /panel/api/whatsapp/setup { action: "tunnelOn" | "tunnelOff" | "saveMeta" | "sendTest" | "forget", values? } -> { ok, error?, ...setup }
// `step` is "app" (nothing saved yet: steps 1 and 2 happen on Meta's site), "tunnel", "test" or "done"; `done` lists "app", "number",
// "values", "tunnel" and "test" as they are reached. No token or secret is ever sent back to the page.
//
// Meta's values (app id and secret, phone number id, access token, the owner's number) and the tunnel's on/off are kept in ~/.pako/secrets.json
// (mode 600), forgotten in one click ("forget"). Messages: the owner's text and button presses reach the door (src/whatsapp.ts) as the chat
// "whatsapp"; Pako's answers go back there while WhatsApp's 24 hours since the owner's last message are open; what Pako starts after that goes
// to Telegram or the panel's chat instead (on a computer no template is sent by itself). Voice notes and photos are answered with a line
// saying to send them in the panel's chat: their files would have to be fetched from Meta with the token, which this first version does not do.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import type { Control } from "./control.ts";
import { texts, type Lang } from "./i18n.ts";
import type { Kv } from "./kv.ts";
import { nationalNumber, withoutTrunkZero } from "./region.ts";
import type { Tunnel } from "./tunnel.ts";
import type { OwnerChannel, WhatsappLine } from "./whatsapp.ts";
import { createLog } from "./log.ts";
import { panelGuard } from "./panel-guard.ts";

const log = createLog("whatsapp");

type Env = Record<string, string | undefined>;
type Body = Record<string, unknown>;

const T = texts(
  {
    official: "Pako only uses Meta's official WhatsApp API: unofficial libraries break WhatsApp's terms and can get your number banned.",
    badAppId: "The App ID is digits only: copy it from App settings, Basic.",
    badSecret: "The App secret is letters and digits (press “Show” in App settings, Basic, and copy all of it).",
    badNumberId: "The number's id is digits only: it is “Phone number ID” in WhatsApp, API Setup.",
    badToken: "That doesn't look like a Meta access token: it usually starts with EAA. Copy all of it.",
    badOwner: "Your WhatsApp number with its country code: for example +44 7700 900123.",
    tokenRefused: "Meta doesn't accept that token (it may have expired: the temporary one lasts 24 hours). Make another, or use the permanent one.",
    numberUnknown: "Meta doesn't know that phone number ID with that token. Copy it again from WhatsApp, API Setup.",
    appRefused: "The App ID and App secret don't match. Copy them again from App settings, Basic.",
    noAnswer: "I couldn't reach Meta. Check the internet connection and try again.",
    notKept: "I couldn't save it on this computer (~/.pako/secrets.json). Check there's free space and permission, then try again.",
    needValues: "First paste your Meta app's details (step 3).",
    needTunnel: "First turn the tunnel on and wait for Meta to confirm the address (step 4).",
    notAllowed: "Meta won't let the test number write to you yet: in WhatsApp, API Setup, add your number under “To” and confirm it with "
      + "the code you get.",
    noHello: "That number has no hello_world template. Write “hi” to it from your WhatsApp first, then press again.",
    sendFailed: "Meta didn't send the test message (code {code}). Try again in a moment.",
    unknownAction: "I don't know how to do that.",
    tunnelPlatform: "Cloudflare doesn't publish cloudflared for this computer.",
    tunnelNetwork: "I couldn't download cloudflared from Cloudflare. Check the internet connection and turn it on again.",
    tunnelChecksum: "The cloudflared download doesn't match the checksum Cloudflare publishes: I didn't use it. Try again later.",
    tunnelUnpack: "I couldn't open the cloudflared download. Try again.",
    tunnelDisk: "I couldn't save cloudflared in ~/.pako/bin. Check there's free space and permission.",
    tunnelStart: "cloudflared won't start on this computer. Try turning the tunnel off and on.",
    registerFailed: "Meta hasn't accepted the tunnel's address yet (code {code}). I'll keep trying by myself.",
    notVerified: "Meta didn't get to check the tunnel's address. I'll keep trying by myself.",
    hello: "Hi, I'm Pako. Reply “hi” here to finish connecting WhatsApp.",
    connected: "✓ Done: WhatsApp is connected to Pako. Write to me here whenever you like.",
    onlyText: "On WhatsApp, on this computer I understand text and buttons. Send voice notes, photos and documents in the panel's chat.",
    logSaved: "WhatsApp: Meta app details saved from the panel (number {number})",
    logTunnelOn: "WhatsApp: Cloudflare tunnel turned on from the panel",
    logTunnelOff: "WhatsApp: Cloudflare tunnel turned off from the panel",
    logRegistered: "WhatsApp: Meta checked the tunnel's address",
    logTest: "WhatsApp: test message sent to your number",
    logConnected: "WhatsApp: connected (you replied to the test message)",
    logForgot: "WhatsApp: details forgotten on this computer",
  },
);
type Key = Parameters<ReturnType<typeof T>>[0];

/** What is kept in secrets.json. `repliedAt`: when the owner answered the test message (the setup is done). */
export interface SavedWhatsapp {
  appId: string;
  appSecret: string;
  phoneNumberId: string;
  accessToken: string;
  ownerNumber: string;
  verifyToken: string;
  wabaId?: string;
  testNumber?: string;
  appName?: string;
  tunnel?: boolean;
  repliedAt?: number;
}

const SHAPES: Record<"appId" | "appSecret" | "phoneNumberId" | "accessToken" | "ownerNumber", { re: RegExp; bad: Key }> = {
  appId: { re: /^\d{5,25}$/, bad: "badAppId" },
  appSecret: { re: /^[A-Za-z0-9]{16,64}$/, bad: "badSecret" },
  phoneNumberId: { re: /^\d{5,25}$/, bad: "badNumberId" },
  accessToken: { re: /^[A-Za-z0-9_|-]{20,1200}$/, bad: "badToken" },
  ownerNumber: { re: /^\d{8,15}$/, bad: "badOwner" },
};
const FIELDS = Object.keys(SHAPES) as (keyof typeof SHAPES)[];
/**
 * A number as typed ("+34 612 34 56 78", "0034...") as WhatsApp writes it: digits with the country code. One typed without it, the way
 * people write their own number at home ("612 34 56 78" in Spain, "(415) 555-0100" in the US), gets the owner's country's code.
 */
export const ownerDigits = (raw: string): string => {
  const typed = withoutTrunkZero(raw).replace(/[\s().-]/g, "");
  if (/^(?:\+|00)/.test(typed)) return typed.replace(/^\+/, "").replace(/^00/, "");
  return (nationalNumber(typed) ?? typed).replace(/^\+/, "");
};

/** Paths a request that came through the tunnel may reach: the webhook, and the phone line's when it is on. Nothing else. */
export const PUBLIC_PATHS = ["/whatsapp/webhook"];
export const PHONE_PATHS = ["/personal-voice/result", "/personal-voice/tool", "/personal-voice/inbound"];

/** A request that came through Cloudflare's tunnel: Cloudflare stamps every one with cf-connecting-ip and cf-ray; its host is the tunnel's. */
export function cameThroughTunnel(req: Pick<Request, "headers">, tunnelHost: string | null): boolean {
  const host = String(req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
  return req.headers["cf-connecting-ip"] !== undefined || req.headers["cf-ray"] !== undefined || host.endsWith(".trycloudflare.com")
    || (!!tunnelHost && host === tunnelHost);
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

const WINDOW_MS = 24 * 3600_000;
const LAST_OWNER_KEY = "whatsapp-computer-last-owner";

export interface ComputerWhatsappDeps {
  /** Where Meta's values are kept (src/local.ts settings: secrets.json). */
  store: { read: () => Record<string, unknown> | null; write: (v: SavedWhatsapp | null) => boolean };
  kv: Kv | null;
  env: Env;
  lang: () => Lang;
  control?: Control;
  /** The tunnel, made with the function to call when its address changes (src/tunnel.ts createTunnel; a stand-in in the tests). */
  tunnel: (onUrl: (url: string | null) => void) => Tunnel;
  /** The LiveKit voice line is set up: its webhook paths go through the tunnel too. */
  phoneOn: () => boolean;
  fetch?: typeof fetch;
  now?: () => number;
  /** How long Meta's verification request is waited for after a registration (default 15 s). */
  verifyWaitMs?: number;
  /** The first wait before registering again after Meta refused (default 5 s, doubled each time up to 120 times this: 10 minutes). */
  retryMs?: number;
  /**
   * The watchdog's WhatsApp part (src/watchdog.ts): each registration of the webhook with Meta, good or not. While Meta keeps refusing the
   * tunnel's address the owner's WhatsApp is silent, so the watchdog tells them on the chat that still works (Telegram, the panel).
   */
  health?: (ok: boolean, detail?: string) => void;
}

export type ComputerWhatsapp = ReturnType<typeof createComputerWhatsapp>;

export function createComputerWhatsapp(o: ComputerWhatsappDeps) {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const tx = (key: Key, vars?: Record<string, string | number>): string => T(o.lang())(key, vars);
  const version = /^v\d{1,2}\.\d$/.test((o.env.WHATSAPP_GRAPH_VERSION ?? "").trim()) ? o.env.WHATSAPP_GRAPH_VERSION!.trim() : "v23.0";
  const GRAPH = `https://graph.facebook.com/${version}`;
  // The owner's notice template: its approval is what lets Pako start a conversation after the 24 hours. "pako_notice", an English
  // template, unless WHATSAPP_REMINDER_TEMPLATE names another (a template approved in Spanish, such as "pako_aviso", with
  // WHATSAPP_TEMPLATE_LANG=es).
  const reminder = (o.env.WHATSAPP_REMINDER_TEMPLATE ?? "").trim();
  const templateName = /^[a-z0-9_]{1,200}$/.test(reminder) ? reminder : "pako_notice";

  const readSaved = (): SavedWhatsapp | null => {
    const v = o.store.read();
    if (!v) return null;
    const s = v as Partial<SavedWhatsapp>;
    if (!FIELDS.every((k) => typeof s[k] === "string" && SHAPES[k].re.test(s[k]!)) || typeof s.verifyToken !== "string") return null;
    return s as SavedWhatsapp;
  };
  let saved = readSaved();
  const keep = (next: SavedWhatsapp | null): boolean => {
    if (!o.store.write(next)) return false;
    saved = next;
    return true;
  };

  // ---------- what the panel shows ----------

  /** Meta's side of things that went wrong, by kind (the tunnel's own trouble is read from the tunnel). */
  const problems = new Map<"webhook", string>();
  let webhook: "none" | "registering" | "verified" | "failed" = "none";
  let verifiedAt = 0;
  let registerGen = 0;
  let awaitingSince = 0;
  let template: { name: string; status: string; at: number } = { name: templateName, status: "unknown", at: 0 };

  // ---------- WhatsApp's 24 hours: from the owner's last message on WhatsApp ----------

  let lastOwnerAt = 0;
  let lastOwnerLoaded = false;
  const loadLastOwner = async (): Promise<void> => {
    if (lastOwnerLoaded) return;
    lastOwnerLoaded = true;
    try {
      const v = Number(await o.kv?.get(LAST_OWNER_KEY));
      if (v > lastOwnerAt) lastOwnerAt = v;
    } catch {
      /* the store did not answer: read again next time */
      lastOwnerLoaded = false;
    }
  };
  const touchOwner = (at: number): void => {
    lastOwnerAt = at;
    o.kv?.set(LAST_OWNER_KEY, String(at), 3 * 24 * 3600).catch(() => undefined);
  };
  const windowOpen = async (): Promise<boolean> => {
    await loadLastOwner();
    return lastOwnerAt > 0 && now() - lastOwnerAt < WINDOW_MS;
  };

  // ---------- Meta's Graph API ----------

  type GraphAnswer = { status: number; json: Record<string, unknown> } | null;
  /** One request to the Graph API; null when Meta did not answer. Nothing of it is ever logged: its URL can hold a token. */
  const graph = async (method: "GET" | "POST", path: string, o2: { token?: string; form?: Record<string, string>; json?: Body } = {}): Promise<GraphAnswer> => {
    try {
      const headers: Record<string, string> = {};
      if (o2.token) headers.authorization = `Bearer ${o2.token}`;
      let body: string | undefined;
      if (o2.form) {
        headers["content-type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams(o2.form).toString();
      } else if (o2.json) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(o2.json);
      }
      const r = await f(`${GRAPH}${path}`, { method, headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(15_000) });
      const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: r.status, json: json && typeof json === "object" ? json : {} };
    } catch {
      /* no answer: the caller says so */
      return null;
    }
  };
  const errorCode = (a: GraphAnswer): number => Number((a?.json.error as { code?: unknown } | undefined)?.code ?? 0) || 0;
  const appToken = (s: SavedWhatsapp): string => `${s.appId}|${s.appSecret}`;

  /** The WhatsApp Business Account the token is for (Meta's debug_token): needed for the template's status. Best effort. */
  const findWaba = async (s: SavedWhatsapp): Promise<string | undefined> => {
    const q = new URLSearchParams({ input_token: s.accessToken, access_token: appToken(s) });
    const a = await graph("GET", `/debug_token?${q}`);
    const scopes = ((a?.json.data as { granular_scopes?: unknown } | undefined)?.granular_scopes ?? []) as { scope?: string; target_ids?: string[] }[];
    const ids = Array.isArray(scopes)
      ? scopes.filter((x) => x.scope === "whatsapp_business_management" || x.scope === "whatsapp_business_messaging").flatMap((x) => x.target_ids ?? [])
      : [];
    return ids.find((id) => /^\d{5,25}$/.test(id));
  };

  /** The notice template's status (approved, pending, rejected, missing), asked at most once a minute. */
  const refreshTemplate = async (): Promise<void> => {
    const s = saved;
    if (!s?.wabaId || now() - template.at < 60_000) return;
    template.at = now();
    const q = new URLSearchParams({ name: templateName, fields: "name,status" });
    const a = await graph("GET", `/${s.wabaId}/message_templates?${q}`, { token: s.accessToken });
    if (!a || a.status >= 300) return;
    const found = ((a.json.data ?? []) as { name?: string; status?: string }[]).find((t) => t.name === templateName);
    template = { name: templateName, status: found?.status ? found.status.toLowerCase() : "missing", at: template.at };
  };

  /** Tells Meta the webhook's address (and checks that Meta came to verify it); again, waiting longer each time, while Meta refuses. */
  const register = async (url: string, gen: number, attempt = 0): Promise<void> => {
    const s = saved;
    if (!s || gen !== registerGen) return;
    webhook = "registering";
    const asked = now();
    const a = await graph("POST", `/${s.appId}/subscriptions`, {
      form: {
        object: "whatsapp_business_account",
        callback_url: `${url}/whatsapp/webhook`,
        verify_token: s.verifyToken,
        fields: "messages",
        access_token: appToken(s),
      },
    });
    if (gen !== registerGen) return;
    let ok = !!a && a.status < 300 && a.json.success === true;
    if (ok) {
      // Meta checks the address while it registers it: its request (GET /whatsapp/webhook, below) must have come.
      const end = now() + (o.verifyWaitMs ?? 15_000);
      while (verifiedAt < asked && now() < end) await new Promise((r) => setTimeout(r, 50));
      ok = verifiedAt >= asked;
      if (!ok) problems.set("webhook", tx("notVerified"));
    } else {
      problems.set("webhook", tx("registerFailed", { code: a ? errorCode(a) || a.status : "—" }));
    }
    if (gen !== registerGen) return;
    if (ok) {
      webhook = "verified";
      problems.delete("webhook");
      o.health?.(true);
      o.control?.log("whatsapp", tx("logRegistered"));
      // The app must also hear the account's messages: asked once the address works (the test number's account usually has it already).
      if (s.wabaId) await graph("POST", `/${s.wabaId}/subscribed_apps`, { token: s.accessToken });
      return;
    }
    webhook = "failed";
    o.health?.(false, problems.get("webhook") ?? tx("notVerified"));
    // A new quick tunnel's name takes a moment to be known everywhere: Meta may not reach it at first. Then, as the panel says, again every
    // ten minutes for as long as this address is the tunnel's (a Meta outage): a new address or turning it off ends it (registerGen).
    const first = o.retryMs ?? 5000;
    const t = setTimeout(() => void register(url, gen, attempt + 1), Math.min(first * 2 ** Math.min(attempt, 10), first * 120));
    t.unref?.();
  };

  const tunnel = o.tunnel((url) => {
    registerGen++;
    if (!url) {
      webhook = "none";
      return;
    }
    if (saved) void register(url, registerGen);
  });
  const tunnelHost = (): string | null => {
    const u = tunnel.url();
    return u ? new URL(u).host.toLowerCase() : null;
  };

  // ---------- sending to the owner ----------

  const sendToOwner = async (body: Body): Promise<GraphAnswer> => {
    const s = saved;
    if (!s) return null;
    return graph("POST", `/${s.phoneNumberId}/messages`, {
      token: s.accessToken,
      json: { messaging_product: "whatsapp", recipient_type: "individual", to: s.ownerNumber, ...body },
    });
  };
  const sendLine = async (text: string): Promise<void> => {
    await sendToOwner({ type: "text", text: { body: text, preview_url: false } });
  };

  /** The door's way to the owner's WhatsApp: only once the setup is done (the owner answered the test), and while the 24 hours are open. */
  const line: WhatsappLine = {
    reachable: async () => !!saved?.repliedAt && (await windowOpen()),
    deliver: async (body) => {
      if (!saved?.repliedAt || !(await windowOpen())) return false;
      const a = await sendToOwner(body);
      if (a && a.status < 300) return true;
      if (a) log.error(`Meta refused a message to the owner (${errorCode(a) || a.status})`);
      return false;
    },
  };

  // ---------- the webhook (mounted before the door's, which on a computer has stand-in settings only) ----------

  const door: { ingest: ((m: Body, channel: OwnerChannel) => Promise<string>) | null; from: () => string } = { ingest: null, from: () => "" };
  const seen = new Set<string>();

  const handle = async (m: Body): Promise<string> => {
    const s = saved;
    if (!s) return "ignored";
    if (String(m.from ?? "").replace(/\D/g, "") !== s.ownerNumber) return "ignored (not the owner)";
    const id = typeof m.id === "string" ? m.id : "";
    if (!id || seen.has(id)) return "repeated";
    seen.add(id);
    if (seen.size > 500) seen.delete(seen.values().next().value!);
    touchOwner(now());
    // The answer to the test message: the setup is done, and from now on this is a chat with Pako.
    if (!s.repliedAt) {
      if (keep({ ...s, repliedAt: now() })) {
        awaitingSince = 0;
        o.control?.log("whatsapp", tx("logConnected"));
        await sendLine(tx("connected"));
        return "setup answered";
      }
      seen.delete(id);
      throw new Error("the setup could not be kept");
    }
    if (m.type === "text" || m.type === "interactive" || m.type === "button" || m.type === "reaction") {
      if (!door.ingest) {
        seen.delete(id);
        throw new Error("the door is not ready yet");
      }
      return door.ingest({ ...m, from: door.from() }, "whatsapp");
    }
    await sendLine(tx("onlyText"));
    return "media not taken";
  };

  const mountWebhook = (app: Express): void => {
    app.get("/whatsapp/webhook", (req, res) => {
      const token = String(req.query["hub.verify_token"] ?? "");
      if (saved && req.query["hub.mode"] === "subscribe" && token && same(token, saved.verifyToken)) {
        verifiedAt = now();
        res.status(200).type("text").send(String(req.query["hub.challenge"] ?? "").slice(0, 200));
        return;
      }
      res.status(403).type("text").send("Forbidden");
    });
    app.post("/whatsapp/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req: Request, res: Response) => {
      const s = saved;
      if (!s) {
        res.status(404).type("text").send("Not set up");
        return;
      }
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const given = String(req.get("x-hub-signature-256") ?? "");
      const expected = `sha256=${createHmac("sha256", s.appSecret).update(body).digest("hex")}`;
      if (!body.length || !same(given, expected)) {
        res.status(401).type("text").send("Bad signature");
        return;
      }
      try {
        const doc = JSON.parse(body.toString("utf8")) as { object?: string; entry?: { changes?: { value?: Body }[] }[] };
        if (doc.object === "whatsapp_business_account") {
          for (const entry of doc.entry ?? []) {
            for (const change of entry.changes ?? []) {
              const v = change.value ?? {};
              if ((v.metadata as { phone_number_id?: string } | undefined)?.phone_number_id !== s.phoneNumberId) continue;
              for (const m of (Array.isArray(v.messages) ? v.messages : []) as Body[]) await handle(m);
            }
          }
        }
        res.status(200).type("text").send("ok");
      } catch (err) {
        // Not a 200: Meta delivers it again, and an id already handled is dropped then.
        log.error(`could not handle a webhook: ${(err as Error).message}`);
        res.status(500).type("text").send("Try again");
      }
    });
  };

  /** Before every other route, the local guard included: what came through the tunnel reaches the webhook paths only, else 404. */
  const gate: RequestHandler = (req, res, next) => {
    if (!cameThroughTunnel(req, tunnelHost())) return next();
    const allowed = tunnel.state() === "on" && (PUBLIC_PATHS.includes(req.path) || (o.phoneOn() && PHONE_PATHS.includes(req.path)));
    if (!allowed) {
      res.status(404).set(HEADERS).type("text").send("Not found");
      return;
    }
    // Only this middleware sets it (nothing a request carries can): src/guard-http.ts lets such a request through to its route.
    res.locals.pakoPublic = true;
    next();
  };

  // ---------- the setup ----------

  const tunnelProblem = (): string | null => {
    const why = tunnel.why();
    if (tunnel.state() !== "error" || !why) return null;
    const key = ({ platform: "tunnelPlatform", network: "tunnelNetwork", checksum: "tunnelChecksum", unpack: "tunnelUnpack", disk: "tunnelDisk" } as Record<string, Key>)[why];
    return tx(key ?? "tunnelStart");
  };

  const setup = async () => {
    await refreshTemplate();
    const s = saved;
    const done: string[] = [];
    if (s) done.push("app", "number", "values");
    if (s && webhook === "verified") done.push("tunnel");
    if (s?.repliedAt) done.push("test");
    const step = !s ? "app" : webhook !== "verified" ? "tunnel" : !s.repliedAt ? "test" : "done";
    const url = tunnel.url();
    const open = await windowOpen();
    const tp = tunnelProblem();
    return {
      step,
      done,
      official: tx("official"),
      tunnel: { state: tunnel.state(), url, ...(tunnel.why() ? { why: tunnel.why() } : {}) },
      meta: s
        ? {
            appId: s.appId, phoneNumberId: s.phoneNumberId, ownerNumber: `+${s.ownerNumber}`,
            ...(s.testNumber ? { testNumber: s.testNumber } : {}), ...(s.appName ? { appName: s.appName } : {}),
            webhook, awaiting: awaitingSince > 0 && !s.repliedAt,
            window: { open, ...(open ? { until: lastOwnerAt + WINDOW_MS } : {}) },
            template: { name: template.name, status: template.status },
          }
        : {},
      phone: { on: o.phoneOn(), url: o.phoneOn() ? url : null },
      problems: [...(tp ? [tp] : []), ...problems.values()],
    };
  };

  type Outcome = { ok: true } | { ok: false; error: string };
  const saveMeta = async (values: Body): Promise<Outcome> => {
    // An empty field keeps what was saved (the page never shows a secret back, so it cannot fill it in again).
    const given = Object.fromEntries(
      FIELDS.map((k) => [k, typeof values[k] === "string" ? String(values[k]).trim() : ""]).filter(([, v]) => v),
    ) as Partial<Record<(typeof FIELDS)[number], string>>;
    // With its country code, as WhatsApp writes from it: "612 345 678" would be kept as a number no reply ever comes from.
    if (given.ownerNumber !== undefined && !/^(\+|00)/.test(given.ownerNumber)) return { ok: false, error: tx("badOwner") };
    if (given.ownerNumber !== undefined) given.ownerNumber = ownerDigits(given.ownerNumber);
    const next = { ...(saved ?? {}), ...given } as Partial<SavedWhatsapp>;
    for (const k of FIELDS) if (!SHAPES[k].re.test(next[k] ?? "")) return { ok: false, error: tx(SHAPES[k].bad) };
    const s = { ...next, verifyToken: next.verifyToken || randomBytes(24).toString("base64url") } as SavedWhatsapp;
    const number = await graph("GET", `/${s.phoneNumberId}?fields=display_phone_number,verified_name`, { token: s.accessToken });
    if (!number) return { ok: false, error: tx("noAnswer") };
    if (number.status >= 300) {
      const code = errorCode(number);
      return { ok: false, error: tx(number.status === 401 || code === 190 ? "tokenRefused" : "numberUnknown") };
    }
    const app = await graph("GET", `/${s.appId}?${new URLSearchParams({ fields: "id,name", access_token: appToken(s) })}`);
    if (!app) return { ok: false, error: tx("noAnswer") };
    if (app.status >= 300) return { ok: false, error: tx("appRefused") };
    const shown = String(number.json.display_phone_number ?? "").slice(0, 40);
    const name = String(app.json.name ?? "").slice(0, 80);
    // Another number or another owner: the test must be answered again before Pako writes there.
    const changed = !saved || saved.phoneNumberId !== s.phoneNumberId || saved.ownerNumber !== s.ownerNumber;
    const wabaId = (await findWaba(s)) ?? (changed ? undefined : saved?.wabaId);
    const { repliedAt: _r, wabaId: _w, testNumber: _t, appName: _a, ...rest } = s;
    const kept: SavedWhatsapp = {
      ...rest, ...(shown ? { testNumber: shown } : {}), ...(name ? { appName: name } : {}), ...(wabaId ? { wabaId } : {}),
      ...(!changed && saved?.repliedAt ? { repliedAt: saved.repliedAt } : {}),
    };
    if (!keep(kept)) return { ok: false, error: tx("notKept") };
    template = { name: templateName, status: "unknown", at: 0 };
    o.control?.log("whatsapp", tx("logSaved", { number: shown || s.phoneNumberId }));
    // The tunnel is already up: Meta hears of it with these values.
    const url = tunnel.url();
    if (url) void register(url, ++registerGen);
    return { ok: true };
  };

  const sendTest = async (): Promise<Outcome> => {
    const s = saved;
    if (!s) return { ok: false, error: tx("needValues") };
    if (webhook !== "verified") return { ok: false, error: tx("needTunnel") };
    // While the owner's 24 hours are open a plain text can go; otherwise only a template, and every number has hello_world to start with.
    const a = (await windowOpen())
      ? await sendToOwner({ type: "text", text: { body: tx("hello"), preview_url: false } })
      : await sendToOwner({ type: "template", template: { name: "hello_world", language: { code: "en_US" } } });
    if (!a) return { ok: false, error: tx("noAnswer") };
    if (a.status >= 300) {
      const code = errorCode(a);
      if (code === 131030) return { ok: false, error: tx("notAllowed") };
      if (a.status === 401 || code === 190) return { ok: false, error: tx("tokenRefused") };
      if (code === 132001) return { ok: false, error: tx("noHello") };
      return { ok: false, error: tx("sendFailed", { code: code || a.status }) };
    }
    const { repliedAt: _r, ...rest } = s;
    if (!keep(rest)) return { ok: false, error: tx("notKept") };
    awaitingSince = now();
    o.control?.log("whatsapp", tx("logTest"));
    return { ok: true };
  };

  const act = async (action: unknown, values: Body): Promise<Outcome> => {
    if (action === "saveMeta") return saveMeta(values);
    if (action === "sendTest") return sendTest();
    if (action === "tunnelOn") {
      if (!saved) return { ok: false, error: tx("needValues") };
      if (!keep({ ...saved, tunnel: true })) return { ok: false, error: tx("notKept") };
      tunnel.start();
      o.control?.log("whatsapp", tx("logTunnelOn"));
      return { ok: true };
    }
    if (action === "tunnelOff") {
      if (saved && !keep({ ...saved, tunnel: false })) return { ok: false, error: tx("notKept") };
      tunnel.stop();
      registerGen++;
      webhook = "none";
      problems.clear();
      o.control?.log("whatsapp", tx("logTunnelOff"));
      return { ok: true };
    }
    if (action === "forget") {
      tunnel.stop();
      registerGen++;
      if (!keep(null)) return { ok: false, error: tx("notKept") };
      webhook = "none";
      problems.clear();
      awaitingSince = 0;
      lastOwnerAt = 0;
      o.kv?.set(LAST_OWNER_KEY, "0", 60).catch(() => undefined);
      template = { name: templateName, status: "unknown", at: 0 };
      o.control?.log("whatsapp", tx("logForgot"));
      return { ok: true };
    }
    return { ok: false, error: tx("unknownAction") };
  };

  const mountPanel = (app: Express, signedIn: (req: Request) => boolean): void => {
    const auth = panelGuard(signedIn);
    const limit = (n: number) =>
      rateLimit({ windowMs: 60_000, limit: n, standardHeaders: "draft-8", legacyHeaders: false, handler: (_q, r) => void r.status(429).json({ error: "too many" }) });
    // The page looks every second or two while a step is under way (the download, Meta's check, the owner's reply).
    app.get("/panel/api/whatsapp/setup", auth(false), limit(180), async (_req, res) => {
      res.json(await setup());
    });
    // One change at a time: two saves at once could each register a webhook.
    let chain: Promise<unknown> = Promise.resolve();
    app.post("/panel/api/whatsapp/setup", auth(true), limit(30), express.json({ limit: "8kb" }), async (req, res) => {
      const b = (req.body ?? {}) as { action?: unknown; values?: unknown };
      const values = b.values && typeof b.values === "object" && !Array.isArray(b.values) ? (b.values as Body) : {};
      const job = chain.then(() => act(b.action, values));
      chain = job.catch(() => undefined);
      try {
        const out = await job;
        res.status(out.ok ? 200 : 400).json({ ...out, ...(await setup()) });
      } catch (err) {
        log.error(`the panel's setup failed: ${(err as Error).name}`);
        res.status(500).json({ ok: false, error: tx("noAnswer") });
      }
    });
  };

  return {
    gate,
    mountWebhook,
    mountPanel,
    line,
    /** The door's way in, once it is built (src/app.ts): what the owner writes on WhatsApp arrives as the chat "whatsapp". */
    attach: (ingest: (m: Body, channel: OwnerChannel) => Promise<string>, from: () => string): void => {
      door.ingest = ingest;
      door.from = from;
    },
    /** Once the server listens: the tunnel again, when it was on before this start. */
    start: (): void => {
      if (saved?.tunnel) tunnel.start();
    },
    stop: (): void => {
      registerGen++;
      tunnel.stop();
    },
  };
}
