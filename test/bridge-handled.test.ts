// The bridge's answered-but-unconfirmed items (assistant/bridge/handled.ts): kept on disk, so a restart between an answer and its ack never
// answers the item a second time (an email's or meeting's notice told twice).

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HandledIds } from "../assistant/bridge/handled.ts";

test("answered items survive a restart until their ack, and old ones are let go", () => {
  const dir = mkdtempSync(join(tmpdir(), "pako-handled-"));
  const path = join(dir, "state", "handled-unacked.json");
  let now = 1_000_000_000_000;
  const a = new HandledIds(path, () => {}, () => now);
  a.add("mail-1");
  a.add("meet-2");
  assert.equal(existsSync(path), true);
  assert.equal(statSync(path).mode & 0o777, 0o600, "only the owner reads it");
  assert.doesNotMatch(readFileSync(path, "utf8"), /notice|text|subject/i, "ids and times only");
  // The bridge restarts before the server confirmed: both are still known as answered.
  const b = new HandledIds(path, () => {}, () => now);
  assert.deepEqual([...b].sort(), ["mail-1", "meet-2"]);
  // The ack goes through for one: gone from disk too.
  b.delete("mail-1");
  assert.deepEqual([...new HandledIds(path, () => {}, () => now)], ["meet-2"]);
  // Two days later an id the server never confirmed is let go.
  now += 2 * 24 * 3600_000 + 1;
  assert.deepEqual([...new HandledIds(path, () => {}, () => now)], []);
});

test("an unreadable or wrong file is no answered item, and a store that cannot be written only logs", () => {
  const dir = mkdtempSync(join(tmpdir(), "pako-handled-"));
  const path = join(dir, "handled-unacked.json");
  writeFileSync(path, "not json");
  assert.equal(new HandledIds(path).size, 0);
  writeFileSync(path, JSON.stringify(["a", "b"]));
  assert.equal(new HandledIds(path).size, 0);
  const said: string[] = [];
  const blocked = new HandledIds(join(path, "inside-a-file", "x.json"), (s) => said.push(s));
  blocked.add("m-1");
  assert.equal(blocked.has("m-1"), true, "still known in memory");
  assert.match(said.join("\n"), /could not keep the answered items/);
});
