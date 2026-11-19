// Pako's secrets in the system's store (src/secret-store.ts, src/secrets.ts): each system's tool driven with no value on its command line, a
// move into the store that never loses a secret, a store that stops answering, the switch back to the file, and every path that reads the
// secrets (the settings, the connections, export, delete everything, the privacy page, `npm run panel`'s reader). A stub store everywhere;
// on a Mac, one test against the real login keychain under a throwaway service, removed at the end.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { createApp, loadAppConfig, type LocalContext } from "../src/app.ts";
import { readStored, writeStored } from "../src/connections.ts";
import { privacy } from "../src/data.ts";
import { createLocalChannel, createSettings, loadHome, localEnv } from "../src/local.ts";
import {
  linuxStore, macStore, SECURITY, StoreError, winStore, WIN_SCRIPT, type RunResult, type Runner, type SecretStore, type StoreKind,
} from "../src/secret-store.ts";
import { encodeValue, folderAccount, readSecrets, secretMode, secretsProblem, secretsWhere, settleSecrets, useStoreForTests, writeSecrets } from "../src/secrets.ts";
import { sqliteKv } from "../src/sqlite-kv.ts";

const root = new URL("../", import.meta.url);
const home = (): string => mkdtempSync(join(tmpdir(), "pako-secrets-"));
const file = (dir: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8")) as Record<string, unknown>;
const KEYCHAIN = { PAKO_SECRET_STORE: "keychain" };

/** An in-memory store, with ways to make it fail: at writing, at reading back, entirely, or with a value that changes on the way. */
function stub(o: { kind?: StoreKind; maxValue?: number } = {}) {
  const items = new Map<string, string>();
  const s = {
    items,
    failSet: false,
    failGet: false,
    failRemove: false,
    /** set writes this instead of the value (a store that mangles it). */
    mangle: false,
    calls: [] as string[],
    store: null as unknown as SecretStore,
  };
  s.store = {
    kind: o.kind ?? "keychain",
    service: "Pako",
    maxValue: o.maxValue ?? Number.POSITIVE_INFINITY,
    get(accounts) {
      s.calls.push(`get ${accounts.length}`);
      if (s.failGet) throw new StoreError("locked");
      return new Map(accounts.map((a) => [a, items.get(a) ?? null]));
    },
    set(entries) {
      s.calls.push(`set ${entries.length}`);
      if (s.failSet) throw new StoreError("denied");
      for (const [a, v] of entries) items.set(a, s.mangle ? `${v}x` : v);
    },
    remove(accounts) {
      s.calls.push(`remove ${accounts.length}`);
      if (s.failRemove) throw new StoreError("denied");
      for (const a of accounts) items.delete(a);
    },
  };
  return s;
}

afterEach(() => useStoreForTests(null));

const SAMPLE = {
  bridgeToken: "b".repeat(48),
  callerToken: "c".repeat(48),
  panelSecret: "p".repeat(48),
  telegramBotToken: `123456:${"T".repeat(35)}`,
  whatsappComputer: { phoneNumberId: "1234", accessToken: `EAA${"w".repeat(60)}`, ownerName: "José Ñandú 🎉" },
  settings: { AGENTMAIL_API_KEY: `am_${"m".repeat(30)}`, AGENTMAIL_INBOX: "pako@agentmail.to" },
};

// ---------- the tools: never a value on a command line, never a hang ----------

/** A runner that records every call and answers from `answer`. */
function recorder(answer: (cmd: string, args: string[], input: string) => Partial<RunResult>) {
  const calls: { cmd: string; args: string[]; input: string; timeoutMs: number }[] = [];
  const run: Runner = (cmd, args, o) => {
    calls.push({ cmd, args, input: o.input ?? "", timeoutMs: o.timeoutMs });
    return { status: 0, stdout: "", stderr: "", ...answer(cmd, args, o.input ?? "") };
  };
  return { calls, run };
}

test("macOS: values go in on stdin as hex through security -i, are read with find-generic-password -w, and never sit on a command line", () => {
  const value = encodeValue("s3cr3t-välue");
  const kept = new Map<string, string>();
  const r = recorder((_cmd, args, input) => {
    if (args[0] === "-i") {
      for (const m of input.matchAll(/add-generic-password -U -s (\S+) -a (\S+) -X ([0-9a-f]+)\n/g)) kept.set(m[2]!, Buffer.from(m[3]!, "hex").toString("utf8"));
      return {};
    }
    const a = args[args.indexOf("-a") + 1]!;
    return kept.has(a) ? { stdout: `${kept.get(a)}\n` } : { status: 44, stderr: "could not be found" };
  });
  const s = macStore("Pako", r.run);
  s.set([["h:bridgeToken", value]]);
  assert.deepEqual([...s.get(["h:bridgeToken", "h:none"])], [["h:bridgeToken", value], ["h:none", null]]);
  for (const c of r.calls) {
    assert.equal(c.cmd, SECURITY);
    assert.ok(!c.args.join(" ").includes("s3cr3t"), "the value is never an argument");
    assert.ok(!c.args.includes("-w") || c.args[0] === "find-generic-password", "-w only to read");
    assert.ok(c.timeoutMs > 0 && c.timeoutMs <= 20_000, "every call has a timeout");
  }
  assert.deepEqual(r.calls[0]!.args, ["-i"]);
  assert.ok(!r.calls[0]!.input.includes("s3cr3t"), "only hex on stdin, so nothing in it can be read as a command");
  assert.ok(!/ -[AT] /.test(r.calls[0]!.input), "no -A and no -T: the item trusts only security itself");
});

test("macOS: a long value (a Microsoft sign-in in the settings) is kept: no `security -i` line is longer than the 4,096 bytes it reads", () => {
  // `security -i` reads each command into a 4,096-byte line (checked on macOS 15: a 2,010-character value goes in, a 2,020 one exits 1).
  const kept = new Map<string, string>();
  const r = recorder((_cmd, args, input) => {
    if (args[0] === "-i") {
      if (input.split("\n").some((l) => l.length + 1 > 4096)) return { status: 1, stderr: "line too long" };
      for (const m of input.matchAll(/add-generic-password -U -s (\S+) -a (\S+) -X ([0-9a-f]+)\n/g)) kept.set(m[2]!, Buffer.from(m[3]!, "hex").toString("utf8"));
      return {};
    }
    const a = args[args.indexOf("-a") + 1]!;
    return kept.has(a) ? { stdout: `${kept.get(a)}\n` } : { status: 44, stderr: "could not be found" };
  });
  useStoreForTests(macStore("Pako", r.run));
  const dir = home();
  const settings = { TEAMS_REFRESH_TOKEN: `1.AQ${"r".repeat(1800)}`, IMAP_REFRESH_TOKEN: `M.C5${"i".repeat(1500)}`, IMAP_OAUTH: "microsoft" };
  writeFileSync(join(dir, "secrets.json"), JSON.stringify({ ...SAMPLE, settings }));
  const moved = settleSecrets(dir, KEYCHAIN);
  assert.equal(moved.where, "keychain", moved.problem ?? "moved");
  assert.deepEqual(readSecrets(dir), { ...SAMPLE, settings });
  assert.ok(writeStored(dir, { ZOOM_REFRESH_TOKEN: "z".repeat(3000) }), "a save from the panel works too");
  assert.equal(readStored(dir)?.ZOOM_REFRESH_TOKEN, "z".repeat(3000));
  rmSync(dir, { recursive: true, force: true });
});

test("macOS: a locked keychain, a timeout or a missing tool is an error, never a value or a hang", () => {
  for (const answer of [{ status: 36, stderr: "User interaction is not allowed." }, { status: null, error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) },
    { status: null, error: Object.assign(new Error("n"), { code: "ENOENT" }) }] as Partial<RunResult>[]) {
    const s = macStore("Pako", recorder(() => answer).run);
    assert.throws(() => s.get(["h:bridgeToken"]), StoreError);
    assert.throws(() => s.set([["h:bridgeToken", "\"v\""]]), StoreError);
  }
  const timedOut = macStore("Pako", recorder(() => ({ status: null, error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) })).run);
  assert.throws(() => timedOut.get(["h:x"]), /did not answer in time/);
  // A name or value that could break the line protocol is refused before anything runs.
  const r = recorder(() => ({}));
  const s = macStore("Pako", r.run);
  assert.throws(() => s.set([["h:x -A", "\"v\""]]), StoreError);
  assert.throws(() => s.set([["h:x", "line\nbreak"]]), StoreError);
  assert.throws(() => macStore("Pa ko", r.run).get(["h:x"]), StoreError);
  assert.equal(r.calls.length, 0);
  // The real timeout: a program that never ends is killed.
  const started = Date.now();
  const slow = macStore("Pako", (cmd, args, o) => {
    const res = spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeout: o.timeoutMs, killSignal: "SIGKILL" });
    return { status: res.status, stdout: "", stderr: "", error: res.error };
  }, 300);
  assert.throws(() => slow.get(["h:x"]), /did not answer in time/);
  assert.ok(Date.now() - started < 10_000);
});

