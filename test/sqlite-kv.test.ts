import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openForeignReadOnly, SET_ASIDE_COPY, sqlite, sqliteKv, StoreUnavailable } from "../src/sqlite-kv.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "pako-sqlite-"));

test("sqliteKv: values are on disk when set returns, survive a restart, expire on time, and the file is private", async () => {
  const dir = tmp();
  let t = 1_000_000;
  const a = sqliteKv(dir, () => t);
  await a.set("note", "hola", 60);
  await a.set("forever", "x", 0);
  // No wait: a second opening of the same folder sees both at once (each write is committed, nothing is pending).
  const b = sqliteKv(dir, () => t);
  assert.equal(b.lost, null);
  assert.equal(await b.get("note"), "hola");
  assert.equal(statSync(join(dir, "kv.db")).mode & 0o777, 0o600, "kv.db is readable by its owner only");
  assert.ok(existsSync(join(dir, "kv.db.made")), "the mark that this store existed");
  t += 61_000;
  assert.equal(await b.get("note"), null, "expired");
  assert.equal(await b.get("forever"), "x");
  assert.equal(await b.get("never"), null);
  assert.deepEqual(b.entries().map((e) => [e.key, e.value, e.expires]), [["forever", "x", null]]);
});

test("sqliteKv: an expired key nobody reads again is deleted from the file (privacy.md: 'deleted by itself')", async () => {
  const dir = tmp();
  let t = 1_000_000;
  const a = sqliteKv(dir, () => t);
  await a.set("voice-result:call_1", "transcript", 30 * 24 * 3600);
  t += 60 * 24 * 3600 * 1000;
  sqliteKv(dir, () => t); // a later start
  const raw = readFileSync(join(dir, "kv.db"));
  assert.ok(!raw.includes(Buffer.from("transcript")), "the transcript's text is still in kv.db after its 30 days ran out");
});

test("sqliteKv: an older Pako's kv.json is copied in once, expired entries left out, checked, and then deleted (no plaintext copy left)", async () => {
  const dir = tmp();
  const t = 5_000_000;
  writeFileSync(join(dir, "kv.json"), JSON.stringify({ note: { v: "hola", exp: 0 }, old: { v: "gone", exp: 10 }, bad: { v: 3, exp: 0 } }));
  writeFileSync(join(dir, "kv.json.made"), "x");
  const kv = sqliteKv(dir, () => t);
  assert.equal(kv.lost, null, "a migration is not a lost store");
  assert.equal(await kv.get("note"), "hola");
  assert.equal(await kv.get("old"), null);
  assert.equal(await kv.get("bad"), null);
  assert.ok(!existsSync(join(dir, "kv.json")) && !existsSync(join(dir, "kv.json.migrated")), "the old plaintext file is gone once the copy is checked");
  assert.ok(!existsSync(join(dir, "kv.json.made")) && existsSync(join(dir, "kv.db.made")));
  // The next start reads kv.db and does not copy anything again.
  writeFileSync(join(dir, "kv.json"), JSON.stringify({ note: { v: "stale", exp: 0 } }));
  assert.equal(await sqliteKv(dir, () => t).get("note"), "hola");
});

test("sqliteKv: a copy of kv.json that stopped halfway (an empty kv.db beside it) is done again at the next start, not lost", async () => {
  const dir = tmp();
  const t = 5_000_000;
  // What a stop inside the copy's transaction leaves: kv.db made, with its table and nothing in it (SQLite rolled back), and kv.json as it was.
  sqliteKv(dir, () => t);
  rmSync(join(dir, "kv.db.made"), { force: true });
  writeFileSync(join(dir, "kv.json"), JSON.stringify({ note: { v: "hola", exp: 0 } }));
  writeFileSync(join(dir, "kv.json.made"), "x");
  const kv = sqliteKv(dir, () => t);
  assert.equal(await kv.get("note"), "hola", "the person's things were left behind in kv.json and Pako started empty");
  assert.equal(kv.lost, null);
  assert.ok(!existsSync(join(dir, "kv.json")), "copied and checked: the plaintext file is gone");
});

