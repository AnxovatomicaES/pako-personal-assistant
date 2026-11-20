// Zoom recordings on this Mac (src/zoom-local.ts): a meeting's captions from its folder go to the review like a cloud transcript, once; only
// inside the home folder the discovery named, only the last two days, never one still being recorded. A temp home, a fake inbox.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Discovery, DiscoveryStore } from "../src/discovery.ts";
import type { Inbound } from "../src/whatsapp.ts";
import { captionsToText, createZoomLocal, folderMeeting, ZOOM_LOCAL_KEY } from "../src/zoom-local.ts";
import { memoryKv } from "./helpers/connect-rig.ts";

const TZ = "Europe/Madrid";
const NOW = Date.parse("2026-11-16T12:00:00Z");

test("Zoom's caption file reads as one line per turn, and a recording folder's name gives the start in Madrid and the topic", () => {
  const raw = "[Ana García] 10:00:03\nHola a todos\n\n[Ana García] 10:00:06\nempezamos\n[Luis] 10:00:09\nVale\n";
  assert.equal(captionsToText(raw), "Ana García: Hola a todos empezamos\nLuis: Vale");
  assert.deepEqual(folderMeeting("2026-11-16 10.00.00 Weekly sync 84512345678", TZ), { at: Date.parse("2026-11-16T09:00:00Z"), topic: "Weekly sync" });
  assert.equal(folderMeeting("Notes", TZ), null);
});

test("a recent recording's captions are queued once for review; old, unfinished and outside-home folders are left alone", async () => {
  const home = mkdtempSync(join(tmpdir(), "pako-zl-"));
  const zoom = join(home, "Documents", "Zoom");
  const make = (name: string, file: string, text: string, mtime = NOW - 3600_000) => {
    const dir = join(zoom, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), text);
    writeFileSync(join(dir, "audio1234.m4a"), "not read");
    utimesSync(join(dir, file), mtime / 1000, mtime / 1000);
    utimesSync(dir, mtime / 1000, mtime / 1000);
  };
  make("2026-11-16 10.00.00 Weekly sync 84512345678", "closed_caption.txt", "[Ana] 10:00:03\nTe paso el informe el viernes\n");
  make("2026-11-10 10.00.00 Old one 84512345678", "closed_caption.txt", "[Ana] 10:00:03\nold\n");
  make("2026-11-16 12.30.00 Still recording 84512345678", "closed_caption.txt", "[Ana] 12:30:03\nnow\n", NOW - 60_000);
  make("2026-11-16 09.00.00 Audio only 84512345678", "notes.txt", "nothing");
  let folder = zoom;
  const discovery: DiscoveryStore = {
    read: async () => ({ zoomRecordings: { folder, count: 4 } }) as Discovery,
    write: async () => undefined,
    forget: async () => undefined,
  };
  const kv = memoryKv();
  const queued: Inbound[] = [];
  const reviewed: string[] = [];
  const zl = createZoomLocal({
    discovery, kv, timeZone: TZ, now: () => NOW, home, lang: () => "en",
    enqueue: async (m) => (queued.push(m), true),
    review: async (m) => (reviewed.push(m.id), { source: "transcript", topic: m.topic, when: "16/11 10:00", head: "h" }),
  });
  assert.equal(await zl.poll(), 1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.meeting!.topic, "Weekly sync");
  assert.equal(queued[0]!.meeting!.transcript, "Ana: Te paso el informe el viernes");
  assert.match(queued[0]!.id, /^zoom:local-[0-9a-f]{24}$/);
  assert.equal(`zoom:${reviewed[0]}`, queued[0]!.id, "the review and the inbox name the same meeting");
  assert.ok(queued[0]!.review);
  assert.doesNotMatch(kv.data.get(ZOOM_LOCAL_KEY)!, /Weekly/, "only a fingerprint of the folder is kept");
  assert.equal(await zl.poll(), 0, "each meeting once");
  folder = "/etc";
  assert.equal(await zl.poll(), 0, "a folder outside the home is never read");
});

// ---------- chat and meeting bugs: regression tests ----------

function localRig(home: string) {
  const zoom = join(home, "Documents", "Zoom");
  const discovery: DiscoveryStore = {
    read: async () => ({ zoomRecordings: { folder: zoom, count: 2 } }) as Discovery,
    write: async () => undefined,
    forget: async () => undefined,
  };
  const queued: Inbound[] = [];
  const zl = createZoomLocal({ discovery, kv: memoryKv(), timeZone: TZ, now: () => NOW, home, lang: () => "en", enqueue: async (m) => (queued.push(m), true) });
  const make = (name: string, text: string, o: { dirAt?: number; fileAt?: number } = {}) => {
    const dir = join(zoom, name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "closed_caption.txt");
    writeFileSync(file, text);
    const fileAt = o.fileAt ?? NOW - 3600_000;
    utimesSync(file, fileAt / 1000, fileAt / 1000);
    const dirAt = o.dirAt ?? NOW - 3600_000;
    utimesSync(dir, dirAt / 1000, dirAt / 1000);
    return { dir, file };
  };
  return { zl, queued, make };
}

test("zoom-local: captions still being written (the file changed a minute ago, the folder an hour ago) wait for the next look", async () => {
  const r = localRig(mkdtempSync(join(tmpdir(), "pako-zl-")));
  // Zoom appends to the captions file as people speak: the file's time moves, the folder's does not.
  r.make("2026-11-16 11.00.00 Long call 84512345678", "[Ana] 11:00:03\nFirst half only\n", { fileAt: NOW - 60_000 });
  assert.equal(await r.zl.poll(), 0, "a half-written meeting is not read and marked done");
  assert.equal(r.queued.length, 0);
});

test("zoom-local: one folder that cannot be read does not stop the meetings after it", { skip: process.getuid?.() === 0 }, async () => {
  const r = localRig(mkdtempSync(join(tmpdir(), "pako-zl-")));
  const bad = r.make("2026-11-16 09.00.00 Locked 84512345678", "[Ana] 09:00:03\nlocked\n");
  r.make("2026-11-16 10.00.00 Weekly sync 84512345678", "[Ana] 10:00:03\nTe paso el informe el viernes\n");
  chmodSync(bad.file, 0o000);
  try {
    const keep = console.error;
    console.error = () => undefined;
    try {
      assert.equal(await r.zl.poll(), 1, "the readable meeting is queued");
    } finally {
      console.error = keep;
    }
    assert.equal(r.queued[0]!.meeting!.topic, "Weekly sync");
  } finally {
    chmodSync(bad.file, 0o644);
  }
});
