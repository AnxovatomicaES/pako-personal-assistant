// The files a stranger copies from (render.yaml, .env.example) must match what the server really asks for: a drift here is a deploy that does not start.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadAppConfig } from "../src/app.ts";
import { loadMailConfig } from "../src/mail.ts";
import { loadSlackConfig } from "../src/slack.ts";
import { loadWhatsappConfig } from "../src/whatsapp.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const docs = ["README.md", "docs/configuration.md", "docs/personal-caller.md", "assistant/README.md", "voice-worker/README.md"].map(read).join("\n");

test("render.yaml: asks for exactly the secrets the hosted server needs, and a store so STOP and the notes survive a restart", () => {
  const yaml = read("render.yaml");
  const keys = [...yaml.matchAll(/- key: ([A-Z0-9_]+)/g)].map((m) => m[1]!);
  const asked = [...yaml.matchAll(/- key: ([A-Z0-9_]+)\n\s+sync: false/g)].map((m) => m[1]!);
  assert.ok(/type: keyvalue/.test(yaml) && /VOICE_RESULTS_URL[\s\S]*fromService[\s\S]*type: keyvalue[\s\S]*connectionString/.test(yaml), "a Key Value store, joined to the server");
  // Filled with plausible values, the Blueprint's own list is enough for every part of the hosted door to turn on.
  const value: Record<string, string> = {
    PERSONAL_OWNER_NAME: "Ana", PERSONAL_OWNER_NUMBER: "+34600111222", PERSONAL_CALLER_TOKEN: "a".repeat(48), ASSISTANT_BRIDGE_TOKEN: "b".repeat(48),
    WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value", WHATSAPP_PHONE_NUMBER_ID: "109876543210", WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef", WHATSAPP_VERIFY_TOKEN: "c".repeat(48),
  };
  assert.deepEqual([...asked].sort(), Object.keys(value).sort(), "what the Blueprint asks for is what the server needs, no more and no less");
  const env = { ...value, RENDER: "true" };
  const config = loadAppConfig(env);
  assert.ok(config.personalCaller, "the phone line's settings are valid");
  assert.ok(loadWhatsappConfig(env, config.personalCaller!.ownerNumber).config, "WhatsApp's settings are valid");
  for (const k of keys) assert.ok(k === "NODE_VERSION" || docs.includes(`\`${k}\``), `${k} is documented`);
});

test(".env.example: every setting in it is one the code reads and the docs explain; the blocks that can be switched on parse with their example values", () => {
  const example = read(".env.example");
  const names = [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!);
  assert.ok(names.length >= 15);
  for (const n of names) assert.ok(docs.includes(`\`${n}\``), `${n} is documented`);
  const uncomment = (block: string): Record<string, string> => Object.fromEntries([...block.matchAll(/^#\s*([A-Z][A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1]!, m[2]!.trim()]));
  const blocks = example.split(/^# --- /m).slice(1);
  const mail = uncomment(blocks.find((b) => b.startsWith("Email"))!);
  mail.AGENTMAIL_API_KEY = "am_example_key_0123456789";
  mail.AGENTMAIL_WEBHOOK_SECRET = "";
  assert.deepEqual(loadMailConfig({ ...mail }).problems, [], "email: key, inbox, and no webhook secret (listing only) is a valid start for a computer at home");
  const slack = uncomment(blocks.find((b) => b.startsWith("Slack"))!);
  slack.SLACK_USER_TOKEN = "xoxp-1234567890-1234567890-abcdefghijklmnop";
  // A computer: the app-level token (Socket Mode) and no signing secret.
  assert.deepEqual(loadSlackConfig({ ...slack, SLACK_APP_TOKEN: "xapp-1-A0123456789-1234567890123-abcdef0123456789" }).problems, []);
  slack.SLACK_SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
  assert.deepEqual(loadSlackConfig({ ...slack }).problems, []);
});

test("ci.yml: the smoke start looks for words the signed-out panel really serves", () => {
  // It looked for "Panel de Pako" after the texts became English: the check could only fail.
  const yaml = read(".github/workflows/ci.yml");
  const wanted = [...yaml.matchAll(/curl -fsS http:\/\/127\.0\.0\.1:\d+\/panel \| grep -q "([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(wanted.length > 0, "the smoke start checks the panel");
  const page = read("src/panel/signin-local.html");
  for (const w of wanted) assert.ok(page.includes(w), `the signed-out panel says ${JSON.stringify(w)}`);
});
