// What the door bug hunt found, each held in place: a typed yes answers only the last card Pako sent, an email card shows what will be sent, DRAFT
// leaves the assistant's requests to it, a text is never cut in half an emoji, an answer sent twice at once is done once, a delivered reminder never
// comes again, a press that failed is handled when Meta sends it again, an older call card says it expired, a late answer is not cut, and
// WhatsApp's marks leave code and sums alone.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import type { Kv } from "../src/kv.ts";
import { waLink } from "../src/links.ts";
import * as shared from "../src/door/shared.ts";
import { callWords, cleanCallMessage, loadWhatsappConfig, mountWhatsapp, plainWhatsapp, type WhatsappDeps } from "../src/whatsapp.ts";
import { loadMemory } from "../src/voice-memory.ts";
import { loadVoiceTools } from "../src/voice-tools.ts";
import { eventually } from "./helpers/wait.ts";

const OWNER = "+34600111222";
const OWNER_WA = "34600111222";
const ENV = {
  WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
  WHATSAPP_PHONE_NUMBER_ID: "109876543210",
  WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef",
  WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
};
const ANA = { name: "Ana", number: "+34 600 999 888" };
let n = 0;

function memKv(): Kv {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v), del: async (k: string) => void m.delete(k) } as unknown as Kv;
}

interface RigOptions {
  kv?: Kv | null;
  extra?: Partial<WhatsappDeps>;
  env?: Record<string, string>;
  start?: number;
  /** Called before each message to Meta; a rejected one is answered with an error from Meta. */
  beforeSend?: (body: any) => Promise<unknown>;
  refuse?: (body: any) => boolean;
}

async function rig(o: RigOptions = {}) {
  const sent: { body: any }[] = [];
  const calls: any[] = [];
  const arrived = { replies: 0 };
  const clock = { now: o.start ?? Date.parse("2026-11-14T12:00:00Z") };
  const memory = loadMemory(null);
  const tools = loadVoiceTools({ memory, actions: { contacts: () => ["Ana", "Luis"], callContact: async (a: any) => { calls.push(a); return { ok: true, text: "started" }; }, lookupCall: async () => "ok" } } as any);
  const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.body === undefined) return new Response("no", { status: 500 });
    const body = JSON.parse(String(init.body));
    await o.beforeSend?.(body);
    if (o.refuse?.(body)) return new Response(JSON.stringify({ error: { code: 131000, message: "refused" } }), { status: 400 });
    sent.push({ body });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out${sent.length}` }] }), { status: 200 });
  }) as typeof fetch;
  const config = loadWhatsappConfig({ ...ENV, ...(o.env ?? {}) }, OWNER).config!;
  const app = express();
  app.use((req, _res, next) => {
    if (req.path === "/assistant/reply") arrived.replies++;
    next();
  });
  const wa = mountWhatsapp(app, {
    config, tools, memory, kv: o.kv ?? null, ownerName: "Marta", timeZone: "Europe/Madrid", contacts: () => ["Ana", "Luis"],
    contactByName: (name: string) => (/^ana$/i.test(name) ? ANA : null), fetch: fake, now: () => clock.now, callCheckMs: 5, healthOnDisk: false, ...(o.extra ?? {}),
  } as any);
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const payload = (msgs: Record<string, unknown>[]) => ({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: config.phoneNumberId }, messages: msgs } }] }] });
  const text = (body: string) => ({ from: OWNER_WA, id: `wamid.hf${++n}`, timestamp: "1", type: "text", text: { body } });
  const press = (buttonId: string) => ({ from: OWNER_WA, id: `wamid.hp${++n}`, timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id: buttonId, title: "x" } } });
  const sign = (raw: string) => `sha256=${createHmac("sha256", config.appSecret).update(raw).digest("hex")}`;
  const hook = (body: unknown) => {
    const raw = JSON.stringify(body);
    return fetch(`${base}/whatsapp/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw) }, body: raw });
  };
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${config.bridgeToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const say = async (body: string) => {
    const m = text(body);
    await hook(payload([m]));
    return m;
  };
  const tap = async (id: string) => {
    const m = press(id);
    return { m, res: await hook(payload([m])) };
  };
  const texts = (from = 0) => sent.slice(from).filter((s) => s.body.type === "text").map((s) => String(s.body.text.body));
  /** The cards sent so far, each with its text and its buttons' ids. */
  const cards = (from = 0) => sent.slice(from).filter((s) => s.body.type === "interactive")
    .map((s) => ({ text: String(s.body.interactive.body.text), ids: s.body.interactive.action.buttons.map((b: any) => String(b.reply.id)) as string[] }));
  const inbox = async () => (await wa.inbox.peek()).map((m: any) => String(m.text));
  /** Whom calls were placed to. */
  const called = (): string[] => calls.map((c) => String(c.name));
  return { sent, called, clock, wa, hook, payload, text, press, post, say, tap, texts, cards, inbox, arrived, close: () => { server.close(); server.closeAllConnections(); } };
}

