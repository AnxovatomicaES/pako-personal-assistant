// Whole-record JSON in the store (src/json-record.ts): a record that no longer parses is kept aside and told about, never written over
// silently; and at home there is one writer per store (the server, under the folder's lock), its changes one at a time.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { mountStore } from "../src/followups/store.ts";
import type { Engine } from "../src/followups/parts.ts";
import { CORRUPT_TTL_S, corruptNotice, onCorruptRecord, readJsonRecord, resetCorruptRecords, type CorruptRecord } from "../src/json-record.ts";
import type { Kv } from "../src/kv.ts";
import { lockHome } from "../src/local.ts";
import { sqliteKv } from "../src/sqlite-kv.ts";

afterEach(() => resetCorruptRecords());

/** A store in memory that remembers each write's time to live, and can be told to refuse writes. */
function memoryKv(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  const ttl = new Map<string, number>();
  let refuse = false;
  const kv: Kv = {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v, t) => {
      if (refuse) throw new Error("read-only");
      m.set(k, v);
      ttl.set(k, t);
    },
  };
  return { kv, m, ttl, refuse: (on: boolean) => void (refuse = on) };
}

const BAD = '{"loops":[{"id":"l1","text":"call the bank"'; // cut short

test("a record that does not parse is kept aside as it was, told once, and reads as none; a good one reads as it is", async () => {
  const s = memoryKv({ followups: BAD, good: '{"a":1}', empty: "" });
  const told: CorruptRecord[] = [];
  assert.deepEqual(await readJsonRecord(s.kv, "good"), { a: 1 });
  assert.equal(await readJsonRecord(s.kv, "missing"), undefined);
  assert.equal(await readJsonRecord(s.kv, "empty"), undefined, "an emptied key (\"\") is none, not damage");
  assert.equal(await readJsonRecord(s.kv, "followups", { onCorrupt: (c) => told.push(c), now: () => 1234 }), undefined);
  assert.deepEqual(told, [{ key: "followups", aside: "corrupt:followups:1234", bytes: BAD.length, at: 1234 }]);
  assert.equal(s.m.get("corrupt:followups:1234"), BAD, "the damaged value, byte for byte");
  assert.equal(s.ttl.get("corrupt:followups:1234"), CORRUPT_TTL_S);
  assert.equal(s.m.get("followups"), BAD, "reading changes nothing in the record itself");
  // The same damage read again: not kept aside twice, not told twice.
  assert.equal(await readJsonRecord(s.kv, "followups", { onCorrupt: (c) => told.push(c), now: () => 5678 }), undefined);
  assert.equal(told.length, 1);
  assert.equal([...s.m.keys()].filter((k) => k.startsWith("corrupt:")).length, 1);
  // Other damage in the same record later: kept and told again.
  s.m.set("followups", "{nope");
  await readJsonRecord(s.kv, "followups", { onCorrupt: (c) => told.push(c), now: () => 9999 });
  assert.equal(told.length, 2);
  assert.equal(s.m.get("corrupt:followups:9999"), "{nope");
  assert.match(corruptNotice(told[0]!), /^⚠️ Part of what I keep \(followups\) was damaged .* \(corrupt:followups:1234, for 180 days\)/);
});

test("damage found before anyone listens is told when the owner's chat is there; the listener hears later damage at once", async () => {
  const s = memoryKv({ a: "[", b: "{" });
  await readJsonRecord(s.kv, "a");
  const told: string[] = [];
  onCorruptRecord((c) => told.push(c.key));
  assert.deepEqual(told, ["a"]);
  await readJsonRecord(s.kv, "b");
  assert.deepEqual(told, ["a", "b"]);
});

test("a damaged record that cannot be kept aside is not written over: the read fails, and so does the change that needed it", async () => {
  const s = memoryKv({ followups: BAD });
  s.refuse(true);
  await assert.rejects(readJsonRecord(s.kv, "followups"), /damaged and could not be kept aside/);
  const store = mountStore({ d: { kv: s.kv }, now: () => 1_000 } as unknown as Engine);
  await assert.rejects(store.mutate((st) => void st.mailRead.push("m1")));
  assert.equal(s.m.get("followups"), BAD, "the damaged value stays where it was");
});

