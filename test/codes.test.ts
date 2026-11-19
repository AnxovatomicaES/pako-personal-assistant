// One-time codes hidden in the mail (src/codes.ts, src/mail.ts) and shown only on the owner's CODE (src/whatsapp.ts): the detector's
// table, the store that keeps them 30 minutes, and an email with a code through AgentMail's webhook into everything the server shows or
// passes on. Nothing here reaches the network.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import express from "express";
import { createApp, loadAppConfig, type LocalContext } from "../src/app.ts";
import { CODE_KEEP_MS, CODE_MARK, createCodeVault, hideCodes } from "../src/codes.ts";
import { createControl } from "../src/control.ts";
import type { Kv } from "../src/kv.ts";
import { createLocalChannel, loadHome, localEnv } from "../src/local.ts";
import { sqliteKv } from "../src/sqlite-kv.ts";
import { createMailbox, loadMailConfig, mountMail, type MailConfig } from "../src/mail.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { loadWhatsappConfig, mountWhatsapp, type TelegramDoor } from "../src/whatsapp.ts";

// ---------- the detector ----------

/** Text, and the code in it that must be hidden. */
const CODES: [string, string][] = [
  // Spanish
  ["123456 es tu código de verificación", "123456"],
  ["G-482910 es tu código de verificación de Google", "G-482910"],
  ["Código de verificación: 1234", "1234"],
  ["Tu clave OTP es 12345678", "12345678"],
  ["Tu código de Uber es 4829.", "4829"],
  ["Introduce este código para iniciar sesión: 582014", "582014"],
  ["Código de seguridad: 905172", "905172"],
  ["Clave de acceso: 77AB92K", "77AB92K"],
  ["Tu contraseña temporal es Xk82Lp9q", "Xk82Lp9q"],
  ["Netflix: tu código de inicio de sesión es 2938", "2938"],
  ["Tu código es 4829-1037", "4829-1037"],
  ["Código de verificación\n\n482910\n\nNo compartas este código con nadie.", "482910"],
  ["Tu código de un solo uso: 99AB12", "99AB12"],
  ["Hola Ana, tu código para entrar en la app es 0912. Caduca en 10 minutos.", "0912"],
  ["Tu código para autorizar la operación de 25,00 € en AMAZON es 482911", "482911"],
  ["Tu código de verificación es 482912, pedido 9999 enviado", "482912"],
  ["Tu código de\nverificación de Google es 482913", "482913"],
  ["Tu código es:\n**482914**\nNo lo compartas.", "482914"],
  ["Tus códigos de recuperación:\n\n4829 1037\n2210 9981", "2210 9981"],
  [
    "Hemos recibido una solicitud para acceder a tu cuenta de Google a través de tu dirección de correo. Tu código de verificación de Google es:"
      + "\n\n482915\n\nSi no has solicitado este código, es posible que otra persona esté intentando acceder a la cuenta.",
    "482915",
  ],
  ["TU CÓDIGO DE VERIFICACIÓN ES 482916", "482916"],
  ["Te envío el código 482919 para entrar", "482919"],
  ["Tu código es 482920, si no lo has pedido ignora este mensaje", "482920"],
  ["482921 es tu código; si no lo has pedido, no hagas nada", "482921"],
  ["PIN: 4821", "4821"],
  // English
  ["Your code is 123456", "123456"],
  ["Security code: 1234567", "1234567"],
  ["Your Apple Account code is: 123456", "123456"],
  ["Your Instagram code is 123 456", "123 456"],
  ["WhatsApp code 123-456", "123-456"],
  ["Your Uber code: 1234", "1234"],
  ["Use 8f3K2Q9 to sign in", "8f3K2Q9"],
  ["123456 is your verification code", "123456"],
  ["Your one-time passcode is 449302", "449302"],
  ["Your login code: 551203", "551203"],
  ["Enter 2FA code 612 908", "612 908"],
  ["Your verification code is\n\n882301\n\nIt expires in 10 minutes.", "882301"],
  ["Here is your GitHub launch code: 81726354", "81726354"],
  ["Your Amazon OTP is 129834", "129834"],
  ["FB-48291 is your Facebook confirmation code", "FB-48291"],
  ["Use verification code 4829 1037 to continue", "4829 1037"],
  ["Your Steam login code: F4J7K", "F4J7K"],
  ["Verification code: 2024", "2024"],
  ["To verify your email address, please use the following One Time Password (OTP):\n382910\nDo not share this OTP with anyone.", "382910"],
  ["Your code:\n482917 (valid for 10 minutes)", "482917"],
  ["Tu código de verificación de Booking.com es 482922", "482922"],
  ["Temporary password: tR7x9Kq2", "tR7x9Kq2"],
  ["Your Microsoft account security code is 4830", "4830"],
  ["Here is the sign-in code for your Microsoft account: 482925", "482925"],
  ["Código de verificación de tu cuenta: 482926", "482926"],
  ["¿Lo has pedido tú? No. Entonces ignora este código: 482927", "482927"],
  ["Your Apple Account code is: 482923. Don't share it with anyone.\n\nApple Inc. One Apple Park Way, Cupertino, CA 95014", "482923"],
  ["Your Zoom meeting starts soon. Meeting ID: 853 4829 1037 Passcode: 482924", "482924"],
  // French, German, Italian, Portuguese, Catalan
  ["Votre code de vérification est 384920", "384920"],
  ["Ihr Bestätigungscode lautet 571920", "571920"],
  ["Ihre mobileTAN lautet 482918", "482918"],
  ["Il tuo codice di verifica è 662019", "662019"],
  ["O seu código de verificação é 448201", "448201"],
  ["El teu codi de verificació és 330192", "330192"],
];