const ofCall = { text: "Ana pide que la llames.", notice: true, call: { name: "Ana", message: "llego tarde" } };

test("a typed yes answers only the card that is the last thing Pako sent: after a notice or another card it goes to the assistant, and the card's buttons still work", async () => {
  for (const kind of ["notice", "card"] as const) {
    const r = await rig();
    try {
      await r.say("hola");
      await r.post("/assistant/reply", ofCall);
      const callCard = r.cards().at(-1)!;
      assert.match(callCard.text, /I'll call Ana to tell them: llego tarde/);
      if (kind === "notice") await r.wa.notifyOwner("📧 Luis (work): can you confirm the budget is approved?");
      else await r.wa.sendCard("Did you send Luis the contract?", [{ id: "f1:0123456789", title: "Done" }, { id: "f4:0123456789", title: "Snooze" }]);
      await r.say("Yes");
      assert.deepEqual(r.called(), [], `a yes after ${kind === "notice" ? "a notice" : "another card"} is not about the call`);
      assert.ok((await r.inbox()).includes("Yes"), "it goes on to the assistant like any message");
      await r.tap(callCard.ids[0]!);
      assert.deepEqual(r.called(), ["Ana"], "its Call button still places it");
    } finally {
      r.close();
    }
  }
  // Nothing after the card: the very next yes places it, as before.
  const r = await rig();
  try {
    await r.say("hola");
    await r.post("/assistant/reply", ofCall);
    await r.say("Yes");
    assert.deepEqual(r.called(), ["Ana"]);
  } finally {
    r.close();
  }
});

test("a typed yes to a message for a friend is the same: a notice after its card makes it about the notice, and its button still sends", async () => {
  const r = await rig({ env: { WHATSAPP_FRIEND_MESSAGES: "1" } });
  try {
    await r.say("hola");
    await r.post("/assistant/reply", { text: "Ana pregunta si vas.", notice: true, send: { to: "Ana", text: "Sí, voy el viernes" } });
    const card = r.cards().at(-1)!;
    assert.match(card.text, /I'll write to Ana from my number/);
    await r.wa.notifyOwner("📧 Luis (work): can you confirm the budget is approved?");
    const toFriends = () => r.sent.filter((s) => s.body.to !== OWNER_WA);
    await r.say("Yes");
    assert.deepEqual(toFriends(), [], "nothing went to Ana");
    await r.tap(card.ids[0]!);
    assert.equal(toFriends().length, 1, "its Send button still sends");
  } finally {
    r.close();
  }
});

test("a card WhatsApp refuses was never shown: it does not take the typed yes away from the card before it", async () => {
  let refuseNext = false;
  const r = await rig({ refuse: (b) => refuseNext && b.type === "interactive" && /Did you send/.test(String(b.interactive.body.text)) });
  try {
    await r.say("hola");
    await r.post("/assistant/reply", ofCall);
    refuseNext = true;
    assert.equal(await r.wa.sendCard("Did you send Luis the contract?", [{ id: "f1:0123456789", title: "Done" }, { id: "f4:0123456789", title: "Snooze" }]), false);
    await r.say("yes");
    assert.deepEqual(r.called(), ["Ana"]);
  } finally {
    r.close();
  }
});

/** A text with no half of an emoji in it. */
const wellFormed = (s: string): boolean => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

/** An email Pako is asked to write because an email asked for it: always a card first (the turn read outside text). */
const emailAsk = (text: string) => ({ text: "Luis pide respuesta.", notice: true, email: { to: "luis@example.com", subject: "Re: hola", text } });
const mailRig = async () => {
  const mails: any[] = [];
  const r = await rig({ extra: { sendEmail: async (e: any) => void mails.push(e), contactEmails: () => [] } as Partial<WhatsappDeps> });
  return { r, mails };
};

test("an email card shows all of what Send sends: a long text comes whole just before the card, a short one is on the card", async () => {
  const { r, mails } = await mailRig();
  try {
    await r.say("hola");
    const long = `Hola Luis, gracias por tu correo. ${"Todo bien por aquí, hablamos pronto. ".repeat(40)}\n\nPD: el jueves no hay nadie en casa.`;
    assert.ok(long.length > 1200 && long.length < 3000);
    const before = r.sent.length;
    await r.post("/assistant/reply", emailAsk(long));
    const after = r.sent.slice(before).filter((s) => s.body.type !== "interactive" || /luis@example\.com/.test(s.body.interactive.body.text));
    const card = r.cards(before).at(-1)!;
    assert.equal(r.texts(before).filter((t) => t !== "Luis pide respuesta.").join("\n"), long.trim(), "the whole text, as it will be sent, is shown");
    assert.equal(after.at(-1)!.body.type, "interactive", "and the card is the last thing, so it is the one a yes would answer");
    assert.match(card.text, /whole text is in the message just above/);
    assert.ok(!card.text.includes("PD:"), "the card does not repeat it, cut");
    await r.tap(card.ids[0]!);
    assert.equal(mails.length, 1);
    assert.ok(mails[0].text.endsWith(long.trim()), "the email is that text");
  } finally {
    r.close();
  }
  const short = await mailRig();
  try {
    await short.r.say("hola");
    const before = short.r.sent.length;
    await short.r.post("/assistant/reply", emailAsk("Hola Luis, mañana a las 10 me va bien."));
    assert.deepEqual(short.r.texts(before), ["Luis pide respuesta."], "a short one needs no message of its own");
    assert.match(short.r.cards(before).at(-1)!.text, /Hola Luis, mañana a las 10 me va bien\./);
  } finally {
    short.r.close();
  }
});

/** A follow-ups engine that knows two follow-ups, which is all DRAFT reads: "contract" is one of them, "omar" is both, anything else none. */
const followupsFor = (drafted: string[]): Partial<WhatsappDeps> => {
  const forDraft = async (words: string) => {
    if (words === "" || /omar/.test(words)) return { many: ["Send Omar the contract", "Book the call with Omar"] };
    if (/contract/.test(words)) return { loop: { id: "d1", title: "Send Omar the contract", who: "", where: { label: "email" }, sources: [] } };
    return { none: true as const };
  };
  return {
    followups: { forDraft, draftFacts: () => [], command: async () => "", context: async () => [] },
    draftFor: async (o: { title: string }) => (drafted.push(o.title), { status: "ok" }),
  } as unknown as Partial<WhatsappDeps>;
};

test("DRAFT with words takes the message only when they match exactly one open follow-up; otherwise it is the assistant's request", async () => {
  const drafted: string[] = [];
  const r = await rig({ kv: memKv(), extra: followupsFor(drafted) });
  try {
    for (const words of ["Draft an email to Ana about Friday's dinner", "draft a tweet announcing the launch", "draft reply to Omar"]) {
      const before = r.sent.length;
      await r.say(words);
      assert.deepEqual(r.texts(before), [], `"${words}" is not answered by the door`);
      assert.ok((await r.inbox()).includes(words), `"${words}" reached the assistant`);
    }
    assert.deepEqual(drafted, []);
    const before = r.sent.length;
    await r.say("draft the contract");
    assert.deepEqual(drafted, ["Send Omar the contract"], "one match: the command's own draft");
    assert.match(r.texts(before).join("\n"), /Writing a draft for “Send Omar the contract”/);
    const b2 = r.sent.length;
    await r.say("draft");
    assert.match(r.texts(b2).join("\n"), /Which one\?/, "DRAFT alone is only this command: it says which");
  } finally {
    r.close();
  }
});

test("a text is cut at a whole character: never in the middle of an emoji, and a link made of one cannot throw", async () => {
  assert.equal(shared.cut("a".repeat(5) + "😀", 6), "a".repeat(5), "the cut would fall inside the emoji");
  assert.equal(shared.cut("a".repeat(4) + "😀", 6), `${"a".repeat(4)}😀`, "an emoji that fits stays");
  assert.equal(shared.cut("abc", 10), "abc");
  assert.ok(wellFormed(shared.cut("😀".repeat(10), 7)));
  assert.doesNotThrow(() => waLink("34600111222", `${"a".repeat(699)}\uD83D`), "half an emoji is dropped from a link");
  assert.equal(decodeURIComponent(waLink("34600111222", `x\uD83Dy\uDE00z`).split("text=")[1]!), "xyz");
  const r = await rig();
  try {
    const m = await r.say("Prepárame un mensaje para Ana");
    const res = await r.post("/assistant/reply", { text: "Aquí tienes el mensaje para Ana.", key: m.id, message: { to: "Ana", text: `${"a".repeat(699)}😀 nos vemos` } });
    assert.equal(res.status, 200, "no 503 for the bridge to repeat the answer's text because of the link");
    assert.equal(r.texts().filter((t) => t === "Aquí tienes el mensaje para Ana.").length, 1);
    const link = r.texts().find((t) => t.includes("https://wa.me/34600999888?text="));
    assert.ok(link, "the link reached the owner");
    assert.ok(wellFormed(decodeURIComponent(link.split("text=")[1]!)));
    // A reminder's words, cut at 200.
    await r.post("/assistant/reply", { text: "Hecho.", remind: [{ at: "2026-11-15 09:00", text: `${"b".repeat(199)}😀 y más` }] });
    const kept = (await r.wa.reminders()).map((x: any) => String(x.text));
    assert.deepEqual(kept.map((t) => t.length), [199]);
    assert.ok(kept.every(wellFormed));
  } finally {
    r.close();
  }
});

test("an answer the bridge sends again while the first is still being handled is done once: the copy waits for it", async () => {
  let entered = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const r = await rig({ beforeSend: async (b) => { if (b.type === "text") { entered++; await gate; } } });
  try {
    const m = await r.say("Recuérdame mañana a las 9 llamar al banco y apunta leche en la compra");
    const body = { text: "Hecho.", key: m.id, lists: [{ name: "compra", op: "add", items: ["leche"] }], call: { name: "Ana", message: "llego tarde" } };
    const before = r.sent.length;
    const first = r.post("/assistant/reply", body);
    await eventually(() => entered === 1);
    const copy = r.post("/assistant/reply", body);
    await eventually(() => r.arrived.replies === 2, { then: 60 });
    release();
    const [a, b] = await Promise.all([first, copy]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(await b.json(), { ok: true, repeated: true });
    assert.equal(r.texts(before).filter((t) => t === "Hecho.").length, 1, "the text once");
    assert.equal(r.cards(before).filter((c) => /I'll call Ana/.test(c.text)).length, 1, "one card to confirm the call");
    assert.equal(r.cards(before).filter((c) => /compra/.test(c.text)).length, 1, "one receipt for the list");
  } finally {
    release();
    r.close();
  }
});

test("held reminders given one by one: one that went is not in the store when the next card is refused, so a restart does not bring it again", async () => {
  const kv = memKv();
  let refuse = false;
  const r = await rig({ kv, refuse: (b) => refuse && b.type === "interactive" && /second thing/.test(String(b.interactive.body.text)) });
  try {
    await r.say("hola");
    await r.post("/assistant/reply", { text: "ok", remind: [{ at: "2026-11-15 14:00", text: "first thing" }, { at: "2026-11-15 14:01", text: "second thing" }] });
    r.clock.now = Date.parse("2026-11-15T13:05:00Z"); // 14:05 in Madrid: WhatsApp's window is closed, so both wait for the owner's next message
    await r.wa.runReminders();
    assert.deepEqual((await r.wa.reminders()).map((x: any) => [x.text, x.held]), [["first thing", true], ["second thing", true]]);
    refuse = true;
    const before = r.sent.length;
    await r.say("buenas");
    assert.equal(r.cards(before).filter((c) => /first thing/.test(c.text)).length, 1, "the first came");
    const stored = JSON.parse((await kv.get("assistant-reminders"))!) as { text: string }[];
    assert.deepEqual(stored.map((x) => x.text), ["second thing"], "and is gone from the store");
  } finally {
    r.close();
  }
  // The server starts again on the same store.
  const again = await rig({ kv, start: Date.parse("2026-11-15T13:10:00Z") });
  try {
    await again.say("otra vez");
    const cards = again.cards().map((c) => c.text);
    assert.equal(cards.filter((c) => /first thing/.test(c)).length, 0, "the first one does not come again");
    assert.equal(cards.filter((c) => /second thing/.test(c)).length, 1, "the one that was refused does");
  } finally {
    again.close();
  }
});

test("a button press that fails once is handled when Meta delivers it again", async () => {
  let fails = 1;
  const done: string[] = [];
  const followups = { press: async (b: string, id: string) => { if (fails-- > 0) throw new Error("store down"); done.push(`${b}:${id}`); return "Done ✅"; }, command: async () => "", context: async () => [] };
  const r = await rig({ extra: { followups } as unknown as Partial<WhatsappDeps> });
  try {
    await r.say("hola");
    const press = r.press("f1:0123456789");
    const first = await r.hook(r.payload([press]));
    assert.equal(first.status, 500, "Meta is told it failed, so it delivers it again");
    const second = await r.hook(r.payload([press])); // the same press, the same message id
    assert.equal(second.status, 200);
    assert.deepEqual(done, ["1:0123456789"], "the retry was handled");
    assert.ok(r.texts().includes("Done ✅"));
    await r.hook(r.payload([press])); // and a third delivery of it is not
    assert.deepEqual(done, ["1:0123456789"]);
  } finally {
    r.close();
  }
});

test("Call on an older card after another call was staged says the card expired, never the words meant for the model, and calls nobody", async () => {
  const r = await rig();
  try {
    await r.say("hola");
    await r.post("/assistant/reply", ofCall);
    const older = r.cards().at(-1)!.ids[0]!;
    // The owner asks for another call in their own words: held for its window to undo, staged in the same slot.
    const m = await r.say("llama a Luis y dile que estoy de camino");
    await r.post("/assistant/reply", { text: "Vale.", key: m.id, call: { name: "Luis", message: "estoy de camino" } });
    assert.ok(r.cards().some((c) => /Calling Luis/.test(c.text)), "the second call is held");
    const before = r.sent.length;
    await r.tap(older);
    assert.deepEqual(r.texts(before), ["That has expired. Ask me again if you want me to do it."]);
    assert.deepEqual(r.called(), [], "nobody was called for the older card");
  } finally {
    r.close();
  }
});

test("a late answer is kept whole for the owner's next message, and a notice longer than any answer says it is cut", async () => {
  const r = await rig();
  try {
    const m = await r.say("Resume mis notas del proyecto");
    r.clock.now += 25 * 3600_000; // the computer slept through WhatsApp's 24 hours
    const long = Array.from({ length: 60 }, (_, i) => `Punto ${i + 1}: lorem ipsum dolor sit amet consectetur.`).join("\n");
    assert.ok(long.length > 2500);
    await r.post("/assistant/reply", { text: long, key: m.id });
    const before = r.sent.length;
    await r.say("hola");
    const got = r.texts(before).join("\n");
    assert.ok(got.includes("Punto 1:") && got.includes("Punto 60: lorem ipsum dolor sit amet consectetur."), "every point came");
    // Over what an answer can be (8000): kept up to a limit, with a mark where it stops.
    r.clock.now += 25 * 3600_000;
    await r.wa.notifyOwner("z".repeat(shared.HELD_TEXT_MAX + 500));
    const b2 = r.sent.length;
    await r.say("otra vez");
    const big = r.texts(b2).join("");
    assert.ok(big.includes("…") && big.length < shared.HELD_TEXT_MAX + 200 && big.includes("z".repeat(shared.HELD_TEXT_MAX - 1)), "cut, and says so");
  } finally {
    r.close();
  }
});

test("WhatsApp's marks leave code and sums alone: a ** is bold only as a pair that starts a word and touches its text", () => {
  assert.equal(plainWhatsapp("```\n# comment in code\n**kwargs\n```"), "```\n# comment in code\n**kwargs\n```");
  assert.equal(plainWhatsapp("Use `**kwargs` and `a ** b` here"), "Use `**kwargs` and `a ** b` here");
  assert.equal(plainWhatsapp("In Python: a**2 + b**2 == c**2"), "In Python: a**2 + b**2 == c**2");
  assert.equal(plainWhatsapp("2**10 is 1024 and 2**20 is 1048576"), "2**10 is 1024 and 2**20 is 1048576");
  assert.equal(plainWhatsapp("2 ** 3 ** 4"), "2 ** 3 ** 4");
  // What it is for still works, beside code.
  assert.equal(plainWhatsapp("**bold** and (**this**) and **two words**. Then `**x**`."), "*bold* and (*this*) and *two words*. Then `**x**`.");
  assert.equal(plainWhatsapp("# Plan\nSee [docs](https://a.example/b) and ~~old~~\n```\n# keep\n```\n## Next"), "Plan\nSee docs: https://a.example/b and ~old~\n```\n# keep\n```\nNext");
  assert.equal(plainWhatsapp("Use `real` and \uE0000\uE001 here"), "Use `real` and 0 here", "the marks that stand for code are not something a text can fake");
});

test("a call's words keep 'It's Marta's…' and 'Marta-Luisa': the owner's name is dropped only as the whole name after 'It's' or 'I'm'", () => {
  for (const kept of ["It's Marta's birthday tomorrow, don't forget", "I'm Marta-Luisa's friend and I'll be late", "This is Marta's new number, save it", "Soy Martina, llego tarde"]) {
    assert.equal(cleanCallMessage(kept, "Marta"), kept);
    assert.equal(callWords(kept, "Marta", false), kept);
  }
  assert.equal(cleanCallMessage("It's Marta. Running late", "Marta"), "Running late");
  assert.equal(cleanCallMessage("Soy Marta, llego tarde", "Marta"), "llego tarde");
  assert.equal(cleanCallMessage("I'm Marta - running late", "Marta"), "running late");
  assert.equal(callWords("Hi Ana, this is Marta. I'm Marta's sister-in-law *really* late", "Marta"), "I'm Marta's sister-in-law really late");
});
