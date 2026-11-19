// House rules the code keeps: every setting it reads is documented, and lines stay readable.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
/** Every .ts file under a folder (subfolders too), as paths from the repository root. */
const sources = (dir: string): string[] =>
  readdirSync(new URL(dir, root)).flatMap((f) => {
    const path = `${dir}${f}`;
    if (statSync(new URL(path, root)).isDirectory()) return f === "node_modules" ? [] : sources(`${path}/`);
    return f.endsWith(".ts") ? [path] : [];
  });

test("docs: every environment variable the server, the Mac bridge and the voice worker read is documented", () => {
  const docs = ["README.md", "docs/configuration.md", "docs/personal-caller.md", "assistant/README.md", "voice-worker/README.md"].map(read).join("\n");
  const env = new Set<string>();
  for (const file of [...sources("src/"), ...sources("assistant/"), ...sources("voice-worker/src/")]) {
    const src = read(file);
    // env.X, env["X"], env("X"), num("X", ...) (the bridge's helper), process.env.X
    for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) env.add(m[1]!);
    for (const m of src.matchAll(/\benv\[\s*"([A-Z][A-Z0-9_]+)"\s*\]/g)) env.add(m[1]!);
    for (const m of src.matchAll(/\benv\(\s*"([A-Z][A-Z0-9_]+)"\s*\)/g)) env.add(m[1]!);
    for (const m of src.matchAll(/\bnum\(\s*"([A-Z][A-Z0-9_]+)"/g)) env.add(m[1]!);
  }
  env.delete("RENDER"); // set by the host, not by the owner
  for (const host of ["RAILWAY_ENVIRONMENT", "FLY_APP_NAME", "K_SERVICE", "DYNO", "WEBSITE_SITE_NAME", "VERCEL", "KOYEB_APP_NAME"]) env.delete(host);
  assert.ok(env.size > 30, "the scan found the configuration");
  assert.deepEqual([...env].filter((name) => !docs.includes(`\`${name}\``)).sort(), [], "settings missing from docs/configuration.md, docs/personal-caller.md, assistant/README.md and voice-worker/README.md");
});

test("size: no line in src is over 200 characters (wrap long ones); src/restaurants/ is code ported as it was, with its long patterns", () => {
  const long = sources("src/")
    .filter((f) => !f.startsWith("src/restaurants/"))
    .flatMap((f) => read(f).split("\n").map((l, i) => ({ f, i: i + 1, n: l.length })))
    .filter((l) => l.n > 200);
  assert.deepEqual(long.map((l) => `${l.f}:${l.i}`), []);
});
