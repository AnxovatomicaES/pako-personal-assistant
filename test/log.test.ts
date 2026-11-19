// The log (src/log-core.ts, src/log.ts): the text and JSON lines, the level filter, the secrets it never writes, and that every line goes out
// through console's methods so a test that swaps them still sees it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { codeMark } from "../src/codes.ts";
import { configureLog } from "../src/log-core.ts";
import { createLog, formatEntry, isSecretName, log, logBody, logLevel, redactFields, scrubText } from "../src/log.ts";

const NOW = new Date("2026-11-18T09:30:00.000Z");

/** The lines written while fn runs, by console method, with the env set as given and the clock fixed. */
function capture(t: TestContext, env: Record<string, string | undefined>, fn: () => void): { log: string[]; warn: string[]; error: string[] } {
  const out = { log: [] as string[], warn: [] as string[], error: [] as string[] };
  const keep = { PAKO_LOG_LEVEL: process.env.PAKO_LOG_LEVEL, PAKO_LOG_FORMAT: process.env.PAKO_LOG_FORMAT };
  for (const k of ["PAKO_LOG_LEVEL", "PAKO_LOG_FORMAT"] as const) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  t.mock.method(console, "log", (...a: unknown[]) => void out.log.push(a.join(" ")));
  t.mock.method(console, "warn", (...a: unknown[]) => void out.warn.push(a.join(" ")));
  t.mock.method(console, "error", (...a: unknown[]) => void out.error.push(a.join(" ")));
  configureLog({ now: () => NOW });
  try {
    fn();
  } finally {
    t.mock.restoreAll();
    configureLog({ now: () => new Date() });
    for (const k of ["PAKO_LOG_LEVEL", "PAKO_LOG_FORMAT"] as const) {
      if (keep[k] === undefined) delete process.env[k];
      else process.env[k] = keep[k];
    }
  }
  return out;
}

test("text lines: timestamp, level, the part in brackets, the message as console would join it, then the fields", (t) => {
  const out = capture(t, {}, () => {
    const wa = createLog("whatsapp");
    wa.info("webhook: %d queued", 2);
    wa.warn("slow send", { ms: 1200, to: "panel" });
    wa.error("send failed:", new Error("boom"));
    log.info("listening");
  });
  assert.deepEqual(out.log, ["2026-11-18T09:30:00.000Z INFO [whatsapp] webhook: 2 queued", "2026-11-18T09:30:00.000Z INFO [pako] listening"]);
  assert.deepEqual(out.warn, ["2026-11-18T09:30:00.000Z WARN [whatsapp] slow send ms=1200 to=panel"]);
  assert.equal(out.error.length, 1);
  assert.match(out.error[0]!, /^2026-11-18T09:30:00\.000Z ERROR \[whatsapp\] send failed: Error: boom\n\s+at /, "an Error keeps its stack");
});

test("a part's log is the same object each time, and child() names another part with its fields on each line", (t) => {
  assert.equal(createLog("bridge"), createLog("bridge"));
  assert.equal(log.child("bridge"), createLog("bridge"));
  const out = capture(t, {}, () => log.child("data", { home: "/x" }).child("data", { n: 1 }).info("kept", { n: 2 }));
  assert.deepEqual(out.log, ["2026-11-18T09:30:00.000Z INFO [data] kept home=/x n=2"]);
});

test("PAKO_LOG_LEVEL drops the lines below it; info by default, and a value it does not know is info", (t) => {
  const all = (l: ReturnType<typeof createLog>) => {
    l.debug("d");
    l.info("i");
    l.warn("w");
    l.error("e");
  };
  const count = (o: { log: string[]; warn: string[]; error: string[] }) => o.log.length + o.warn.length + o.error.length;
  assert.equal(count(capture(t, {}, () => all(createLog("x")))), 3);
  assert.equal(count(capture(t, { PAKO_LOG_LEVEL: "debug" }, () => all(createLog("x")))), 4);
  assert.equal(count(capture(t, { PAKO_LOG_LEVEL: "WARN" }, () => all(createLog("x")))), 2);
  assert.deepEqual(capture(t, { PAKO_LOG_LEVEL: "error" }, () => all(createLog("x"))).error, ["2026-11-18T09:30:00.000Z ERROR [x] e"]);
  assert.equal(logLevel({ PAKO_LOG_LEVEL: "loud" }), "info");
  assert.equal(logLevel({}), "info");
});

