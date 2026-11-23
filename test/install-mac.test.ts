// install-mac.sh: Pako for Mac from Terminal in one line, checked against the signed update feed. The checks run offline: a small ad hoc
// signed stand-in Pako.app in a dmg made here, a feed signed with a key made here (PAKO_FEED_PUBLIC_KEY), and file:// addresses. Nothing is
// downloaded, and nothing is installed outside a temporary folder.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { generateFeedKey, signFeed } from "../desktop/mac/feed-sign.ts";
import { eventually } from "./helpers/wait.ts";

const root = join(import.meta.dirname, "..");
const SCRIPT = join(root, "install-mac.sh");
const mac = process.platform === "darwin";
const has = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;

test("install-mac.sh: every shell reads it (sh -n)", () => {
  for (const sh of ["sh", "bash", "zsh", "dash"].filter(has)) {
    const r = spawnSync(sh, ["-n", SCRIPT], { encoding: "utf8" });
    assert.equal(r.status, 0, `${sh}: ${r.stderr}`);
  }
});

test("install-mac.sh: it trusts exactly the keys the app carries (desktop/mac/feed-key.pub)", () => {
  const pub = readFileSync(join(root, "desktop/mac/feed-key.pub"), "utf8").split(/\s+/).filter(Boolean);
  const inScript = /PAKO_FEED_PUBLIC_KEY:-([^}]+)\}/.exec(readFileSync(SCRIPT, "utf8"))?.[1]?.split(" ");
  assert.deepEqual(inScript, pub);
});

// The installs: macOS only (hdiutil, codesign, plutil).
const VERSION = "9.8.7";
let dir = "";
let dmg = "";
let sha = "";
const key = generateFeedKey();
// An OpenSSL that can check Ed25519, as the script looks for one: without it the signature is said to be unchecked, not checked.
const edOpenssl = ["openssl", "/opt/homebrew/bin/openssl", "/usr/local/bin/openssl"].some(
  (o) => spawnSync("sh", ["-c", `"${o}" list -public-key-algorithms 2>/dev/null | grep -qi ed25519`]).status === 0,
);

function app(at: string, id: string, version: string) {
  mkdirSync(join(at, "Contents/MacOS"), { recursive: true });
  writeFileSync(
    join(at, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleExecutable</key><string>Pako</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
  );
  writeFileSync(join(at, "Contents/MacOS/Pako"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(at, "Contents/MacOS/Pako"), 0o755);
}

before(() => {
  if (!mac) return;
  dir = mkdtempSync(join(tmpdir(), "pako-install-mac-"));
  const src = join(dir, "src");
  app(join(src, "Pako.app"), "io.github.anxovatomicaes.pako", VERSION);
  const sign = spawnSync("codesign", ["--force", "-s", "-", join(src, "Pako.app")], { encoding: "utf8" });
  assert.equal(sign.status, 0, sign.stderr);
  dmg = join(dir, `Pako-${VERSION}.dmg`);
  const made = spawnSync("hdiutil", ["create", "-quiet", "-fs", "HFS+", "-srcfolder", src, "-volname", "Pako", "-format", "UDZO", dmg], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  sha = createHash("sha256").update(readFileSync(dmg)).digest("hex");
});
after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A signed feed in its own file; `change` edits it after signing (to break the signature) or before (to name another dmg or hash). */
function feed(name: string, o: { before?: Record<string, unknown>; after?: Record<string, unknown> } = {}) {
  const body = {
    version: VERSION,
    build: 42,
    url: `file://${dmg}`,
    sha256: sha,
    minimumMacOS: "13.0",
    notes: "Pako 9.8.7: a test",
    page: "https://example.invalid/release",
    ...o.before,
  };
  const signed = { ...signFeed(body, key.privateKey), ...o.after };
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(signed, null, 2));
  return `file://${file}`;
}

/** Runs the installer into a fresh Applications folder and home of its own. */
function install(feedUrl: string, o: { apps?: string; env?: Record<string, string> } = {}) {
  const home = mkdtempSync(join(dir, "home-"));
  mkdirSync(join(home, ".Trash"));
  const apps = o.apps ?? join(home, "Applications");
  const r = spawnSync("sh", [SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: home,
      TMPDIR: dir,
      PAKO_FEED_URL: feedUrl,
      PAKO_FEED_PUBLIC_KEY: key.publicKey,
      PAKO_APP_DIR: apps,
      PAKO_NO_OPEN: "1",
      ...o.env,
    },
  });
  return { ...r, out: r.stdout + r.stderr, home, apps, target: join(apps, "Pako.app") };
}
const versionOf = (appPath: string) =>
  spawnSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(appPath, "Contents/Info.plist")], { encoding: "utf8" }).stdout.trim();

