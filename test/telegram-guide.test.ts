// Telegram in a few taps (src/telegram-panel.ts): the guide opens @BotFather with the exact /newbot steps, and a token pasted with `pair`
// is checked (getMe) and answered with the one-time pairing link at once, so the phone pairs with one tap. A fake channel: no Telegram.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mountTelegramPanel, type TelegramPanelDeps } from "../src/telegram-panel.ts";
import type { TelegramChannel } from "../src/telegram.ts";
import { serve } from "./helpers/connect-rig.ts";

const TOKEN = `123456789:${"A".repeat(35)}`;

test("the guide gives the BotFather link and the /newbot steps, and a token pasted with pair comes back with the pairing link", async () => {
  let current: TelegramChannel | null = null;
  const candidate = {
    check: async () => ({ ok: true, bot: "pako_ana_bot" }),
    hasWebhook: async () => false,
    pairLink: async () => "https://t.me/pako_ana_bot?start=onetimecode_0123456789ab",
  } as unknown as TelegramChannel;
  const d: TelegramPanelDeps = {
    signedIn: (req) => req.get("cookie") === "ok=1",
    env: {},
    lang: () => "en",
    current: () => current,
    create: () => candidate,
    keep: () => true,
    use: (ch) => void (current = ch),
  };
  const p = await serve((app) => mountTelegramPanel(app, d));
  const s = await serve((app) => mountTelegramPanel(app, null));
  try {
    const guide = await p.get("/panel/api/telegram/guide");
    assert.equal(guide.body.botFather, "https://t.me/BotFather");
    assert.ok((guide.body.steps as string[]).some((x) => x.includes("/newbot")));
    assert.equal((await p.get("/panel/api/telegram/guide", {})).status, 401);
    const set = await p.post("/panel/api/telegram/token", { token: TOKEN, pair: true });
    assert.equal(set.body.ok, true);
    assert.equal(set.body.link, "https://t.me/pako_ana_bot?start=onetimecode_0123456789ab");
    assert.match(String(set.body.svg), /^<svg/);
    assert.equal((await s.get("/panel/api/telegram/guide")).status, 404);
  } finally {
    await p.close();
    await s.close();
  }
});