test("follow-ups: a damaged record is kept aside and the owner told before the next change starts it again", async () => {
  const s = memoryKv({ followups: BAD });
  const told: CorruptRecord[] = [];
  onCorruptRecord((c) => told.push(c));
  const store = mountStore({ d: { kv: s.kv }, now: () => 1_000 } as unknown as Engine);
  await store.mutate((st) => void st.mailRead.push("m1"));
  assert.equal(told.length, 1, "told once");
  const aside = [...s.m.entries()].find(([k]) => k.startsWith("corrupt:followups:"));
  assert.equal(aside?.[1], BAD, "the lost record is still there to recover");
  assert.deepEqual((JSON.parse(s.m.get("followups")!) as { mailRead: string[] }).mailRead, ["m1"]);
  await store.mutate((st) => void st.mailRead.push("m2"));
  assert.equal(told.length, 1, "a good record now: nothing more to tell");
});

test("the file store at home: a damaged record's copy is kept in kv.db, beside the fresh record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pako-json-record-"));
  const kv = sqliteKv(dir);
  await kv.set("assistant-lists", "{broken", 3600);
  assert.equal(await readJsonRecord(kv, "assistant-lists", { onCorrupt: () => undefined, now: () => 42 }), undefined);
  await kv.set("assistant-lists", JSON.stringify({ lists: [], tasks: [] }), 3600);
  assert.equal(await kv.get("corrupt:assistant-lists:42"), "{broken");
});

test("concurrent writers in one process: changes to a record go one at a time, none lost", async () => {
  const s = memoryKv();
  // A slow store: every read and write waits a little, so unserialised read-change-write cycles would overwrite each other.
  const slow: Kv = {
    get: async (k) => (await new Promise((r) => setTimeout(r, 5)), s.kv.get(k)),
    set: async (k, v, t) => (await new Promise((r) => setTimeout(r, 5)), s.kv.set(k, v, t)),
  };
  const a = mountStore({ d: { kv: slow }, now: () => 1_000 } as unknown as Engine);
  await Promise.all(Array.from({ length: 20 }, (_, i) => a.mutate((st) => void st.mailRead.push(`m${i}`))));
  assert.equal((JSON.parse(s.m.get("followups")!) as { mailRead: string[] }).mailRead.length, 20);
});

test("one writer per store at home: a second Pako cannot take the folder, and only the server opens kv.db, after taking the lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "pako-one-writer-"));
  const release = lockHome(dir, 8787);
  try {
    // Another process (test/home-lock-child.ts, as a second `npm start` would): refused while this one holds the folder.
    const child = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "home-lock-child.ts"), dir, "0"], {
      encoding: "utf8",
    });
    assert.match(child.stdout, /^REFUSED /, child.stdout + child.stderr);
  } finally {
    release();
  }
  // Every place that opens the file store: the server alone, and only after lockHome.
  const root = new URL("../", import.meta.url);
  const files = (dir: string): string[] =>
    readdirSync(new URL(dir, root)).flatMap((f) => {
      const path = `${dir}${f}`;
      if (f === "node_modules" || f === "fixtures") return [];
      if (statSync(new URL(path, root)).isDirectory()) return files(`${path}/`);
      return /\.(ts|cjs|mjs|js|swift|sh)$/.test(f) ? [path] : [];
    });
  const openers = files("src/").filter((f) => f !== "src/sqlite-kv.ts" && /\bsqliteKv\(/.test(readFileSync(new URL(f, root), "utf8")));
  assert.deepEqual(openers, ["src/server.ts"]);
  const server = readFileSync(new URL("src/server.ts", root), "utf8");
  assert.ok(server.indexOf("lockHome(home.dir") > 0 && server.indexOf("lockHome(home.dir") < server.indexOf("sqliteKv(home.dir)"));
  // The bridge, the panel command and the Mac app never open the store.
  for (const f of [...files("assistant/"), ...files("bin/"), ...files("desktop/")]) {
    assert.doesNotMatch(readFileSync(new URL(f, root), "utf8"), /kv\.db\b|sqlite-kv|sqliteKv/, f);
  }
});
