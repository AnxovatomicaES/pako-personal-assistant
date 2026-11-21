// Pako.app installing its own update (desktop/mac/Update.swift), run as the app runs it once Update is pressed, by a small program
// (test/fixtures/mac-update/main.swift) against small real apps: universal (Intel and Apple silicon), signed ad hoc, put in real dmgs by
// desktop/mac/dmg.sh, described by desktop/mac/feed.sh and served by a local http server. Each case checks what is in place afterwards: the
// new app swapped in and the old one in the (test's own) Trash, or, on any failure, the running app exactly as it was and nothing left over.
// Every feed is signed with a release key made here (desktop/mac/feed-sign.ts), whose public half the program carries, as the app does; a
// feed that is not signed by it is refused before anything is downloaded. The whole app doing it (two builds, a local feed, the relaunch)
// is in test/mac-app.test.ts. Elsewhere (no swiftc, not a Mac): skipped.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { generateFeedKey, signFeed } from "../desktop/mac/feed-sign.ts";

const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const hasSwift = process.platform === "darwin" && spawnSync("swiftc", ["--version"], { stdio: "ignore" }).status === 0;
const skip = hasSwift ? false : "needs macOS with swiftc (the Command Line Tools)";
const work = mkdtempSync(join(tmpdir(), "pako-mac-update-"));
const tool = join(work, "update-check");
/** Downloads, mounts and staging happen in the program's own temporary folder (TMPDIR): checked empty after every case. */
const tmp = join(work, "tmp");
const home = join(work, "home");
const served = join(work, "served");
const ID = "io.github.anxovatomicaes.pako";
/** The processor this Mac is not (swiftc builds for the one it is, even when this node runs under Rosetta). */
const otherArch = hasSwift && spawnSync("sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8" }).stdout.trim() === "1" ? "x86_64" : "arm64";
const KEY = generateFeedKey();
let server: Server;
let base = "";
const hits: string[] = [];

type Out = { ok?: string; error?: string; stages?: string[] };
const sh = (cmd: string, args: string[], env: Record<string, string> = {}): { code: number | null; out: string } => {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
};
const ok = (cmd: string, args: string[], env: Record<string, string> = {}): string => {
  const r = sh(cmd, args, env);
  assert.equal(r.code, 0, `${cmd} ${args.join(" ")}: ${r.out}`);
  return r.out;
};

