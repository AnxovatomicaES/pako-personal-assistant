// The guided connections in the real app (src/app.ts): on a computer the Mac app posts what it found and its calendars with the bridge token
// it already has, the first calendar push restarts Pako so the calendar reads it, and the status lists every connection; a hosted server
// answers 404 to all of it. A temp home and a store in memory: nothing of the owner's is touched.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp, loadAppConfig, type LocalContext } from "../src/app.ts";
import { createLocalChannel, loadHome, localEnv } from "../src/local.ts";
import { memoryKv } from "./helpers/connect-rig.ts";

type Env = Record<string, string | undefined>;

test("on a computer the Mac app posts its discovery and calendars with its token, and the first push restarts Pako; a server answers 404", async () => {
  const home = loadHome({ PAKO_HOME: join(mkdtempSync(join(tmpdir(), "pako-flows-")), "home"), PAKO_NAME: "Ana" });
  const env: Env = { ...localEnv({}, home, 0), PAKO_HOME: home.dir };
  const kv = memoryKv();
  const local: LocalContext = {
    kv, channel: createLocalChannel({ kv }), bridgeToken: home.bridgeToken, panelSecret: home.panelSecret, bridge: { status: () => ({ claude: "ok", running: true }) },
  };
  const app = createApp(loadAppConfig(env), env, local);
  let restarted = 0;
  app.locals.restart = () => (restarted++, true);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const asApp = { authorization: `Bearer ${home.bridgeToken}`, "content-type": "application/json" };
  try {
    assert.equal((await fetch(`${base}/panel/api/discovery`)).status, 401);
    const found = await fetch(`${base}/panel/api/discovery`, {
      method: "POST", headers: asApp,
      body: JSON.stringify({ at: Date.now(), apps: { zoom: true }, calendars: [{ id: "c1", title: "Trabajo" }], mailAccounts: [], contacts: { count: 2 } }),
    });
    assert.equal(found.status, 200);
    const start = Date.now() + 3600_000;
    const push = await fetch(`${base}/panel/api/calendar/local`, {
      method: "POST", headers: asApp,
      body: JSON.stringify({ calendars: ["c1"], events: [{ id: "e1", calendarId: "c1", title: "Comité", start, end: start + 1800_000, allDay: false }] }),
    });
    assert.deepEqual(await push.json(), { ok: true, events: 1, restarting: true });
    for (let i = 0; i < 50 && !restarted; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(restarted, 1);
    const status = (await (await fetch(`${base}/panel/api/connections/status`, { headers: asApp })).json()) as { connections: { id: string; state: string }[] };
    const mac = status.connections.find((c) => c.id === "macCalendar")!;
    assert.equal(mac.state, "connected");
    assert.ok(status.connections.some((c) => c.id === "imap"));
    assert.equal((await fetch(`${base}/panel/api/telegram/guide`, { headers: asApp })).status, 401, "the Telegram card stays the panel's own");
  } finally {
    server.close();
    server.closeAllConnections();
  }

  const hostedEnv: Env = {
    PERSONAL_CALLER_TOKEN: "p".repeat(32), PERSONAL_OWNER_NAME: "Ana", PERSONAL_OWNER_NUMBER: "+34600111222", WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value",
    WHATSAPP_PHONE_NUMBER_ID: "109876543210", WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef", WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  };
  const hosted = createServer(createApp(loadAppConfig(hostedEnv), hostedEnv));
  await new Promise<void>((r) => hosted.listen(0, "127.0.0.1", () => r()));
  const hb = `http://127.0.0.1:${(hosted.address() as AddressInfo).port}`;
  try {
    for (const path of ["discovery", "calendar/local", "people/import", "mail/autoconfig", "slack/setup", "zoom/setup", "connections/status"]) {
      assert.equal((await fetch(`${hb}/panel/api/${path}`)).status, 404, path);
    }
  } finally {
    hosted.close();
    hosted.closeAllConnections();
  }
});