/** Texts whose numbers are not one-time codes: they must come out exactly as they went in. */
const NOT_CODES: string[] = [
  // Spanish
  "Tu código de pedido es 12345678",
  "Código postal: 28013",
  "Código de reserva: XK4P2Q",
  "Código de seguimiento: 4829103",
  "Usa el código de descuento VERANO25",
  "Usa el código AHORRA20 en tu próxima compra",
  "Factura nº 2026-0042",
  "Referencia: ABC123",
  "Tu localizador es KX92PQ",
  "Tu código caduca el 15/11/2026",
  "Código válido hasta 2026-11-20",
  "Tu código expira el 20.11.2026",
  "El código caduca a las 10:30",
  "Código enviado a las 10h30",
  "Tu código de verificación es para el cargo de 2500 €",
  "Código regalo de 1500 euros",
  "Si no pediste este código, llama al 900 123 456",
  "Código enviado al +34 600 111 222",
  "Te hemos enviado un código al 600111222",
  "Código IBAN: ES91 2100 0418 4502 0005 1332",
  "Tu código de 2025 ya no vale",
  "Código enviado a tu tarjeta terminada en 4821",
  "Tu número de pedido es 12345678 y tu código de cliente es 4821",
  "Tu vuelo IB3456 ha cambiado; código de reserva XK4P2Q",
  "Tu DNI 12345678Z se usó para iniciar sesión",
  "Tu código de invitación es FRIEND25",
  "Tu código de socio: 99812",
  "Número de confirmación: 48291037",
  "Hemos verificado tu pago de 1234 €",
  "El pedido 12345678 ya está en camino. Tu código de verificación llegará por SMS.",
  "Llámanos al 912345678 si no has pedido este código",
  "Código de barras: 8412345678905",
  "Inicia sesión antes del 15 de noviembre de 2026",
  "Si no has solicitado este código, ignora este correo\n\nGoogle LLC, 1600 Amphitheatre Parkway, Mountain View, CA 94043, USA",
  "Si no has solicitado este código ignora este correo\nGoogle LLC\n1600 Amphitheatre Parkway",
  "Tu código para la tarjeta *4821",
  "Has recibido 1000 tokens en tu cuenta",
  "Cuenta 48291037 verificada: ya puedes iniciar sesión",
  "Tu reserva Ref. 482910: inicia sesión para ver los detalles",
  "Pedido núm. 48291037. Tu código de verificación llegará por SMS.",
  "Newsletter de noviembre: 30% de descuento con el código NOV30 hasta el 30/11. Tel. 912 345 678",
  "Tu pedido nº 171-4829103-2210981 ha sido enviado. Importe: 45,90 €. Número de seguimiento: 1Z999AA10123456784",
  // English
  "Booking code ABC123",
  "Promo code SAVE2024 for 20% off",
  "Invoice INV-20260042 is attached",
  "Your code expires; you were charged $1234",
  "Call 1-800-555-0199 if you didn't request this code",
  "Zip code 94103",
  "Your card ending in 4821 needs a verification code",
  "Order #123456: your code is on its way",
  "Your referral code: ANA2024",
  "Gift card code 4829-1037-2210-9981",
  "Confirmation number: ABC123",
  "Your verification code was sent to +1 415 555 0199",
  "In order to sign in, use the code we sent to your phone ending in 4821",
  "We noticed a new sign-in to your account from Seattle, WA 98101",
  "Sign in to Office365 to see your code",
  "Your code expires in 10 minutes",
  "Use code AB20 for 20% off",
  "Your 2FA is now enabled for account 48291037",
  "Account no. 48291037: new sign-in",
  "Join Zoom Meeting: Meeting ID 853 4829 1037",
  // French, German, Italian
  "Code promo : ETE2024",
  "Ihr Code ist bis 2026 gültig",
  "Il codice postale è 00184",
];

