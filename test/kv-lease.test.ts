// The writer lease on the hosted Redis store (src/kv-lease.ts), against a fake Redis with its own clock: one server takes the lease and
// renews it, the other waits read only (its writes and claims skipped), takes over when the lease is released or runs out, and at no moment
// are both writers. And the real client sends the lease's commands as Redis expects them.

import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import test from "node:test";
import { loadKv, type Kv } from "../src/kv.ts";
import { createWriterLease, hasCommand, LEASE_KEY, RELEASE_SCRIPT, RENEW_SCRIPT } from "../src/kv-lease.ts";

/** A Redis in memory: GET, SET (EX, PX, NX), and EVAL for the lease's two scripts, with keys that expire on its clock. */
function fakeRedis() {
  const clock = { now: 1_000_000 };
  const data = new Map<string, { v: string; until: number }>();
  const seen: string[][] = [];
  let down = false;
  const live = (k: string) => {
    const e = data.get(k);
    if (e && e.until <= clock.now) data.delete(k);
    return data.get(k);
  };
  const setRaw = (args: string[]): string | null => {
    const [, k, v] = args as [string, string, string];
    const up = args.map((a) => a.toUpperCase());
    if (up.includes("NX") && live(k)) return null;
    const ex = up.indexOf("EX");
    const px = up.indexOf("PX");
    const until = px > 0 ? clock.now + Number(args[px + 1]) : ex > 0 ? clock.now + Number(args[ex + 1]) * 1000 : Infinity;
    data.set(k, { v, until });
    return "OK";
  };
  const command = async (args: string[]): Promise<string | number | null> => {
    seen.push(args);
    if (down) throw new Error("key value store: timed out");
    if (args[0] === "SET") return setRaw(args);
    if (args[0] === "GET") return live(args[1]!)?.v ?? null;
    if (args[0] === "EVAL") {
      const [, script, , k, id, ms] = args as [string, string, string, string, string, string?];
      const e = live(k);
      if (!e || e.v !== id) return 0;
      if (script === RENEW_SCRIPT) e.until = clock.now + Number(ms);
      else if (script === RELEASE_SCRIPT) data.delete(k);
      else throw new Error("unknown script");
      return 1;
    }
    throw new Error(`unknown command ${args[0]}`);
  };
  const kv: Kv & { command: typeof command } = {
    get: async (k) => (await command(["GET", k])) as string | null,
    set: async (k, v, ttl) => void (await command(["SET", k, v, "EX", String(ttl)])),
    add: async (k, v, ttl) => (await command(["SET", k, v, "NX", "EX", String(ttl)])) === "OK",
    command,
  };
  return { kv, clock, data, seen, setDown: (d: boolean) => (down = d), holder: () => live(LEASE_KEY)?.v ?? null };
}

const server = (r: ReturnType<typeof fakeRedis>, id: string, meanwhile?: () => Promise<void>) => {
  const said: string[] = [];
  // The sleep of a waiting write moves the fake clock (and lets the other server look): no real time passes in these tests.
  const sleep = async (ms: number) => {
    r.clock.now += ms;
    await meanwhile?.();
  };
  const lease = createWriterLease(r.kv, { id, now: () => r.clock.now, log: (t) => void said.push(t), sleep });
  return { lease, said };
};