test("sqliteKv: a kv.json left beside kv.db by a stop right after the copy is deleted at the next start, once kv.db is seen to hold it", async () => {
  const dir = tmp();
  const t = 5_000_000;
  const old = JSON.stringify({ note: { v: "hola", exp: 0 }, list: { v: "[1,2]", exp: 9_000_000 }, gone: { v: "x", exp: 10 } });
  writeFileSync(join(dir, "kv.json"), old);
  sqliteKv(dir, () => t);
  // The copy was made and checked, and Pako stopped before the old file was deleted: it is still there at the next start.
  writeFileSync(join(dir, "kv.json"), old);
  writeFileSync(join(dir, "kv.json.made"), "x");
  const kv = sqliteKv(dir, () => t + 1000);
  assert.equal(await kv.get("note"), "hola");
  assert.equal(kv.lost, null);
  assert.ok(!existsSync(join(dir, "kv.json")) && !existsSync(join(dir, "kv.json.made")), "no plaintext copy left behind");
  assert.ok(!existsSync(join(dir, "kv.json.migrated")));
  // One that does not match what kv.db holds is not deleted unseen: kept aside as kv.json.migrated, as a copy that did not match is.
  writeFileSync(join(dir, "kv.json"), JSON.stringify({ note: { v: "something else", exp: 0 } }));
  assert.equal(await sqliteKv(dir, () => t).get("note"), "hola");
  assert.ok(!existsSync(join(dir, "kv.json")) && existsSync(join(dir, "kv.json.migrated")));
});

test("sqliteKv: a store that existed and is gone starts as 'missing', for kv.db and for an older Pako's kv.json", () => {
  const a = tmp();
  writeFileSync(join(a, "kv.db.made"), "x");
  assert.equal(sqliteKv(a).lost, "missing");
  const b = tmp();
  writeFileSync(join(b, "kv.json.made"), "x");
  assert.equal(sqliteKv(b).lost, "missing");
  assert.equal(sqliteKv(tmp()).lost, null, "a first run is not a loss");
});

test("sqliteKv: a damaged kv.db is kept aside as kv.db.bad and Pako starts with an empty one; a damaged kv.json as kv.json.bad", async () => {
  const a = tmp();
  writeFileSync(join(a, "kv.db"), "this is not a database at all, just text that is long enough to have a header".repeat(20));
  const kv = sqliteKv(a);
  assert.equal(kv.lost, "damaged");
  assert.ok(existsSync(join(a, "kv.db.bad")), "the damaged file is still there to look at");
  await kv.set("b", "1", 0);
  assert.equal(await kv.get("b"), "1");
  const b = tmp();
  writeFileSync(join(b, "kv.json"), '{"a":{"v":"x","exp":0},');
  assert.equal(sqliteKv(b).lost, "damaged");
  assert.ok(existsSync(join(b, "kv.json.bad")));
});

// A store that is only busy, or that this process cannot open, is not a damaged one: it stays where it is with its journal, nothing starts on
// an empty store beside it, and a later damage never writes over an older copy.
const asRoot = process.getuid?.() === 0 || process.platform === "win32" ? "run as root or on Windows, where a file always opens" : false;
const noWarn = (): (() => void) => {
  const errors = console.error;
  console.error = () => undefined;
  return () => void (console.error = errors);
};