test("hideCodes: the common shapes of a one-time code are hidden, in Spanish, English and five more languages", () => {
  assert.ok(CODES.length >= 40);
  for (const [text, code] of CODES) {
    const r = hideCodes(text);
    assert.ok(r.codes.includes(code), `${JSON.stringify(text)} gave ${JSON.stringify(r.codes)}`);
    assert.ok(!r.text.includes(code), `${JSON.stringify(text)} still shows the code: ${JSON.stringify(r.text)}`);
    assert.ok(r.text.includes(CODE_MARK));
    assert.equal(hideCodes(r.text).text, r.text, "looking again changes nothing");
  }
  assert.deepEqual(hideCodes("Tu código es 482910. Repito: 482910.").codes, ["482910"], "each code once");
  // A number kept to its own line before it does not hide the words above from a code alone on the next line.
  assert.deepEqual(hideCodes("Tu código de verificación\nAB12 Madrid\n582014").codes, ["582014"]);
  assert.equal(hideCodes("Your code is 123456").text, `Your code is ${CODE_MARK}`);
});

test("hideCodes: dates, times, amounts, phones, IBANs, years, postal codes and order, booking, invoice and offer numbers stay as they are", () => {
  assert.ok(NOT_CODES.length >= 40);
  for (const text of NOT_CODES) assert.deepEqual(hideCodes(text), { text, codes: [] }, JSON.stringify(text));
  // The mark's own word "código" does not make a number next to it look like a code.
  const marked = `Google: ${CODE_MARK}, y te quedan 4821 puntos`;
  assert.deepEqual(hideCodes(marked), { text: marked, codes: [] });
});

test("hideCodes: pairs of digits (48 29 10) and groups of capitals (ABCD-EFGH) are hidden next to a strong word, and only there", () => {
  for (const [text, code] of [
    ["Your verification code: 48 29 10", "48 29 10"],
    ["Inicio de sesión: 12 34 56 78", "12 34 56 78"],
    ["Your sign-in code is ABCD-EFGH", "ABCD-EFGH"],
    ["Here is your magic link code ABCD-EFGH", "ABCD-EFGH"],
    ["Código de verificación: QWER-TYUI-ZXCV", "QWER-TYUI-ZXCV"],
  ] as const) {
    const r = hideCodes(text);
    assert.deepEqual(r.codes, [code], text);
    assert.ok(!r.text.includes(code) && r.text.includes(CODE_MARK), r.text);
    assert.equal(hideCodes(r.text).text, r.text, "looking again changes nothing");
  }
  for (const text of [
    "Enter this code to continue: 48 29 10", // a generic word alone is not enough for these shapes
    "Order ABCD-EFGH shipped",
    "VERIFY YOUR ONE-TIME CODE",
    "Enter your PASS-CODE at sign-in",
    "Code de vérification envoyé au 06 12 34 56 78",
    "Verification code sent to 600 11 22 33",
    "Sign-in on 12 05 2026 from Madrid",
    "Verification: ticket ABCD-EFGH",
  ]) assert.deepEqual(hideCodes(text), { text, codes: [] }, text);
});

