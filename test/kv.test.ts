import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import { test } from "node:test";
import { decode, encode, loadKv } from "../src/kv.ts";

test("kv: encode and decode the protocol's replies", () => {
  assert.equal(encode(["SET", "k", "vé"]).toString(), "*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$3\r\nvé\r\n");
  assert.deepEqual(decode(Buffer.from("+OK\r\n")), { value: "OK" });
  assert.deepEqual(decode(Buffer.from(":3\r\n")), { value: 3 });
  assert.deepEqual(decode(Buffer.from("$-1\r\n")), { value: null });
  assert.deepEqual(decode(Buffer.from("$5\r\nhello\r\n")), { value: "hello" });
  assert.equal(decode(Buffer.from("$5\r\nhel")), undefined, "incomplete");
  assert.throws(() => decode(Buffer.from("-NOAUTH Authentication required\r\n")), /NOAUTH/);
});

test("kv: no store without a redis URL", () => {
  assert.equal(loadKv(undefined), null);
  assert.equal(loadKv(""), null);
  assert.equal(loadKv("https://example.com"), null);
  assert.ok(loadKv("redis://red-abc:6379"));
});

/** A tiny fake server: AUTH, SET and GET from a map; replies are sent in 3-byte pieces to exercise reassembly. */
async function fakeServer(password?: string) {
  const data = new Map<string, string>();
  const seen: string[][] = [];
  const server = createServer((sock) => {
    // The client hangs up as soon as it has the reply it wants (after a refused AUTH, before the reply to the command behind it): bytes still
    // on their way then make its kernel answer with a reset, which this end reads as ECONNRESET. A real store shrugs that off; unheard, it
    // would be an uncaught exception that fails whichever test is running (it did, under the load of the whole gate).
    sock.on("error", () => undefined);
    let buf = Buffer.alloc(0);
    sock.on("data", (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      for (;;) {
        const head = /^\*(\d+)\r\n/.exec(buf.toString("latin1"));
        if (!head) return;
        let pos = head[0].length;
        const args: string[] = [];
        for (let i = 0; i < Number(head[1]); i++) {
          const h = /^\$(\d+)\r\n/.exec(buf.subarray(pos).toString("latin1"));
          if (!h) return;
          const len = Number(h[1]);
          const start = pos + h[0].length;
          if (buf.length < start + len + 2) return;
          args.push(buf.subarray(start, start + len).toString());
          pos = start + len + 2;
        }
        buf = buf.subarray(pos);
        seen.push(args);
        let reply: Buffer;
        if (args[0] === "AUTH") reply = Buffer.from(args[2] === password ? "+OK\r\n" : "-WRONGPASS invalid password\r\n");
        else if (args[0] === "SET" && args.includes("NX") && data.has(args[1]!)) reply = Buffer.from("$-1\r\n");
        else if (args[0] === "SET") {
          data.set(args[1]!, args[2]!);
          reply = Buffer.from("+OK\r\n");
        } else if (args[0] === "GET") {
          const v = data.get(args[1]!);
          reply = Buffer.from(v === undefined ? "$-1\r\n" : `$${Buffer.byteLength(v)}\r\n${v}\r\n`);
        } else reply = Buffer.from("-ERR unknown\r\n");
        for (let i = 0; i < reply.length; i += 3) sock.write(reply.subarray(i, i + 3));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const close = () => new Promise<void>((r) => server.close(() => r()));
  return { port: (server.address() as AddressInfo).port, data, seen, close };
}

test("kv: set with expiry and get back over a real socket, with and without a password", async () => {
  const open = await fakeServer();
  try {
    // A long deadline: on a machine running the whole suite (and other suites) at once, a local connect can take seconds.
    const kv = loadKv(`redis://127.0.0.1:${open.port}`, { timeoutMs: 20_000 })!;
    assert.equal(await kv.get("nothing"), null);
    await kv.set("voice-result:lk_x", '{"a":"ñ"}', 60);
    assert.equal(await kv.get("voice-result:lk_x"), '{"a":"ñ"}');
    assert.deepEqual(open.seen.find((a) => a[0] === "SET"), ["SET", "voice-result:lk_x", '{"a":"ñ"}', "EX", "60"]);
  } finally {
    await open.close();
  }
  const locked = await fakeServer("p@ss");
  try {
    await loadKv(`redis://default:p%40ss@127.0.0.1:${locked.port}`, { timeoutMs: 20_000 })!.set("k", "v", 5);
    assert.equal(locked.data.get("k"), "v");
    await assert.rejects(loadKv(`redis://default:wrong@127.0.0.1:${locked.port}`, { timeoutMs: 20_000 })!.get("k"), /WRONGPASS/);
  } finally {
    await locked.close();
  }
});

test("kv: a store that closes the connection before replying fails the lookup at once", async () => {
  const closing = createServer((s) => s.end());
  await new Promise<void>((r) => closing.listen(0, "127.0.0.1", r));
  try {
    const kv = loadKv(`redis://127.0.0.1:${(closing.address() as AddressInfo).port}`, { timeoutMs: 5000 })!;
    await assert.rejects(kv.get("k"), /connection closed/);
  } finally {
    // Not awaited: the close callback of a server whose sockets the peer already reset does not always fire.
    closing.close();
  }
});

test("kv: a malformed escape in the password is kept as typed", () => {
  assert.ok(loadKv("redis://default:50%off@red-abc:6379"));
});

test("kv: a store that does not answer times out instead of hanging the call lookup", async () => {
  const sockets: import("node:net").Socket[] = [];
  const silent = createServer((s) => void sockets.push(s));
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  try {
    const kv = loadKv(`redis://127.0.0.1:${(silent.address() as AddressInfo).port}`, { timeoutMs: 200 })!;
    await assert.rejects(kv.get("k"), /timed out/);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => silent.close(() => r()));
  }
});

test("kv: add is SET NX EX: true when it wrote, false when the key was there (the jobs' atomic claim)", async () => {
  const open = await fakeServer();
  try {
    // A long deadline: on a machine running the whole suite (and other suites) at once, a local connect can take seconds.
    const kv = loadKv(`redis://127.0.0.1:${open.port}`, { timeoutMs: 20_000 })!;
    assert.equal(await kv.add!("job-claim:x", "A:1", 600), true);
    assert.equal(await kv.add!("job-claim:x", "B:1", 600), false);
    assert.equal(await kv.get("job-claim:x"), "A:1");
    assert.deepEqual(open.seen.find((a) => a[0] === "SET"), ["SET", "job-claim:x", "A:1", "NX", "EX", "600"]);
  } finally {
    await open.close();
  }
});
