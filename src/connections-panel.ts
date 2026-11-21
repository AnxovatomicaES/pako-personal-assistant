// Connections set from the panel, on a person's computer (local mode only): the catalogue and the store are in src/connections.ts.
//
//   GET  /panel/api/connections          -> { connections: ConnectionState[], restart, phone, readable }
//   POST /panel/api/connections          { id, values: { KEY: "text" } } -> { ok: true, restarting } | { ok: false, error, field? }
//   POST /panel/api/connections/remove   { id } -> { ok: true, restarting, outside: [KEY...] } | { ok: false, error }
//   POST /panel/api/connections/resend/check  { key? } -> { ok: true, domains: [...] } | { ok: false, error }   (the typed key, else the set one)
//
// A key left out of `values` keeps what it has; "" removes it. A value set outside the panel (the shell, ~/.pako/.env, ./.env) wins and is
// refused here. After a change the server restarts itself in place (src/server.ts) so every module reads its settings again; `restarting`
// false means it cannot (the change applies at the next start). `restart` in the GET says the same beforehand. `readable` is false when
// ~/.pako/secrets.json cannot be read: nothing can be saved then.
//
// The same protection as the STOP switch: the panel's signed-in session, and on a POST the x-pako header that another site cannot send. A
// server's panel has none of this (every route answers 404): its settings are its environment, and the panel never writes them.

import express, { type Express, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import type { Control } from "./control.ts";
import { appliedAtStart, connectionStates, findConnection, type ConnectionId, icsLink, readStored, WORDS, writeStored } from "./connections.ts";
import { texts, type Lang } from "./i18n.ts";
import { checkResendKey } from "./resend.ts";
import { pakoHome } from "./local.ts";
import { createLog } from "./log.ts";
import { panelGuard } from "./panel-guard.ts";

const log = createLog("connections");

type Env = Record<string, string | undefined>;

const T = texts(
  {
    unknown: "That can't be connected from here.",
    elsewhere: "This one is connected in its own card.",
    bad: "Send the values as text.",
    tooLong: "{label}: it's too long, or it has line breaks.",
    wrong: "{label} isn't valid: {hint}.",
    outside: "{label} is already in your settings ({key} in ~/.pako/.env, ./.env or the terminal), and that wins: change it there.",
    nothing: "You haven't typed anything new.",
    unreadable: "I can't read ~/.pako/secrets.json: fix it (or delete it and start Pako again) before connecting anything.",
    notKept: "I couldn't save it on this computer (~/.pako/secrets.json). Check there's free space and permission, then try again.",
    busy: "Pako is restarting. Wait a moment.",
    mailRefused: "AgentMail doesn't accept that key. Copy it again from its console.",
    mailNoInbox: "AgentMail can't find that inbox with that key. Copy its address as it is.",
    mailNoAnswer: "I couldn't reach AgentMail. Check the internet connection and try again.",
    mailOther: "AgentMail gave an unexpected answer. Try again in a moment.",
    resendRefused: "Resend doesn't accept that key. Copy it again from its dashboard (API Keys).",
    resendNoAnswer: "I couldn't reach Resend. Check the internet connection and try again.",
    resendOther: "Resend gave an unexpected answer. Try again in a moment.",
    resendNoKey: "Type the Resend key first.",
    logSaved: "{name}: settings saved from the panel",
    logRemoved: "{name}: disconnected from the panel",
  },
);

export interface ConnectionsPanelDeps {
  /** The panel's session check (src/dashboard.ts). */
  signedIn: (req: Request) => boolean;
  /** The environment the server runs with now. */
  env: Env;
  /** The language of the card's words and of the answers' sentences (always English: src/i18n.ts). */
  lang: () => Lang;
  control?: Control;
  /** Pako's folder; ~/.pako (PAKO_HOME) without it. */
  dir?: string;
  /** The keys taken from the store at start (src/connections.ts appliedAtStart without it). */
  fromStore?: () => ReadonlySet<string>;
  /** Restarts the server in place (src/server.ts sets app.locals.restart). Without it, app.locals.restart is asked at each change. */
  /** False when it could not (npm run dev and the file could not be touched): the card then takes changes again. */
  restart?: () => boolean | void;
  /** For the tests: the AgentMail and Resend checks' requests. */
  fetch?: typeof fetch;
  /** What a running connection says is wrong now, (the IMAP mailbox's refused login, src/imap.ts): shown on its card. */
  problems?: (l: Lang) => Partial<Record<ConnectionId, string | null>>;
  /** Whether a connection with no live check (the calendar link, the Places key) has answered once: false shows it saved, not connected. */
  checked?: () => Partial<Record<ConnectionId, boolean>>;
}

const PATHS = ["/panel/api/connections", "/panel/api/connections/remove", "/panel/api/connections/resend/check"];
const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};
const AGENTMAIL = "https://api.agentmail.to/v0";
const MAX = 2000;