test("hideCodes: a hostile text cannot hold the server up (linear in its length)", () => {
  const hostile = [
    "code 1234 ".repeat(1200), "1".repeat(12_000), "a1".repeat(6000), "1 ".repeat(6000), "código ".repeat(2000), "123 456 ".repeat(1500),
    "pedido code verify 12345 ".repeat(500), "G-12345 ".repeat(1500), "A1B2C3D4 ".repeat(1300), "Tu código es:\n\n482910\n\n".repeat(600),
    "\n".repeat(12_000), `${"x".repeat(59)}\n1234 `.repeat(190), "**1234** code ".repeat(800),
    "nº. núm. ref. tel. 1234. ".repeat(480), "cuenta 1234 account no. 5678 ".repeat(400), "id id id id id id 1234 ".repeat(500),
  ];
  const t0 = Date.now();
  for (const h of hostile) hideCodes(h);
  // About 0.2 s on a laptop; the margin is for a busy CI machine.
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
});

// ---------- the store ----------

/** A store in memory, as Render's: `fail` makes reads or writes of the codes' key fail (the store down). */
function memKv(fail: { get?: boolean; set?: boolean } = {}) {
  const m = new Map<string, string>();
  const ttl = new Map<string, number>();
  const kv: Kv = {
    get: async (k) => {
      if (fail.get && k === "assistant-mail-codes") throw new Error("store down");
      return m.get(k) ?? null;
    },
    set: async (k, v, s) => {
      if (fail.set && k === "assistant-mail-codes") throw new Error("store down");
      m.set(k, v);
      ttl.set(k, s);
    },
  };
  return { kv, m, ttl, fail };
}

test("code store: kept 30 minutes and through a restart; one email's codes once; at most 10 emails and 5 codes each; a failing store is an error", async () => {
  const t = Date.parse("2026-11-15T10:00:00Z");
  const s = memKv();
  const vault = createCodeVault(s.kv);
  await vault.add({ id: "a", at: t, from: "Google", subject: "s", codes: ["111111"] }, t);
  await vault.add({ id: "a", at: t, from: "Google", subject: "s", codes: ["111111", "222222"] }, t + 1000);
  assert.deepEqual((await vault.recent(t + 60_000)).map((x) => [x.id, x.codes]), [["a", ["111111", "222222"]]], "delivered twice: kept once, codes joined");
  assert.equal(s.ttl.get("assistant-mail-codes"), 1799, "the store forgets the record when its newest code is due");
  const one = createCodeVault(memKv().kv);
  await one.add({ id: "g", at: t, from: "Google", subject: "", codes: ["G-482910", "123 456"] }, t);
  await one.add({ id: "g", at: t, from: "Google", subject: "", codes: ["482910", "123456", "G-482911"] }, t);
  assert.deepEqual((await one.recent(t))[0]!.codes, ["482910", "123456", "G-482911"], "one code once, in its shortest form (as it is typed)");
  assert.deepEqual((await createCodeVault(s.kv).recent(t + 60_000)).map((x) => x.id), ["a"], "a restart keeps them");
  assert.deepEqual(await vault.recent(t + CODE_KEEP_MS), [], "gone after 30 minutes");
  await vault.add({ id: "old", at: t - CODE_KEEP_MS, from: "x", subject: "", codes: ["333333"] }, t);
  assert.deepEqual((await vault.recent(t)).map((x) => x.id), ["a"]);
  assert.ok(!s.m.get("assistant-mail-codes")!.includes("333333"), "a code already past its time is not even written");

  for (let i = 0; i < 12; i++) await vault.add({ id: `m${i}`, at: t + i, from: `s${i}`, subject: "", codes: ["1", "2", "3", "4", "5", "6"].map((c) => c + i) }, t + 20);
  const kept = await vault.recent(t + 20);
  assert.equal(kept.length, 10);
  assert.equal(kept[0]!.id, "m11", "newest first");
  assert.equal(kept[0]!.codes.length, 5);

  const down = memKv({ set: true });
  const broken = createCodeVault(down.kv);
  await assert.rejects(() => broken.add({ id: "b", at: t, from: "x", subject: "", codes: ["444444"] }, t), /store down/);
  down.fail.set = false;
  assert.deepEqual(await broken.recent(t), [], "nothing half kept");
  const unreadable = memKv({ get: true });
  await assert.rejects(() => createCodeVault(unreadable.kv).recent(t), /store down/);
  const garbled = memKv();
  garbled.m.set("assistant-mail-codes", "{not json");
  const keep = console.error;
  console.error = () => undefined;
  try {
    assert.deepEqual(await createCodeVault(garbled.kv).recent(t), []);
  } finally {
    console.error = keep;
  }
});

// ---------- an email with a code, through the server ----------

