import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openForeignReadOnly, sqlite, sqliteKv } from "../src/sqlite-kv.ts";

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