test("sqliteKv: a kv.db another process is in the middle of writing is busy, not damaged: nothing moves, its journal stays, and it opens when the write is done", async () => {
  const dir = tmp();
  const first = sqliteKv(dir);
  await first.set("assistant-reminders", JSON.stringify([{ text: "call mum" }]), 0);
  await first.set("owner-memory", "notes", 0);
  const Db = sqlite();
  const holder = new Db(join(dir, "kv.db"));
  holder.exec("BEGIN EXCLUSIVE");
  holder.prepare("INSERT INTO kv (k, v, exp) VALUES (?, ?, 0) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run("owner-memory", "written during the lock");
  const files = (): string => readdirSync(dir).sort().join(" ");
  const before = files();
  assert.ok(existsSync(join(dir, "kv.db-journal")), "the holder's journal is there (a write in the middle)");
  const done = noWarn();
  try {
    assert.throws(() => sqliteKv(dir, Date.now, 0), (err: unknown) => err instanceof StoreUnavailable && /another program is using it/.test(err.message) && /Nothing was changed/.test(err.message));
    // And again: the second failure must not have anything left to destroy.
    assert.throws(() => sqliteKv(dir, Date.now, 0), StoreUnavailable);
  } finally {
    done();
  }
  assert.equal(files(), before, "no kv.db.bad, no journal removed, no new file");
  holder.exec("COMMIT");
  holder.close();
  const again = sqliteKv(dir);
  assert.equal(again.lost, null, "not lost, not damaged: no pause, no 'damaged' notice");
  assert.deepEqual(again.entries().map((e) => [e.key, e.value]), [["assistant-reminders", JSON.stringify([{ text: "call mum" }])], ["owner-memory", "written during the lock"]]);
  assert.ok(!existsSync(join(dir, "kv.db.bad")));
});

test("sqliteKv: a kv.db that is busy for a moment is waited for when it opens, and opens with everything in it", async () => {
  const dir = tmp();
  const first = sqliteKv(dir);
  await first.set("owner-memory", "notes", 0);
  // Another process holds the file and lets go 300 ms after saying so; this one is blocked inside sqliteKv while it waits (the open is synchronous).
  const CHILD = `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN EXCLUSIVE");
db.prepare("INSERT INTO kv (k, v, exp) VALUES (?, ?, 0) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run("owner-memory", "written during the lock");
console.log("holding");
setTimeout(() => { db.exec("COMMIT"); db.close(); }, 300);`;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", CHILD, join(dir, "kv.db")], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((r) => child.stdout.once("data", r));
  const kv = sqliteKv(dir, Date.now, 20_000);
  assert.equal(kv.lost, null);
  assert.equal(await kv.get("owner-memory"), "written during the lock", "the write that held it was waited for, not cut off");
  assert.ok(!existsSync(join(dir, "kv.db.bad")));
  await new Promise((r) => child.once("exit", r));
  await kv.set("after", "1", 0);
  assert.equal(await kv.get("after"), "1", "and a write afterwards fails at once as it did, not after the wait: the wait was for opening");
});

test("sqliteKv: a kv.db this process has no permission to open is not damaged: nothing moves, and it opens again when it can", { skip: asRoot }, async () => {
  const dir = tmp();
  const first = sqliteKv(dir);
  await first.set("owner-memory", "notes", 0);
  const before = readFileSync(join(dir, "kv.db"));
  chmodSync(join(dir, "kv.db"), 0o000);
  const done = noWarn();
  try {
    assert.throws(() => sqliteKv(dir), (err: unknown) => err instanceof StoreUnavailable && /no permission/.test(err.message));
  } finally {
    done();
    chmodSync(join(dir, "kv.db"), 0o600);
  }
  assert.ok(!existsSync(join(dir, "kv.db.bad")), "not set aside");
  assert.deepEqual(readFileSync(join(dir, "kv.db")), before, "not emptied");
  const again = sqliteKv(dir);
  assert.equal(again.lost, null);
  assert.equal(await again.get("owner-memory"), "notes");
});

test("sqliteKv: server.ts says why the store cannot be opened and stops, without starting on an empty one", () => {
  const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.match(server, /kv = sqliteKv\(home\.dir\);[\s\S]{0,200}err instanceof StoreUnavailable[\s\S]{0,600}console\.error\([\s\S]{0,40}process\.exit\(1\)/);
});

test("sqliteKv: a second damage never writes over the first kv.db.bad: the older copies keep a dated name", () => {
  const dir = tmp();
  const done = noWarn();
  try {
    let t = Date.UTC(2026, 10, 1, 9);
    for (const word of ["first", "second", "third", "fourth"]) {
      writeFileSync(join(dir, "kv.db"), `${word}: not a database, just text that is long enough to have a header`.repeat(20));
      // "fourth" damages at the very same instant as "third": the dated name must still be a new one.
      if (word !== "fourth") t += 3600_000;
      assert.equal(sqliteKv(dir, () => t).lost, "damaged");
      rmSync(join(dir, "kv.db"));
      rmSync(join(dir, "kv.db.made"), { force: true });
    }
  } finally {
    done();
  }
  const copies = readdirSync(dir).filter((f) => SET_ASIDE_COPY.test(f)).sort();
  const text = (f: string): string => readFileSync(join(dir, f), "utf8").slice(0, 7);
  assert.equal(text("kv.db.bad"), "fourth:", "the newest damage is kv.db.bad");
  const dated = copies.filter((f) => f !== "kv.db.bad");
  assert.deepEqual(dated.map(text).sort(), ["first: ", "second:", "third: "], "every older one is still there, under a name with the day and time it was displaced");
  assert.ok(dated.every((f) => /^kv\.db\.bad\.2026-11-01T\d\d-00-00-000Z(-\d+)?$/.test(f)), dated.join(" "));
});

test("sqliteKv: a damaged kv.json never writes over an older kv.json.bad either", () => {
  const dir = tmp();
  const done = noWarn();
  try {
    writeFileSync(join(dir, "kv.json"), '{"a":{"v":"x","exp":0},');
    assert.equal(sqliteKv(dir, () => Date.UTC(2026, 10, 1)).lost, "damaged");
    rmSync(join(dir, "kv.db"));
    rmSync(join(dir, "kv.db.made"), { force: true });
    writeFileSync(join(dir, "kv.json"), '{"b":{"v":"y","exp":0},');
    assert.equal(sqliteKv(dir, () => Date.UTC(2026, 10, 2)).lost, "damaged");
  } finally {
    done();
  }
  assert.equal(readFileSync(join(dir, "kv.json.bad"), "utf8"), '{"b":{"v":"y","exp":0},');
  const older = readdirSync(dir).filter((f) => /^kv\.json\.bad\./.test(f) && SET_ASIDE_COPY.test(f));
  assert.equal(older.length, 1);
  assert.equal(readFileSync(join(dir, older[0]!), "utf8"), '{"a":{"v":"x","exp":0},');
});

test("sqliteKv: wipe keeps only the given line, and the store takes no more writes until the next start", async () => {
  const dir = tmp();
  const kv = sqliteKv(dir);
  await kv.set("note", "secret", 0);
  assert.equal(kv.wipe([{ key: "assistant-log", value: "[]", ttlSeconds: 0 }]), true);
  await kv.set("late", "write from a module's copy", 0);
  assert.equal(await kv.add!("claim", "1", 60), false);
  const next = sqliteKv(dir);
  assert.deepEqual(next.entries().map((e) => e.key), ["assistant-log"]);
  assert.ok(!readFileSync(join(dir, "kv.db")).includes(Buffer.from("secret")), "the wiped value is not left in the file");
});

test("sqliteKv: add writes only when the key is free or expired; onSave hears each write", async () => {
  let t = 0;
  const kv = sqliteKv(tmp(), () => t);
  const saves: boolean[] = [];
  kv.onSave((ok) => saves.push(ok));
  assert.equal(await kv.add!("job", "a", 10), true);
  assert.equal(await kv.add!("job", "b", 10), false);
  t += 11_000;
  assert.equal(await kv.add!("job", "c", 10), true);
  assert.equal(await kv.get("job"), "c");
  assert.ok(saves.length >= 2 && saves.every(Boolean));
});

test("sqliteKv: a write that fails rejects, is kept as a failing state, told in plain words even to who listens later, and cleared by a good write",
  { skip: process.platform === "win32" }, async () => {
    const dir = tmp();
    const kv = sqliteKv(dir);
    const errors = console.error;
    console.error = () => undefined;
    try {
      chmodSync(dir, 0o500); // a folder it can no longer write in: SQLite cannot make its journal
      // The write rejects, as the hosted store's does: the caller knows it was not saved (it resolved before, silently).
      await assert.rejects(kv.set("a", "1", 0), /could not save: the disk is full, or the Pako folder cannot be written to/);
    } finally {
      chmodSync(dir, 0o700);
      console.error = errors;
    }
    assert.equal(await kv.get("a"), null);
    // The watchdog listens only once the app is built: a write that failed before is told to it then.
    const saves: [boolean, string | undefined][] = [];
    kv.onSave((ok, detail) => saves.push([ok, detail]));
    assert.deepEqual(saves, [[false, "the disk is full, or the Pako folder cannot be written to"]]);
    await kv.set("a", "1", 0);
    assert.deepEqual(saves.at(-1), [true, undefined], "writes work again: cleared");
  });

test("sqliteKv: opening it prints no 'experimental' warning to the person", () => {
  const dir = tmp();
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import { sqliteKv } from ${JSON.stringify(new URL("../src/sqlite-kv.ts", import.meta.url).href)}; const kv = sqliteKv(${JSON.stringify(dir)}); await kv.set("a", "1", 0); process.emitWarning("other warning");`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/experimental/i.test(r.stderr), r.stderr);
  assert.match(r.stderr, /other warning/, "other warnings still show");
});

test("another app's database, read only: nothing is written beside it when that app is closed, and its live log is read when it runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "pako-foreign-"));
  const path = join(dir, "their.db");
  const Db = sqlite();
  const w = new Db(path);
  w.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);");
  w.close(); // the app quits: SQLite folds its log back in and removes -wal and -shm
  assert.equal(existsSync(`${path}-wal`), false);
  const before = readFileSync(path);
  const r = openForeignReadOnly(path);
  assert.equal((r.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n, 1);
  assert.throws(() => r.exec("INSERT INTO t VALUES (2)"), "no statement can change it");
  r.close();
  assert.equal(existsSync(`${path}-wal`), false, "no empty -wal left behind");
  assert.equal(existsSync(`${path}-shm`), false, "no empty -shm left behind");
  assert.deepEqual(readFileSync(path), before, "the file itself is untouched");
  // The app running again (its log beside the file): its newest rows are seen through it.
  const live = new Db(path);
  live.exec("PRAGMA journal_mode = WAL; INSERT INTO t VALUES (3);");
  const r2 = openForeignReadOnly(path);
  assert.equal((r2.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n, 2);
  r2.close();
  live.close();
});
