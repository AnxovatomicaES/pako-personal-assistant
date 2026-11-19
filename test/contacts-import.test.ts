// Contacts imported from this Mac (src/contacts.ts): a preview first, written only on the person's confirmation, the same person twice (by an
// email or a phone in common) one entry, listed and forgotten in one click.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTACTS_KEY, contactOf, createContactsStore, merge, mountContactsPanel, phoneOf } from "../src/contacts.ts";
import { setOwnerRegion } from "../src/region.ts";
import { APP, auth, memoryKv, serve } from "./helpers/connect-rig.ts";

test("phones compare by their digits, a Spanish mobile with or without +34 and 00 the same for an owner in Spain; a contact needs a way to reach them", (t) => {
  assert.equal(phoneOf("612 34 56 78"), "612345678", "no country set yet: a number without its code is left as written");
  t.after(() => setOwnerRegion(""));
  setOwnerRegion("ES");
  assert.equal(phoneOf("612 34 56 78"), "+34612345678");
  assert.equal(phoneOf("+34 612-345-678"), "+34612345678");
  assert.equal(phoneOf("0034612345678"), "+34612345678");
  assert.equal(phoneOf("12"), null);
  assert.equal(contactOf({ name: "Solo nombre" }), null);
  assert.deepEqual(contactOf({ name: " Ana\nGarcía ", emails: ["ANA@x.com", "ana@x.com", "bad"], phones: [], org: "Acme" }),
    { name: "Ana García", emails: ["ana@x.com"], phones: [], org: "Acme" });
});

test("an import adds the new, completes the one already there by a shared email or phone, and counts what changes nothing", (t) => {
  // An owner in Spain: a national number takes +34.
  t.after(() => setOwnerRegion(""));
  setOwnerRegion("ES");
  const book = [{ name: "Ana", emails: ["ana@x.com"], phones: [] }];
  const { book: after, count } = merge(book, [
    { name: "Ana García", emails: ["ana@x.com"], phones: ["612345678"] },
    { name: "Ana", emails: ["ana@x.com"] },
    { name: "Luis", phones: ["+44 7700 900123"] },
    { name: "Nobody" },
  ]);
  assert.deepEqual(count, { total: 4, added: 1, merged: 1, same: 1, skipped: 1 });
  assert.deepEqual(after[0], { name: "Ana", emails: ["ana@x.com"], phones: ["+34612345678"] });
  assert.equal(book[0]!.phones.length, 0, "the book it started from is not changed");
});

test("the import route previews, writes only on confirm, lists and forgets", async () => {
  const kv = memoryKv();
  const store = createContactsStore(kv);
  const p = await serve((app) => mountContactsPanel(app, { ...auth, store, lang: () => "en", now: () => 1000 }));
  const people = [{ name: "Ana", emails: ["ana@x.com"] }, { name: "Luis", phones: ["612345678"] }];
  try {
    const preview = await p.post("/panel/api/people/import", { people }, APP);
    assert.deepEqual(preview.body, { ok: true, preview: true, total: 2, added: 2, merged: 0, same: 0, skipped: 0, count: 0 });
    assert.equal(kv.data.has(CONTACTS_KEY), false, "a preview writes nothing");
    const done = await p.post("/panel/api/people/import", { people, confirm: true });
    assert.equal((done.body as { count: number }).count, 2);
    const again = await p.post("/panel/api/people/import", { people, confirm: true });
    assert.equal((again.body as { same: number }).same, 2, "the same import twice adds nobody");
    const listed = await p.get("/panel/api/people/imported");
    assert.equal((listed.body as { count: number }).count, 2);
    assert.equal((listed.body as { at: number }).at, 1000);
    assert.equal((await p.del("/panel/api/people/imported")).status, 200);
    assert.equal((await p.get("/panel/api/people/imported")).body.count, 0);
    assert.equal((await p.post("/panel/api/people/import", { people: "x" })).status, 400);
    assert.equal((await p.post("/panel/api/people/import", { people }, { cookie: "ok=1" })).status, 401);
  } finally {
    await p.close();
  }
});

test("an address that completes a person with five already is kept when read back, and the same import again changes nothing", async () => {
  const five = ["a1@x.com", "a2@x.com", "a3@x.com", "a4@x.com", "a5@x.com"];
  const first = merge([], [{ name: "Ana", emails: five }]).book;
  const card = { name: "Ana", emails: ["a1@x.com", "ana@work.com"] };
  const second = merge(first, [card]);
  assert.equal(second.count.merged, 1);
  const store = createContactsStore(memoryKv());
  await store.write(second.book, 1);
  const back = (await store.read()).people;
  assert.ok(back[0]!.emails.includes("ana@work.com"), "the new address survives the next read");
  assert.deepEqual({ merged: merge(back, [card]).count.merged, same: merge(back, [card]).count.same }, { merged: 0, same: 1 });
  // Full: an address that would not fit is not reported as completing the person.
  const ten = merge([], [{ name: "Bea", emails: ["b1@x.com"] }]).book;
  ten[0]!.emails = Array.from({ length: 10 }, (_, i) => `b${i + 1}@x.com`);
  assert.deepEqual(merge(ten, [{ name: "Bea", emails: ["b1@x.com", "b11@x.com"] }]).count.same, 1);
});