test("Windows: the Credential Manager through CredRead/CredWrite, the script on the command line and the values on stdin", () => {
  const kept = new Map<string, string>();
  const r = recorder((_cmd, _args, input) => {
    const out: string[] = [];
    for (const line of input.split("\n").filter(Boolean)) {
      const [op, target, value] = line.split("\t");
      if (op === "set") (kept.set(target!, value!), out.push(`ok\t${target}`));
      else if (op === "get") out.push(kept.has(target!) ? `ok\t${target}\t${kept.get(target!)}` : `none\t${target}`);
      else if (op === "del") out.push(kept.delete(target!) ? `ok\t${target}` : `none\t${target}`);
    }
    return { stdout: out.join("\r\n") + "\r\n" };
  });
  const s = winStore("Pako", { SystemRoot: "C:\\Windows" }, r.run);
  s.set([["h:bridgeToken", "\"s3cr3t\""]]);
  assert.deepEqual([...s.get(["h:bridgeToken", "h:none"])], [["h:bridgeToken", "\"s3cr3t\""], ["h:none", null]]);
  s.remove(["h:bridgeToken", "h:none"]);
  assert.equal(kept.size, 0);
  for (const c of r.calls) {
    assert.match(c.cmd, /WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    assert.ok(c.args.includes("-EncodedCommand") && c.args.includes("-NonInteractive"));
    assert.ok(!c.args.join(" ").includes("s3cr3t"));
    assert.equal(Buffer.from(c.args.at(-1)!, "base64").toString("utf16le"), WIN_SCRIPT);
  }
  assert.match(WIN_SCRIPT, /CredReadW/);
  assert.match(WIN_SCRIPT, /CredWriteW/);
  assert.match(WIN_SCRIPT, /CredDeleteW/);
  assert.match(WIN_SCRIPT, /\[Console\]::In\.ReadToEnd\(\)/, "the values come on stdin");
  assert.equal(s.maxValue < 2560, true, "under the Credential Manager's blob limit: longer values are split");
  // An answer that is not ok is an error, and so is PowerShell failing (a constrained language mode that refuses Add-Type).
  assert.throws(() => winStore("Pako", {}, recorder(() => ({ stdout: "err\tPako:h:x\t5\n" })).run).get(["h:x"]), StoreError);
  assert.throws(() => winStore("Pako", {}, recorder(() => ({ status: 1 })).run).set([["h:x", "\"v\""]]), StoreError);
});

test("Linux: secret-tool reads the value on stdin, answers on stdout; 'nothing found' is not an error, a locked collection is", () => {
  const kept = new Map<string, string>();
  const r = recorder((_cmd, args, input) => {
    const a = args[args.indexOf("account") + 1]!;
    if (args[0] === "store") return (kept.set(a, input), {});
    if (args[0] === "lookup") return kept.has(a) ? { stdout: kept.get(a)! } : { status: 1 };
    return kept.delete(a) ? {} : { status: 1 };
  });
  const s = linuxStore("Pako", "/usr/bin/secret-tool", r.run);
  s.set([["h:bridgeToken", "\"s3cr3t\""]]);
  assert.equal(s.get(["h:bridgeToken"]).get("h:bridgeToken"), "\"s3cr3t\"");
  assert.equal(s.get(["h:none"]).get("h:none"), null);
  s.remove(["h:bridgeToken", "h:none"]);
  for (const c of r.calls) assert.ok(!c.args.join(" ").includes("s3cr3t"));
  assert.equal(r.calls[0]!.input, "\"s3cr3t\"");
  const locked = linuxStore("Pako", "secret-tool", recorder(() => ({ status: 1, stderr: "secret-tool: Cannot create an item in a locked collection" })).run);
  assert.throws(() => locked.get(["h:x"]), StoreError);
});

// ---------- moving into the store ----------

test("the switch: file, keychain, auto (the default, also for anything else)", () => {
  assert.equal(secretMode({}), "auto");
  assert.equal(secretMode({ PAKO_SECRET_STORE: " Keychain " }), "keychain");
  assert.equal(secretMode({ PAKO_SECRET_STORE: "file" }), "file");
  assert.equal(secretMode({ PAKO_SECRET_STORE: "vault" }), "auto");
});

test("a move: every secret into the store, read back, then secrets.json is a marker with no value in it; reading gives the same secrets", () => {
  const dir = home();
  writeFileSync(join(dir, "secrets.json"), JSON.stringify(SAMPLE));
  const s = stub();
  useStoreForTests(s.store);
  const moved = settleSecrets(dir, KEYCHAIN);
  assert.equal(moved.where, "keychain");
  assert.deepEqual(moved.moved.sort(), Object.keys(SAMPLE).sort());
  const marker = file(dir);
  assert.equal(marker._store, "keychain");
  assert.equal(marker._service, "Pako");
  assert.equal(marker._account, folderAccount(dir));
  const text = readFileSync(join(dir, "secrets.json"), "utf8");
  for (const v of [SAMPLE.bridgeToken, SAMPLE.telegramBotToken, SAMPLE.whatsappComputer.accessToken, SAMPLE.settings.AGENTMAIL_API_KEY]) assert.ok(!text.includes(v));
  assert.equal(s.items.get(`${folderAccount(dir)}:bridgeToken`), JSON.stringify(SAMPLE.bridgeToken));
  for (const v of s.items.values()) assert.match(v, /^[\x20-\x7e]*$/, "printable ASCII only, the accents and the emoji escaped");
  assert.deepEqual(readSecrets(dir), SAMPLE);
  assert.equal(secretsWhere(dir), "keychain");
  // A second start: nothing to move, and the store is read once per marker (from memory after).
  assert.deepEqual(settleSecrets(dir, KEYCHAIN).moved, []);
  s.calls.length = 0;
  readSecrets(dir);
  readSecrets(dir);
  assert.deepEqual(s.calls, [], "read from memory while the marker is the same");
});

test("a move never loses a secret: a failure at writing, at reading back, or at replacing the file leaves the file as it was", () => {
  const original = JSON.stringify(SAMPLE);
  for (const fail of ["set", "get", "mangle", "rename"] as const) {
    const dir = home();
    writeFileSync(join(dir, "secrets.json"), original);
    const s = stub();
    if (fail === "set") s.failSet = true;
    if (fail === "get") s.failGet = true;
    if (fail === "mangle") s.mangle = true;
    // The file cannot be replaced: where its new copy is written first, a folder is in the way.
    if (fail === "rename") mkdirSync(join(dir, `secrets.json.${process.pid}.tmp`));
    useStoreForTests(s.store);
    const r = settleSecrets(dir, KEYCHAIN);
    assert.equal(r.where, "file", fail);
    assert.ok(r.problem, fail);
    assert.ok(!JSON.stringify(r).includes(SAMPLE.bridgeToken), "the problem never quotes a value");
    assert.equal(readFileSync(join(dir, "secrets.json"), "utf8"), original, `${fail}: the file is untouched`);
    assert.deepEqual(readSecrets(dir), SAMPLE, fail);
    if (fail !== "set") assert.equal(s.items.size, 0, `${fail}: what was written is taken out again`);
  }
});

test("a crash between the store's write and the file's replacement: the next start finds the file whole, and moves it then", () => {
  const dir = home();
  writeFileSync(join(dir, "secrets.json"), JSON.stringify(SAMPLE));
  const s = stub();
  // What a crash leaves: the values in the store (some of them stale), the file as it was.
  s.items.set(`${folderAccount(dir)}:bridgeToken`, JSON.stringify("an older token, from a crash"));
  useStoreForTests(s.store);
  assert.deepEqual(readSecrets(dir), SAMPLE, "the file is the truth until the marker replaces it");
  assert.equal(settleSecrets(dir, KEYCHAIN).where, "keychain");
  assert.deepEqual(readSecrets(dir), SAMPLE, "the stale entry was written over");
});

test("values longer than one entry holds are split, read back whole, and their pieces removed when they shrink or go", () => {
  const dir = home();
  writeFileSync(join(dir, "secrets.json"), JSON.stringify(SAMPLE));
  const s = stub({ kind: "wincred", maxValue: 16 });
  useStoreForTests(s.store);
  assert.equal(settleSecrets(dir, KEYCHAIN).where, "wincred");
  const acct = folderAccount(dir);
  assert.match(s.items.get(`${acct}:whatsappComputer`)!, /^#parts:\d+$/);
  for (const v of s.items.values()) assert.ok(v.length <= 16);
  assert.deepEqual(readSecrets(dir), SAMPLE);
  writeSecrets(dir, { ...SAMPLE, whatsappComputer: { a: 1 } });
  assert.deepEqual(readSecrets(dir), { ...SAMPLE, whatsappComputer: { a: 1 } });
  assert.ok(![...s.items.keys()].some((k) => k.startsWith(`${acct}:whatsappComputer#`)), "the pieces of the longer value are gone");
  const { settings: _s, ...rest } = SAMPLE;
  writeSecrets(dir, { ...rest, whatsappComputer: { a: 1 } });
  assert.ok(![...s.items.keys()].some((k) => k.startsWith(`${acct}:settings`)), "a key that goes, goes from the store, pieces and all");
});

test("auto keeps the file under the test runner and with a HOME that is not this account's; file moves secrets back out of the store", () => {
  const dir = home();
  writeFileSync(join(dir, "secrets.json"), JSON.stringify(SAMPLE));
  const s = stub();
  useStoreForTests(s.store);
  assert.deepEqual(settleSecrets(dir, {}), { where: "file", moved: [] }, "auto, in a test: the file");
  assert.equal(s.items.size, 0);
  assert.equal(settleSecrets(dir, KEYCHAIN).where, "keychain");
  const back = settleSecrets(dir, { PAKO_SECRET_STORE: "file" });
  assert.equal(back.where, "file");
  assert.equal(back.problem, undefined);
  assert.deepEqual(file(dir), SAMPLE, "every value back in the file");
  assert.equal(s.items.size, 0, "and none left in the store");
  // Back to the file needs the store to answer: when it cannot, the marker stays, and nothing is lost.
  assert.equal(settleSecrets(dir, KEYCHAIN).where, "keychain");
  s.failGet = true;
  useStoreForTests(s.store); // a fresh look (the cache is cleared)
  const stuck = settleSecrets(dir, { PAKO_SECRET_STORE: "file" });
  assert.equal(stuck.where, "keychain");
  assert.ok(stuck.problem);
  assert.equal(file(dir)._store, "keychain");
});

test("no store on this computer: keychain says so, auto stays quiet, and the secrets stay in the file", () => {
  const dir = home();
  writeFileSync(join(dir, "secrets.json"), JSON.stringify(SAMPLE));
  useStoreForTests(() => null);
  const asked = settleSecrets(dir, KEYCHAIN);
  assert.equal(asked.where, "file");
  assert.match(asked.problem ?? "", /no secret store/);
  assert.deepEqual(file(dir), SAMPLE);
});

// ---------- a store that stops answering ----------

test("a store that no longer answers: readSecrets says it cannot read, loadHome runs on temporary secrets and writes nothing, the owner is told", () => {
  const dir = home();
  const env = { PAKO_HOME: dir, ...KEYCHAIN };
  const s = stub();
  useStoreForTests(s.store);
  const first = loadHome(env);
  assert.equal(first.secretsAt, "keychain");
  assert.equal(first.firstRun, true);
  const again = loadHome(env);
  assert.equal(again.bridgeToken, first.bridgeToken, "the same secrets from the store at the next start");
  assert.equal(again.secretsProblem, undefined);
  const marker = readFileSync(join(dir, "secrets.json"), "utf8");
  const items = new Map(s.items);

  s.failGet = true;
  useStoreForTests(s.store);
  assert.equal(readSecrets(dir), null);
  assert.match(secretsProblem(dir) ?? "", /locked/);
  const locked = loadHome(env);
  assert.ok(locked.secretsProblem);
  assert.notEqual(locked.bridgeToken, first.bridgeToken, "temporary, never the old ones guessed");
  assert.equal(locked.firstRun, false, "not a first run: the store guard must not take this for a new home");
  assert.equal(readFileSync(join(dir, "secrets.json"), "utf8"), marker, "the marker is left as it was");
  assert.deepEqual(s.items, items, "and nothing in the store was written over");
  // Nothing is saved while it cannot be read.
  const settings = createSettings(dir, env);
  assert.equal(settings.setTelegramToken!("123:abc"), false);
  assert.equal(writeStored(dir, { AGENTMAIL_INBOX: "x@agentmail.to" }), false);
  assert.equal(readStored(dir), null);
  assert.throws(() => writeSecrets(dir, {}), StoreError);

  // A missing entry is no better than a locked store: the secrets are not whole.
  s.failGet = false;
  s.items.delete(`${folderAccount(dir)}:panelSecret`);
  useStoreForTests(s.store);
  assert.equal(readSecrets(dir), null);
  assert.match(secretsProblem(dir) ?? "", /panelSecret is missing/);
  // A folder copied from a Mac to Linux: its marker names a store this system does not have.
  writeFileSync(join(dir, "secrets.json"), marker.replace('"keychain"', '"libsecret"'));
  assert.equal(readSecrets(dir), null);
});

test("the start tells the owner in the chat when the secrets cannot be read", async () => {
  const { unreadableNotice } = await import("../src/secrets.ts");
  assert.match(unreadableNotice("en", "keychain", "locked"), /the macOS keychain \(locked\)/);
  assert.match(unreadableNotice("en", "wincred", "x"), /the Windows Credential Manager \(x\)/);
  const server = readFileSync(new URL("src/server.ts", root), "utf8");
  assert.match(server, /home\.secretsProblem[\s\S]{0,200}local\.channel\.push\("pako", unreadableNotice\(/);
});

// ---------- every path that reads them ----------

test("the settings and the connections read and write through the store, and the file never holds a value", () => {
  const dir = home();
  const env = { PAKO_HOME: dir, ...KEYCHAIN };
  const s = stub();
  useStoreForTests(s.store);
  loadHome(env);
  const settings = createSettings(dir, env);
  assert.equal(settings.setTelegramToken!(SAMPLE.telegramBotToken), true);
  assert.equal(settings.telegramToken!(), SAMPLE.telegramBotToken);
  assert.equal(settings.setWhatsapp!(SAMPLE.whatsappComputer), true);
  assert.deepEqual(settings.whatsapp!(), SAMPLE.whatsappComputer);
  assert.equal(writeStored(dir, { AGENTMAIL_API_KEY: SAMPLE.settings.AGENTMAIL_API_KEY }), true);
  assert.deepEqual(readStored(dir), { AGENTMAIL_API_KEY: SAMPLE.settings.AGENTMAIL_API_KEY });
  const text = readFileSync(join(dir, "secrets.json"), "utf8");
  for (const v of [SAMPLE.telegramBotToken, SAMPLE.whatsappComputer.accessToken, SAMPLE.settings.AGENTMAIL_API_KEY]) assert.ok(!text.includes(v));
  assert.equal(settings.setWhatsapp!(null), true);
  assert.equal(settings.whatsapp!(), null);
  assert.ok(![...s.items.keys()].some((k) => k.endsWith(":whatsappComputer")), "forgotten in the store too");
  // Another process writing (a second start): the marker changes, and this one reads the store again.
  const before = readFileSync(join(dir, "secrets.json"), "utf8");
  const raw = JSON.parse(before) as Record<string, unknown>;
  s.items.set(`${raw._account}:telegramBotToken`, JSON.stringify("999:other"));
  writeFileSync(join(dir, "secrets.json"), JSON.stringify({ ...raw, _rev: "elsewhere" }));
  assert.equal(settings.telegramToken!(), "999:other");
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("export carries no secret from the store, delete everything removes the store's entries but the three, the privacy page says where they are", async () => {
  const dir = join(home(), "home");
  const s = stub();
  useStoreForTests(s.store);
  const h = loadHome({ PAKO_HOME: dir, PAKO_NAME: "Ana", ...KEYCHAIN });
  writeSecrets(dir, { ...readSecrets(dir), telegramBotToken: SAMPLE.telegramBotToken, settings: SAMPLE.settings });
  const env: Record<string, string | undefined> = { ...localEnv({}, h, 0), PAKO_HOME: dir };
  const kv = sqliteKv(dir);
  await kv.set("owner-memory", JSON.stringify({ notes: [{ at: 1, text: `the bot is ${SAMPLE.telegramBotToken}` }], calls: [] }), 3600);
  const local: LocalContext = { kv, channel: createLocalChannel({ kv }), bridgeToken: h.bridgeToken, panelSecret: h.panelSecret, bridge: { status: () => ({ claude: "ok", running: true }) } };
  const app = createApp(loadAppConfig(env), env, local);
  const server = createServer(app);
  try {
    const base = await listen(server);
    const login = await fetch((app.locals.panelLink as () => string)().replace(/^http:\/\/127\.0\.0\.1:\d+/, base), { redirect: "manual" });
    const headers = { cookie: (login.headers.get("set-cookie") ?? "").split(";")[0]!, "x-pako": "1", "content-type": "application/json" };
    const exported = await (await fetch(`${base}/panel/api/export`, { headers })).text();
    for (const v of [SAMPLE.telegramBotToken, SAMPLE.settings.AGENTMAIL_API_KEY, h.bridgeToken, h.panelSecret, h.callerToken]) {
      assert.ok(!exported.includes(v), "no secret, even one quoted in a note: the store's values are scrubbed as the file's were");
    }
    assert.match(exported, /AGENTMAIL_API_KEY/, "the connections set in the panel, by name");

    const p = privacy({ dir, env, lang: "en" });
    assert.match(p.files.find((f) => f.name === "secrets.json")!.what, /Only a marker: .* the macOS keychain/);

    {
      app.locals.restart = () => {};
      const r = await fetch(`${base}/panel/api/delete-all`, { method: "POST", headers, body: JSON.stringify({ confirm: "DELETE EVERYTHING" }) });
      assert.equal(r.status, 200);
      const out = (await r.json()) as { removed: string[]; kept: string[] };
      assert.ok(out.removed.some((x) => x.startsWith("keychain (Telegram, connections)")));
      assert.ok(out.kept.some((x) => /keychain|llavero/.test(x)), "the three kept, said where");
    }
    const acct = folderAccount(dir);
    assert.deepEqual([...s.items.keys()].sort(), [`${acct}:bridgeToken`, `${acct}:callerToken`, `${acct}:panelSecret`], "Telegram and the connections gone from the store");
    assert.deepEqual(readSecrets(dir), { bridgeToken: h.bridgeToken, callerToken: h.callerToken, panelSecret: h.panelSecret });
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("npm run panel's reader prints the bridge token from the file, and nothing when there is none", () => {
  const dir = home();
  writeFileSync(join(dir, "secrets.json"), JSON.stringify(SAMPLE));
  const reader = new URL("src/bridge-token.ts", root).pathname;
  const ok = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", reader, dir], { encoding: "utf8", timeout: 30_000 });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, SAMPLE.bridgeToken);
  const none = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", reader, home()], { encoding: "utf8", timeout: 30_000 });
  assert.equal(none.status, 1);
  assert.equal(none.stdout, "");
  // panel.cjs and the Mac app read the keychain with security, by the marker's own names, the value on a pipe.
  const panel = readFileSync(new URL("bin/panel.cjs", root), "utf8");
  assert.match(panel, /"find-generic-password", "-s", marker\._service, "-a", marker\._account \+ ":bridgeToken", "-w"/);
  const swift = readFileSync(new URL("desktop/mac/Pako.swift", root), "utf8");
  assert.match(swift, /run\("\/usr\/bin\/security", \["find-generic-password", "-s", service, "-a", "\\\(account\):bridgeToken", "-w"\], timeout: 5\)/);
});

// ---------- the real keychain, on a Mac ----------

/** A throwaway service name, so nothing here can meet the owner's own items; null when this Mac's keychain cannot be used (CI, SSH). */
function realKeychain(): string | null {
  // Opt-in: a test run must not write to the keychain of whoever runs the suite (a contributor, a reviewer). PAKO_TEST_KEYCHAIN=1 turns it on.
  if (process.env.PAKO_TEST_KEYCHAIN !== "1") return null;
  if (process.platform !== "darwin" || !existsSync(SECURITY)) return null;
  const service = `pako-test-${randomBytes(6).toString("hex")}`;
  try {
    const s = macStore(service);
    s.set([["probe", "\"1\""]]);
    const ok = s.get(["probe"]).get("probe") === "\"1\"";
    s.remove(["probe"]);
    return ok ? service : null;
  } catch {
    return null;
  }
}

const service = realKeychain();
const written: { service: string; accounts: string[] }[] = [];
after(() => {
  // Whatever happened, nothing this file wrote stays in the keychain.
  for (const w of written) {
    try {
      macStore(w.service).remove(w.accounts);
    } catch {
      /* the keychain went away: nothing to remove from it */
    }
  }
});

test("the real login keychain: a move, a read through the marker, the reader npm run panel uses, a move back, nothing left", { skip: service ? false : "set PAKO_TEST_KEYCHAIN=1 on a Mac with an unlocked login keychain to run it" }, () => {
  const dir = home();
  writeFileSync(join(dir, "secrets.json"), JSON.stringify(SAMPLE));
  useStoreForTests(null);
  const acct = folderAccount(dir);
  written.push({ service: service!, accounts: Object.keys(SAMPLE).map((k) => `${acct}:${k}`) });
  const moved = settleSecrets(dir, KEYCHAIN, { service: service! });
  assert.equal(moved.where, "keychain", moved.problem ?? "moved");
  assert.equal(file(dir)._service, service);
  assert.ok(!readFileSync(join(dir, "secrets.json"), "utf8").includes(SAMPLE.bridgeToken));
  assert.deepEqual(readSecrets(dir), SAMPLE, "accents and emoji come back as they went in");
  const viaSecurity = spawnSync(SECURITY, ["find-generic-password", "-s", service!, "-a", `${acct}:bridgeToken`, "-w"], { encoding: "utf8", timeout: 5000 });
  assert.equal(JSON.parse(viaSecurity.stdout.trim()), SAMPLE.bridgeToken, "what the Mac app and panel.cjs read");
  const reader = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", new URL("src/bridge-token.ts", root).pathname, dir], { encoding: "utf8", timeout: 30_000 });
  assert.equal(reader.stdout, SAMPLE.bridgeToken);
  writeSecrets(dir, { ...SAMPLE, telegramBotToken: "456:new" });
  assert.equal((readSecrets(dir) as typeof SAMPLE).telegramBotToken, "456:new");
  const back = settleSecrets(dir, { PAKO_SECRET_STORE: "file" });
  assert.equal(back.where, "file");
  assert.equal(back.problem, undefined);
  assert.deepEqual(file(dir), { ...SAMPLE, telegramBotToken: "456:new" });
  assert.deepEqual([...macStore(service!).get(written[0]!.accounts).values()].filter((v) => v !== null), [], "nothing left in the keychain");
  rmSync(dir, { recursive: true, force: true });
});
