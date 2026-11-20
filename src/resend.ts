// Sending email from Pako's own domain through Resend (https://resend.com/docs/api-reference/emails/send-email): send only. When it is set,
// the emails the owner asks for (send_email, through the held-action and confirmation flow in src/door/held.ts) go out here instead of
// through the AgentMail inbox (src/mail.ts sendEmail); inbound mail stays with AgentMail or IMAP. Without it, nothing changes.
//
//   RESEND_API_KEY   the API key (re_...), a secret: kept with the panel's other secrets (src/secrets.ts), never in kv or the export
//   RESEND_FROM      the sender on a domain verified in Resend, for example "Pako <hello@pako-os.com>"
//   RESEND_REPLY_TO  optional: where replies go; without it, Pako's AgentMail inbox when there is one, so replies still reach Pako
//
// Every send carries an Idempotency-Key made from the held action's id: a send retried after a lost answer is not sent twice.

import { sendEmail, type MailConfig } from "./mail.ts";

type Env = Record<string, string | undefined>;

export interface ResendConfig {
  apiKey: string;
  from: string;
  replyTo?: string;
}

const API = "https://api.resend.com";
const ADDRESS = /^[^\s@<>,;"]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

/** "a@b.c" or "Name <a@b.c>": the shapes Resend takes for from and reply_to. */
export const isSender = (v: string): boolean => {
  const m = /^([^<>"\r\n]{0,100})<([^<>\s]+)>$/.exec(v.trim());
  return m ? ADDRESS.test(m[2]!) : ADDRESS.test(v.trim());
};

/** Off (null) unless the key and the sender are set; a wrong one is reported and keeps it off, without stopping the server. */
export function loadResendConfig(env: Env): { config: ResendConfig | null; problems: string[] } {
  const apiKey = (env.RESEND_API_KEY ?? "").trim();
  const from = (env.RESEND_FROM ?? "").trim();
  const replyTo = (env.RESEND_REPLY_TO ?? "").trim();
  if (!apiKey && !from && !replyTo) return { config: null, problems: [] };
  const problems: string[] = [];
  if (!/^re_[A-Za-z0-9_-]{8,200}$/.test(apiKey)) problems.push("RESEND_API_KEY must be an API key from Resend's dashboard (it starts with re_)");
  if (!from || from.length > 200 || !isSender(from)) problems.push("RESEND_FROM must be an address on your verified domain, for example Pako <hello@example.com>");
  if (replyTo && (replyTo.length > 200 || !isSender(replyTo))) problems.push("RESEND_REPLY_TO must be one email address");
  return problems.length ? { config: null, problems } : { config: { apiKey, from, ...(replyTo ? { replyTo } : {}) }, problems };
}

/** Resend's own words about a refusal ({ statusCode, name, message }), on one line and short: shown to the owner as the reason. */
async function refusal(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as { message?: unknown };
    return typeof j?.message === "string" ? j.message.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) : "";
  } catch {
    /* not JSON: no reason */
    return "";
  }
}

/**
 * Sends one email. A refusal throws with `status` (a 4xx certainly did not send, src/door/held.ts) and `why` (Resend's message, for the
 * owner); anything else (no answer, a 5xx) may have sent, and the caller never sends it again.
 */
export async function sendViaResend(
  config: ResendConfig,
  m: { to: string; subject: string; text: string; replyTo?: string; idempotencyKey?: string },
  f: typeof fetch = fetch,
): Promise<{ id: string }> {
  const replyTo = m.replyTo ?? config.replyTo;
  const r = await f(`${API}/emails`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
      ...(m.idempotencyKey ? { "Idempotency-Key": m.idempotencyKey.slice(0, 256) } : {}),
    },
    body: JSON.stringify({
      from: config.from,
      to: [m.to],
      subject: m.subject.slice(0, 200),
      text: m.text.slice(0, 5000),
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) {
    const why = await refusal(r);
    throw Object.assign(new Error(`Resend answered ${r.status} to the send${why ? `: ${why}` : ""}`), { status: r.status, why });
  }
  const j = (await r.json().catch(() => ({}))) as { id?: unknown };
  return { id: typeof j.id === "string" ? j.id : "" };
}

export type ResendCheck = { ok: true; domains: string[] } | { ok: false; why: "resendRefused" | "resendNoAnswer" | "resendOther" };

/**
 * Whether Resend accepts this key, with GET /domains (cheap, sends nothing), and the domains it knows. A key made "sending access" only
 * answers 401 restricted_api_key there: it can still send, so that counts as accepted, with no domains to show.
 */
export async function checkResendKey(apiKey: string, f: typeof fetch = fetch): Promise<ResendCheck> {
  try {
    const r = await f(`${API}/domains`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(8_000) });
    if (r.ok) {
      const j = (await r.json().catch(() => ({}))) as { data?: { name?: unknown; status?: unknown }[] };
      const domains = (Array.isArray(j.data) ? j.data : [])
        .filter((d) => typeof d?.name === "string")
        .map((d) => `${String(d.name).slice(0, 100)}${typeof d.status === "string" ? ` (${d.status.slice(0, 20)})` : ""}`)
        .slice(0, 20);
      return { ok: true, domains };
    }
    if (r.status === 401 || r.status === 403) {
      const j = (await r.json().catch(() => ({}))) as { name?: unknown };
      return j?.name === "restricted_api_key" ? { ok: true, domains: [] } : { ok: false, why: "resendRefused" };
    }
    return { ok: false, why: "resendOther" };
  } catch {
    /* offline or timed out: said as no answer */
    return { ok: false, why: "resendNoAnswer" };
  }
}

/** One outgoing email as the door hands it over (src/door/deps.ts sendEmail). */
export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  /** The held action's (or the card's) id: Resend's Idempotency-Key. AgentMail has no such header and ignores it. */
  idempotencyKey?: string;
}

/**
 * Who sends the emails the owner asks for: Resend when it is set, else Pako's AgentMail inbox exactly as before, else nobody (null: the
 * door then says email is off). With both, replies go to RESEND_REPLY_TO, else to the AgentMail inbox, so they still reach Pako.
 */
export function chooseSender(o: {
  resend: ResendConfig | null;
  agentmail: Pick<MailConfig, "apiKey" | "inbox"> | null;
  fetch?: typeof fetch;
}): { via: "resend" | "agentmail"; send: (m: OutgoingMail) => Promise<void> } | null {
  const f = o.fetch ?? fetch;
  if (o.resend) {
    const resend = o.resend;
    // AgentMail's inbox id may be an opaque id rather than its address: only an address can be reply_to (Resend refuses the send otherwise).
    const inbox = o.agentmail?.inbox;
    const replyTo = resend.replyTo ?? (inbox && isSender(inbox) ? inbox : undefined);
    return {
      via: "resend",
      send: async (m) => {
        await sendViaResend(resend, { to: m.to, subject: m.subject, text: m.text, ...(replyTo ? { replyTo } : {}), ...(m.idempotencyKey ? { idempotencyKey: m.idempotencyKey } : {}) }, f);
      },
    };
  }
  if (o.agentmail) {
    const am = o.agentmail;
    return { via: "agentmail", send: (m) => sendEmail(am, { to: m.to, subject: m.subject, text: m.text }, f) };
  }
  return null;
}