const SECRET = `whsec_${Buffer.from("a-test-signing-key-0123456789").toString("base64")}`;
const svix = (id: string, ts: number, body: string) => `v1,${createHmac("sha256", Buffer.from(SECRET.slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64")}`;
const CONFIG: MailConfig = { apiKey: "am_test_key_0123456789", inbox: "pako@agentmail.to", webhookSecret: SECRET, pollMinutes: 0, workDomains: [], vip: [] };
const OWNER = "+34600111222";
const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};
const GOOGLE = "Google <no-reply@accounts.google.com>";
const SUBJECT = "G-583014 es tu código de verificación de Google";
const BODY = "Hola:\n\nTu código de verificación de Google es:\n\n583014\n\nSi no has solicitado este código, ignora este mensaje.";
let n = 0;

/** The door, the mail and the store wired as src/app.ts wires them, on one clock, with stand-ins for Meta (and Telegram when asked). */
async function rig(o: { showCodes?: boolean; kv?: Kv; telegram?: TelegramDoor } = {}) {
  const clock = { now: Date.parse("2026-11-15T10:00:00Z") };
  const kv = o.kv ?? memKv().kv;
  const control = createControl(kv, () => clock.now);
  const box = createMailbox(kv, o.showCodes ? { showCodes: true } : {});
  const sent: Record<string, any>[] = [];
  const meta = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.body) sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200 });
  }) as typeof fetch;
  const memory = loadMemory(null);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => [], callContact: async () => ({ ok: true, text: "started" }), lookupCall: async () => "ok" } });
  const config = loadWhatsappConfig(ENV, OWNER).config!;
  const app = express();
  const timeZone = "Europe/Madrid";
  const door = mountWhatsapp(app, {
    config, tools, memory, kv, control, ownerName: "Marta", timeZone, contacts: () => [], fetch: meta, now: () => clock.now,
    ...(o.telegram ? { telegram: o.telegram } : {}),
    mail: {
      address: CONFIG.inbox,
      recent: () => box.recent(timeZone, clock.now),
      annotate: (id, kind, summary) => box.annotate(id, kind, summary, clock.now),
      digest: () => box.digest(timeZone, clock.now),
    },
    codes: { recent: () => box.codes(clock.now) },
  });
  // AgentMail is never asked anything: the events carry the inbox and the body.
  const noNetwork = (async () => {
    throw new Error("no network in this test");
  }) as typeof fetch;
  mountMail(app, { config: o.showCodes ? { ...CONFIG, showCodes: true } : CONFIG, box, control, now: () => clock.now, fetch: noNetwork, enqueue: (m) => door.inbox.add(m) });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const email = (id: string, fields: Record<string, unknown> = {}) => {
    const body = JSON.stringify({
      type: "event",
      event_type: "message.received",
      event_id: `evt_${id}`,
      message: { inbox_id: CONFIG.inbox, message_id: id, labels: ["received"], to: [CONFIG.inbox], from: GOOGLE, timestamp: new Date(clock.now).toISOString(), subject: SUBJECT, text: BODY, ...fields },
    });
    const sid = `msg_${++n}`;
    const ts = Math.floor(clock.now / 1000);
    return fetch(`${base}/email/webhook`, { method: "POST", headers: { "content-type": "application/json", "svix-id": sid, "svix-timestamp": String(ts), "svix-signature": svix(sid, ts, body) }, body });
  };
  /** The owner writes on WhatsApp (a signed Meta webhook). */
  const say = (text: string) => {
    const raw = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: config.phoneNumberId }, messages: [{ from: "34600111222", id: `wamid.${++n}`, timestamp: "1", type: "text", text: { body: text } }] } }] }],
    });
    return fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}` }, body: raw });
  };
  const bridge = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${config.bridgeToken}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const texts = () => sent.filter((s) => s.type === "text").map((s) => String(s.text.body));
  /** Everything the server shows or passes on, as text: what the Mac gets, its context, MAIL, the panel's list and the action log. */
  const everywhere = async (): Promise<string> => {
    await say("correo");
    return JSON.stringify([
      await (await bridge("/assistant/inbox")).json(),
      await (await bridge("/assistant/context")).json(),
      texts().at(-1),
      await box.items(),
      await control.recent(100),
    ]);
  };
  return { clock, box, control, door, sent, email, say, bridge, texts, everywhere, close: () => { server.close(); server.closeAllConnections(); } };
}

test("an email with a code: the Mac, its context, MAIL, the panel and the log never see the code; CODE shows it, logged without it; 30 minutes later it is gone", async () => {
  const r = await rig();
  try {
    assert.deepEqual(await (await r.email("<g1@google.com>")).json(), { ok: true, result: "queued" });
    assert.equal((await r.email("<g1@google.com>")).status, 200, "AgentMail delivers it again");
    const seen = await r.everywhere();
    assert.ok(!seen.includes("583014"), seen);
    assert.ok(seen.includes(CODE_MARK), "the place of the code is marked");
    const [m] = (await (await r.bridge("/assistant/inbox")).json()).messages as { email: { subject: string; text: string } }[];
    assert.equal(m!.email.subject, `${CODE_MARK} es tu código de verificación de Google`);
    assert.match(m!.email.text, /es:\n\n\[code hidden · type CODE\]\n\nSi no has solicitado/);

    r.clock.now += 3 * 60_000;
    await r.say("Code");
    assert.equal(r.texts().at(-1), `🔑 Code from ${GOOGLE} (3 min ago): 583014`);
    const log = (await r.control.recent(100)).map((l) => l.text);
    assert.equal(log.at(-1), `Code shown (email from ${GOOGLE})`);
    assert.ok(!JSON.stringify(log).includes("583014"), "the log says a code was shown, never which");
    assert.equal((await r.door.inbox.peek()).filter((x) => x.text === "Code").length, 0, "a command, not a message for the assistant");

    await r.say("CODES");
    assert.match(r.texts().at(-1)!, /^🔑 Code from .*: 583014$/, "it stays until its time is up");
    r.clock.now += 27 * 60_000;
    await r.say("codes");
    assert.equal(r.texts().at(-1), "I have no codes from the last 30 minutes.");
  } finally {
    r.close();
  }
});

test("the same email twice at once (the webhook and the listing): queued once, its code kept once", async () => {
  const r = await rig();
  try {
    const both = await Promise.all([r.email("<g7@google.com>"), r.email("<g7@google.com>")]);
    assert.deepEqual((await Promise.all(both.map(async (x) => ((await x.json()) as { result: string }).result))).sort(), ["queued", "seen"]);
    assert.equal((await r.door.inbox.peek()).length, 1);
    await r.say("code");
    assert.equal(r.texts().at(-1), `🔑 Code from ${GOOGLE} (just now): 583014`);
  } finally {
    r.close();
  }
});

test("CODE with the store full: the newest 10 emails, 5 codes each at most, in one message within WhatsApp's 4096 characters", async () => {
  const r = await rig();
  try {
    const from = `${"Un remitente con un nombre larguísimo ".repeat(8)}<no-reply@example.com>`;
    const body = "Códigos de verificación: 1111110, 2222220, 3333330, 4444440, 5555550 y 6666660.";
    for (let i = 0; i < 11; i++) {
      r.clock.now += 1000;
      assert.deepEqual(await (await r.email(`<c${i}@example.com>`, { from, subject: `Tu código es ${700000 + i}`, text: body })).json(), { ok: true, result: "queued" });
    }
    const before = r.texts().length;
    await r.say("CODE");
    assert.equal(r.texts().length, before + 1, "one message");
    const answer = r.texts().at(-1)!;
    assert.ok(answer.length <= 4096, `${answer.length} characters`);
    const lines = answer.split("\n");
    assert.equal(lines.length, 10);
    assert.match(lines[0]!, /: 700010, 1111110, 2222220, 3333330, 4444440$/, "newest first, five codes");
    assert.ok(!answer.includes("700000"), "the oldest email is gone");
  } finally {
    r.close();
  }
});

test("a code the Mac's summary restates is stored hidden, and CODE shows it with the email's own", async () => {
  const r = await rig();
  try {
    await r.email("<g2@google.com>", { subject: "Tu código de Google", text: "Usa 583014 para iniciar sesión." });
    const ok = await r.bridge("/assistant/mail-summary", { id: "mail:<g2@google.com>", notify: true, summary: "Google te manda el código 905172 para entrar." });
    assert.deepEqual(await ok.json(), { ok: true });
    const seen = await r.everywhere();
    assert.ok(!seen.includes("905172") && !seen.includes("583014"), seen);
    assert.equal((await r.box.items())[0]!.summary, `Google te manda el código ${CODE_MARK} para entrar.`);
    await r.say("CODE");
    assert.equal(r.texts().at(-1), `🔑 Code from ${GOOGLE} (just now): 583014, 905172`);
  } finally {
    r.close();
  }
});

test("mail kept before codes were hidden: its codes are hidden as it is read back, for MAIL, the panel and the Mac's context", async () => {
  const s = memKv();
  const at = Date.parse("2026-11-15T09:50:00Z");
  const old = {
    id: "<old@google.com>",
    at,
    from: GOOGLE,
    subject: "G-771204 es tu código de verificación de Google",
    preview: "Tu código de verificación es 771204",
    kind: "aviso",
    summary: "Google te manda el código 771204 para entrar.",
  };
  s.m.set("assistant-mail", JSON.stringify({ seen: [old.id], primed: true, recent: [old] }));
  const box = createMailbox(s.kv);
  const now = at + 60_000;
  const seen = JSON.stringify([await box.items(), await box.recent("Europe/Madrid", now), await box.digest("Europe/Madrid", now)]);
  assert.ok(!seen.includes("771204") && seen.includes(CODE_MARK), seen);
  assert.deepEqual(await box.codes(now), [], "an old code is only hidden: it is not kept for CODE");
  assert.equal((await createMailbox(s.kv, { showCodes: true }).items())[0]!.summary, old.summary, "MAIL_SHOW_CODES=1 leaves it as it was");
});

test("MAIL_SHOW_CODES=1 keeps the codes in the emails' words, as before; CODE still lists them", async () => {
  assert.equal(loadMailConfig({ AGENTMAIL_API_KEY: CONFIG.apiKey, AGENTMAIL_INBOX: CONFIG.inbox, AGENTMAIL_WEBHOOK_SECRET: SECRET }).config?.showCodes, false);
  const env = { AGENTMAIL_API_KEY: CONFIG.apiKey, AGENTMAIL_INBOX: CONFIG.inbox, AGENTMAIL_WEBHOOK_SECRET: SECRET, MAIL_SHOW_CODES: "1" };
  assert.equal(loadMailConfig(env).config?.showCodes, true);
  assert.equal(loadMailConfig({ ...env, MAIL_SHOW_CODES: "true" }).config?.showCodes, false, "only 1 shows them: a mistyped value keeps them hidden");
  const r = await rig({ showCodes: true });
  try {
    await r.email("<g3@google.com>");
    const [m] = (await (await r.bridge("/assistant/inbox")).json()).messages as { email: { subject: string; text: string } }[];
    assert.equal(m!.email.subject, SUBJECT);
    assert.equal(m!.email.text, BODY);
    await r.bridge("/assistant/mail-summary", { id: "mail:<g3@google.com>", notify: true, summary: "Tu código de Google es 583014." });
    assert.equal((await r.box.items())[0]!.summary, "Tu código de Google es 583014.");
    await r.say("code");
    assert.equal(r.texts().at(-1), `🔑 Code from ${GOOGLE} (just now): 583014`);
  } finally {
    r.close();
  }
});

test("the store failing: the email waits for AgentMail's retry and nothing shows its code; a store that cannot be read is said plainly", async () => {
  const s = memKv({ set: true });
  const r = await rig({ kv: s.kv });
  const keep = console.error;
  console.error = () => undefined;
  try {
    assert.equal((await r.email("<g4@google.com>")).status, 503, "not passed on without its code kept");
    assert.deepEqual(await r.door.inbox.peek(), []);
    assert.deepEqual(await r.box.items(), []);
    s.fail.set = false;
    assert.deepEqual(await (await r.email("<g4@google.com>")).json(), { ok: true, result: "queued" });
    await r.say("code");
    assert.match(r.texts().at(-1)!, /: 583014$/);
  } finally {
    console.error = keep;
    r.close();
  }
  const down = await rig({ kv: memKv({ get: true }).kv });
  console.error = () => undefined;
  try {
    await down.say("code");
    assert.equal(down.texts().at(-1), "I couldn't read the codes right now. Try again in a moment.");
  } finally {
    console.error = keep;
    down.close();
  }
});

test("CODE works while Pako is paused, and on Telegram the answer goes back to Telegram", async () => {
  const tg: Record<string, any>[] = [];
  const telegram: TelegramDoor = {
    paired: async () => true,
    reachable: async () => true,
    deliver: async (body) => (tg.push(body), true),
    pairLink: async () => null,
    unpair: async () => true,
    farewell: async () => undefined,
    media: async () => null,
  };
  const r = await rig({ telegram });
  try {
    await r.email("<g5@google.com>");
    await r.say("STOP");
    assert.match(r.texts().at(-1)!, /Stopped/);
    await r.say("code");
    assert.match(r.texts().at(-1)!, /^🔑 Code from .*: 583014$/, "reading the owner's own code is not an action STOP holds");
    const before = r.sent.length;
    assert.equal(await r.door.ingest({ from: r.door.ownerFrom, id: "tg-1", type: "text", text: { body: "CODE" } }, "telegram"), "codes shown");
    assert.equal(r.sent.length, before, "nothing on WhatsApp");
    assert.match(String(tg.at(-1)?.text?.body), /^🔑 Code from .*: 583014$/);
  } finally {
    r.close();
  }
});

test("local mode end to end (src/app.ts): an email with a code reaches the panel and the Mac hidden, and CODE in the panel's chat shows it", async () => {
  const home = loadHome({ PAKO_HOME: join(mkdtempSync(join(tmpdir(), "pako-codes-")), "home"), PAKO_NAME: "Ana" });
  const env: Record<string, string | undefined> = {
    ...localEnv({}, home, 0),
    PAKO_HOME: home.dir,
    AGENTMAIL_API_KEY: CONFIG.apiKey,
    AGENTMAIL_INBOX: CONFIG.inbox,
    AGENTMAIL_WEBHOOK_SECRET: SECRET,
    AGENTMAIL_POLL_MINUTES: "0",
  };
  const kv = sqliteKv(home.dir);
  const local: LocalContext = { kv, channel: createLocalChannel({ kv }), bridgeToken: home.bridgeToken, panelSecret: home.panelSecret, bridge: { status: () => ({ claude: "ok", running: true }) } };
  const keep = console.log;
  console.log = () => undefined;
  const app = createApp(loadAppConfig(env), env, local);
  console.log = keep;
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch((app.locals.panelLink as () => string)().replace(/^http:\/\/127\.0\.0\.1:\d+/, base), { redirect: "manual" });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const api = (path: string, body?: unknown) =>
      fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: { cookie, "x-pako": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const body = JSON.stringify({
      type: "event",
      event_type: "message.received",
      message: { inbox_id: CONFIG.inbox, message_id: "<g6@google.com>", labels: ["received"], from: GOOGLE, timestamp: new Date().toISOString(), subject: SUBJECT, text: BODY },
    });
    const ts = Math.floor(Date.now() / 1000);
    const hook = await fetch(`${base}/email/webhook`, { method: "POST", headers: { "content-type": "application/json", "svix-id": "msg_local", "svix-timestamp": String(ts), "svix-signature": svix("msg_local", ts, body) }, body });
    assert.deepEqual(await hook.json(), { ok: true, result: "queued" });
    const overview = JSON.stringify(await (await api("/panel/api/overview")).json());
    const inbox = JSON.stringify(await (await fetch(`${base}/assistant/inbox`, { headers: { authorization: `Bearer ${home.bridgeToken}` } })).json());
    assert.ok(overview.includes(CODE_MARK) && !overview.includes("583014"), overview);
    assert.ok(inbox.includes(CODE_MARK) && !inbox.includes("583014"), inbox);

    assert.equal((await api("/panel/api/chat", { text: "CODE" })).status, 202);
    let last = "";
    // The panel's chat hands the message to the door in the background: asked again until the answer is there (a busy machine is slower).
    for (let i = 0; i < 200 && !last.startsWith("🔑"); i++) {
      await sleep(25);
      last = ((await (await api("/panel/api/chat?since=0")).json()) as { messages: { text: string }[] }).messages.at(-1)!.text;
    }
    assert.equal(last, `🔑 Code from ${GOOGLE} (just now): 583014`);
    // The chat keeps it marked secret: the export leaves it out (src/data.ts).
    const kept = JSON.parse((await kv.get("pako-local-chat"))!) as { text: string; secret?: boolean }[];
    assert.equal(kept.find((m) => m.text.startsWith("🔑"))?.secret, true);
    const exported = await (await api("/panel/api/export")).text();
    assert.ok(!exported.includes("583014"), exported);
    const after = JSON.stringify(((await (await api("/panel/api/overview")).json()) as { log: unknown[] }).log);
    assert.ok(after.includes("Code shown (email from") && !after.includes("583014"), after);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
