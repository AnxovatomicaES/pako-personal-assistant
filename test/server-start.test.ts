// The real entry point (src/server.ts) started as a person would start it: `npm start` with nothing set up. A process per test, a throwaway home.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ENTRY = new URL("../src/server.ts", import.meta.url).pathname;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function start(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "pako-start-"));
  const fake = join(dir, "claude");
  writeFileSync(fake, "#!/bin/sh\nexit 0\n");
  chmodSync(fake, 0o755);
  const child: ChildProcess = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ENTRY], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: dir, PAKO_HOME: join(dir, "home"), PAKO_NAME: "Ana", PAKO_NO_OPEN: "1", CLAUDE_BIN: fake, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<{ code: number | null }>((resolve) => child.on("exit", (code) => resolve({ code })));
  // Returns as soon as the line shows. The long limit is for a machine running the whole suite at once, where starting Node can take several seconds.
  const until = async (re: RegExp, ms = 30_000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (re.test(out)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return re.test(out);
  };
  return { dir, child, exited, out: () => out, until, stop: () => child.kill("SIGKILL") };
}

const IN_USE = /Port \d+ is already in use/;
/**
 * Started on a free port, and started again on another when that one was taken between finding it and listening: with the whole suite
 * running at once, another test's process can bind it in that moment (it was seen: "Port 49165 is already in use"). Ready: the line shows.
 */
async function launch(env: Record<string, string>, ready: RegExp) {
  for (let i = 0; ; i++) {
    const port = await freePort();
    const s = start({ ...env, PORT: String(port) });
    const ok = await s.until(new RegExp(`${ready.source}|${IN_USE.source}`));
    if (IN_USE.test(s.out()) && !ready.test(s.out()) && i < 4) {
      s.stop();
      continue;
    }
    return { s, port, ok: ok && ready.test(s.out()) };
  }
}

test("start: with nothing set up it runs in local mode, says so, answers on this computer only, and Ctrl+C ends it at once with code 0", async () => {
  const { s, port, ok } = await launch({}, /Pako is running for you/);
  try {
    assert.ok(ok, s.out());
    assert.match(s.out(), new RegExp(`http://127\\.0\\.0\\.1:${port}/panel/login/`));
    assert.doesNotMatch(s.out(), /Meta|webhook|\[(whatsapp|panel|personal-caller)\]/, "a newcomer's terminal shows the banner, not a hosted server's status lines");
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    // Not reachable from the network: the machine's own non-loopback address refuses the connection.
    const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (lan) {
      const refused = await new Promise<boolean>((resolve) => {
        const c = connect({ host: lan, port, timeout: 2000 });
        c.on("connect", () => (c.destroy(), resolve(false)));
        c.on("error", () => resolve(true));
        c.on("timeout", () => (c.destroy(), resolve(true)));
      });
      assert.equal(refused, true, `the panel must not answer on ${lan}`);
    }
    const pressed = Date.now();
    s.child.kill("SIGINT");
    const done = await s.exited;
    const ms = Date.now() - pressed;
    assert.equal(done.code, 0, s.out());
    // Well under a second when nothing is connected; code 0 already proves the 10 s forced exit (code 1) was not needed.
    assert.ok(ms < 5000, `Ctrl+C took ${ms} ms`);
  } finally {
    s.stop();
  }
});

test("start: a second Pako on the same home says so and stops (it would overwrite the first one's notes); a port in use is said too, with no 'running' banner and no browser", async () => {
  const { s: first, port, ok } = await launch({}, /Pako is running for you/);
  try {
    assert.ok(ok, first.out());
    const home = join(first.dir, "home");
    const second = start({ PORT: String(await freePort()), PAKO_HOME: home });
    const done = await second.exited;
    assert.equal(done.code, 1);
    assert.match(second.out(), /already running for this folder/);
    assert.doesNotMatch(second.out(), /Pako is running for you/);
    const busy = start({ PORT: String(port) }); // another home, the same port
    const gone = await busy.exited;
    assert.equal(gone.code, 1);
    assert.match(busy.out(), /Port \d+ is already in use/);
    assert.doesNotMatch(busy.out(), /Pako is running for you/, "the success banner is not printed when listening failed");
  } finally {
    first.stop();
  }
});