test("PAKO_LOG_FORMAT=json writes one JSON object per line, fields beside the message and never over it", (t) => {
  const out = capture(t, { PAKO_LOG_FORMAT: "json" }, () => {
    createLog("telegram").warn("poll failed: %s", "timeout", { attempt: 3, msg: "not mine", password: "hunter2" });
  });
  assert.equal(out.warn.length, 1);
  assert.deepEqual(JSON.parse(out.warn[0]!), {
    ts: "2026-11-18T09:30:00.000Z",
    level: "warn",
    component: "telegram",
    msg: "poll failed: timeout",
    attempt: 3,
    _msg: "not mine",
    password: "[redacted]",
  });
  const text = formatEntry({ ts: "t", level: "info", component: "c", msg: "line\nnext" }, "json");
  assert.equal(text.includes("\n"), false, "one line, whatever the message holds");
});

test("fields named like a secret are replaced whole; a status or exit code is not a secret", () => {
  for (const name of ["token", "accessToken", "refresh_token", "client_secret", "password", "Authorization", "set-cookie", "apiKey", "x-api-key", "key", "code", "otp", "pin", "clientsecret"]) {
    assert.ok(isSecretName(name), name);
  }
  for (const name of ["statusCode", "exit_code", "countryCode", "lang", "monkey", "tokens_used", "id", "subject"]) assert.ok(!isSecretName(name), name);
  assert.deepEqual(redactFields({ token: "abc", nested: { secret: "s", ok: 1 }, list: [{ password: "p" }], statusCode: 401 }), {
    token: "[redacted]",
    nested: { secret: "[redacted]", ok: 1 },
    list: [{ password: "[redacted]" }],
    statusCode: 401,
  });
});

test("in any text: bearer tokens, keys in their known shapes, secrets in a query, and phone numbers past their last 3 digits", () => {
  const cases: [string, string][] = [
    ["Authorization: Bearer abcdefghijklmnop.qrs", "Authorization: Bearer [redacted]"],
    ["key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA refused", "key [redacted] refused"],
    ["slack xoxb-1234567890-abcdefghij said no", "slack [redacted] said no"],
    ["bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0 gone", "bot [redacted] gone"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijk end", "jwt [redacted] end"],
    ["GET /cb?code=4/0AbCdEf&state=xyz", "GET /cb?code=[redacted]&state=xyz"],
    ["https://x.test/a?access_token=zzz&page=2", "https://x.test/a?access_token=[redacted]&page=2"],
    ['body {"refresh_token":"r-123","ok":true}', 'body {"refresh_token":"[redacted]","ok":true}'],
    ["call to +34 600 111 222 placed", "call to +***222 placed"],
    ["from 34600111222@s.whatsapp.net", "from ***222@s.whatsapp.net"],
    ["took 1200 ms at 2026-11-18T09:30:00Z, order 123456789", "took 1200 ms at 2026-11-18T09:30:00Z, order 123456789"],
  ];
  for (const [input, want] of cases) assert.equal(scrubText(input), want, input);
  assert.deepEqual(redactFields({ phone: "34600111222", to: "+44 7700 900123", count: 34600111222 }), { phone: "***222", to: "+***123", count: 34600111222 });
});

test("a Telegram bot token inside its API address (.../bot123456:ABC.../getUpdates) is hidden too", () => {
  const token = "1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";
  for (const line of [`GET https://api.telegram.org/bot${token}/getUpdates failed`, `https://api.telegram.org/file/bot${token}/voice/file_1.oga`]) {
    const out = scrubText(line);
    assert.ok(!out.includes("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1"), out);
  }
});

test("the mail's one-time codes are hidden by the same rules as src/codes.ts, and a line's message is scrubbed too", (t) => {
  assert.equal(scrubText("subject: Your verification code is 482910"), `subject: Your verification code is ${codeMark("en")}`);
  const out = capture(t, {}, () => createLog("mail").info("new mail: %s", "Tu código de verificación es 482910", { from: "+34600111222" }));
  assert.deepEqual(out.log, [`2026-11-18T09:30:00.000Z INFO [mail] new mail: Tu código de verificación es ${codeMark("en")} from=+***222`]);
});

test("a line that cannot be written does not throw into the code that logged it", (t) => {
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  const out = capture(t, {}, () => createLog("x").info("loop", { loop }));
  assert.equal(out.log.length + out.error.length, 1);
});

test("the voice worker's log is a copy of src/log-core.ts", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  assert.equal(read("../voice-worker/src/log.ts"), read("../src/log-core.ts"), "copy src/log-core.ts to voice-worker/src/log.ts");
});

test("logBody gives a text line back as the part wrote it, for tests that compare lines", (t) => {
  const out = capture(t, {}, () => createLog("whatsapp").info("webhook: 1 queued"));
  assert.deepEqual(out.log.map(logBody), ["[whatsapp] webhook: 1 queued"]);
  assert.equal(logBody("plain text"), "plain text");
});