test("install-mac.sh: installs the release the signed feed names, with no quarantine mark, and leaves no temporary files", { skip: !mac }, () => {
  const r = install(feed("good"));
  assert.equal(r.status, 0, r.out);
  assert.equal(versionOf(r.target), VERSION);
  assert.match(r.out, edOpenssl ? /Signature: verified/ : /Signature: not checked/);
  assert.match(r.out, /SHA-256: matches the release/);
  const xattr = spawnSync("xattr", ["-r", r.target], { encoding: "utf8" }).stdout;
  assert.doesNotMatch(xattr, /com\.apple\.quarantine/);
  assert.deepEqual(readdirSync(r.apps), ["Pako.app"], "no staging copy left behind");
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("pako-install.")), [], "its work folder is removed");
});

test("install-mac.sh: an older Pako is replaced, and goes to the Trash", { skip: !mac }, () => {
  const home = mkdtempSync(join(dir, "apps-"));
  app(join(home, "Pako.app"), "io.github.anxovatomicaes.pako", "0.0.1");
  const r = install(feed("update"), { apps: home });
  assert.equal(r.status, 0, r.out);
  assert.equal(versionOf(r.target), VERSION);
  const trashed = readdirSync(join(r.home, ".Trash"));
  assert.equal(trashed.length, 1);
  assert.match(trashed[0]!, /^Pako 0\.0\.1 .*\.app$/);
});

test("install-mac.sh: another app called Pako.app is left alone, and nothing is installed", { skip: !mac }, () => {
  const apps = mkdtempSync(join(dir, "apps-"));
  app(join(apps, "Pako.app"), "com.example.other", "1.0");
  const r = install(feed("other"), { apps });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /is not Pako: left as it is/);
  assert.equal(versionOf(join(apps, "Pako.app")), "1.0");
});

test("install-mac.sh: a download whose SHA-256 is not the feed's installs nothing", { skip: !mac }, () => {
  const r = install(feed("badsha", { before: { sha256: "0".repeat(64) } }));
  assert.notEqual(r.status, 0);
  assert.match(r.out, /is not the release's/);
  assert.equal(existsSync(r.target), false);
});

test("install-mac.sh: a feed changed after signing installs nothing", { skip: !mac || !edOpenssl }, () => {
  const r = install(feed("tampered", { after: { sha256: sha.replace(/^./, sha[0] === "a" ? "b" : "a") } }));
  assert.notEqual(r.status, 0);
  assert.match(r.out, /does NOT verify/);
  assert.equal(existsSync(r.target), false);
});

test("install-mac.sh: an unsigned feed installs nothing, and a feed must be https (or a local file)", { skip: !mac }, () => {
  const r = install(feed("unsigned", { after: { signature: undefined } }));
  assert.notEqual(r.status, 0);
  assert.match(r.out, /not signed/);
  const http = install("http://example.invalid/feed.json");
  assert.notEqual(http.status, 0);
  assert.match(http.out, /must be an https/);
});

test("install-mac.sh: a dry run checks the feed and changes nothing", { skip: !mac }, () => {
  const r = install(feed("dry"), { env: { PAKO_DRY_RUN: "1" } });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Would install Pako 9\.8\.7/);
  assert.equal(existsSync(r.apps), false);
});

