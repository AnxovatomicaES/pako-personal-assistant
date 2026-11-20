// The app's lifecycle registry (src/app/services.ts): the start order (each part after the parts it names, otherwise as added), the stop in
// reverse, one failing stop never keeping the others from stopping (and logged), and start and stop each safe to call twice.

import assert from "node:assert/strict";
import test from "node:test";
import { createServiceRegistry, named, type Service } from "../src/app/services.ts";

const part = (name: string, seen: string[], o: { failStop?: boolean; asyncStop?: boolean; asyncStart?: boolean } = {}): Service => ({
  name,
  start: () => {
    if (o.asyncStart) return new Promise<void>((r) => setTimeout(() => (seen.push(`start ${name}`), r()), 5));
    seen.push(`start ${name}`);
  },
  stop: () => {
    seen.push(`stop ${name}`);
    if (o.failStop) throw new Error(`${name} broke`);
    if (o.asyncStop) return Promise.reject(new Error(`${name} broke later`));
  },
});

test("order: as added, unless a part names the ones it starts after; a name never added (a part that is off) is ignored", async () => {
  const seen: string[] = [];
  const r = createServiceRegistry();
  r.add(part("whatsapp", seen), { after: ["store"] });
  r.add(part("watchdog", seen), { after: ["store"] });
  r.add(part("telegram", seen), { after: ["store", "slack"] });
  r.add(part("store", seen));
  assert.deepEqual(r.order(), ["store", "whatsapp", "watchdog", "telegram"]);
  await r.start();
  assert.deepEqual(seen, ["start store", "start whatsapp", "start watchdog", "start telegram"]);
});

test("start: parts that return nothing all start in the same turn; one that returns a promise is waited for before the next", async () => {
  const seen: string[] = [];
  const r = createServiceRegistry();
  r.add(part("a", seen));
  r.add(part("b", seen));
  const p = r.start();
  assert.deepEqual(seen, ["start a", "start b"], "both started before start() returned");
  await p;
  const slow: string[] = [];
  const q = createServiceRegistry();
  q.add(part("first", slow, { asyncStart: true }));
  q.add(part("second", slow));
  const started = q.start();
  assert.deepEqual(slow, [], "the second waits for the first");
  await started;
  assert.deepEqual(slow, ["start first", "start second"]);
});

test("start: called twice starts nothing twice; a start that throws stops the start there and the caller gets the error", async () => {
  const seen: string[] = [];
  const r = createServiceRegistry();
  r.add(part("a", seen));
  const first = r.start();
  assert.equal(r.start(), first);
  await first;
  assert.deepEqual(seen, ["start a"]);
  const broken = createServiceRegistry();
  broken.add({ name: "bad", start: () => { throw new Error("no"); }, stop: () => undefined });
  broken.add(part("later", seen));
  assert.throws(() => broken.start(), /no/);
  assert.ok(!seen.includes("start later"));
});

test("stop: the reverse of the start order, every part stopped even when one throws or rejects, each failure logged", async () => {
  const seen: string[] = [];
  const logged: string[] = [];
  const r = createServiceRegistry({ log: (t) => logged.push(t) });
  r.add(part("telegram", seen, { asyncStop: true }), { after: ["store"] });
  r.add(part("watchdog", seen, { failStop: true }), { after: ["store"] });
  r.add(part("slack", seen), { after: ["store"] });
  r.add(part("store", seen, { failStop: true }));
  await r.start();
  seen.length = 0;
  await r.stop();
  assert.deepEqual(seen, ["stop slack", "stop watchdog", "stop telegram", "stop store"]);
  assert.equal(logged.length, 3);
  assert.match(logged.join("\n"), /watchdog did not stop cleanly: watchdog broke/);
  assert.match(logged.join("\n"), /store did not stop cleanly: store broke/);
  assert.match(logged.join("\n"), /telegram did not stop cleanly: telegram broke later/);
});

test("stop: safe to call twice (nothing stopped twice), and safe before any start (as a shutdown before listening is)", async () => {
  const seen: string[] = [];
  const r = createServiceRegistry();
  r.add(part("a", seen));
  r.add(part("b", seen));
  const first = r.stop();
  assert.equal(r.stop(), first);
  await first;
  assert.deepEqual(seen, ["stop b", "stop a"]);
});

test("the registry refuses a name twice, a part added after the start, and a loop in the order", () => {
  const r = createServiceRegistry();
  r.add(named("a", { start: () => undefined, stop: () => undefined }));
  assert.throws(() => r.add(named("a", { start: () => undefined, stop: () => undefined })), /twice/);
  const loop = createServiceRegistry();
  loop.add(named("x", { start: () => undefined, stop: () => undefined }), { after: ["y"] });
  loop.add(named("y", { start: () => undefined, stop: () => undefined }), { after: ["x"] });
  assert.throws(() => loop.order(), /loop/);
  void r.start();
  assert.throws(() => r.add(named("b", { start: () => undefined, stop: () => undefined })), /after the start/);
});

test("named: calls the handle's own start and stop each time (a handle's methods may change)", () => {
  const seen: string[] = [];
  const handle = { start: () => void seen.push("one"), stop: () => undefined };
  const s = named("h", handle);
  handle.start = () => void seen.push("two");
  void s.start();
  assert.deepEqual(seen, ["two"]);
});