/** A small app as Pako.app is laid out: a universal program, its Info.plist, signed ad hoc with the hardened runtime as sign.sh does. */
/** `program` and `node`: other builds of the tiny program, for Pako's own and for the Node.js inside (none by default, as a dev build). */
function makeApp(dir: string, version: string, build: number, o: { id?: string; minimum?: string; program?: string; node?: string } = {}): string {
  const app = join(dir, "Pako.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  cpSync(o.program ?? join(work, "tiny"), join(app, "Contents", "MacOS", "Pako"));
  if (o.node) {
    mkdirSync(join(app, "Contents", "Resources", "node", "bin"), { recursive: true });
    cpSync(o.node, join(app, "Contents", "Resources", "node", "bin", "node"));
  }
  writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${o.id ?? ID}</string>
<key>CFBundleExecutable</key><string>Pako</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${build}</string>
<key>LSMinimumSystemVersion</key><string>${o.minimum ?? "13.0"}</string>
</dict></plist>
`);
  ok("codesign", ["--force", "--options", "runtime", "--timestamp=none", "-s", "-", app]);
  return app;
}

/** A release of `version`/`build`: the dmg (dmg.sh) and its feed (feed.sh), served at /<name>/; the feed's url then points here. */
function release(name: string, version: string, build: number, o: Parameters<typeof makeApp>[3] & { tamper?: (app: string) => void } = {}) {
  const dir = join(work, "releases", name);
  const app = makeApp(join(dir, "app"), version, build, o);
  o.tamper?.(app);
  // dmg.sh refuses an app whose signature does not verify: a tampered one is put in a dmg by hand, as a forger would.
  if (o.tamper) {
    mkdirSync(join(dir, "disk"), { recursive: true });
    ok("ditto", [app, join(dir, "disk", "Pako.app")]);
    ok("hdiutil", ["create", "-quiet", "-volname", "Pako", "-srcfolder", join(dir, "disk"), "-fs", "HFS+", "-format", "UDZO", "-ov", join(dir, `Pako-${version}.dmg`)]);
  } else {
    ok("sh", [join(repo, "desktop/mac/dmg.sh"), app, dir], { PAKO_SIGN_IDENTITY: "-" });
  }
  const dmg = join(dir, `Pako-${version}.dmg`);
  ok("sh", [join(repo, "desktop/mac/feed.sh"), dmg, join(dir, "feed.json")], { PAKO_RELEASE_REPO: "example/pako", PAKO_RELEASE_NOTES: `Pako ${version}\nfixes` });
  const feed = JSON.parse(readFileSync(join(dir, "feed.json"), "utf8")) as Record<string, unknown>;
  mkdirSync(join(served, name), { recursive: true });
  cpSync(dmg, join(served, name, `Pako-${version}.dmg`));
  return { dmg, feed: { ...feed, url: `${base}/${name}/Pako-${version}.dmg` } as Record<string, unknown> };
}

/** The running app: a fresh copy of version 0.2.0 build 100 in a folder of its own (the one replaced). */
function installed(name: string): string {
  return makeApp(join(work, "apps", name), "0.2.0", 100);
}

/** Runs the install as the app does (current 0.2.0 build 100 unless said otherwise); the feed is written to a file for the program. */
/** Asynchronous: the http server serving the download runs in this very process, and must keep answering while the program runs. */
/** The feed is signed with the test's release key first, unless `signedBy` says another (null: left as it is). */
type InstallOptions = { team?: string; macos?: string; version?: string; build?: string; env?: Record<string, string>; signedBy?: string | null; appKey?: string };
async function install(app: string, feed: Record<string, unknown>, o: InstallOptions = {}): Promise<Out> {
  const f = join(work, `feed-${Math.random().toString(36).slice(2)}.json`);
  const signer = o.signedBy === undefined ? KEY.privateKey : o.signedBy;
  writeFileSync(f, JSON.stringify(signer === null ? feed : signFeed(feed, signer)));
  const args = ["install", f, app, o.version ?? "0.2.0", o.build ?? "100", o.team ?? "-", home, ...(o.macos ? [o.macos] : [])];
  const r = await new Promise<{ code: number | null; out: string; err: string }>((done) => {
    const env = { ...process.env, TMPDIR: tmp, PAKO_TEST_FEED_KEY: o.appKey ?? KEY.publicKey, ...o.env };
    const p = spawn(tool, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => done({ code, out, err }));
  });
  assert.equal(r.code, 0, r.err);
  return (JSON.parse(r.out) as { r: Out }).r;
}

const plist = (app: string, key: string): string => ok("plutil", ["-extract", key, "raw", "-o", "-", join(app, "Contents", "Info.plist")]);
/** Every file of a bundle with its SHA-256: "exactly as it was" means the same list. */
const fingerprint = (app: string): string => ok("sh", ["-c", `cd "$1" && find . -type f -print0 | xargs -0 shasum -a 256 | sort -k 2`, "-", app]);
const leftovers = (dir: string): string[] => readdirSync(dir).filter((n) => n.startsWith(".Pako-"));
const trashed = (): string[] => (existsSync(join(home, ".Trash")) ? readdirSync(join(home, ".Trash")) : []);
const mounted = (): boolean => ok("mount", []).includes(work);

/** A failure: the error, and the running app left exactly as it was, nothing beside it, nothing in the Trash, nothing mounted or kept. */
async function refused(app: string, feed: Record<string, unknown>, want: string, o: Parameters<typeof install>[2] = {}): Promise<Out> {
  const before = fingerprint(app);
  const trash = trashed().length;
  const r = await install(app, feed, o);
  assert.equal(r.error, want, JSON.stringify(r));
  assert.equal(fingerprint(app), before, "the running app is exactly as it was");
  assert.deepEqual(leftovers(join(app, "..")), [], "nothing staged beside it");
  assert.equal(trashed().length, trash, "nothing went to the Trash");
  assert.equal(mounted(), false, "the disk is not left mounted");
  assert.deepEqual(readdirSync(tmp), [], "the temporary folder is cleaned");
  return r;
}

before(async () => {
  if (skip) return;
  mkdirSync(tmp, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(served, { recursive: true });
  // A program for both architectures, as Pako.app is: the check then covers the arm64 slice's signature too, on an Intel Mac.
  writeFileSync(join(work, "tiny.c"), "int main(void) { return 0; }\n");
  ok("cc", ["-arch", "x86_64", "-arch", "arm64", "-mmacosx-version-min=13.0", "-o", join(work, "tiny"), join(work, "tiny.c")]);
  // And one for the processor this Mac does not have (the update program below is built for the one it has).
  ok("cc", ["-arch", otherArch, "-mmacosx-version-min=13.0", "-o", join(work, "tiny-other"), join(work, "tiny.c")]);
  const c = sh("swiftc", ["-Onone", "-swift-version", "5", "desktop/mac/Core.swift", "desktop/mac/Pako.swift", "desktop/mac/Update.swift",
    "test/fixtures/mac-update/main.swift", "-o", tool].map((p) => (p.startsWith("desktop/") || p.startsWith("test/") ? join(repo, p) : p)));
  assert.equal(c.code, 0, `the update program did not compile:\n${c.out}`);
  server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    hits.push(path);
    if (path.startsWith("/redirect/")) return void res.writeHead(302, { location: `${base}/${path.slice("/redirect/".length)}` }).end();
    // Somewhere that is not this Mac: never followed (and so never reached).
    if (path === "/away") return void res.writeHead(302, { location: "http://example.invalid/Pako.dmg" }).end();
    if (path === "/huge") {
      res.writeHead(200, { "content-length": String(2_000_000_000), "content-type": "application/octet-stream" });
      res.write(Buffer.alloc(256 * 1024));
      return void setTimeout(() => res.destroy(), 2000);
    }
    const file = join(served, path);
    if (!file.startsWith(served) || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
  // The test's own disks, should a failed case have left one mounted.
  for (const line of sh("mount", []).out.split("\n")) {
    const m = / on (\S*pako-mac-update-\S*) /.exec(line);
    if (m) sh("hdiutil", ["detach", "-force", m[1]!]);
  }
  sh("chmod", ["-R", "u+w", work]);
  rmSync(work, { recursive: true, force: true });
});

test("mac update: feed.sh describes the dmg exactly: version, build and minimum macOS from the app on it, its SHA-256, https addresses", { skip }, async () => {
  const { dmg, feed } = release("described", "0.2.1", 101);
  const sha = ok("shasum", ["-a", "256", dmg]).split(" ")[0];
  // The app's own SHA-256 (read a megabyte at a time, to the end) agrees with shasum, on the dmg and on an empty file.
  assert.equal((JSON.parse(ok(tool, ["sha", dmg])) as { r: unknown }).r, sha);
  writeFileSync(join(work, "empty"), "");
  assert.equal((JSON.parse(ok(tool, ["sha", join(work, "empty")])) as { r: unknown }).r, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.deepEqual({ ...feed, url: undefined }, {
    version: "0.2.1", build: 101, sha256: sha, minimumMacOS: "13.0", notes: "Pako 0.2.1 fixes", url: undefined,
    page: "https://github.com/example/pako/releases/tag/v0.2.1",
  });
  const written = JSON.parse(readFileSync(join(work, "releases", "described", "feed.json"), "utf8")) as { url: string };
  assert.equal(written.url, "https://github.com/example/pako/releases/download/v0.2.1/Pako-0.2.1.dmg", "GitHub Releases by default");
  // Refused: an address that is not https, a dmg named for another version than the app on it.
  const r = sh("sh", [join(repo, "desktop/mac/feed.sh"), dmg, join(work, "x.json")], { PAKO_RELEASE_URL: "http://example.com/Pako.dmg" });
  assert.equal(r.code, 1);
  assert.match(r.out, /not an https address/);
  cpSync(dmg, join(work, "Pako-9.9.9.dmg"));
  const named = sh("sh", [join(repo, "desktop/mac/feed.sh"), join(work, "Pako-9.9.9.dmg"), join(work, "y.json")]);
  assert.equal(named.code, 1);
  assert.match(named.out, /but the app on it is 0\.2\.1/);
  assert.ok(!existsSync(join(work, "x.json")) && !existsSync(join(work, "y.json")));
});

test("mac update: a newer release is downloaded, checked, swapped in, and the old app goes to the Trash under its version's name", { skip }, async () => {
  const app = installed("happy");
  const { feed } = release("happy", "0.2.1", 101);
  const r = await install(app, feed);
  assert.deepEqual(r, { ok: app, stages: ["downloading", "verifying", "installing"] });
  assert.equal(plist(app, "CFBundleShortVersionString"), "0.2.1");
  assert.equal(plist(app, "CFBundleVersion"), "101");
  assert.equal(sh("codesign", ["--verify", "--deep", "--strict", app]).code, 0, "the new app's signature verifies in place");
  assert.ok(trashed().includes("Pako 0.2.0.app"), `the old one is in the Trash: ${trashed().join(", ")}`);
  assert.equal(plist(join(home, ".Trash", "Pako 0.2.0.app"), "CFBundleVersion"), "100");
  assert.deepEqual(leftovers(join(app, "..")), []);
  assert.equal(mounted(), false);
  assert.deepEqual(readdirSync(tmp), []);
  // The same version with a higher build is newer too; through a redirect on this Mac (GitHub sends assets on to its storage the same way).
  const again = await install(app, { ...release("rebuild", "0.2.1", 102).feed, url: `${base}/redirect/rebuild/Pako-0.2.1.dmg` }, { version: "0.2.1", build: "101" });
  assert.equal(again.ok, app, JSON.stringify(again));
  assert.equal(plist(app, "CFBundleVersion"), "102");
});

test("mac update: nothing is downloaded for a release that is not newer, needs a newer macOS, or for an app run from its disk image", { skip }, async () => {
  const app = installed("early");
  const { feed } = release("early", "0.2.1", 101);
  const was = hits.length;
  await refused(app, feed, "not-newer", { version: "0.2.1", build: "101" });
  await refused(app, feed, "not-newer", { version: "0.3.0", build: "50" });
  await refused(app, feed, "needs-macos", { macos: "12.6.0" });
  assert.equal(hits.length, was, "no request was made");
  // Run from where it cannot stay (a translocated copy): it must be moved first.
  const moved = makeApp(join(work, "AppTranslocation", "x"), "0.2.0", 100);
  await refused(moved, feed, "must-move");
  // A feed with no checksum (the first format) is only a page to open: the app never installs it.
  await refused(app, { ...feed, sha256: undefined }, "download");
});

test("mac update: a feed not signed by the release key the app carries is refused before anything is downloaded", { skip }, async () => {
  const app = installed("unsigned");
  const { feed } = release("unsigned", "0.2.1", 101);
  const was = hits.length;
  const other = generateFeedKey();
  // Not signed; signed by another key; signed, then a field changed (the dmg's address, its checksum); an app that carries no key.
  await refused(app, feed, "feed-signature", { signedBy: null });
  await refused(app, feed, "feed-signature", { signedBy: other.privateKey });
  for (const change of [{ url: `${base}/elsewhere/Pako-0.2.1.dmg` }, { sha256: "1".repeat(64) }]) {
    await refused(app, { ...signFeed(feed, KEY.privateKey), ...change }, "feed-signature", { signedBy: null });
  }
  await refused(app, feed, "feed-signature", { appKey: "" });
  await refused(app, feed, "feed-signature", { appKey: other.publicKey });
  await refused(app, feed, "feed-signature", { appKey: `${other.publicKey},${generateFeedKey().publicKey}` });
  assert.equal(hits.length, was, "no request was made");
  // The same feed, signed by one of the keys the app carries (here the second: a recovery key, for a lost release key): installed.
  assert.equal((await install(app, feed, { appKey: `${other.publicKey},${KEY.publicKey}` })).ok, app);
});

test("mac update: a download that is not exactly the announced one is refused and the running app stays as it was", { skip }, async () => {
  const app = installed("refused");
  const good = release("good", "0.2.1", 101).feed;
  await refused(app, { ...good, sha256: "0".repeat(64) }, "checksum");
  await refused(app, { ...good, url: `${base}/nothing-here.dmg` }, "download");
  await refused(app, { ...good, url: `${base}/away` }, "download");
  await refused(app, { ...good, url: `${base}/huge` }, "too-large");
  // Bytes that match their checksum but are no disk image; a disk image with no app on it.
  mkdirSync(join(served, "junk"), { recursive: true });
  writeFileSync(join(served, "junk", "Pako-0.2.1.dmg"), "not a disk image");
  const junkSha = ok("shasum", ["-a", "256", join(served, "junk", "Pako-0.2.1.dmg")]).split(" ")[0];
  await refused(app, { ...good, url: `${base}/junk/Pako-0.2.1.dmg`, sha256: junkSha }, "mount");
  mkdirSync(join(work, "empty-disk", "nothing"), { recursive: true });
  ok("hdiutil", ["create", "-quiet", "-volname", "Pako", "-srcfolder", join(work, "empty-disk"), "-fs", "HFS+", "-format", "UDZO", "-ov", join(served, "empty.dmg")]);
  const emptySha = ok("shasum", ["-a", "256", join(served, "empty.dmg")]).split(" ")[0];
  await refused(app, { ...good, url: `${base}/empty.dmg`, sha256: emptySha }, "no-app");
});

test("mac update: the app on the disk must be the one promised: same identifier, version and build, a macOS this Mac has, a valid signature", { skip }, async () => {
  const app = installed("checked");
  await refused(app, release("other-id", "0.2.1", 101, { id: "com.example.other" }).feed, "not-the-same-app:identifier");
  await refused(app, { ...release("other-build", "0.2.1", 102).feed, build: 101 }, "not-the-same-app:build");
  await refused(app, { ...release("other-version", "0.2.2", 101).feed, version: "0.2.1" }, "not-the-same-app:version");
  // The feed says nothing about macOS, the app on the disk needs a newer one than this Mac (given as 13.1).
  const { minimumMacOS: _, ...noMin } = release("needs-14", "0.2.1", 101, { minimum: "14.0" }).feed;
  await refused(app, noMin, "needs-macos", { macos: "13.1.0" });
  // Changed after it was signed: the seal is broken.
  const tampered = release("tampered", "0.2.1", 101, { tamper: (a) => writeFileSync(join(a, "Contents", "MacOS", "Pako"), "#!/bin/sh\necho hi\n") });
  await refused(app, tampered.feed, "signature");
});

test("mac update: a release that cannot run on this Mac's processor is refused before the swap: its program, or the Node.js inside it", { skip }, async () => {
  const app = installed("arch");
  assert.match(ok("lipo", ["-archs", join(work, "tiny-other")]), new RegExp(`^${otherArch}$`));
  await refused(app, release("other-arch", "0.2.1", 101, { program: join(work, "tiny-other") }).feed, "architecture");
  await refused(app, release("other-arch-node", "0.2.1", 101, { node: join(work, "tiny-other") }).feed, "architecture");
  // A universal program with a universal Node.js inside is taken.
  const r = await install(app, release("universal-node", "0.2.1", 101, { node: join(work, "tiny") }).feed);
  assert.equal(r.ok, app, JSON.stringify(r));
});

test("mac update: a Developer ID app takes only an update signed by its own team (an ad-hoc one is refused)", { skip }, async () => {
  const app = installed("team");
  await refused(app, release("adhoc", "0.2.1", 101).feed, "team", { team: "ABCDE12345" });
  // The check itself, on a real Developer ID signature when this Mac has one: Anthropic's claude (team Q6L2SF6YDW).
  const versions = join(process.env.HOME ?? "", ".local", "share", "claude", "versions");
  const real = existsSync(versions) ? readdirSync(versions).map((v) => join(versions, v)).find((p) => sh("codesign", ["-dv", p]).out.includes("TeamIdentifier=Q6L2SF6YDW")) : undefined;
  if (real) {
    const run = (...a: string[]) => (JSON.parse(ok(tool, a)) as { r: unknown }).r;
    assert.equal(run("team", real), "Q6L2SF6YDW");
    assert.equal(run("check", real, "Q6L2SF6YDW"), null, "its own team: accepted");
    assert.equal(run("check", real, "ABCDE12345"), "team", "another team: refused");
    assert.equal(run("check", real, "Q6L2\"SF6Y"), "team", "nothing but a team identifier goes into the requirement");
  }
  assert.equal((JSON.parse(ok(tool, ["team", app])) as { r: unknown }).r, null, "ad hoc: no team");
});

// The app's folder is made read-only (chmod 555) for the first case. Root writes there all the same, so as root that case cannot happen.
const asRoot = process.getuid?.() === 0 ? "run as root, which writes to a read-only folder all the same: the refused swap cannot happen" : false;

test("mac update: a folder the app cannot write, or a cancel before the swap, leaves everything as it was", { skip: skip || asRoot }, async () => {
  const app = installed("locked");
  const { feed } = release("locked", "0.2.1", 101);
  chmodSync(join(app, ".."), 0o555);
  try {
    const r = await refused(app, feed, "cannot-replace");
    assert.deepEqual(r.stages, [], "refused before downloading anything");
  } finally {
    chmodSync(join(app, ".."), 0o755);
  }
  await refused(app, feed, "cancelled", { env: { PAKO_TEST_CANCEL: "1" } });
});
