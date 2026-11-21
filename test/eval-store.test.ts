// The evals' and the beta report's reading of a Pako folder (test/evals/from-feedback.ts readStore): the store is kv.db (SQLite) since
// 0.3.0, and kv.json is deleted once copied in. Reading only kv.json made npm run beta:report, evals:from-feedback and evals:promote fail
// on every current install ("cannot read kv.json").

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sqliteKv } from "../src/sqlite-kv.ts";
import { readStore } from "./evals/from-feedback.ts";

test("eval store: a current install's kv.db is read, expired entries left out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pako-evalstore-"));
  try {
    const kv = sqliteKv(dir);
    await kv.set("feedback", JSON.stringify([{ verdict: "up" }]), 0);
    await kv.set("gone", JSON.stringify(1), 1);
    const get = readStore(dir, Date.now() + 5000);
    assert.deepEqual(get("feedback"), [{ verdict: "up" }]);
    assert.equal(get("gone"), null, "expired");
    assert.equal(get("never-set"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("eval store: an older install's kv.json is still read when there is no kv.db", () => {
  const dir = mkdtempSync(join(tmpdir(), "pako-evalstore-"));
  try {
    writeFileSync(join(dir, "kv.json"), JSON.stringify({ feedback: { v: JSON.stringify([1]), exp: 0 } }));
    assert.deepEqual(readStore(dir)("feedback"), [1]);
    assert.throws(() => readStore(join(dir, "nowhere")), /no Pako store/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
