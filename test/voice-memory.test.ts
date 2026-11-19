import assert from "node:assert/strict";
import { test } from "node:test";
import type { Kv } from "../src/kv.ts";
import { loadMemory, memoryText } from "../src/voice-memory.ts";

/** A key value store in a map, with a delay on every call so that unlocked read-modify-write cycles would overlap. */
function slowKv(): Kv & { data: Map<string, string>; fail: { get: boolean; set: boolean } } {
  const data = new Map<string, string>();
  const fail = { get: false, set: false };
  const wait = () => new Promise<void>((r) => setTimeout(r, 5));
  return {
    data,
    fail,
    async get(k) {
      await wait();
      if (fail.get) throw new Error("store down");
      return data.get(k) ?? null;
    },
    async set(k, v) {
      await wait();
      if (fail.set) throw new Error("store down");
      data.set(k, v);
    },
  };
}

test("memory: notes are kept once, newest last, and shown with the recent calls", async () => {
  const m = loadMemory(null);
  await m.addNote("Prefiere llamadas después de las diez", Date.parse("2026-11-12T10:00:00Z"));
  await m.addNote("  prefiere   llamadas después de las DIEZ ", Date.parse("2026-11-12T11:00:00Z"));
  await m.addNote("Cena con Ana el viernes");
  await m.addCall("Quiere que le recuerde lo de Ana el jueves.", Date.parse("2026-11-12T12:00:00Z"));
  const mem = await m.read();
  assert.equal(mem.notes.length, 2, "the same note twice is one note");
  const text = memoryText(mem, "Europe/Madrid");
  assert.match(text, /^Notes:\n- Prefiere llamadas después de las diez\n- Cena con Ana el viernes\nRecent calls:\n- .*: Quiere que le recuerde/);
  assert.equal(await m.forgetNote("ana"), 1);
  assert.equal((await m.read()).notes.length, 1);
  assert.equal(await m.forgetNote(""), 0);
});

test("memory: writes happen one at a time, so parallel remembers and a call summary lose nothing", async () => {
  const kv = slowKv();
  const m = loadMemory(kv);
  await Promise.all([m.addNote("uno"), m.addNote("dos"), m.addNote("tres"), m.addCall("resumen de una llamada"), m.addNote("cuatro")]);
  const mem = await m.read();
  assert.deepEqual(mem.notes.map((n) => n.text).sort(), ["cuatro", "dos", "tres", "uno"]);
  assert.equal(mem.calls.length, 1);
});

test("memory: a store that cannot be read is an error for a write, never a reason to overwrite the record with an old copy", async () => {
  const kv = slowKv();
  const first = loadMemory(kv);
  await first.addNote("la llave está con Ana");
  // A restarted server: its own copy is empty, and the store does not answer for a moment.
  const restarted = loadMemory(kv);
  kv.fail.get = true;
  await assert.rejects(restarted.addNote("otra cosa"), /store down/);
  await assert.rejects(restarted.addCall("una llamada"), /store down/);
  await assert.rejects(restarted.forgetNote("llave"), /store down/);
  assert.deepEqual((await restarted.read()).notes, [], "for showing in a prompt it falls back to its own (empty) copy");
  kv.fail.get = false;
  assert.deepEqual((await restarted.read()).notes.map((n) => n.text), ["la llave está con Ana"], "the real record was never overwritten");
  // A store that reads but cannot write reports the failure too, so "saved" is never said for a note that was not.
  kv.fail.set = true;
  await assert.rejects(restarted.addNote("tampoco"), /store down/);
});

test("memory: a stored record that is not valid JSON is replaced rather than blocking every write", async () => {
  const kv = slowKv();
  kv.data.set("owner-memory", "{not json");
  const m = loadMemory(kv);
  await m.addNote("empezar de nuevo");
  assert.deepEqual((await m.read()).notes.map((n) => n.text), ["empezar de nuevo"]);
});
