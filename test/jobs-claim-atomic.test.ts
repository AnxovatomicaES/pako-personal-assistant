// Two servers on one store (a deploy's overlap): the jobs' claim must be atomic, or both run the same slot (src/jobs.ts, Kv.add).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claimKey, createJobs } from "../src/jobs.ts";
import { sqliteKv } from "../src/sqlite-kv.ts";
import type { Kv } from "../src/kv.ts";

/** One shared store with a network's latency, and SET NX as Redis has it. */
function sharedStore() {
  const m = new Map<string, { v: string; exp: number }>();
  const slow = { a: 0, b: 0 };
  const live = (k: string) => {
    const e = m.get(k);
    return e && e.exp > Date.now() ? e : undefined;
  };
  const kvFor = (who: "a" | "b", withAdd = true): Kv => ({
    get: async (k) => {
      const v = live(k)?.v ?? null;
      await new Promise((r) => setTimeout(r, slow[who]));
      return v;
    },
    set: async (k, v, ttl) => {
      await new Promise((r) => setTimeout(r, 1));
      m.set(k, { v, exp: Date.now() + ttl * 1000 });
    },
    ...(withAdd
      ? {
          add: async (k: string, v: string, ttl: number) => {
            await new Promise((r) => setTimeout(r, 1));
            if (live(k)) return false;
            m.set(k, { v, exp: Date.now() + ttl * 1000 });
            return true;
          },
        }
      : {}),
  });
  return { m, slow, kvFor };
}

test("two runners on one store with a slow read: the slot runs once, the other is busy", async () => {
  const { slow, kvFor } = sharedStore();
  const now = () => Date.parse("2026-11-17T09:00:10Z");
  const A = createJobs({ kv: kvFor("a"), now, sleeps: false, owner: "A" });
  const B = createJobs({ kv: kvFor("b"), now, sleeps: false, owner: "B" });
  slow.b = 20;
  let sends = 0;
  const run = async () => {
    sends++;
    await new Promise((r) => setTimeout(r, 30));
  };
  const pA = A.slot("reminder", "reminder:x@1", now() - 10_000, run);
  const pB = (async () => {
    const p = B.slot("reminder", "reminder:x@1", now() - 10_000, run);
    await new Promise((r) => setTimeout(r, 5));
    slow.b = 0;
    return p;
  })();
  const out = await Promise.all([pA, pB]);
  assert.equal(sends, 1, `sent ${sends} times; outcomes ${out}`);
  assert.deepEqual([...out].sort(), ["busy", "done"]);
});

test("the claim is let go when the run ends: a retry can take the slot again, and a slot done stays done without a new claim", async () => {
  const { m, kvFor } = sharedStore();
  const now = () => Date.parse("2026-11-17T09:00:10Z");
  const A = createJobs({ kv: kvFor("a"), now, sleeps: false, owner: "A" });
  let tries = 0;
  const first = await A.slot("routine", "r:1", now() - 1000, async () => {
    tries++;
    return "retry";
  });
  assert.equal(first, "retry");
  // Let go with a moment's expiry (the store has no delete).
  assert.equal(m.get(claimKey("r:1"))?.v, "");
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(await A.slot("routine", "r:1", now() - 1000, async () => void tries++), "done");
  assert.equal(tries, 2);
  m.delete(claimKey("r:1"));
  assert.equal(await A.slot("routine", "r:1", now() - 1000, async () => void tries++), "done");
  assert.equal(tries, 2);
  assert.equal(m.has(claimKey("r:1")), false, "a slot done takes no claim");
});

test("a claim another process holds makes the slot busy, and nothing is run", async () => {
  const { m, kvFor } = sharedStore();
  const now = () => Date.parse("2026-11-17T09:00:10Z");
  m.set(claimKey("brief:2026-11-17"), { v: "B:1:aa", exp: Date.now() + 60_000 });
  const A = createJobs({ kv: kvFor("a"), now, sleeps: false, owner: "A" });
  let ran = false;
  assert.equal(await A.slot("brief", "brief:2026-11-17", now() - 1000, async () => void (ran = true)), "busy");
  assert.equal(ran, false);
});

test("the file store's add writes only when the key is empty or expired", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pako-kvadd-"));
  try {
    let t = 1_000_000;
    const kv = sqliteKv(dir, () => t);
    assert.equal(await kv.add!("k", "a", 10), true);
    assert.equal(await kv.add!("k", "b", 10), false);
    assert.equal(await kv.get("k"), "a");
    t += 11_000;
    assert.equal(await kv.add!("k", "c", 10), true);
    assert.equal(await kv.get("k"), "c");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the app's store wrappers keep add: the server's store reaches the jobs with its SET NX", async () => {
  const { watchStore } = await import("../src/store-guard.ts");
  const { reportingKv } = await import("../src/watchdog.ts");
  const { kvFor } = sharedStore();
  const seen: boolean[] = [];
  const wrapped = watchStore(reportingKv(kvFor("a"), (ok) => void seen.push(ok))).kv!;
  assert.equal(await wrapped.add!("k", "v", 10), true);
  assert.equal(await wrapped.add!("k", "w", 10), false);
  assert.deepEqual(seen, [true, true]);
  assert.equal(watchStore(reportingKv(kvFor("a", false), () => undefined)).kv!.add, undefined, "a store without it stays without it");
});
