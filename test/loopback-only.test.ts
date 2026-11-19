// The bridge token and the panel's cookie go to 127.0.0.1 only (security review F2, F3, F7): `npm run panel` and the Mac app never fall back
// to [::1] (another account on this computer can listen there on the same port, a separate socket), the app takes only 127.0.0.1 on the
// panel's port as the panel (desktop/mac/Core.swift isPanelURL, isPanelOrigin; the Swift logic itself runs in test/mac-app.test.ts), and
// every reload goes through connect(), which checks the port is this Pako's own again before the cookie is sent.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const repo = join(import.meta.dirname, "..");
const source = (f: string): string => readFileSync(join(repo, f), "utf8");

test("npm run panel: 127.0.0.1 refuses (Pako starting) and something listens on [::1]: the token is never sent there", async (t) => {
  const got: (string | undefined)[] = [];
  const imposter = createServer((req, res) => {
    got.push(req.headers.authorization);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ link: "http://127.0.0.1:1/panel/login/x" }));
  });
  const ok = await new Promise<boolean>((done) => {
    imposter.once("error", () => done(false));
    imposter.listen({ host: "::1", port: 0, ipv6Only: true }, () => done(true));
  });
  if (!ok) return t.skip("no IPv6 loopback here");
  const port = (imposter.address() as AddressInfo).port;
  const home = mkdtempSync(join(tmpdir(), "loopback-only-"));
  mkdirSync(join(home, ".pako"), { mode: 0o700 });
  const token = "T".repeat(48);
  writeFileSync(join(home, ".pako", "secrets.json"), JSON.stringify({ bridgeToken: token }), { mode: 0o600 });
  // A live lock: this test's own process stands in for a Pako that holds its lock and does not listen on 127.0.0.1 yet.
  writeFileSync(join(home, ".pako", ".lock"), `${process.pid}\n${port}\n0\n`);
  const out = await new Promise<string>((done) =>
    execFile(process.execPath, [join(repo, "bin/panel.cjs")], { env: { PATH: process.env.PATH, HOME: home, PAKO_HOME: join(home, ".pako") }, timeout: 15_000 },
      (_err, stdout, stderr) => done(stdout + stderr)));
  await new Promise((done) => imposter.close(done));
  assert.deepEqual(got, [], "nothing reached [::1]");
  assert.match(out, /Pako está arrancando|Pako is starting/, "told it is starting, as before");
});

test("Mac app: the sign-in link is asked at 127.0.0.1 only, with no [::1] fallback", () => {
  const pako = source("desktop/mac/Pako.swift");
  const link = pako.slice(pako.indexOf("func signInLink"), pako.indexOf("extension Int32"));
  assert.ok(link.includes('"http://127.0.0.1:\\(port)/panel/api/link"'));
  assert.ok(!link.replace(/^\s*\/\/.*$/gm, "").includes("::1"), "no IPv6 fallback");
});

test("Mac app: the message handler and the file chooser take only the panel's exact origin (127.0.0.1, its port), never localhost", () => {
  const app = source("desktop/mac/App.swift");
  assert.ok(!/o\.host == "localhost"|"localhost"\]\.contains\(o\.host\)/.test(app), "no localhost origin");
  const handler = app.slice(app.indexOf("func userContentController"), app.indexOf("func userContentController") + 600);
  assert.match(handler, /isPanelOrigin\(protocol: o\.protocol, host: o\.host, port: o\.port, port: port\)/);
  const chooser = app.slice(app.indexOf("runOpenPanelWith"), app.indexOf("runOpenPanelWith") + 600);
  assert.match(chooser, /isPanelOrigin\(protocol: o\.protocol, host: o\.host, port: o\.port, port: port\)/);
  const core = source("desktop/mac/Core.swift");
  const isPanel = core.slice(core.indexOf("func isPanelURL"), core.indexOf("enum PanelNavigation"));
  assert.ok(!/localhost|::1/.test(isPanel.replace(/^\s*\/\/\/.*$/gm, "")), "isPanelURL names 127.0.0.1 only");
});

test("Mac app: Reload and a closed web content go through connect() (the port's owner checked), never a plain reload with the cookie", () => {
  const app = source("desktop/mac/App.swift");
  const reload = app.slice(app.indexOf("@objc private func reloadPanel()"), app.indexOf("private func connect()"));
  assert.ok(!reload.includes("webView.reload()"), "no plain reload");
  assert.match(reload, /connect\(\)/);
  const gone = app.slice(app.indexOf("func webViewWebContentProcessDidTerminate"), app.indexOf("func webView(_ wv: WKWebView, createWebViewWith"));
  assert.ok(!/\.load\(/.test(gone), "no load of the old address");
  assert.match(gone, /connect\(\)/);
});