test("start: a folder that cannot be used, or a wrong setting in .env, ends with a sentence a person can act on, not a stack trace", async () => {
  const notAFolder = start({ PAKO_HOME: "/dev/null/pako" });
  assert.equal((await notAFolder.exited).code, 1);
  assert.match(notAFolder.out(), /cannot use .* to keep your notes/);
  assert.doesNotMatch(notAFolder.out(), /at .*\.ts:\d+/);
  const wrong = start({ PERSONAL_CONTACTS: "garbage" });
  assert.equal((await wrong.exited).code, 1);
  assert.match(wrong.out(), /Pako cannot start: a setting .* is wrong/);
  assert.doesNotMatch(wrong.out(), /Pako is running for you/);
});

test("start: on a hosting platform (RENDER set, WhatsApp's settings given) it is not local mode and listens for the world", async () => {
  const { s, port, ok } = await launch({
    RENDER: "true", PERSONAL_OWNER_NAME: "Ana", PERSONAL_OWNER_NUMBER: "+34600111222", PERSONAL_CALLER_TOKEN: "t".repeat(32),
    ASSISTANT_BRIDGE_TOKEN: "b".repeat(48), WHATSAPP_ACCESS_TOKEN: "EAAB_secret_token_value", WHATSAPP_PHONE_NUMBER_ID: "109876543210",
    WHATSAPP_APP_SECRET: "0123456789abcdef0123456789abcdef", WHATSAPP_VERIFY_TOKEN: "verify_token_0123456789",
  }, /assistant listening on port/);
  try {
    assert.ok(ok, s.out());
    assert.match(s.out(), /\[whatsapp\] ON/, "a server says what it serves");
    assert.doesNotMatch(s.out(), /Pako is running for you/);
    const handshake = await fetch(`http://127.0.0.1:${port}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify_token_0123456789&hub.challenge=777`);
    assert.equal(await handshake.text(), "777");
  } finally {
    s.stop();
  }
});

test("started by the Mac app (PAKO_APP_PID): no sign-in link in its output, and it stops by itself once the app is gone (Force Quit, a crash)", async () => {
  const app = spawn("sleep", ["60"]);
  const { s, port, ok } = await launch({ PAKO_APP_PID: String(app.pid) }, /Pako is running for you/);
  try {
    assert.ok(ok, s.out());
    assert.doesNotMatch(s.out(), /\/panel\/login\//, "no live sign-in link in app.log");
    assert.match(s.out(), /Open its panel from the Pako app/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    app.kill("SIGKILL");
    const ended = await Promise.race([s.exited, new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
    assert.ok(ended, `it stopped by itself:\n${s.out()}`);
    assert.equal(ended.code, 0, "its normal shutdown");
    assert.match(s.out(), /PAKO_APP_PID/);
  } finally {
    app.kill("SIGKILL");
    s.stop();
  }
});

test("watchParent and printsLink: nothing to watch under launchd or with no app; the app's end is noticed once", async () => {
  const { printsLink, watchParent } = await import("../src/server.ts");
  assert.equal(printsLink({}), true, "npm start in a terminal");
  assert.equal(printsLink({ PAKO_APP_PID: "123" }), false);
  assert.equal(printsLink({ PAKO_SERVICE: "1" }), false);
  let calls = 0;
  for (const env of [{}, { PAKO_APP_PID: "x" }, { PAKO_APP_PID: "1" }, { PAKO_APP_PID: String(process.pid) }, { PAKO_APP_PID: "4242", PAKO_SERVICE: "1" }]) {
    watchParent(env, () => calls++, { every: 5, alive: () => false })();
  }
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 0, "none of those is watched");
  let alive = true;
  const stop = watchParent({ PAKO_APP_PID: "4242" }, () => calls++, { every: 5, alive: () => alive });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 0);
  alive = false;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(calls, 1, "once");
  stop();
});