type Check = { ok: true } | { ok: false; why: "mailRefused" | "mailNoInbox" | "mailNoAnswer" | "mailOther" };

/** Whether AgentMail knows this inbox under this key: one cheap request, within eight seconds. */
export async function checkAgentMail(apiKey: string, inbox: string, f: typeof fetch = fetch): Promise<Check> {
  try {
    const r = await f(`${AGENTMAIL}/inboxes/${encodeURIComponent(inbox)}`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(8_000) });
    if (r.ok) return { ok: true };
    return { ok: false, why: r.status === 401 || r.status === 403 ? "mailRefused" : r.status === 404 ? "mailNoInbox" : "mailOther" };
  } catch {
    /* offline or timed out: said as no answer */
    return { ok: false, why: "mailNoAnswer" };
  }
}

/**
 * What the guided flows (src/mail-autoconfig.ts, src/connect-setup.ts) use once a live check passed: the same save as the card's (one change
 * at a time, a value set outside wins, the module's own check), then the restart after the answer has gone.
 */
export interface ConnectionsSaver {
  save(id: ConnectionId, values: Record<string, string>): Promise<{ ok: true; name: string } | { ok: false; error: string; field?: string; status?: number }>;
  restartAfter(res: express.Response): boolean;
}

/** The panel's connection routes. `d` null: not a person's computer, and every route answers 404. */
export function mountConnectionsPanel(app: Express, d: ConnectionsPanelDeps | null): ConnectionsSaver | null {
  if (!d) {
    app.all(PATHS, (_req, res) => {
      res.status(404).set(HEADERS).json({ error: "local mode only" });
    });
    return null;
  }
  const dir = d.dir ?? pakoHome(d.env);
  const fromStore = d.fromStore ?? appliedAtStart;
  const restartFn = (): (() => boolean | void) | null => {
    const r = d.restart ?? (app.locals.restart as unknown);
    return typeof r === "function" ? (r as () => boolean | void) : null;
  };
  /** Set once a restart has been asked for: this process is going away, and nothing more is written. */
  let restarting = false;
  /** One change at a time: two saves at once would each read the file and the second would undo the first. */
  let changing: Promise<unknown> = Promise.resolve();

  // Not signed in is answered before anything is counted: only the owner's own requests use up the allowance.
  const auth = panelGuard(d.signedIn);
  const limit = (n: number) =>
    rateLimit({ windowMs: 60_000, limit: n, standardHeaders: "draft-8", legacyHeaders: false, handler: (_req, res) => void res.status(429).json({ error: "too many" }) });
  const reads = limit(60);
  const writes = limit(20);
  const body = express.json({ limit: "16kb" });

  /** After the answer has gone: the page shows "restarting" and waits for the server to come back. */
  const restartAfter = (res: express.Response): boolean => {
    const r = restartFn();
    if (!r) return false;
    restarting = true;
    // A restart that could not happen leaves the card usable: the change applies at the next start (said in the server's log).
    res.on("finish", () => setTimeout(() => {
      if (r() === false) restarting = false;
    }, 200).unref?.());
    return true;
  };

  app.get("/panel/api/connections", auth(false), reads, (_req, res) => {
    const l = d.lang();
    const stored = readStored(dir);
    res.json({
      connections: connectionStates({ env: d.env, stored, fromStore: fromStore(), lang: l, ...(d.problems ? { problems: d.problems(l) } : {}), ...(d.checked ? { checked: d.checked() } : {}) }),
      restart: !!restartFn(),
      phone: WORDS(l)("phone"),
      readable: stored !== null,
    });
  });

  app.post("/panel/api/connections", auth(true), writes, body, async (req, res) => {
    const job = changing.then(() => save(req.body as unknown));
    changing = job.catch(() => undefined);
    try {
      const out = await job;
      if (!out.ok) {
        res.status(out.status ?? 400).json({ ok: false, error: out.error, ...(out.field ? { field: out.field } : {}) });
        return;
      }
      res.json({ ok: true, restarting: restartAfter(res) });
    } catch (err) {
      log.error(`the panel could not save: ${(err as Error).name}`);
      res.status(500).json({ ok: false, error: T(d.lang())("notKept") });
    }
  });

  type Out = { ok: true; name: string } | { ok: false; error: string; field?: string; status?: number };

  /** `sameOk`: a guided flow's save after its live check, where the service gave back what is kept already (Slack's same token): a success. */
  const save = async (raw: unknown, sameOk = false): Promise<Out> => {
    const say = T(d.lang());
    const words = WORDS(d.lang());
    if (restarting) return { ok: false, error: say("busy"), status: 409 };
    const { id, values } = (raw && typeof raw === "object" ? raw : {}) as { id?: unknown; values?: unknown };
    const c = findConnection(id);
    if (!c) return { ok: false, error: say("unknown") };
    if (c.card) return { ok: false, error: say("elsewhere") };
    if (!values || typeof values !== "object" || Array.isArray(values)) return { ok: false, error: say("bad") };
    const given = values as Record<string, unknown>;
    const label = (key: string) => words(key as Parameters<typeof words>[0]);
    const known = new Set(c.fields.map((f) => f.key));
    if (Object.keys(given).some((k) => !known.has(k))) return { ok: false, error: say("unknown") };
    const stored = readStored(dir);
    if (!stored) return { ok: false, error: say("unreadable"), status: 500 };
    const patch: Record<string, string | null> = {};
    for (const [key, v] of Object.entries(given)) {
      if (typeof v !== "string") return { ok: false, error: say("bad"), field: key };
      const value = v.trim();
      // A line break would end the value early in a .env file copied from here, and nothing the services give has one.
      if (value.length > MAX || /[\u0000-\u001f\u007f]/.test(value)) return { ok: false, error: say("tooLong", { label: label(key) }), field: key };
      const running = (d.env[key] ?? "").trim();
      if (running && !fromStore().has(key)) return { ok: false, error: say("outside", { label: label(key), key }), field: key, status: 409 };
      patch[key] = value === "" ? null : key === "CALENDAR_ICS_URL" ? (icsLink(value) ?? value) : value;
    }
    if (!Object.entries(patch).some(([k, v]) => v !== (stored[k] ?? null))) {
      return sameOk ? { ok: true, name: words(`${c.id}.name` as Parameters<typeof words>[0]) } : { ok: false, error: say("nothing") };
    }
    // What this connection would start with after the restart: what is outside, then the panel's values with this change.
    const after: Env = { ...d.env };
    for (const f of c.fields) {
      const running = (d.env[f.key] ?? "").trim();
      if (running && !fromStore().has(f.key)) continue;
      const v = Object.hasOwn(patch, f.key) ? patch[f.key] : stored[f.key];
      if (v) after[f.key] = v;
      else delete after[f.key];
    }
    // Everything cleared is a removal, which needs no check.
    const anything = c.fields.some((f) => (after[f.key] ?? "").trim());
    const wrong = anything ? (c.check?.(after) ?? []) : [];
    if (wrong.length) {
      const key = wrong[0]!;
      return { ok: false, error: say("wrong", { label: label(key), hint: words(`${key}.hint` as Parameters<typeof words>[0]) }), field: key };
    }
    // AgentMail answers cheaply whether it knows the inbox under that key: asked when either of them changes, so a typo is caught here and
    // not as a silent inbox after the restart.
    if (c.id === "mail" && anything && (Object.hasOwn(patch, "AGENTMAIL_API_KEY") || Object.hasOwn(patch, "AGENTMAIL_INBOX"))) {
      const checked = await checkAgentMail((after.AGENTMAIL_API_KEY ?? "").trim(), (after.AGENTMAIL_INBOX ?? "").trim(), d.fetch);
      if (!checked.ok) return { ok: false, error: say(checked.why), field: checked.why === "mailNoInbox" ? "AGENTMAIL_INBOX" : "AGENTMAIL_API_KEY" };
    }
    // Resend's key is tried with GET /domains (it sends nothing) when it changes: a wrong key is caught here, not at the first email.
    if (c.id === "resend" && anything && Object.hasOwn(patch, "RESEND_API_KEY")) {
      const checked = await checkResendKey((after.RESEND_API_KEY ?? "").trim(), d.fetch);
      if (!checked.ok) return { ok: false, error: say(checked.why), field: "RESEND_API_KEY" };
    }
    if (restarting) return { ok: false, error: say("busy"), status: 409 };
    if (!writeStored(dir, patch)) return { ok: false, error: say("notKept"), status: 500 };
    const name = words(`${c.id}.name` as Parameters<typeof words>[0]);
    d.control?.log("panel", say(anything ? "logSaved" : "logRemoved", { name }));
    return { ok: true, name };
  };

  // The card's Check: the key typed in the field, else the one Pako has, tried with Resend's GET /domains. Nothing is saved, and the key
  // never comes back: only whether it works and the domains Resend knows for it.
  app.post("/panel/api/connections/resend/check", auth(true), writes, body, async (req, res) => {
    const say = T(d.lang());
    const typed = (req.body as { key?: unknown } | undefined)?.key;
    const key = (typeof typed === "string" && typed.trim() ? typed : (d.env.RESEND_API_KEY ?? "") || (readStored(dir)?.RESEND_API_KEY ?? "")).trim();
    if (!key) {
      res.status(400).json({ ok: false, error: say("resendNoKey") });
      return;
    }
    if (key.length > MAX || /[\u0000-\u001f\u007f]/.test(key)) {
      res.status(400).json({ ok: false, error: say("resendRefused") });
      return;
    }
    const checked = await checkResendKey(key, d.fetch);
    res.json(checked.ok ? { ok: true, domains: checked.domains } : { ok: false, error: say(checked.why) });
  });

  app.post("/panel/api/connections/remove", auth(true), writes, body, async (req, res) => {
    const say = T(d.lang());
    const job = changing.then(() => {
      if (restarting) return { status: 409, body: { ok: false, error: say("busy") } };
      const c = findConnection((req.body as { id?: unknown } | undefined)?.id);
      if (!c || c.card) return { status: 400, body: { ok: false, error: say(c ? "elsewhere" : "unknown") } };
      const stored = readStored(dir);
      if (!stored) return { status: 500, body: { ok: false, error: say("unreadable") } };
      // What is set outside stays (the panel cannot change it): the answer names it, so the card can say where it is.
      const outside = c.fields.filter((f) => (d.env[f.key] ?? "").trim() && !fromStore().has(f.key)).map((f) => f.key);
      const mine = c.fields.filter((f) => Object.hasOwn(stored, f.key) || fromStore().has(f.key)).map((f) => f.key);
      if (!mine.length) return { status: 200, body: { ok: true, restarting: false, outside } };
      if (!writeStored(dir, Object.fromEntries(mine.map((k) => [k, null])))) return { status: 500, body: { ok: false, error: say("notKept") } };
      d.control?.log("panel", say("logRemoved", { name: WORDS(d.lang())(`${c.id}.name` as Parameters<ReturnType<typeof WORDS>>[0]) }));
      return { status: 200, body: { ok: true, restart: true, outside } };
    });
    changing = job.catch(() => undefined);
    try {
      const out = await job;
      if ((out.body as { restart?: boolean }).restart) {
        const { restart: _r, ...rest } = out.body as Record<string, unknown>;
        res.json({ ...rest, restarting: restartAfter(res) });
        return;
      }
      res.status(out.status).json(out.body);
    } catch (err) {
      log.error(`the panel could not remove: ${(err as Error).name}`);
      res.status(500).json({ ok: false, error: say("notKept") });
    }
  });

  return {
    save: (id, values) => {
      const job = changing.then(() => save({ id, values }, true));
      changing = job.catch(() => undefined);
      return job;
    },
    restartAfter,
  };
}
