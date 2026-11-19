#!/usr/bin/env node
// The site's build step (Render's static site runs `node bin/fetch-site-media.mjs`): the reels and other large media are not kept in git,
// where every clone would pay for them, but in a GitHub release. This downloads each file listed in site/media.json into site/ and checks
// its SHA-256, so the published URLs (pako-os.com/social/ig/…) keep working. A wrong or missing file fails the build: Render then keeps the
// site that is live, rather than publishing one with a broken video. A file already there with the right hash is not downloaded again.
// No dependency: Node's own fetch and crypto.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "site");
const site = process.argv[2] ? resolve(process.argv[2]) : root;
const manifest = JSON.parse(readFileSync(join(site, "media.json"), "utf8"));
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

let failed = 0;
for (const f of manifest.files) {
  const target = join(site, f.path);
  // Only paths inside the site folder: the manifest is ours, but a typo must not write anywhere else.
  if (!target.startsWith(site + "/") || f.path.includes("..")) {
    console.error(`media: ${f.path} is outside the site folder`);
    failed++;
    continue;
  }
  if (existsSync(target) && sha(readFileSync(target)) === f.sha256) {
    console.log(`media: ${f.path} already there`);
    continue;
  }
  try {
    const res = await fetch(f.url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = sha(buf);
    if (got !== f.sha256) throw new Error(`SHA-256 ${got}, expected ${f.sha256}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(`${target}.part`, buf);
    renameSync(`${target}.part`, target);
    console.log(`media: ${f.path} (${(buf.length / 1048576).toFixed(1)} MB)`);
  } catch (err) {
    console.error(`media: ${f.path} from ${f.url}: ${err.message}`);
    failed++;
  }
}
if (failed) {
  console.error(`media: ${failed} file(s) failed; the build stops so the live site stays as it is`);
  process.exit(1);
}