/** An older Pako in `apps` whose program really runs (a copy of sleep, signed here): the installer must see it as running. */
function runningPako(apps: string) {
  const at = join(apps, "Pako.app");
  app(at, "io.github.anxovatomicaes.pako", "0.0.1");
  const exe = join(at, "Contents/MacOS/Pako");
  copyFileSync("/bin/sleep", exe);
  const sign = spawnSync("codesign", ["--force", "-s", "-", exe], { encoding: "utf8" });
  assert.equal(sign.status, 0, sign.stderr);
  const child = spawn(exe, ["60"], { stdio: "ignore" });
  return { at, stop: () => child.kill() };
}

test("install-mac.sh: a running Pako is never replaced, whatever the folder's spelling (a trailing slash, brackets, a plus)", { skip: !mac }, async () => {
  const apps = join(mkdtempSync(join(dir, "apps-")), "Apps (old)+[8]");
  mkdirSync(apps);
  const p = runningPako(apps);
  try {
    await eventually(() => spawnSync("pgrep", ["-x", "Pako"]).status === 0);
    for (const spelled of [apps, `${apps}/`, `${apps}//`]) {
      const r = install(feed("running"), { apps: spelled });
      assert.notEqual(r.status, 0, `${spelled}: ${r.out}`);
      assert.match(r.out, /Pako is running/);
      assert.equal(versionOf(p.at), "0.0.1", spelled);
    }
  } finally {
    p.stop();
  }
});

/** A command of `name` in front of the real one, running `script`: there it stops the installer as Ctrl+C would. */
function interrupting(name: string, script: string) {
  const shim = mkdtempSync(join(dir, "shim-"));
  writeFileSync(join(shim, name), `#!/bin/sh\n${script}\n`);
  chmodSync(join(shim, name), 0o755);
  return { PATH: `${shim}:${process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}` };
}

test("install-mac.sh: stopped during the copy, it leaves no hidden copy, and the old Pako where it was", { skip: !mac }, () => {
  const apps = mkdtempSync(join(dir, "apps-"));
  app(join(apps, "Pako.app"), "io.github.anxovatomicaes.pako", "0.0.1");
  const r = install(feed("interrupted"), { apps, env: interrupting("ditto", '/usr/bin/ditto "$@"\nkill -INT $PPID') });
  assert.equal(r.status, 130, r.out);
  assert.deepEqual(readdirSync(apps), ["Pako.app"], "no .Pako-installing.app left behind");
  assert.equal(versionOf(join(apps, "Pako.app")), "0.0.1");
});

test("install-mac.sh: stopped between setting the old Pako aside and moving the new one in, the old one is put back", { skip: !mac }, () => {
  const apps = mkdtempSync(join(dir, "apps-"));
  app(join(apps, "Pako.app"), "io.github.anxovatomicaes.pako", "0.0.1");
  // The rename of the staged copy is where it stops: the old app is already aside, the new one not yet in.
  const mv = 'case "$1" in *.Pako-installing.app) kill -INT $PPID; exit 1 ;; esac\nexec /bin/mv "$@"';
  const r = install(feed("between"), { apps, env: interrupting("mv", mv) });
  assert.notEqual(r.status, 0, r.out);
  assert.deepEqual(readdirSync(apps), ["Pako.app"], "nothing hidden left behind");
  assert.equal(versionOf(join(apps, "Pako.app")), "0.0.1");
  // And uninterrupted, the old one ends in the Trash with nothing left aside.
  const ok = install(feed("between-ok"), { apps });
  assert.equal(ok.status, 0, ok.out);
  assert.deepEqual(readdirSync(apps), ["Pako.app"]);
  assert.equal(versionOf(join(apps, "Pako.app")), VERSION);
});
