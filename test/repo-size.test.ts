import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const root = new URL("..", import.meta.url).pathname;
const tracked = (): string[] => execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);

// Every clone pays for every file in git, for ever: large media go to a GitHub release (site/media.json) and the site fetches them.
const LIMIT = 2 * 1024 * 1024;

test("no tracked file is over 2 MB, and no video is tracked at all (media live in a release, see site/media.json)", () => {
  const files = tracked();
  const big = files.filter((f) => {
    try {
      return statSync(join(root, f)).size > LIMIT;
    } catch {
      return false; // deleted in the working tree
    }
  });
  assert.deepEqual(big, [], "move these to the media release and list them in site/media.json");
  assert.deepEqual(files.filter((f) => /\.(mp4|mov|webm|m4v)$/i.test(f)), []);
});

test("site/media.json: every file has a release URL, a SHA-256 and a path inside the site", () => {
  const m = JSON.parse(readFileSync(join(root, "site", "media.json"), "utf8")) as { files: { path: string; url: string; sha256: string; bytes: number }[] };
  assert.ok(m.files.length > 0);
  for (const f of m.files) {
    assert.match(f.url, /^https:\/\/github\.com\/AnxovatomicaES\/pako(-personal-assistant)?\/releases\/download\/[\w.-]+\/[\w.-]+$/);
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!f.path.startsWith("/") && !f.path.includes(".."), f.path);
    assert.ok(Number.isInteger(f.bytes) && f.bytes > 0);
  }
});

test("bin/fetch-site-media.mjs downloads what the manifest lists, checks the hash, and fails the build on a wrong file", async () => {
  const good = Buffer.from("a small video");
  const server = createServer((req, res) => {
    if (req.url === "/moved") {
      res.writeHead(302, { location: "/good" }).end();
      return;
    }
    res.writeHead(req.url === "/missing" ? 404 : 200).end(req.url === "/bad" ? "tampered" : good);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hash = createHash("sha256").update(good).digest("hex");
  // Run without blocking: the stand-in server answers from this same process.
  const run = async (files: unknown[]) => {
    const site = mkdtempSync(join(tmpdir(), "pako-media-"));
    mkdirSync(site, { recursive: true });
    writeFileSync(join(site, "media.json"), JSON.stringify({ files }));
    try {
      await promisify(execFile)(process.execPath, [join(root, "bin", "fetch-site-media.mjs"), site]);
      return { ok: true, site };
    } catch {
      return { ok: false, site };
    }
  };
  try {
    const ok = await run([{ path: "social/a.mp4", url: `${base}/moved`, sha256: hash, bytes: good.length }]);
    assert.equal(ok.ok, true, "a redirect is followed, as GitHub's release downloads redirect");
    assert.deepEqual(readFileSync(join(ok.site, "social", "a.mp4")), good);
    assert.equal((await run([{ path: "a.mp4", url: `${base}/bad`, sha256: hash, bytes: 1 }])).ok, false, "a file with the wrong hash fails the build");
    assert.equal((await run([{ path: "a.mp4", url: `${base}/missing`, sha256: hash, bytes: 1 }])).ok, false, "a missing file fails the build");
    assert.equal((await run([{ path: "../escape.mp4", url: `${base}/good`, sha256: hash, bytes: 1 }])).ok, false, "nothing is written outside the site");
  } finally {
    server.close();
  }
});