test("lease: the first server takes it with SET NX PX, writes go through, and the renewal keeps it past its first term", async () => {
  const r = fakeRedis();
  const a = server(r, "A");
  await a.lease.ready;
  assert.equal(a.lease.writer(), true);
  assert.deepEqual(r.seen[0], ["SET", LEASE_KEY, "A", "NX", "PX", "30000"]);
  assert.match(a.said[0]!, /holds the store's writer lease \(A\)/);
  await a.lease.kv.set("note", "one", 60);
  assert.equal(r.data.get("note")?.v, "one");
  assert.equal(await a.lease.kv.add!("job-claim:x", "A", 60), true);
  for (let i = 0; i < 9; i++) {
    r.clock.now += 10_000;
    await a.lease.step();
  }
  assert.equal(a.lease.writer(), true, "renewed every 10 s, still the writer after 90 s");
  assert.equal(r.holder(), "A");
  assert.ok(r.seen.some((c) => c[0] === "EVAL" && c[1] === RENEW_SCRIPT && c[4] === "A" && c[5] === "30000"));
});

test("lease: a second server waits read only (claims answer taken, said once), then takes over when the first one stops", async () => {
  const r = fakeRedis();
  const a = server(r, "A");
  await a.lease.ready;
  const b = server(r, "B");
  await b.lease.ready;
  assert.equal(b.lease.writer(), false);
  assert.match(b.said[0]!, /another server writes the store \(A\)\. Read only/);
  assert.equal(await b.lease.kv.add!("job-claim:x", "B", 60), false, "a claim answers taken");
  assert.equal(await b.lease.kv.add!("job-claim:y", "B", 60), false);
  assert.equal(r.data.get("job-claim:x"), undefined);
  assert.equal(b.said.filter((t) => /skipped/.test(t)).length, 1, "the skipping is said once");
  assert.equal(await b.lease.kv.get(LEASE_KEY), "A", "reads go through");
  r.clock.now += 3_000;
  await b.lease.step();
  assert.equal(b.said.filter((t) => /Read only/.test(t)).length, 1, "the waiting is said once");
  await a.lease.stop();
  assert.equal(a.lease.writer(), false);
  assert.equal(r.holder(), null, "released");
  r.clock.now += 3_000;
  await b.lease.step();
  assert.equal(b.lease.writer(), true);
  assert.match(b.said.at(-1)!, /took the store's writer lease \(B\): writing again/);
  await b.lease.kv.set("note", "from B", 60);
  assert.equal(r.data.get("note")?.v, "from B");
});

test("lease: a server that dies without a word loses it when it runs out, and the waiting one takes over", async () => {
  const r = fakeRedis();
  const a = server(r, "A");
  await a.lease.ready;
  const b = server(r, "B");
  await b.lease.ready;
  // A stops renewing (it was killed): B keeps asking.
  for (let t = 0; t < 27_000; t += 3_000) {
    r.clock.now += 3_000;
    await b.lease.step();
    assert.equal(b.lease.writer(), false, "not before the lease runs out");
  }
  r.clock.now += 3_000;
  await b.lease.step();
  assert.equal(b.lease.writer(), true, "30 s after A's last renewal");
  assert.equal(r.holder(), "B");
  // A comes back (a paused process): its renewal finds B's id, and it is read only at once; its write waits while B renews, then fails.
  assert.equal(a.lease.writer(), false, "by its own clock A's lease ran out too");
  const a2 = createWriterLease(r.kv, { id: "A", now: () => r.clock.now, log: () => {}, sleep: async (ms) => { r.clock.now += ms; await b.lease.step(); } });
  await a2.ready;
  await assert.rejects(a2.kv.set("note", "from A", 60), /read only/);
  assert.equal(r.data.get("note"), undefined);
  await a.lease.step();
  assert.equal(a.lease.writer(), false);
  assert.equal(r.holder(), "B", "A did not take it back");
});

test("lease: never two writers, whatever the order of looks, the clock's jumps and the store's silences", async () => {
  const r = fakeRedis();
  const servers = [server(r, "A"), server(r, "B"), server(r, "C")];
  await Promise.all(servers.map((s) => s.lease.ready));
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let writers = 0;
  for (let i = 0; i < 2000; i++) {
    r.clock.now += Math.floor(rand() * 12_000);
    r.setDown(rand() < 0.1);
    const s = servers[Math.floor(rand() * servers.length)]!;
    if (rand() < 0.05) await s.lease.stop();
    else await s.lease.step();
    r.setDown(false);
    const now = servers.filter((x) => x.lease.writer());
    assert.ok(now.length <= 1, `two writers at step ${i}: ${now.map((x) => x.lease.id).join(", ")}`);
    // The one that thinks it writes is the one the store names.
    if (now[0]) assert.equal(r.holder(), now[0].lease.id);
    writers += now.length;
  }
  assert.ok(writers > 500, "someone was the writer most of the time");
});

test("lease: a renewal the store does not answer keeps the writer only until its lease would have run out", async () => {
  const r = fakeRedis();
  const a = server(r, "A");
  await a.lease.ready;
  r.setDown(true);
  r.clock.now += 10_000;
  await a.lease.step();
  assert.equal(a.lease.writer(), true, "20 s left by its own clock");
  r.clock.now += 20_000;
  await a.lease.step();
  assert.equal(a.lease.writer(), false, "ran out: read only");
  assert.ok(a.said.some((t) => /could not be renewed/.test(t)));
  r.setDown(false);
  await a.lease.step();
  assert.equal(a.lease.writer(), true, "the store answers again and the lease was free: taken again");
});

test("lease: a write made before the first look's answer waits for it, and the loop renews on its own", async () => {
  const r = fakeRedis();
  r.clock.now = Date.now();
  const lease = createWriterLease(r.kv, { id: "A", renewMs: 20, waitMs: 20, leaseMs: 200, log: () => undefined });
  await lease.kv.set("early", "yes", 60);
  assert.equal(r.data.get("early")?.v, "yes");
  await lease.start();
  const renewals = () => r.seen.filter((c) => c[0] === "EVAL" && c[1] === RENEW_SCRIPT).length;
  const deadline = Date.now() + 5000;
  while (renewals() < 3 && Date.now() < deadline) {
    r.clock.now = Date.now();
    await new Promise((res) => setTimeout(res, 10));
  }
  assert.ok(renewals() >= 3, "renewed by the loop");
  await lease.stop();
  assert.equal(r.holder(), null);
});

test("lease: the real client sends SET NX PX and EVAL as Redis expects, and reads their replies", async () => {
  const seen: string[][] = [];
  const replies = ["+OK\r\n", ":1\r\n", "$-1\r\n"];
  const srv = createServer((sock) => {
    let buf = "";
    sock.on("data", (c: Buffer) => {
      buf += c.toString();
      const n = Number(/^\*(\d+)\r\n/.exec(buf)?.[1] ?? 0);
      const parts = buf.split("\r\n");
      if (!n || parts.length < 1 + n * 2) return;
      seen.push(parts.slice(1, 1 + n * 2).filter((_, i) => i % 2 === 1));
      buf = "";
      sock.write(replies.shift()!);
    });
  });
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
  try {
    const kv = loadKv(`redis://127.0.0.1:${(srv.address() as AddressInfo).port}`, { timeoutMs: 20_000 })!;
    assert.ok(hasCommand(kv));
    assert.equal(await kv.command!(["SET", LEASE_KEY, "A", "NX", "PX", "30000"]), "OK");
    assert.equal(await kv.command!(["EVAL", RENEW_SCRIPT, "1", LEASE_KEY, "A", "30000"]), 1);
    assert.equal(await kv.command!(["SET", LEASE_KEY, "B", "NX", "PX", "30000"]), null);
    assert.deepEqual(seen[0], ["SET", LEASE_KEY, "A", "NX", "PX", "30000"]);
    assert.deepEqual(seen[1], ["EVAL", RENEW_SCRIPT, "1", LEASE_KEY, "A", "30000"]);
  } finally {
    await new Promise<void>((res) => srv.close(() => res()));
  }
});

test("lease: a write on the waiting server (a deploy: the owner's message reached the new one first) waits and is kept, never skipped", async () => {
  const r = fakeRedis();
  const a = server(r, "A");
  await a.lease.ready;
  const b = server(r, "B");
  await b.lease.ready;
  const startedAt = r.clock.now;
  // A stops (its deploy ends) while B's write waits: B takes the lease on a later look and writes.
  const write = b.lease.kv.set("reminder", "at 17:00", 60);
  await a.lease.stop();
  await write;
  assert.equal(r.data.get("reminder")?.v, "at 17:00", "the write was kept");
  assert.equal(b.lease.writer(), true);
  assert.ok(r.clock.now - startedAt <= 6_000, "within two looks of the release");
});

test("lease: a write that never gets the lease fails loudly after WRITE_WAIT_MS, and writes nothing", async () => {
  const r = fakeRedis();
  const a = server(r, "A");
  await a.lease.ready;
  // A keeps renewing while B waits.
  const b = server(r, "B", () => a.lease.step());
  await b.lease.ready;
  await assert.rejects(b.lease.kv.set("note", "from B", 60), /read only: another server holds its writer lease/);
  assert.equal(r.data.get("note"), undefined);
  assert.ok(b.said.some((t) => /a write waits for the store's writer lease/.test(t)));
});

test("lease: two looks at once are one look (the second SET NX would otherwise undo the first's win)", async () => {
  const r = fakeRedis();
  const a = server(r, "A");
  await Promise.all([a.lease.ready, a.lease.step(), a.lease.step()]);
  assert.equal(a.lease.writer(), true);
  assert.equal(r.seen.filter((c) => c[0] === "SET").length, 1);
});

