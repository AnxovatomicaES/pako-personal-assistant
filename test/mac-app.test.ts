// Pako.app, the desktop app for macOS (desktop/mac, docs/desktop-mac.md). On a Mac with swiftc, desktop/mac/build.sh is run once into a
// temporary folder (a developer build, from a copy of the sources) and its bundle checked: the layout, Info.plist, both architectures, the
// signature. That app is then made self-contained as a release is (package.sh: Node.js and the server inside, sign.sh: hardened runtime), put
// in a dmg (dmg.sh) and checked as a stranger gets it (release-check.sh: mounted read-only, the server run from it with no node on PATH). The
// rules the app shares with `npm run panel` (the Pako home, its lock, the .env files) are compiled into a small test program
// (test/fixtures/mac-core/main.swift) and compared with bin/panel.cjs on the same files. Elsewhere (no swiftc, not a Mac) all of it is
// skipped: nothing here is needed to run Pako. The release half downloads Node.js once (about 100 MB, kept in ~/Library/Caches/pako-build).

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { before, test } from "node:test";
import { generateFeedKey, signFeed } from "../desktop/mac/feed-sign.ts";

// git's hook settings (GIT_DIR and the like, when the tests run from a pre-push hook) must not reach the git this file runs in its own
// throwaway repositories: it would work on the real repository instead.
for (const k of Object.keys(process.env)) if (k.startsWith("GIT_")) delete process.env[k];

const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const panel = createRequire(import.meta.url)("../bin/panel.cjs") as {
  readEnvFile: (file: string, names: string[]) => Record<string, string>;
  pakoHome: (env: Record<string, string | undefined>, cwd: string, userHome: string) => string;
  readLock: (home: string, upSeconds: number) => { pid: number; port: number; alive: boolean } | null;
};

const hasSwift = process.platform === "darwin" && spawnSync("swiftc", ["--version"], { stdio: "ignore" }).status === 0;
const skip = hasSwift ? false : "needs macOS with swiftc (the Command Line Tools)";
const work = mkdtempSync(join(tmpdir(), "pako-mac-app-"));
/** The release key of these builds (desktop/mac/feed-sign.ts), made for the test: the app carries its public half, the feeds are signed. */
const KEY = generateFeedKey();
// Built from a copy of the app's sources in a folder whose path has a space and a quote, into another such folder: build.sh must keep paths whole.
const copy = join(work, "Pako's folder");
const app = join(work, "out dir", "Pako.app");
// The same app made self-contained, as a release is: in another folder with a space, then its dmg.
const rel = join(work, "release dir", "Pako.app");
const BUILD = "42";
const check = join(work, "core-check");
type Ran = { code: number | null; out: string };
let built: Ran = { code: null, out: "" };
let packaged: Ran = { code: null, out: "" };
let checked: Ran = { code: null, out: "" };

/** A command run to its end without blocking the other one: the app's build and the check program compile side by side. */
const runAsync = (cmd: string, args: string[], env: Record<string, string> = {}): Promise<Ran> =>
  new Promise((done) => {
    const p = spawn(cmd, args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => done({ code, out }));
    p.on("error", (err) => done({ code: 1, out: err.message }));
  });

before(async () => {
  if (skip) return;
  cpSync(join(repo, "desktop", "mac"), join(copy, "desktop", "mac"), { recursive: true });
  cpSync(join(repo, "package.json"), join(copy, "package.json"));
  // A source file with Finder information and a resource fork (a file that went through iCloud or the Finder): build.sh copies it into the
  // app, and codesign refuses any app that carries such detritus. The build must still sign.
  const detritus = join(copy, "desktop", "mac", "InfoPlist.en.strings");
  spawnSync("xattr", ["-wx", "com.apple.FinderInfo", "0000000000000000000400000000000000000000000000000000000000000000", detritus]);
  spawnSync("xattr", ["-w", "com.apple.ResourceFork", "detritus", detritus]);
  const [b, c] = await Promise.all([
    runAsync("sh", [join(copy, "desktop/mac/build.sh"), join(work, "out dir")], { PAKO_DEV_BUILD: "1", PAKO_BUILD: BUILD, PAKO_SIGN_IDENTITY: "", PAKO_FEED_PUBLIC_KEY: KEY.publicKey }),
    runAsync("swiftc", ["-Onone", "-swift-version", "5", "desktop/mac/Core.swift", "desktop/mac/DiscoveryCore.swift", "desktop/mac/RemindersCore.swift", "desktop/mac/Reminders.swift",
      "test/fixtures/mac-core/main.swift", "-o", check]),
  ]);
  built = b;
  assert.equal(c.code, 0, `the check program did not compile:\n${c.out}`);
  if (b.code !== 0) return;
  // The release half, with this repo's own scripts (the server comes from its git), ad hoc: no identity of the person running the tests.
  mkdirSync(join(work, "release dir"), { recursive: true });
  const steps: [string, string[]][] = [
    ["ditto", [app, rel]],
    ["sh", ["desktop/mac/package.sh", rel]],
    ["sh", ["desktop/mac/sign.sh", rel]],
    ["sh", ["desktop/mac/dmg.sh", rel]],
  ];
  for (const [cmd, args] of steps) {
    const r = await runAsync(cmd, args, { PAKO_SIGN_IDENTITY: "-" });
    packaged = { code: r.code, out: `${packaged.out}${r.out}` };
    if (r.code !== 0) return;
  }
  checked = await runAsync("sh", ["desktop/mac/release-check.sh", join(work, "release dir", `Pako-${version()}.dmg`)]);
});

const version = (): string => (JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string }).version;
const sh = (cmd: string, args: string[]): { code: number | null; out: string } => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
};
const plistOf = (bundle: string, key: string): { code: number | null; out: string } =>
  sh("plutil", ["-extract", key, "raw", "-o", "-", join(bundle, "Contents", "Info.plist")]);
const plist = (key: string): string => plistOf(app, key).out;
/** The app's rule, run by the check program: its JSON answer. */
const swift = (...args: string[]): unknown => swiftKeyed("", ...args);
/** The same, with `key` as the app's release key (PAKO_TEST_FEED_KEY). */
const swiftKeyed = (key: string, ...args: string[]): unknown => {
  const r = spawnSync(check, args, { encoding: "utf8", env: { ...process.env, PAKO_TEST_FEED_KEY: key } });
  assert.equal(r.status, 0, r.stderr);
  return (JSON.parse(r.stdout) as { r: unknown }).r;
};
/** The app's own entitlements (desktop/mac/app.entitlements): only the three that let macOS ask for Calendars, Contacts and Mail. */
const APP_ENTITLEMENTS = ["com.apple.security.automation.apple-events", "com.apple.security.personal-information.addressbook",
  "com.apple.security.personal-information.calendars"];
/** The entitlement keys a signed file has, sorted. */
const entitlements = (file: string): string[] => {
  const xml = sh("codesign", ["-d", "--entitlements", "-", "--xml", file]).out;
  return [...xml.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]!).sort();
};

test("mac app: the npm scripts, the release scripts and the ignored build folder", () => {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["mac-app"], "sh desktop/mac/build.sh");
  assert.equal(pkg.scripts["mac-release"], "sh desktop/mac/release.sh");
  assert.equal(pkg.scripts["mac-release-check"], "sh desktop/mac/release-check.sh");
  assert.match(readFileSync(join(repo, ".gitignore"), "utf8"), /^\/?dist\/$/m);
  for (const f of ["build", "package", "sign", "dmg", "notarize", "release", "release-check", "feed"]) {
    const r = spawnSync("sh", ["-n", join(repo, "desktop/mac", `${f}.sh`)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${f}.sh: ${r.stderr}`);
  }
  // Downloads and build output stay outside the repo; credentials are never taken by the scripts, only the names of keychain items.
  const scripts = ["package", "sign", "notarize", "release"].map((f) => readFileSync(join(repo, "desktop/mac", `${f}.sh`), "utf8")).join("\n");
  assert.match(scripts, /Library\/Caches\/pako-build/);
  assert.doesNotMatch(scripts, /--password|--apple-id "\$|APPLE_ID|AC_PASSWORD/);
  assert.match(scripts, /--keychain-profile "\$PAKO_NOTARY_PROFILE"/);
  assert.doesNotMatch(readFileSync(join(repo, "desktop/mac/sign.sh"), "utf8"), /codesign[^\n]*--deep[^\n]*-s /, "no --deep signing");
});

test("mac app: the app's entitlements are only the three that let macOS ask for Calendars, Contacts and Mail", () => {
  const ent = readFileSync(join(repo, "desktop/mac/app.entitlements"), "utf8");
  assert.deepEqual([...ent.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]).sort(), APP_ENTITLEMENTS);
  assert.equal((ent.match(/<true\/>/g) ?? []).length, 3);
  for (const f of ["sign", "release-check"]) assert.ok(readFileSync(join(repo, "desktop/mac", `${f}.sh`), "utf8").includes(`APP_ENTS="${APP_ENTITLEMENTS.join(" ")} "`), f);
});

test("mac app: a Quit (Apple event, logout, SIGTERM, the update) is not refused by a confirm() open in Settings or an alert waiting for an answer", () => {
  const swift = readFileSync(join(repo, "desktop/mac/App.swift"), "utf8");
  const quit = swift.slice(swift.indexOf("private func terminateNow()"), swift.indexOf("func applicationDidFinishLaunching"));
  // The main window (Settings open in it) shows the page's alert/confirm as a sheet: every window's sheet is ended.
  assert.match(quit, /for w in NSApp\.windows \{ while let sheet = w\.attachedSheet \{ w\.endSheet\(sheet\) \} \}/);
  assert.match(quit, /if NSApp\.modalWindow != nil \{ NSApp\.abortModal\(\) \}/);
  assert.ok(quit.indexOf("abortModal") < quit.indexOf("NSApp.perform(#selector(NSApplication.terminate"), "the dialogs go before the terminate");
  assert.match(swift, /beginSheetModal\(for:/, "the page's dialogs are sheets there");
});

test("mac app: Settings open in the main window (menu, Cmd+, and the gear), never a window of their own; Back to the dashboard is the same window", () => {
  const swift = readFileSync(join(repo, "desktop/mac/App.swift"), "utf8");
  assert.ok(!existsSync(join(repo, "desktop/mac/PanelWindow.swift")), "no second window for Settings");
  assert.doesNotMatch(swift, /PanelWindow|panelWindow/);
  const open = swift.slice(swift.indexOf("private func openPanelSettings("), swift.indexOf("@objc private func showSettings()"));
  assert.match(open, /window\.makeKeyAndOrderFront\(nil\)/, "the main window comes forward");
  assert.match(open, /webView\.load\(URLRequest\(url: url\)\)/, "the main window's own web view goes to Settings");
  assert.match(open, /location\.hash = h;/, "already on Settings: only the card changes");
  const dash = swift.slice(swift.indexOf("@objc private func showDashboard()"), swift.indexOf("@objc private func reloadPanel()"));
  assert.match(dash, /url\.path != "\/panel"/, "Dashboard from Settings goes back in the same window");
});

test("mac app: the Node.js runtime is pinned (version and SHA-256 of both tarballs) and its entitlements are only the two JIT ones", () => {
  const pins = readFileSync(join(repo, "desktop/mac/node.sha256"), "utf8");
  const v = /^version (v22\.\d+\.\d+)$/m.exec(pins)?.[1];
  assert.ok(v, "a Node.js 22 version");
  for (const arch of ["x64", "arm64"]) assert.match(pins, new RegExp(`^[0-9a-f]{64}  node-${v!.replace(/\./g, "\\.")}-darwin-${arch}\\.tar\\.gz$`, "m"), arch);
  const ent = readFileSync(join(repo, "desktop/mac/node.entitlements"), "utf8");
  assert.deepEqual([...ent.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]).sort(),
    ["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory"]);
});

test("mac app: build.sh makes a bundle with its binary, Info.plist, icon and PkgInfo", { skip }, () => {
  assert.equal(built.code, 0, built.out);
  const bin = join(app, "Contents", "MacOS", "Pako");
  assert.ok(statSync(bin).mode & 0o100, "the binary is executable");
  for (const f of ["Info.plist", "PkgInfo", "Resources/AppIcon.icns"]) assert.ok(existsSync(join(app, "Contents", f)), f);
  // Every source of the app is in the build (a file left out of build.sh would not be noticed until the app missed it).
  const listed = readFileSync(join(repo, "desktop/mac/build.sh"), "utf8");
  const sources = ["Core", "DiscoveryCore", "Pako", "Claude", "Connect", "Status", "Texts", "Update", "Discovery", "RemindersCore", "Reminders", "App", "main"];
  for (const f of sources) assert.match(listed, new RegExp(`"\\$HERE/${f}\\.swift"`), f);
  // A developer build carries no server and no Node.js: it runs the folder it was built from.
  assert.ok(!existsSync(join(app, "Contents", "Resources", "pako")) && !existsSync(join(app, "Contents", "Resources", "node")));
});

test("mac app: Info.plist is valid and says what the app is", { skip }, () => {
  assert.equal(sh("plutil", ["-lint", join(app, "Contents", "Info.plist")]).code, 0);
  assert.equal(plist("CFBundleIdentifier"), "io.github.anxovatomicaes.pako");
  assert.equal(plist("CFBundleExecutable"), "Pako");
  assert.equal(plist("CFBundleShortVersionString"), version());
  assert.equal(plist("CFBundleVersion"), BUILD, "the build number, a whole number that only grows, not the version");
  assert.equal(plist("LSMinimumSystemVersion"), "13.0");
  assert.equal(plist("LSApplicationCategoryType"), "public.app-category.productivity");
  assert.match(plist("NSHumanReadableCopyright"), /^© 2026 Pako contributors\. MIT License\.$/);
  assert.equal(plist("PakoUpdateFeed"), "", "no update check unless the build is given a feed");
  assert.equal(plist("PakoFeedPublicKey"), KEY.publicKey, "the release key's public half (PAKO_FEED_PUBLIC_KEY, else desktop/mac/feed-key.pub)");
  // A Dock icon and a window, not only a menu-bar item.
  assert.equal(plist("LSUIElement"), "false");
  assert.equal(plist("NSAppTransportSecurity.NSAllowsLocalNetworking"), "true");
  const anywhere = sh("plutil", ["-extract", "NSAppTransportSecurity.NSAllowsArbitraryLoads", "raw", "-o", "-", join(app, "Contents", "Info.plist")]);
  assert.notEqual(anywhere.code, 0, "plain http to anywhere stays off (no NSAllowsArbitraryLoads)");
  assert.equal(plist("PakoRepoPath"), copy, "a developer build: the folder it was built from (spaces and all) is where it looks first");
  // Why macOS asks, in English only: the words in Info.plist and en.lproj, the same keys in each, and no Spanish es.lproj any more.
  const asks = ["NSCalendarsFullAccessUsageDescription", "NSCalendarsUsageDescription", "NSContactsUsageDescription", "NSAppleEventsUsageDescription",
    "NSDocumentsFolderUsageDescription", "NSRemindersFullAccessUsageDescription", "NSRemindersUsageDescription"];
  for (const k of asks) assert.match(plist(k), /^Pako .+\.$/, k);
  const strings = (l: string) => JSON.parse(sh("plutil", ["-convert", "json", "-o", "-", join(app, "Contents", "Resources", `${l}.lproj`, "InfoPlist.strings")]).out) as Record<string, string>;
  const en = strings("en");
  assert.deepEqual(Object.keys(en).sort(), [...asks].sort());
  for (const k of asks) assert.equal(en[k], plist(k), k);
  assert.ok(!existsSync(join(app, "Contents", "Resources", "es.lproj")), "no Spanish localization");
});

test("mac app: build.sh refuses a build with no whole build number or a feed that is not https, before compiling anything", { skip }, () => {
  const refusals = [["PAKO_BUILD", "1.2", /PAKO_BUILD/], ["PAKO_UPDATE_FEED", "http://example.com/f.json", /https/],
    ["PAKO_FEED_PUBLIC_KEY", "not-a-key", /not 32 bytes of base64/], ["PAKO_FEED_PUBLIC_KEY", "A".repeat(42) + "==", /not 32 bytes/]] as const;
  for (const [name, value, said] of refusals) {
    const r = spawnSync("sh", [join(copy, "desktop/mac/build.sh"), join(work, "refused")], { encoding: "utf8", env: { ...process.env, PAKO_BUILD: "7", [name]: value } });
    assert.equal(r.status, 1, name);
    assert.match(r.stdout, said);
    assert.ok(!existsSync(join(work, "refused", "Pako.app")), "nothing made");
  }
});

test("mac app: one binary for Intel and Apple silicon, signed ad hoc with the hardened runtime, only the discovery entitlements", { skip }, () => {
  const info = sh("lipo", ["-info", join(app, "Contents", "MacOS", "Pako")]).out;
  assert.match(info, /x86_64/);
  assert.match(info, /arm64/);
  const v = sh("codesign", ["--verify", "--deep", "--strict", app]);
  assert.equal(v.code, 0, v.out);
  const d = sh("codesign", ["-dv", app]).out;
  assert.match(d, /Signature=adhoc/);
  assert.match(d, /flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/);
  assert.deepEqual(entitlements(app), APP_ENTITLEMENTS);
});

test("mac app: a release is self-contained: universal Node.js, the server from git with its production modules, no build folder", { skip }, () => {
  assert.equal(packaged.code, 0, packaged.out);
  const res = join(rel, "Contents", "Resources");
  const node = join(res, "node", "bin", "node");
  assert.deepEqual(sh("lipo", ["-archs", node]).out.split(/\s+/).sort(), ["arm64", "x86_64"]);
  assert.ok(existsSync(join(res, "node", "LICENSE")), "Node.js's licence travels with it");
  for (const f of ["src/server.ts", "assistant/run.ts", "assistant/bridge.ts", "package.json", "package-lock.json", "LICENSE", "node_modules/express/package.json"]) {
    assert.ok(existsSync(join(res, "pako", f)), f);
  }
  // Every file of the bridge that git has is in the app: one missing (assistant/update.ts once) stopped the bridge at every start.
  const bridgeFiles = sh("git", ["-C", repo, "ls-files", "assistant/*.ts"]).out.split("\n").filter(Boolean);
  assert.ok(bridgeFiles.includes("assistant/update.ts"), "the list is read from git");
  for (const f of bridgeFiles) assert.ok(existsSync(join(res, "pako", f)), `${f} is in the app`);
  // Every file the panel serves from node_modules (src/dashboard.ts's vendor map) survived the pruning.
  const vendor = [...readFileSync(join(repo, "src/dashboard.ts"), "utf8").matchAll(/\{ file: "([^"]+)", type:/g)].map((m) => m[1]!);
  assert.ok(vendor.length >= 4);
  for (const f of vendor) assert.ok(existsSync(join(res, "pako", "node_modules", f)), f);
  assert.notEqual(plistOf(rel, "PakoRepoPath").code, 0, "a release names no folder of the builder's");
  assert.equal(plistOf(rel, "CFBundleVersion").out, BUILD);
  // Nothing private or dev-only: no .env, notes, tests, dev tools; no Mach-O but the app and node; no home folder path in the shipped code.
  const all = sh("find", [rel, "-name", ".env*", "-o", "-name", "HANDOFF.md", "-o", "-name", "spec.md", "-o", "-name", "*.test.ts", "-o", "-name", ".pako",
    "-o", "-name", "typescript", "-o", "-name", "@types", "-o", "-name", "voice-worker", "-o", "-name", "*.map"]).out;
  assert.equal(all, "");
  const machos = sh("sh", ["-c", `cd "$1/Contents" && find . -type f -print0 | xargs -0 file -h | grep Mach-O | cut -d: -f1 | sed 's/ (for .*//' | sort -u`, "-", rel]);
  assert.deepEqual(machos.out.split("\n"), ["./MacOS/Pako", "./Resources/node/bin/node"]);
  assert.equal(sh("grep", ["-rlE", "/Users/[A-Za-z]", join(res, "pako", "src"), join(res, "pako", "assistant"), join(rel, "Contents", "Info.plist")]).out, "");
  // A size ceiling, so a dependency that balloons is noticed (measured: about 250 MB unpacked, 80 MB as a dmg).
  const mb = Number(sh("du", ["-sm", rel]).out.split(/\s/)[0]);
  assert.ok(mb > 150 && mb < 320, `${mb} MB`);
  const dmg = join(work, "release dir", `Pako-${version()}.dmg`);
  assert.ok(statSync(dmg).size < 120 * 1024 * 1024, `the dmg is ${statSync(dmg).size} bytes`);
  assert.match(readFileSync(`${dmg}.sha256`, "utf8"), new RegExp(`^[0-9a-f]{64}  Pako-${version().replace(/\./g, "\\.")}\\.dmg\n$`));
});

test("mac app: a release is signed inside out with the hardened runtime: node with only the JIT entitlements, the app with the discovery ones", { skip }, () => {
  assert.equal(packaged.code, 0, packaged.out);
  const node = join(rel, "Contents", "Resources", "node", "bin", "node");
  const v = sh("codesign", ["--verify", "--deep", "--strict", "--verbose=2", rel]);
  assert.equal(v.code, 0, v.out);
  for (const f of [rel, node]) assert.match(sh("codesign", ["-dv", f]).out, /flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/, f);
  assert.deepEqual(entitlements(node), ["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory"]);
  assert.deepEqual(entitlements(rel), APP_ENTITLEMENTS);
  assert.match(sh("codesign", ["-dv", node]).out, /Identifier=io\.github\.anxovatomicaes\.pako\.node/);
  // sign.sh ran compiled JavaScript with it under the hardened runtime (a node without the entitlements aborts there).
  // An Apple silicon Mac without Rosetta cannot run the x86_64 slice: sign.sh says so instead (as for arm64 on an Intel Mac, below).
  const canX64 = sh("arch", ["-x86_64", "/usr/bin/true"]).code === 0;
  assert.match(packaged.out, canX64 ? /node runs compiled code under the hardened runtime: x64 v22\./ : /node \(x86_64\): this Mac cannot run that slice/);
});

test("mac app: Apple silicon, checked on this Mac whatever its chip: every arm64 slice is signed, hardened, entitled as allowed, for macOS 13", { skip }, () => {
  assert.equal(packaged.code, 0, packaged.out);
  const node = join(rel, "Contents", "Resources", "node", "bin", "node");
  const bin = join(rel, "Contents", "MacOS", "Pako");
  // package.sh: each slice of the universal node is nodejs.org's binary byte for byte, and the app is universal (a release must be).
  assert.match(packaged.out, /node's two slices are the official binaries, byte for byte/);
  assert.match(packaged.out, /node: each slice \(x86_64 arm64\) signed, hardened, with only the two JIT entitlements/);
  for (const arch of ["x86_64", "arm64"]) {
    for (const f of [rel, node]) {
      const v = sh("codesign", ["--verify", "--strict", "--arch", arch, f]);
      assert.equal(v.code, 0, `${arch} ${f}: ${v.out}`);
      assert.match(sh("codesign", ["-dv", "--arch", arch, f]).out, /flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/, `${arch} ${f}`);
    }
    const ents = (f: string) => [...sh("codesign", ["-d", "--arch", arch, "--entitlements", "-", "--xml", f]).out.matchAll(/<key>([^<]+)<\/key>/g)]
      .map((m) => m[1]!).sort();
    assert.deepEqual(ents(node), ["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory"], arch);
    assert.deepEqual(ents(rel), APP_ENTITLEMENTS, arch);
    // Built for the macOS the app says it needs (Info.plist 13.0), node for no newer one; only macOS's own libraries.
    const minos = (f: string) => /^\s*minos (\S+)$/m.exec(sh("vtool", ["-arch", arch, "-show-build", f]).out)?.[1];
    assert.equal(minos(bin), "13.0", `${arch}: the app's minimum`);
    assert.ok(Number(minos(node)!.split(".")[0]) <= 13, `${arch}: node needs macOS ${minos(node)}`);
    const libs = sh("otool", ["-L", "-arch", arch, bin]).out.split("\n").slice(1).map((l) => l.trim().split(" ")[0]!);
    assert.ok(libs.length > 5 && libs.every((l) => l.startsWith("/System/Library/") || l.startsWith("/usr/lib/")), `${arch}: ${libs.join(", ")}`);
  }
  // sign.sh runs node's compiled code on every slice this Mac can run; on an Intel Mac it says the arm64 one was not run (it cannot be).
  const canArm = sh("arch", ["-arm64", "/usr/bin/true"]).code === 0;
  assert.match(packaged.out, canArm ? /node runs compiled code under the hardened runtime: arm64 v22\./ : /node \(arm64\): this Mac cannot run that slice/);
  // release-check.sh checks the same per slice on the dmg as it ships.
  assert.match(checked.out, /each slice \(x86_64, arm64\) of the app and node: signed, hardened, entitled as allowed, built for macOS 13\.0 or older/);
});

test("mac app: the dmg, mounted read-only, runs the bundled server with no node on PATH, signs in, stops cleanly and changes nothing", { skip }, () => {
  assert.equal(packaged.code, 0, packaged.out);
  assert.equal(checked.code, 0, checked.out);
  for (const line of [/disk: Applications Pako\.app/, /node: (x86_64 arm64|arm64 x86_64)/, /no node on PATH/, /signed-in \/panel\/api\/overview 200/,
    /nothing left running from the disk/, /nothing inside the app changed/, /release-check passed/]) {
    assert.match(checked.out, line);
  }
});

test("mac app: the self-contained app's rules: its own server first, where it may not run from, an older LaunchAgent, the update feed", { skip }, () => {
  const res = "/Applications/Pako.app/Contents/Resources";
  const both = `${res}/pako/src/server.ts,${res}/node/bin/node`;
  assert.deepEqual(swift("bundled", res, both), { repo: `${res}/pako`, node: `${res}/node/bin/node` });
  assert.equal(swift("bundled", res, `${res}/pako/src/server.ts`), null, "no node: a developer build");
  assert.equal(swift("bundled", res, `${res}/node/bin/node`), null, "no server: a developer build");
  assert.equal(swift("bundled", "relative/Resources", "relative/Resources/pako/src/server.ts,relative/Resources/node/bin/node"), null);
  assert.equal(swift("move", "/Volumes/Pako/Pako.app"), true);
  assert.equal(swift("move", "/private/var/folders/x1/abc/T/AppTranslocation/0E1F/d/Pako.app"), true);
  assert.equal(swift("move", "/Applications/Pako.app"), false);
  assert.equal(swift("move", "/Users/ana/Applications/Pako.app"), false);
  const repoAgent = ["/opt/homebrew/opt/node@22/bin/node", "--disable-warning=ExperimentalWarning", "/Users/ana/pako/src/server.ts"];
  assert.equal(swift("agent", `${repoAgent[0]},${repoAgent[2]}`, ...repoAgent), false, "a working folder install");
  assert.equal(swift("agent", repoAgent[0]!, ...repoAgent), true, "its folder is gone");
  const inApp = ["/Volumes/Pako/Pako.app/Contents/Resources/node/bin/node", "/Volumes/Pako/Pako.app/Contents/Resources/pako/src/server.ts"];
  assert.equal(swift("agent", inApp.join(","), ...inApp), true, "it runs something inside an app bundle");
  assert.equal(swift("agent", "-"), true, "no program at all");
  assert.equal(swift("newer", "0.10.0", "0.9.9"), true);
  assert.equal(swift("newer", "1.0", "0.99.1"), true);
  assert.equal(swift("newer", "0.2.0", "0.2"), false);
  assert.equal(swift("newer", "0.2.0", "0.2.1"), false);
  assert.equal(swift("newer", "0.3.0-beta", "0.2.0"), false, "not a plain version: never offered");
  assert.equal(swift("newer", "", "0.2.0"), false);
  // The first format (a page to open): still read, not installable.
  assert.deepEqual(swift("feed", JSON.stringify({ version: "0.3.0", url: "https://example.com/Pako-0.3.0.dmg", notes: "Fixes.\nMore." })),
    { version: "0.3.0", url: "https://example.com/Pako-0.3.0.dmg", notes: "Fixes. More.", build: null, sha256: null, minimumMacOS: null, page: null,
      installable: false, signed: false });
  for (const bad of [{ version: "0.3.0", url: "http://example.com/x.dmg" }, { version: "0.3.0", url: "file:///tmp/x" }, { version: "x", url: "https://e.com/" },
    { url: "https://e.com/" }, { version: "0.3.0", url: "javascript:alert(1)" }, { version: "0.3.0", url: "https://user:pw@e.com/x.dmg" }]) {
    assert.equal(swift("feed", JSON.stringify(bad)), null, JSON.stringify(bad));
  }
  assert.equal(swift("feed", "not json"), null);
});

test("mac app: the update feed made by feed.sh: a dmg with its SHA-256, build and minimum macOS; anything half understood offers nothing", { skip }, () => {
  const sha = "a".repeat(64);
  const full = { version: "0.3.0", build: 512, url: "https://github.com/o/r/releases/download/v0.3.0/Pako-0.3.0.dmg", sha256: sha.toUpperCase(),
    minimumMacOS: "13.0", notes: "One line.", page: "https://github.com/o/r/releases/tag/v0.3.0" };
  // Signed with the release key the app carries: installable. Unsigned, signed by another key, a field changed after signing, or an app
  // with no key: never (the SHA-256 is only worth what the feed is).
  const signed = signFeed(full, KEY.privateKey);
  assert.deepEqual(swiftKeyed(KEY.publicKey, "feed", JSON.stringify(signed)), { ...full, sha256: sha, installable: true, signed: true });
  assert.deepEqual(swiftKeyed(KEY.publicKey, "feed", JSON.stringify(full)), { ...full, sha256: sha, installable: false, signed: false });
  assert.deepEqual(swift("feed", JSON.stringify(signed)), { ...full, sha256: sha, installable: false, signed: false }, "an app with no key");
  const other = generateFeedKey();
  assert.equal((swiftKeyed(KEY.publicKey, "feed", JSON.stringify(signFeed(full, other.privateKey))) as { signed: boolean }).signed, false);
  for (const change of [{ url: "https://evil.example/Pako-0.3.0.dmg" }, { sha256: "b".repeat(64) }, { version: "0.3.1" }, { build: 513 }, { notes: "x" },
    { page: "https://evil.example/" }, { minimumMacOS: "12.0" }, { signature: "A".repeat(86) + "==" }, { signature: 7 }]) {
    const out = swiftKeyed(KEY.publicKey, "feed", JSON.stringify({ ...signed, ...change })) as { signed: boolean } | null;
    assert.equal(out?.signed ?? false, false, JSON.stringify(change));
  }
  for (const bad of ["", "abc", "A".repeat(44), other.publicKey]) {
    assert.equal((swiftKeyed(bad, "feed", JSON.stringify(signed)) as { signed: boolean }).signed, false, bad);
  }
  // A field that is there but wrong refuses the whole feed.
  for (const bad of [{ sha256: "abc" }, { sha256: "g".repeat(64) }, { sha256: 7 }, { build: 1.5 }, { build: "512" }, { build: true }, { build: 0 },
    { minimumMacOS: "thirteen" }, { minimumMacOS: 13 }]) {
    assert.equal(swift("feed", JSON.stringify({ ...full, ...bad })), null, JSON.stringify(bad));
  }
  // A page that is not https is left out, the rest stands.
  assert.equal((swift("feed", JSON.stringify({ ...full, page: "http://e.com/" })) as { page: unknown }).page, null);
  // Plain http only on this Mac's own address, and only for the check-only feed (PAKO_APP_UPDATE_FEED).
  const local = { ...full, url: "http://127.0.0.1:9/Pako-0.3.0.dmg" };
  assert.equal(swift("feed", JSON.stringify(local)), null);
  assert.equal((swift("feed", JSON.stringify(local), "loopback") as { url: string }).url, local.url);
  assert.equal(swift("feed", JSON.stringify({ ...full, url: "http://example.com/Pako.dmg" }), "loopback"), null);
  // Newer: a newer version, or the same version with a higher build; an older version never, whatever its build.
  assert.equal(swift("release", "0.3.0", "10", "0.2.0", "99"), true);
  assert.equal(swift("release", "0.2.0", "43", "0.2.0", "42"), true);
  assert.equal(swift("release", "0.2.0", "42", "0.2.0", "42"), false);
  assert.equal(swift("release", "0.2.0", "-", "0.2.0", "42"), false, "the same version with no build is not newer");
  assert.equal(swift("release", "0.1.9", "999", "0.2.0", "42"), false);
  assert.equal(swift("release", "0.3.0-beta", "999", "0.2.0", "42"), false);
  assert.equal(swift("macos", "13.0", "15.7.7"), true);
  assert.equal(swift("macos", "15.7.7", "15.7.7"), true);
  assert.equal(swift("macos", "16.0", "15.7.7"), false);
  assert.equal(swift("macos", "nope", "15.7.7"), false);
});

test("mac app: Connect your things lists Telegram first, then Calendar, Mail, Slack and Zoom, with the Connections card's own words", { skip }, () => {
  const connections = { connections: [
    { id: "claude", name: "Claude", how: "key", state: "off" },
    { id: "zoom", name: "Zoom", how: "Zoom steps", state: "partial" },
    { id: "calendar", name: "Calendario", how: "ICS steps", state: "on" },
    { id: "mail", name: "Correo", how: "AgentMail steps", state: "weird" },
    { id: "slack", name: "Slack", how: "Slack steps", state: "off" },
    { id: "telegram", name: "Telegram", how: "its card", state: "off", card: "telegram" },
    { id: "tables", name: "Mesas", how: "places", state: "on" },
  ] };
  const ids = (r: unknown) => (r as { id: string; state: string }[]).map((x) => `${x.id}:${x.state}`);
  assert.deepEqual(ids(swift("things", JSON.stringify(connections), JSON.stringify({ state: "paired" }))),
    ["telegram:on", "calendar:on", "mail:off", "slack:off", "zoom:partial"]);
  assert.deepEqual(ids(swift("things", JSON.stringify(connections), JSON.stringify({ state: "unpaired" })))[0], "telegram:partial");
  assert.deepEqual(ids(swift("things", JSON.stringify(connections), "-"))[0], "telegram:off", "no answer from the Telegram card: not connected");
  assert.equal((swift("things", JSON.stringify(connections), "-") as { how: string }[])[1]!.how, "ICS steps", "the card's own steps");
  assert.equal(swift("things", "-", "-"), null, "no Connections card (a server's panel): no step");
  assert.equal(swift("things", JSON.stringify({ connections: [] }), "-"), null);
});

test("mac app: reads .env files as npm run panel does", { skip }, () => {
  const file = join(work, "a.env");
  writeFileSync(file, [
    "PAKO_HOME=/plain/path",
    "export PORT = 9000 # a comment",
    "PAKO_NAME=\"quoted # not a comment\" # but this is",
    "ODD='single'",
    "TICK=`back`",
    "  SPACED  =   value with spaces   ",
    "EMPTY=",
    "HASH=abc#def",
    "#PAKO_HOME=/commented",
    "PAKO_HOME=/second/wins\r",
    "1BAD=x",
    "",
  ].join("\n"));
  const names = ["PAKO_HOME", "PORT", "PAKO_NAME", "ODD", "TICK", "SPACED", "EMPTY", "HASH", "MISSING"];
  assert.deepEqual(swift("env", file, ...names), panel.readEnvFile(file, names));
  assert.deepEqual(swift("env", join(work, "nope.env"), "PAKO_HOME"), {});
});

test("mac app: finds the Pako home folder as npm run panel does", { skip }, () => {
  const user = join(work, "user");
  const repoDir = join(work, "repo");
  mkdirSync(join(user, ".pako"), { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  const both = (given?: string): void => {
    const env = given === undefined ? {} : { PAKO_HOME: given === "-" ? "" : given };
    const args = given === undefined ? [repoDir, user] : [repoDir, user, given];
    assert.equal(swift("home", ...args), panel.pakoHome(env, repoDir, user), `PAKO_HOME ${given ?? "unset"}`);
  };
  both();
  both("/given/home ");
  both("-");
  writeFileSync(join(repoDir, ".env"), "PAKO_HOME=/from/repo\n");
  both();
  writeFileSync(join(user, ".pako", ".env"), "PAKO_HOME=\"/from/home\"\n");
  both();
  both("-");
  writeFileSync(join(user, ".pako", ".env"), "PAKO_HOME=\n");
  both();
  assert.equal(swift("home", repoDir, user), join(user, ".pako"), "an empty value in the home's .env means ~/.pako");
});

test("mac app: reads the lock as npm run panel does", { skip }, () => {
  const home = join(work, "lockhome");
  mkdirSync(home, { recursive: true });
  const dead = spawnSync("true").pid ?? 999_999;
  const up = 5000;
  const cases = [
    `${process.pid}\n8787\n100\n`, // alive, this very process
    `${process.pid}\n8787\n100\nservice\n`,
    `${process.pid}\n8787\n9000\n`, // from before the computer last restarted
    `${process.pid}\n0\n100\n`,
    `${process.pid}\n70000\n`,
    `${process.pid}`, // an older Pako: the process only
    `${dead}\n8787\n100\n`,
    "  42abc\nx\n",
    "-5\n8787\n",
    "",
    "garbage",
  ];
  for (const text of cases) {
    writeFileSync(join(home, ".lock"), text);
    assert.deepEqual(swift("lock", home, String(up)), panel.readLock(home, up), JSON.stringify(text));
  }
  assert.deepEqual(swift("lock", join(work, "no-such-home"), "1"), null);
});

test("mac app: Node.js versions and which links it opens", { skip }, () => {
  assert.deepEqual(swift("node", "v22.18.0\n"), { v: [22, 18, 0], ok: true });
  assert.deepEqual(swift("node", "v22.17.9"), { v: [22, 17, 9], ok: false });
  assert.deepEqual(swift("node", "v24.1.0"), { v: [24, 1, 0], ok: true });
  assert.deepEqual(swift("node", "v18.20.4"), { v: [18, 20, 4], ok: false });
  assert.equal(swift("node", "not node"), null);
  // Only the exact origin the app loads: "localhost" may resolve to [::1], where another account on this Mac can listen (security review F2).
  assert.equal(swift("link", "http://localhost:8787/panel/login/abc", "8787"), false);
  assert.equal(swift("link", "http://[::1]:8787/panel/login/abc", "8787"), false);
  assert.equal(swift("link", "http://127.0.0.1:8787/panel/login/abc", "8787"), true);
  assert.equal(swift("link", "http://localhost:9999/panel/login/abc", "8787"), false);
  assert.equal(swift("link", "https://example.com:8787/panel/login/abc", "8787"), false);
  assert.equal(swift("link", "http://localhost.example.com:8787/panel/login/abc", "8787"), false);
});

const listening = (): Promise<{ server: Server; port: number }> =>
  new Promise((done) => {
    const server = createServer((_req, res) => res.end("{}")).listen(0, "127.0.0.1", () => done({ server, port: (server.address() as AddressInfo).port }));
  });

test("mac app: a lock's port counts only when the lock's own process listens on it", { skip }, async () => {
  const a = await listening();
  const b = await listening();
  const freePort = b.port;
  await new Promise((done) => b.server.close(done));
  try {
    assert.equal(swift("listens", String(process.pid), String(a.port)), true, "this process listens there");
    assert.equal(swift("listens", String(process.pid), String(freePort)), false, "nobody listens there now");
    const dead = spawnSync("true").pid ?? 999_999;
    assert.equal(swift("listens", String(dead), String(a.port)), false, "another process number (a stale lock) does not own it");
    assert.equal(swift("listens", "1", String(a.port)), false, "nor does another user's process (launchd)");
    assert.equal(swift("listens", String(process.pid), "0"), false);
  } finally {
    await new Promise((done) => a.server.close(done));
  }
});

test("mac app: what stays in the window, what goes to the browser, what is refused", { skip }, () => {
  const nav = (url: string, port: string, main = "1", clicked = "0"): unknown => swift("nav", url, port, main, clicked);
  // The panel's own pages, on its port only.
  assert.equal(nav("http://127.0.0.1:8787/panel", "8787"), "allow");
  assert.equal(nav("http://127.0.0.1:8787/panel/login/x", "8787"), "allow");
  // "localhost" and [::1] are not the panel (another account can answer there): a click opens them in the browser, never in the app.
  assert.equal(nav("http://localhost:8787/x", "8787", "1", "1"), "browser");
  assert.equal(nav("http://[::1]:8787/x", "8787", "1", "1"), "browser");
  assert.equal(nav("http://localhost:8787/x", "8787"), "refuse");
  assert.equal(nav("http://[::1]:8787/x", "8787"), "refuse");
  assert.equal(nav("blob:http://localhost:8787/1d2c", "8787"), "refuse");
  // The message handler and the file chooser: the same exact origin.
  assert.equal(swift("origin", "http", "127.0.0.1", "8787", "8787"), true);
  assert.equal(swift("origin", "http", "localhost", "8787", "8787"), false);
  assert.equal(swift("origin", "http", "::1", "8787", "8787"), false);
  assert.equal(swift("origin", "http", "[::1]", "8787", "8787"), false);
  assert.equal(swift("origin", "https", "127.0.0.1", "8787", "8787"), false);
  assert.equal(swift("origin", "http", "127.0.0.1", "8788", "8787"), false);
  assert.equal(swift("origin", "http", "127.0.0.1", "8787", "-"), false);
  assert.equal(nav("http://localhost:8788/panel", "8787"), "refuse", "another port, even on this computer");
  assert.equal(nav("http://localhost:8787/panel", "-"), "refuse", "no port known yet: nothing is the panel");
  assert.equal(nav("http://localhost/panel", "-"), "refuse");
  assert.equal(nav("https://localhost:8787/panel", "8787", "1", "1"), "browser", "https is not the panel");
  // The app's own pages and the panel's blobs (the data export).
  assert.equal(nav("about:blank", "8787"), "allow");
  assert.equal(nav("about:srcdoc", "8787"), "allow");
  assert.equal(nav("about:config", "8787"), "refuse");
  assert.equal(nav("blob:http://127.0.0.1:8787/1d2c", "8787"), "allow");
  assert.equal(nav("blob:https://example.com/1d2c", "8787"), "refuse");
  assert.equal(nav("blob:http://localhost:9999/1d2c", "8787"), "refuse");
  // Other sites: the default browser, only for a click in the page itself.
  assert.equal(nav("https://example.com/", "8787", "1", "1"), "browser");
  assert.equal(nav("mailto:a@example.com", "8787", "1", "1"), "browser");
  assert.equal(nav("tel:+34600000000", "8787", "1", "1"), "browser");
  assert.equal(nav("message://%3Cabc@mail.example%3E", "8787", "1", "1"), "browser", "the reader's Open in Apple Mail");
  assert.equal(nav("message://%3Cabc@mail.example%3E", "8787", "1", "0"), "refuse", "never by a script");
  assert.equal(nav("https://example.com/", "8787", "1", "0"), "refuse", "a script moving the page on by itself");
  assert.equal(nav("https://example.com/", "8787", "0", "1"), "refuse", "a frame");
  // Never, clicked or not.
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,<b>x</b>", "ftp://example.com/", "pako-app://retry", "x-apple.systempreferences:"]) {
    assert.equal(nav(url, "8787", "1", "1"), "refuse", url);
  }
});

test("mac app: the login shell's PATH is read after its marker, whatever its startup files print", { skip }, () => {
  assert.equal(swift("path", "\n__PAKO_PATH__/usr/bin:/bin\n"), "/usr/bin:/bin");
  assert.equal(swift("path", "Last login: today\nnvm: warning\n\n__PAKO_PATH__/a b/bin:/usr/bin\n"), "/a b/bin:/usr/bin");
  assert.equal(swift("path", "/usr/bin:/bin"), "", "no marker, nothing taken");
});

// ---------- Claude: the Connect Claude window (desktop/mac/Claude.swift) ----------

const NOT_IN = JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty", analyticsDisabled: false, loginExpiresAt: null }, null, 2);
const PLAN = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "ana@example.com", subscriptionType: "max", orgName: "x" });

test("mac app: claude auth status is read for loggedIn, authMethod, email and plan only, as the server reads it", { skip }, async () => {
  const { authFromStatus } = await import("../src/local.ts");
  const cases: [number, string, unknown][] = [
    [1, NOT_IN, { loggedIn: false, method: "none", email: null, plan: null }],
    [0, PLAN, { loggedIn: true, method: "claude.ai", email: "ana@example.com", plan: "max" }],
    [0, '{"loggedIn":true,"authMethod":"oauth_token"}', { loggedIn: true, method: "oauth_token", email: null, plan: null }],
    [0, '{"loggedIn":true,"authMethod":"api_key","newField":{"a":1}}', { loggedIn: true, method: "api_key", email: null, plan: null }],
    [0, `note: a line first\n${PLAN}\n`, { loggedIn: true, method: "claude.ai", email: "ana@example.com", plan: "max" }],
    [0, '{"loggedIn":false,"authMethod":"none"}', { loggedIn: false, method: "none", email: null, plan: null }],
    [1, '{"loggedIn":true,"authMethod":"claude.ai","email":"x@example.com"}', { loggedIn: false, method: "none", email: null, plan: null }],
    [0, '{"somethingElse":true}', null],
    [1, "error: unknown command 'auth'", null],
    [2, PLAN, null],
    [0, "", null],
  ];
  for (const [code, out, want] of cases) assert.deepEqual(swift("auth", String(code), out), want, `${code} ${out}`);
  for (const v of ["2.1.268 (Claude Code)", "2.1.325 (Claude Code)\n", "3.0.0"]) assert.equal(swift("version", v), true, v);
  for (const v of ["2.1.267 (Claude Code)", "1.0.128 (Claude Code)", "Claude Code", ""]) assert.equal(swift("version", v), false, v);
  // The server's reading of the same answers agrees on signed in or not.
  assert.equal(authFromStatus(1, NOT_IN), "none");
  assert.equal(authFromStatus(0, PLAN), "plan");
});

test("mac app: the Claude state from the app's own look and the running Pako's word", { skip }, () => {
  const st = (bin: boolean, code: string, out: string, server: unknown) => swift("state", bin ? "1" : "0", code, out, server === null ? "-" : JSON.stringify(server));
  assert.equal(st(false, "-", "-", null), "notInstalled");
  assert.equal(st(false, "-", "-", { claude: "ok", running: true, auth: "plan" }), "notInstalled", "the app's own look wins: the command is gone");
  assert.equal(st(true, "1", NOT_IN, null), "notSignedIn");
  assert.equal(st(true, "1", NOT_IN, { claude: "ok", running: true }), "notSignedIn", "fresher than a Pako that has not asked yet");
  assert.equal(st(true, "0", PLAN, null), "plan");
  assert.equal(st(true, "0", PLAN.replace('"max"', '"free"'), null), "needsPlan", "the free plan cannot run Claude Code");
  assert.equal(st(true, "0", PLAN, { claude: "ok", running: true, auth: "plan" }), "plan");
  assert.equal(st(true, "0", PLAN, { claude: "ok", running: true, auth: "key", key: "connections" }), "apiKey", "a key set for Pako wins over the plan");
  assert.equal(st(true, "0", PLAN, { claude: "ok", running: true, key: "environment" }), "apiKey");
  assert.equal(st(true, "0", '{"loggedIn":true,"authMethod":"api_key"}', null), "apiKey");
  assert.equal(st(true, "0", PLAN, { claude: "limit", running: true }), "limit");
  assert.equal(st(true, "-", "-", { claude: "login", running: true }), "notSignedIn", "no answer of its own: Pako's word");
  assert.equal(st(true, "-", "-", { claude: "ok", running: true, auth: "plan" }), "plan");
  assert.equal(st(true, "-", "-", { claude: "ok", running: true }), "unknown");
  assert.equal(st(true, "-", "-", null), "unknown");
  assert.equal(st(true, "0", '{"loggedIn":true,"authMethod":"brand-new"}', null), "unknown");
  // Where a key that wins over the plan is set: only whether it is, never its value.
  assert.equal(swift("keysrc", "-", "-"), null);
  assert.equal(swift("keysrc", "  ", "-"), null);
  assert.equal(swift("keysrc", "sk-ant-x", "-"), "app");
  assert.equal(swift("keysrc", "-", JSON.stringify({ claude: "ok", key: "connections" })), "connections");
  assert.equal(swift("keysrc", "sk-ant-x", JSON.stringify({ claude: "ok", key: "environment" })), "environment");
  assert.equal(swift("keysrc", "-", JSON.stringify({ claude: "ok", key: "<b>" })), null);
});

test("mac app: claude is found anew in the login shell's PATH, then the installers' folders; CLAUDE_BIN is that one or none", { skip }, () => {
  const find = (given: string, path: string, exec: string[]) => swift("find", given, path, "/Users/ana", exec.join(","));
  assert.equal(find("-", "/usr/bin:/bin", []), null);
  assert.equal(find("-", "/usr/bin:/bin", ["/Users/ana/.local/bin/claude"]), "/Users/ana/.local/bin/claude", "the native installer's folder, not on the PATH yet");
  assert.equal(find("-", "/opt/x/bin:/usr/bin", ["/Users/ana/.local/bin/claude", "/opt/x/bin/claude"]), "/opt/x/bin/claude", "the PATH first");
  assert.equal(find("-", "", ["/Users/ana/.claude/local/claude", "/opt/homebrew/bin/claude"]), "/Users/ana/.claude/local/claude");
  assert.equal(find("-", "bin:.:/usr/bin", ["bin/claude", "./claude"]), null, "a relative folder is never looked in");
  assert.equal(find("/opt/mine/claude", "/usr/bin", ["/opt/mine/claude", "/Users/ana/.local/bin/claude"]), "/opt/mine/claude");
  assert.equal(find(" /opt/mine/claude ", "/usr/bin", ["/Users/ana/.local/bin/claude"]), null, "CLAUDE_BIN set and not there: none, as Pako does");
  assert.equal(find("claude", "/usr/bin", ["claude"]), null);
  assert.equal(swift("merge", "/a:/b::rel:/a", "/c:/b", "/d"), "/a:/b:/c:/d");
});

test("mac app: only Anthropic's installer is run, only Claude's own sign-in page is reopened, and output is shown as its last lines", { skip }, () => {
  for (const u of ["https://claude.ai/install.sh", "https://downloads.claude.ai/claude-code-releases/bootstrap.sh"]) assert.equal(swift("installer", u), true, u);
  for (const u of ["http://claude.ai/install.sh", "https://claude.ai.example.com/install.sh", "https://evil.com/claude.ai", "https://user@claude.ai/install.sh", "file:///tmp/install.sh"]) {
    assert.equal(swift("installer", u), false, u);
  }
  const login = "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y\nPaste code here if prompted > ";
  assert.equal(swift("loginurl", login), "https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y");
  assert.equal(swift("loginurl", "visit: https://claude.com.evil.example/x"), null);
  assert.equal(swift("loginurl", "visit: http://claude.com/x"), null);
  assert.equal(swift("loginurl", "nothing here"), null);
  assert.equal(swift("tail", "a\n\u001b[32mgreen\u001b[0m\n10%\r50%\r100%\n\n", "2"), "green\n100%");
  assert.equal(swift("tail", "one\ntwo\nthree", "1"), "three");
});

test("mac app: the sign-in's code (Claude Code 2.1.325 asks for it): the prompt is seen, the page found, the code trimmed, the error shown", { skip }, () => {
  // As `claude auth login --claudeai` printed it on a Mac with stdin a pipe (the challenge and state shortened); the prompt has no newline.
  const real =
    "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
    "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=abc&code_challenge_method=S256&state=xyz\n" +
    "Paste code here if prompted > ";
  assert.equal(swift("asks", real), true);
  assert.equal(swift("asks", "Opening browser to sign in…\n"), false, "not before it asks");
  assert.equal(swift("asks", "PASTE CODE here >"), true);
  const page = swift("loginurl", real) as string;
  assert.ok(page.startsWith("https://claude.com/cai/oauth/authorize?code=true&"), page);
  assert.ok(page.endsWith("&state=xyz"), "the whole address, up to the newline");
  assert.equal(swift("code", "  abcDEF123#state-456\n"), "abcDEF123#state-456");
  assert.equal(swift("code", "abcDEF\r\n123#st ate\t"), "abcDEF123#state", "a code copied across a line break");
  assert.equal(swift("code", " \n\t "), null, "nothing to send");
  assert.equal(swift("code", "abc\u0003def"), null, "control characters: not a code");
  assert.equal(swift("code", "x".repeat(2001)), null);
  // What it wrote on stderr for a code it refused (it then waits for another), and for one that failed (it then ends): shown as the last line.
  assert.equal(swift("tail", "Invalid code. Please make sure the full code was copied.\n", "1"), "Invalid code. Please make sure the full code was copied.");
  const failed = "Login failed: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.\n";
  assert.ok((swift("tail", failed, "1") as string).startsWith("Login failed: That code wasn't accepted."));
});

test("mac app: the real claude on this Mac, when there is one: its auth status maps to the state the window shows", { skip }, () => {
  const home = process.env.HOME ?? "";
  const bin = [join(home, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].find((p) => existsSync(p));
  if (!bin) return;
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const r = spawnSync(bin, ["auth", "status"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  assert.ok(r.status === 0 || r.status === 1, `exit ${r.status}`);
  const parsed = swift("auth", String(r.status), r.stdout) as { loggedIn: boolean } | null;
  assert.ok(parsed, "this Claude Code's answer is read");
  assert.equal(parsed.loggedIn, r.status === 0);
  const state = swift("state", "1", String(r.status), r.stdout, "-");
  assert.equal(state, r.status === 0 ? (JSON.parse(r.stdout) as { authMethod: string }).authMethod.startsWith("api_key") ? "apiKey" : "plan" : "notSignedIn");
});

test("mac app: a lock that says when its process started holds only for that process (a number that came round again is taken over)", { skip }, () => {
  const home = join(work, "lockstart");
  mkdirSync(home, { recursive: true });
  const me = swift("started", String(process.pid)) as { start: number; path: string };
  assert.ok(Math.abs(me.start - (Date.now() / 1000 - process.uptime())) < 3, "the kernel's start time of this process");
  assert.equal(me.path, process.execPath);
  writeFileSync(join(home, ".lock"), `${process.pid}\n8787\n100\n\n${me.start}\n`);
  assert.deepEqual(swift("lock", home, "5000"), { pid: process.pid, port: 8787, alive: true });
  writeFileSync(join(home, ".lock"), `${process.pid}\n8787\n100\nservice\n${me.start - 3600}\n`);
  assert.deepEqual(swift("lock", home, "5000"), { pid: process.pid, port: 8787, alive: false }, "started at another time: another program");
  assert.deepEqual(swift("started", "999999"), { start: -1, path: "" });
});

test("mac app: keeping Pako running: the pause before each restart, why a start failed, a free port, log rotation", { skip }, () => {
  assert.deepEqual(swift("delays"), [-1, 1, 2, 4, -1, -1], "1, 2, 4 s; the fourth crash in a row: no more");
  assert.deepEqual(swift("why", "\n  Port 8787 is already in use. If Pako is already running, open its panel instead\n"), { port: 8787 });
  assert.deepEqual(swift("why", "Error: listen EADDRINUSE: address already in use 127.0.0.1:9000"), { port: 0 });
  assert.equal(swift("why", "\n  Pako cannot start: a setting in ~/.pako/.env or ./.env is wrong (see the line above)."), "settings");
  assert.equal(swift("why", "Pako is already running for this folder (process 12)."), "held");
  assert.equal(swift("why", "something else"), "unknown");
  assert.deepEqual(swift("free", "1"), { given: false, chosen: true, chosenFree: true }, "port 1 is not ours to take");
  const dir = join(work, "logs");
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "app.log");
  writeFileSync(log, "a".repeat(100), { mode: 0o600 });
  assert.equal(swift("rotate", log, "1000"), false, "small: left alone");
  for (const ch of ["b", "c", "d", "e"]) {
    writeFileSync(log, ch.repeat(2000), { mode: 0o600 });
    assert.equal(swift("rotate", log, "1000"), true);
  }
  assert.equal(statSync(log).size, 0, "emptied in place");
  assert.deepEqual([1, 2, 3].map((i) => readFileSync(`${log}.${i}`, "utf8")[0]), ["e", "d", "c"], "three generations, newest first");
  assert.ok(!existsSync(`${log}.4`));
  assert.equal(statSync(`${log}.1`).mode & 0o777, 0o600);
});

test("mac app: notices: what is new is notified once, what is after the last read is the badge, a secret is never quoted", { skip }, () => {
  const body = JSON.stringify({ now: 5000, notices: [{ n: 1, at: 1000, text: "a" }, { n: 2, at: 2000, text: "", secret: true }, { n: 3, at: 3000, text: "c" }] });
  assert.deepEqual(swift("counts", body, "1500", "1000"), { now: 5000, fresh: [2, 3], unread: 2, secret: [2] });
  assert.deepEqual(swift("counts", body, "3000", "3000"), { now: 5000, fresh: [], unread: 0, secret: [2] });
  assert.equal(swift("counts", "{}", "0", "0"), null);
  assert.equal(swift("hash", "/tmp/x"), fnv("/tmp/x"));
});

test("mac app: the panel's messages: only known types with well-formed values are taken, anything else is ignored", { skip }, () => {
  const msg = (m: unknown) => swift("msg", JSON.stringify(m));
  assert.deepEqual(msg({ type: "discover", what: ["apps", "mail", "apps"] }), { type: "discover", what: ["apps", "mail"], openMail: false });
  assert.deepEqual(msg({ type: "discover", what: ["zoom"], openMail: true }), { type: "discover", what: ["zoom"], openMail: true });
  for (const bad of [{ type: "discover" }, { type: "discover", what: [] }, { type: "discover", what: ["photos"] }, { type: "discover", what: "apps" },
    { type: "discover", what: ["apps"], openMail: "yes" }, { type: "calendarSelect", ids: [1] }, { type: "calendarSelect", ids: ["a\nb"] },
    { type: "calendarSelect" }, { type: "openURL", url: "file:///etc/passwd" }, { type: "runScript", src: "x" }, { type: 3 }, {}, ["discover"], "discover"]) {
    assert.equal(msg(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(msg({ type: "calendarSelect", ids: ["A1", "B2", "A1"] }), { type: "calendarSelect", ids: ["A1", "B2"] });
  assert.deepEqual(msg({ type: "calendarSelect", ids: [] }), { type: "calendarSelect", ids: [] }, "none chosen: stop");
  assert.deepEqual(msg({ type: "contactsImport" }), { type: "contactsImport" });
  assert.deepEqual(msg({ type: "openSettingsWindow" }), { type: "openSettingsWindow" });
  assert.deepEqual(msg({ type: "calendarPush" }), { type: "calendarPush" }, "the dashboard's refresh asks for the calendars now");
  assert.deepEqual(msg({ type: "openURL", url: "https://app.slack.com/" }), { type: "openURL", url: "https://app.slack.com/" });
  assert.deepEqual(msg({ lang: "en" }), { type: "panelWord" }, "the welcome's first step");
  assert.deepEqual(msg({ lang: "es" }), { type: "panelWord" }, "an older panel's language word is still understood (and changes nothing)");
  assert.deepEqual(msg({ welcomed: true }), { type: "panelWord" });
});

test("mac app: the connections page's own messages (its window, \"use this\", Zoom's recordings by the contract's name) are understood", { skip }, () => {
  const msg = (m: unknown) => swift("msg", JSON.stringify(m));
  assert.deepEqual(msg({ type: "openWindow", path: "/panel/settings" }), { type: "openWindow", path: "/panel/settings" });
  assert.deepEqual(msg({ type: "openWindow", path: "/panel/settings#calendar" }), { type: "openWindow", path: "/panel/settings#calendar" });
  assert.deepEqual(msg({ type: "use", what: "calendars", ids: ["A", "A", "B"] }), { type: "use", what: "calendars", ids: ["A", "B"] });
  assert.deepEqual(msg({ type: "use", what: "contacts" }), { type: "use", what: "contacts", ids: [] });
  assert.deepEqual(msg({ type: "use", what: "zoomRecordings" }), { type: "use", what: "zoomRecordings", ids: [] });
  assert.deepEqual(msg({ type: "discover", what: ["apps", "zoomRecordings", "zoom"] }), { type: "discover", what: ["apps", "zoom"], openMail: false });
  for (const bad of [{ type: "openWindow", path: "https://evil.example/" }, { type: "openWindow", path: "/panel/settings/../x" },
    { type: "openWindow", path: "/panel/settings#Bad-1" }, { type: "openWindow" }, { type: "use", what: "photos" },
    { type: "use", what: "calendars" }, { type: "use", what: "calendars", ids: [3] }]) {
    assert.equal(msg(bad), null, JSON.stringify(bad));
  }
});

test("mac app: Apple Reminders: which reminder is Pako's and of which loop, due dates both ways, what is posted, and which ops may be made", { skip }, () => {
  const A = "a000000001";
  // The loop: by its link, else by the tag at the end of its notes; anything else is not Pako's.
  assert.equal(swift("rloop", `pako://loop/${A}`, "-"), A);
  assert.equal(swift("rloop", "-", `You told Ana you would.\nKept in step by Pako [pako:${A}]`), A, "the link dropped by a device: the tag");
  assert.equal(swift("rloop", "https://example.com/", "Buy milk"), null);
  assert.equal(swift("rloop", "pako://loop/../../etc", "[pako:XYZ]"), null);
  // Due dates: a day and a time in the owner's zone, a day with no time as its date (Pako reads it as 09:00 there).
  assert.equal(swift("rdue", JSON.stringify({ year: 2026, month: 11, day: 21, hour: 9, minute: 30 }), "Europe/Madrid"), Date.parse("2026-11-21T08:30:00Z"));
  assert.equal(swift("rdue", JSON.stringify({ year: 2026, month: 11, day: 21 }), "Europe/Madrid"), "2026-11-21");
  assert.equal(swift("rdue", "-", "Europe/Madrid"), null);
  assert.deepEqual(swift("rcomp", String(Date.parse("2026-11-21T08:30:00Z")), "Europe/Madrid"),
    { year: 2026, month: 11, day: 21, hour: 9, minute: 30, zone: "Europe/Madrid" });
  // What is posted: Pako's lists only, never a reminder's notes.
  const lists = { owe: "L1", waiting: "L2", groceries: "L3" };
  const body = swift("rpayload", "1", JSON.stringify(lists), JSON.stringify([
    { id: "r1", list: "owe", title: "Send Ana the deck", url: `pako://loop/${A}`, notes: "secret words", due: { year: 2026, month: 11, day: 21 }, modified: 5000 },
    { id: "r2", list: "owe", title: "Buy milk", completed: true },
    { id: "r3", list: "groceries", title: "Eggs" },
  ]), "Europe/Madrid") as { on: boolean; lists: Record<string, string>; reminders: Record<string, unknown>[] };
  assert.equal(body.on, true);
  assert.deepEqual(body.lists, { owe: "L1", waiting: "L2" });
  assert.deepEqual(body.reminders, [
    { id: "r1", list: "owe", loop: A, title: "Send Ana the deck", due: "2026-11-21", completed: false, modified: 5000 },
    { id: "r2", list: "owe", title: "Buy milk", due: null, completed: true },
  ]);
  assert.doesNotMatch(JSON.stringify(body), /secret words/);
  assert.deepEqual((swift("rpayload", "0", JSON.stringify(lists), "[]", "UTC") as { reminders: unknown[] }).reminders, []);
  // The ops: a create made once (not when its reminder is already there), an update or a removal only of a reminder of Pako's lists that
  // carries that loop's tag.
  const ops = [
    { op: "create", loop: A, list: "owe", title: "Send Ana the deck", due: 1000, notes: "n" },
    { op: "create", loop: "b000000002", list: "owe", title: "Call Kenji", due: null, notes: "" },
    { op: "create", loop: "b000000002", list: "owe", title: "Call Kenji", due: null, notes: "" },
    { op: "create", loop: "c000000003", list: "groceries", title: "x", notes: "" },
    { op: "update", id: "r9", loop: A, due: null, completed: true },
    { op: "remove", id: "r8", loop: A },
    { op: "runScript", loop: A },
  ];
  assert.deepEqual(swift("rops", JSON.stringify(ops), JSON.stringify([{ id: "r1", list: "owe", title: "x", url: `pako://loop/${A}` }])), [
    { op: "create", loop: "b000000002", list: "owe", title: "Call Kenji", due: null, notes: "" },
    { op: "update", id: "r9", loop: A, due: null, completed: true },
    { op: "remove", id: "r8", loop: A },
  ]);
  const upd = JSON.stringify({ op: "update", id: "r1", loop: A, completed: true });
  assert.equal(swift("rallowed", upd, JSON.stringify({ id: "r1", list: "owe", title: "x", url: `pako://loop/${A}` })), true);
  assert.equal(swift("rallowed", upd, JSON.stringify({ id: "r1", list: "owe", title: "x", notes: `[pako:${A}]` })), true);
  assert.equal(swift("rallowed", upd, JSON.stringify({ id: "r1", list: "groceries", title: "x", url: `pako://loop/${A}` })), false, "another list");
  assert.equal(swift("rallowed", upd, JSON.stringify({ id: "r1", list: "owe", title: "Buy milk" })), false, "no tag: the person's own");
  assert.equal(swift("rallowed", upd, JSON.stringify({ id: "r1", list: "owe", title: "x", url: "pako://loop/b000000002" })), false, "another loop");
  assert.equal(swift("rallowed", upd, JSON.stringify({ id: "r2", list: "owe", title: "x", url: `pako://loop/${A}` })), false, "another reminder");
  assert.equal(swift("rallowed", upd, "-"), false, "not found");
  assert.equal(swift("rallowed", JSON.stringify({ op: "remove", id: "r1", loop: "../x" }), "-"), null, "not an op");
  // The panel's switch, and its privacy pane.
  assert.deepEqual(swift("msg", JSON.stringify({ type: "reminders", on: true })), { type: "reminders", on: true });
  assert.deepEqual(swift("msg", JSON.stringify({ type: "reminders", on: false })), { type: "reminders", on: false });
  assert.equal(swift("msg", JSON.stringify({ type: "reminders" })), null);
  assert.equal(swift("msg", JSON.stringify({ type: "reminders", on: "yes" })), null);
  const pane = "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders";
  assert.equal(swift("openurl", pane), pane);
});

test("mac app: Reminders turned off while a round is under way: off is the last thing Pako hears, and that round's changes are not made", { skip }, () => {
  // The round read Reminders and would post "on" after the switch's "off": Pako would turn it on again and the app make its changes.
  assert.deepEqual(swift("roff"), { posts: [false], applied: 0, on: false });
});

test("mac app: the panel opens only https, Slack, Telegram and Zoom's apps and the privacy panes of System Settings", { skip }, () => {
  for (const u of ["https://zoom.us/signin", "slack://open", "tg://resolve?domain=pako_bot", "zoommtg://zoom.us/join?confno=1",
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars", "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Contacts"]) assert.equal(swift("openurl", u), u, u);
  for (const u of ["http://example.com/", "file:///Users/ana/.pako/secrets.json", "javascript:alert(1)", "ssh://host", "https://user:pw@example.com/",
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera", "x-apple.systempreferences:com.apple.Users-Groups-Settings.extension",
    "https://example.com/ a", "vnc://host", "smb://host/share", ""]) assert.equal(swift("openurl", u), null, u);
});

test("mac app: installed apps by bundle id, and a mail address's provider from its domain (or Mail's iCloud type)", { skip }, () => {
  assert.deepEqual(swift("apps", "us.zoom.xos,org.telegram.desktop,com.apple.mail"),
    { zoom: true, slack: false, telegram: true, whatsapp: false, mail: true, outlook: false, teams: false });
  assert.deepEqual(swift("apps", "-"), { zoom: false, slack: false, telegram: false, whatsapp: false, mail: false, outlook: false, teams: false });
  const cases: [string, string][] = [["ana@icloud.com", "icloud"], ["ana@me.com", "icloud"], ["ana@mac.com", "icloud"], ["ana@gmail.com", "google"],
    ["ana@googlemail.com", "google"], ["ana@outlook.com", "microsoft"], ["ana@hotmail.es", "microsoft"], ["ana@live.co.uk", "microsoft"],
    ["ana@msn.com", "microsoft"], ["ana@yahoo.es", "yahoo"], ["ana@ymail.com", "yahoo"], ["ana@pako.es", "other"], ["ANA@GMAIL.COM", "google"],
    ["gmail.com", "other"], ["ana@gmail.com.evil.example", "other"]];
  for (const [a, p] of cases) assert.equal(swift("provider", a), p, a);
  assert.equal(swift("provider", "ana@pako.es", "iCloud"), "icloud", "an iCloud account with its own domain");
});

test("mac app: Mail's accounts: one entry per address, lower case, said once, with provider and kind; nothing that is not an address", { skip }, () => {
  const out = "Gmail\tAna@Gmail.com,ana@gmail.com,\timap\niCloud\tana@me.com,ana@pako.es,\tiCloud\nWork\tana@corp.com,\tews\n"
    + "Old\tana@isp.example,\tpop\nNone\t\timap\nBroken\tnot an address,a@b,\timap\nshort line\n";
  assert.deepEqual(swift("mailparse", out), [
    { address: "ana@gmail.com", name: "Gmail", provider: "google", kind: "imap" },
    { address: "ana@me.com", name: "iCloud", provider: "icloud", kind: "imap" },
    { address: "ana@pako.es", name: "iCloud", provider: "icloud", kind: "imap" },
    { address: "ana@corp.com", name: "Work", provider: "other", kind: "exchange" },
    { address: "ana@isp.example", name: "Old", provider: "other", kind: "other" },
  ]);
  assert.deepEqual(swift("mailparse", ""), []);
});

test("mac app: a cancelled meeting (Exchange keeps it as \"Canceled: …\") is not sent; 30 attendees with an address are", { skip }, () => {
  const now = Date.UTC(2026, 10, 16, 8, 0, 0);
  const h = 3600_000;
  const people = ["Room 4.01", ...Array.from({ length: 35 }, (_, i) => `P${i} <p${i}@x.com>`)];
  const events = [
    { id: "gone", calendarId: "work", title: "Canceled: Budget", start: now + h, end: now + 2 * h, cancelled: true },
    { id: "kept", calendarId: "work", title: "Budget", start: now + 3 * h, end: now + 4 * h, attendees: people.slice(0, 31) },
  ];
  const r = swift("events", JSON.stringify(events), "work", String(now), "UTC") as { events: Record<string, unknown>[] };
  assert.deepEqual(r.events.map((e) => e.title), ["Budget"]);
  assert.equal((r.events[0]!.attendees as unknown[]).length, 30, "a name without an address does not take one of the 30 places");
});

test("mac app: calendar events: only the chosen calendars, two days back to fourteen ahead, each occurrence its own id, local dates", { skip }, () => {
  const now = Date.UTC(2026, 10, 16, 8, 0, 0);
  const h = 3600_000, day = 24 * h;
  const ev = (id: string, cal: string, start: number, more: Record<string, unknown> = {}) => ({ id, calendarId: cal, title: ` ${id} `, start, end: start + h, ...more });
  const events = [
    ev("weekly", "home", now + day, { url: "https://meet.example/x", location: "Sala 1", attendees: ["Ana <ana@x.com>", ""],
      notes: `${"Microsoft Teams meeting. Join on your computer or mobile app. ".repeat(30)}https://us02web.zoom.us/j/123456 agenda` }),
    ev("weekly", "home", now + 8 * day, { url: "javascript:alert(1)" }),
    ev("other", "work", now + h),
    ev("old", "home", now - 3 * day),
    ev("far", "home", now + 15 * day),
    ev("allday", "home", Date.UTC(2026, 10, 15, 23, 0, 0), { allDay: true }),
    ev("", "home", now),
  ];
  const r = swift("events", JSON.stringify(events), "home", String(now), "Europe/Madrid") as { calendars: string[]; events: Record<string, unknown>[] };
  assert.deepEqual(r.calendars, ["home"]);
  assert.deepEqual(r.events.map((e) => e.id), [`allday@${Date.UTC(2026, 10, 15, 23) / 1000}`, `weekly@${(now + day) / 1000}`, `weekly@${(now + 8 * day) / 1000}`]);
  assert.deepEqual(r.events[0], { id: `allday@${Date.UTC(2026, 10, 15, 23) / 1000}`, calendarId: "home", title: "allday", start: "2026-11-16T00:00:00+01:00",
    end: "2026-11-16T01:00:00+01:00", allDay: true }, "an all-day event keeps its own day in this Mac's time zone");
  assert.deepEqual(r.events[1], { id: `weekly@${(now + day) / 1000}`, calendarId: "home", title: "weekly", start: "2026-11-17T09:00:00+01:00",
    end: "2026-11-17T10:00:00+01:00", allDay: false, location: "Sala 1", notes: "https://us02web.zoom.us/j/123456", url: "https://meet.example/x",
    attendees: [{ email: "ana@x.com", name: "Ana" }] },
    "of the notes only their links go (the call's); the attendees go as address and name, for People and meeting prep");
  assert.equal(r.events[2]!.url, undefined, "a link that is not http(s) is left out");
  assert.ok(Number.isFinite(Date.parse(r.events[1]!.start as string)), "JavaScript reads the dates");
  assert.deepEqual(swift("events", JSON.stringify(events), "-", String(now), "UTC"), { calendars: ["-"], events: [], writes: true }, "a push says this app makes the changes the person says yes to");
  assert.deepEqual(swift("calendars", JSON.stringify([{ id: "home", title: " Casa ", source: "iCloud", color: "#ff0000", writable: true }, { id: "", title: "x" }])),
    [{ id: "home", title: "Casa", source: "iCloud", color: "#ff0000", writable: true }]);
});

test("mac app: a calendar change touches the occurrence it means, never a repeating event's first one", { skip }, () => {
  const at = Date.UTC(2026, 10, 24, 9);
  const target = (near: unknown[], byID: unknown) => swift("wtarget", String(at), JSON.stringify(near), byID === null ? "-" : JSON.stringify(byID));
  // EventKit's event(withIdentifier:) answers a repeating event's first occurrence (here a year ago).
  const first = { name: "first", start: at - 365 * 86400_000, repeats: true };
  assert.equal(target([{ name: "tuesday", start: at + 20_000, repeats: true }], first), "tuesday", "the occurrence at that start");
  assert.equal(target([], first), null, "moved or deleted meanwhile (or already moved by this write): never the series' first occurrence");
  assert.equal(target([], { name: "single", start: at + 3600_000, repeats: false }), "single", "an event that does not repeat, moved since");
  assert.equal(target([], null), null);
  assert.equal(swift("wtarget", "-", "[]", JSON.stringify(first)), "first", "no start said: the event itself");
});

test("mac app: contacts: a name (or the company's), addresses in lower case, merged when two cards share one, nobody without a way to reach", { skip }, () => {
  const people = [
    { name: "Ana", emails: ["ANA@x.com"], phones: [] },
    { name: "Ana López", emails: ["ana@x.com", "a2@x.com", "not an address"], phones: ["+34 600 000 000"] },
    { name: "Ana L.", emails: [], phones: ["+34600000000"] },
    { name: "", emails: [], phones: ["123"], org: "Acme" },
    { name: "Nobody", emails: [], phones: [] },
    { name: "", emails: ["x@y.com"], phones: [] },
  ];
  assert.deepEqual(swift("people", JSON.stringify(people)), [
    { name: "Ana", emails: ["ana@x.com", "a2@x.com"], phones: ["+34 600 000 000", "+34600000000"] },
    { name: "Acme", emails: [], phones: ["123"], org: "Acme" },
  ]);
  assert.equal(swift("zoom", JSON.stringify({ "2026-11-10 Standup": ["closed_caption.vtt", "zoom_0.mp4"], "2026-11-11 Call": ["recording.conf"],
    "2026-11-12 Chat": ["meeting_saved_chat.txt"] })), 2, "a transcript or a recording not converted yet; never what is in them");
});

test("mac app: one discovery asks macOS only for what was asked and never answered, reads nothing without its yes, opens Mail only on the button", { skip }, () => {
  const disc = (what: string, openMail: boolean, fake: Record<string, unknown>) =>
    swift("discover", what, openMail ? "1" : "0", JSON.stringify(fake)) as { result: Record<string, unknown>; calls: string[] };
  // Everything, on a Mac where nothing was ever asked: calendars said yes, contacts said no, Mail is not running (so it is not asked).
  const all = disc("apps,calendars,contacts,mail,zoom", false, { grant: ["calendars"], installed: ["us.zoom.xos", "com.tinyspeck.slackmacgap"],
    calendarList: [{ id: "c1", title: "Casa", source: "iCloud", color: "#ff0000", writable: true }], contactsCount: 120,
    zoom: { m1: ["a.vtt"], m2: ["x.mp4"] } });
  assert.deepEqual(all.calls, ["request:calendars", "read:calendars", "request:contacts", "read:zoom"]);
  assert.deepEqual(all.result, {
    at: "2027-01-15T08:00:00Z",
    apps: { zoom: true, slack: true, telegram: false, whatsapp: false, mail: false, outlook: false, teams: false },
    calendars: [{ id: "c1", title: "Casa", source: "iCloud", color: "#ff0000", writable: true }],
    contacts: { count: 0 }, mailAccounts: [], mailState: "closed", zoomRecordings: { folder: "/Users/test/Documents/Zoom", count: 1 },
    permissions: { calendars: "granted", contacts: "denied", mail: "notAsked" },
  });
  // Only apps: no prompt, nothing read but the bundle ids; the permissions are still said (reading them asks nothing).
  const apps = disc("apps", false, { calendars: "granted", contacts: "granted", mail: "granted", mailRunning: true });
  assert.deepEqual(apps.calls, []);
  assert.deepEqual(Object.keys(apps.result).sort(), ["apps", "at", "permissions"]);
  // A refusal is not asked again, and nothing behind it is read.
  assert.deepEqual(disc("calendars,contacts", false, { calendars: "denied", contacts: "denied", grant: ["calendars", "contacts"] }).calls, []);
  // Mail: not running and no button, nothing; running, asked (macOS's Automation prompt); not running with the button, opened and asked.
  assert.deepEqual(disc("mail", false, { mailRunning: false, grant: ["mail"], mailOutput: "G\ta@b.co,\timap\n" }).calls, []);
  const running = disc("mail", false, { mailRunning: true, grant: ["mail"], mailOutput: "G\ta@b.co,\timap\n" });
  assert.deepEqual(running.calls, ["ask:mail", "request:mail"]);
  assert.deepEqual(running.result.mailAccounts, [{ address: "a@b.co", name: "G", provider: "other", kind: "imap", apps: ["mail"] }]);
  assert.equal(running.result.mailState, "found");
  assert.deepEqual((running.result.permissions as Record<string, string>).mail, "granted");
  assert.deepEqual(disc("mail", true, { mailRunning: false, grant: ["mail"], mailOutput: "G\ta@b.co,\timap\n" }).calls, ["open:mail", "request:mail"]);
  const refused = disc("mail", true, { mailRunning: true, mail: "denied", mailOutput: "G\ta@b.co,\timap\n" });
  assert.deepEqual(refused.calls, [], "Automation refused before: Mail is not asked");
  assert.deepEqual(refused.result.mailAccounts, []);
  assert.equal(refused.result.mailState, "denied");
  assert.equal(disc("zoom", false, {}).result.zoomRecordings, null, "no Zoom folder");
  // What Pako kept, with this look on top: every field of the contract, the look's parts replaced, nothing else carried over.
  assert.deepEqual(swift("dmerge", JSON.stringify({ calendars: [{ id: "c1" }], at: "then", stray: "x" }), JSON.stringify({ at: "now", apps: { zoom: true } })), {
    at: "now", apps: { zoom: true }, calendars: [{ id: "c1" }], mailAccounts: [], contacts: { count: 0 }, zoomRecordings: null,
    permissions: { calendars: "notAsked", contacts: "notAsked", mail: "notAsked" },
  });
});

test("mac app: Mail's state is said exactly: closed, refused, not set up, no answer, or found", { skip }, () => {
  assert.equal(swift("mailstate", "0", "-", "notAsked"), "closed", "Mail not running and the button not pressed");
  assert.equal(swift("mailstate", "1", "-", "denied"), "denied", "Automation refused (asked, or refused before)");
  assert.equal(swift("mailstate", "0", "-", "denied"), "denied");
  assert.equal(swift("mailstate", "1", "", "granted"), "empty", "Mail answered with no account: not set up on this Mac");
  assert.equal(swift("mailstate", "1", "-", "granted"), "failed", "Mail did not answer");
  assert.equal(swift("mailstate", "1", "G\ta@b.co,\timap\n", "granted"), "found");
});

test("mac app: the other places a Mac keeps the person's addresses: Thunderbird, iCloud, eM Client (addresses only, never a password)", { skip }, () => {
  const prefs = [
    'user_pref("mail.identity.id1.fullName", "Ana");',
    'user_pref("mail.identity.id1.useremail", "Ana@Fastmail.example");',
    'user_pref("mail.identity.id2.useremail", "ana@corp.example");',
    'user_pref("mail.server.server1.userName", "notanaddress@x.example");',
    'user_pref("mail.identity.id3.useremail", "not an address");',
  ].join("\n");
  assert.deepEqual(swift("tbprefs", prefs), ["ana@fastmail.example", "ana@corp.example"]);
  assert.deepEqual(swift("mobileme", join(repo, "test/fixtures/mac-core/MobileMeAccounts.plist")), [
    { address: "ana.test@icloud.com", name: "Ana Test", mail: true },
    { address: "ana.test@gmail.example", name: "Ana Test", mail: false },
    { address: "work.id@me.com", name: "Ana Work", mail: false },
  ]);
  assert.deepEqual(swift("mobileme", join(repo, "package.json")), [], "not a plist: nothing");
  // eM Client's account file, made here (its layout is not documented): an address column is read, a password column never is.
  const db = join(work, "accounts.dat");
  const s = new DatabaseSync(db);
  s.exec(`CREATE TABLE Accounts (id INTEGER, displayName TEXT, emailAddress TEXT, loginUser TEXT, password TEXT, oauthToken TEXT);
    INSERT INTO Accounts VALUES (1, 'Work', 'Ana@Corp.example', 'ana@corp.example', 'secret@pass.example', 'tok@en.example');
    INSERT INTO Accounts VALUES (2, 'Home', 'ana@outlook.example', 'ana', 'p', NULL);
    CREATE TABLE Other (address BLOB, note TEXT); INSERT INTO Other VALUES (X'61406222', 'x@y.example');`);
  s.close();
  const found = swift("emclient", db) as string[];
  assert.deepEqual(found, ["ana@corp.example", "ana@outlook.example"]);
  assert.ok(!found.some((a) => a.includes("pass") || a.includes("tok")), "never a password or token column");
  assert.deepEqual(swift("emclient", join(work, "missing.dat")), []);

  // The whole look: Mail closed, Outlook running, eM Client, Thunderbird, iCloud and the Me card, merged with every app each was found in.
  const r = swift("discover", "mail", "0", JSON.stringify({
    installed: ["com.microsoft.Outlook"], outlookRunning: true, outlookOutput: "Work\tana@corp.example\tews\nHome\tana@outlook.example\timap\n",
    emClientFiles: [db], thunderbird: [prefs], mobileMe: join(repo, "test/fixtures/mac-core/MobileMeAccounts.plist"),
    contacts: "granted", meCard: ["ANA.TEST@icloud.com", "ana@home.example"],
  })) as { result: Record<string, any>; calls: string[] };
  assert.deepEqual(r.calls, ["ask:outlook", "read:me"], "Mail closed: not asked; Outlook running: asked");
  assert.equal(r.result.mailState, "closed");
  const by = Object.fromEntries((r.result.mailAccounts as { address: string; apps: string[]; provider: string; kind: string; icloudMail?: boolean }[])
    .map((a) => [a.address, a]));
  assert.deepEqual(by["ana@corp.example"]!.apps, ["outlook", "emclient", "thunderbird"]);
  assert.equal(by["ana@corp.example"]!.kind, "exchange");
  assert.deepEqual(by["ana@outlook.example"]!.apps, ["outlook", "emclient"]);
  assert.deepEqual(by["ana.test@icloud.com"]!.apps, ["icloud", "contacts"]);
  assert.equal(by["ana.test@icloud.com"]!.icloudMail, true);
  assert.equal(by["ana.test@icloud.com"]!.provider, "icloud");
  assert.deepEqual(by["ana@home.example"]!.apps, ["contacts"]);
  // Contacts not allowed: the Me card is not read.
  const closed = swift("discover", "mail", "0", JSON.stringify({ contacts: "denied", meCard: ["x@y.example"] })) as { calls: string[] };
  assert.deepEqual(closed.calls, []);
});

test("mac app: Connect Claude explains failures in plain words, and only Anthropic's signed claude gets the sign-in", { skip }, () => {
  for (const [tail, kind] of [["Invalid code. Please make sure the full code was copied.", "invalidCode"], ["10 min", "timeout"],
    ["installer output\n(15 min)", "timeout"], ["https://claude.ai/install.sh: The Internet connection appears to be offline.", "network"],
    ["curl: (6) Could not resolve host: downloads.claude.ai", "network"], ["Claude Code at /x/claude is older than 2.1.268: update it (claude update), then try again.", "oldVersion"],
    ["claude not found after installing", "notFound"], ["notAnthropic", "notAnthropic"], ["exit 3", "other"],
    // No DNS, a server that refuses, a Wi-Fi login page in place of the installer: each is the network, with its plain way out.
    ["https://claude.ai/install.sh: A server with the specified hostname could not be found.", "network"],
    ["https://claude.ai/install.sh: Could not connect to the server.", "network"],
    ["https://claude.ai/install.sh: HTTP 200, not the installer", "network"], ["https://claude.ai/install.sh: ?, not the installer", "network"]] as const) {
    assert.equal(swift("failure", tail), kind, tail);
  }
  assert.equal(swift("macho", process.execPath), true);
  assert.equal(swift("macho", join(repo, "bin", "panel.cjs")), false);
  const core = readFileSync(join(repo, "desktop/mac/Core.swift"), "utf8");
  assert.match(core, /let anthropicTeamID = "Q6L2SF6YDW"/);
  // The real Claude Code on this Mac, when there is one, passes the very check the app runs; this Mac's node (not Anthropic's) does not.
  const real = join(process.env.HOME ?? "", ".local", "share", "claude", "versions");
  const versions = existsSync(real) ? sh("ls", [real]).out.split("\n").filter(Boolean) : [];
  const requirement = '=anchor apple generic and certificate leaf[subject.OU] = "Q6L2SF6YDW"';
  if (versions.length) assert.equal(sh("codesign", ["--verify", "--strict", "-R", requirement, join(real, versions.at(-1)!)]).code, 0);
  assert.notEqual(sh("codesign", ["--verify", "--strict", "-R", requirement, process.execPath]).code, 0);
});

test("mac app: every native text is English and in Texts, with no language choice left, and no window or menu shows a word that is not in Texts", () => {
  const texts = readFileSync(join(repo, "desktop/mac/Texts.swift"), "utf8");
  const words = [...texts.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
  assert.ok(words.length > 150, `${words.length} texts`);
  assert.deepEqual(words.filter((w) => /[áéíóúñ¿¡]/.test(w)), [], "no Spanish left");
  // No t(es, en) pair and no language: the app follows no language choice any more.
  assert.doesNotMatch(texts, /\bt\(\s*"|\blang\b/);
  const core = readFileSync(join(repo, "desktop/mac/Core.swift"), "utf8");
  assert.doesNotMatch(core, /enum Lang\b|func appLang\b/);
  assert.doesNotMatch(readFileSync(join(repo, "desktop/mac/Status.swift"), "utf8"), /Español/);
  for (const f of ["App.swift", "Connect.swift", "Status.swift", "Discovery.swift"]) {
    const src = readFileSync(join(repo, "desktop/mac", f), "utf8");
    const shown = [...src.matchAll(/(?:messageText|informativeText|title|stringValue|placeholderString)\s*[:=]\s*"([A-Za-z][^"]*)"/g)].map((m) => m[1])
      .filter((w) => w !== "Pako");
    assert.deepEqual(shown, [], `${f}: words shown that are not in Texts`);
  }
});

/** FNV-1a 64 of a text, as Core.swift stableHash: the name of the settings a run with its own PAKO_HOME keeps. */
function fnv(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(s, "utf8")) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
  return h.toString(16);
}

test("mac app: the released app keeps its Pako running: a busy port, a crash restarted, Quit stops it, a killed app takes it along, a stale lock", { skip }, async () => {
  assert.equal(packaged.code, 0, packaged.out);
  const bin = join(rel, "Contents", "MacOS", "Pako");
  const dir = mkdtempSync(join(tmpdir(), "pako-life-"));
  const home = join(dir, "home");
  mkdirSync(join(dir, "user"), { recursive: true });
  mkdirSync(home, { recursive: true });
  // The app's default port taken by someone else (on this Mac it may already be the person's own Pako: either way, taken).
  const squatter = netServer();
  await new Promise<void>((r) => squatter.once("error", () => r()).listen(8787, "127.0.0.1", () => r()));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const lock = () => {
    try {
      const [pid, port] = readFileSync(join(home, ".lock"), "utf8").split("\n").map(Number);
      return { pid: pid!, port: port! };
    } catch {
      return null;
    }
  };
  /** A Pako answering at the lock's port whose process is not `not`. */
  const running = async (not = 0, ms = 90_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const l = lock();
      if (l && l.pid !== not && l.port && alive(l.pid)) {
        const ok = await fetch(`http://127.0.0.1:${l.port}/health`).then((r) => r.ok, () => false);
        if (ok) return l;
      }
      await sleep(250);
    }
    throw new Error(`no Pako answered:\n${readFileSync(join(home, "logs", "app.log"), "utf8").slice(-2000)}`);
  };
  const gone = async (pid: number, ms: number) => {
    const until = Date.now() + ms;
    while (alive(pid) && Date.now() < until) await sleep(100);
    return !alive(pid);
  };
  const start = () => spawn(bin, [], {
    env: { PATH: "/usr/bin:/bin", HOME: join(dir, "user"), PAKO_HOME: home, PAKO_APP_SELFTEST: "headless" },
    stdio: "ignore",
  });
  const appLog = () => {
    try {
      return readFileSync(join(home, "logs", "app.log"), "utf8");
    } catch {
      return "";
    }
  };
  /** Until the app itself has taken its Pako as up (its line in app.log): /health can answer the test a moment before the app has looked. */
  const upForApp = async (pid: number) => {
    const until = Date.now() + 30_000;
    while (!appLog().includes(`Pako is up (process ${pid},`) && Date.now() < until) await sleep(100);
    assert.match(appLog(), new RegExp(`Pako is up \\(process ${pid}, port \\d+\\)`));
  };
  let app = start();
  try {
    const first = await running();
    assert.notEqual(first.port, 8787, "8787 was taken: another port was chosen");
    await upForApp(first.pid);
    // An older panel's language choice reaching the server while the app runs: accepted and ignored (Pako's texts are English only), and
    // the app keeps running through its next looks at Pako (every 5 s).
    const base = `http://127.0.0.1:${first.port}`;
    const token = (JSON.parse(readFileSync(join(home, "secrets.json"), "utf8")) as { bridgeToken: string }).bridgeToken;
    const linked = await fetch(`${base}/panel/api/link`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const { link } = (await linked.json()) as { link: string };
    const login = await fetch(link, { redirect: "manual" });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    for (const l of ["es", "en"]) {
      const set = await fetch(`${base}/panel/api/settings`, {
        method: "POST", headers: { cookie, "x-pako": "1", "content-type": "application/json" }, body: JSON.stringify({ lang: l }),
      });
      assert.equal(set.status, 200, `the panel took lang ${l}`);
      await sleep(11_000);
      assert.ok(alive(app.pid!), `the app is still running after the switch to ${l}:\n${appLog().slice(-1500)}`);
    }
    // A crash of the server it started: started again by itself, said in app.log.
    process.kill(first.pid, "SIGKILL");
    const second = await running(first.pid, 30_000);
    assert.equal(second.port, first.port, "the same port, kept");
    assert.match(readFileSync(join(home, "logs", "app.log"), "utf8"), /Pako stopped by itself \(signal 9, after \d+ s\)[\s\S]*starting it again in 1 s/);
    // Quit (SIGTERM, as at logout): the app ends within seconds and its Pako with it.
    app.kill("SIGTERM");
    assert.ok(await gone(app.pid!, 10_000), "the app quit");
    assert.ok(await gone(second.pid, 2000), "its Pako stopped with it");
    // Force Quit: the app is killed, its Pako notices and stops by itself (PAKO_APP_PID).
    app = start();
    const third = await running(second.pid);
    app.kill("SIGKILL");
    assert.ok(await gone(third.pid, 8000), "no Pako left behind by a killed app");
    // A lock left behind whose number is now another program's (a crash, then the number came round): taken over, no question asked.
    const other = spawn("sleep", ["60"]);
    try {
      const started = Math.floor(Date.now() / 1000) - 3600;
      writeFileSync(join(home, ".lock"), `${other.pid}\n${third.port}\n${Math.floor(uptime())}\n\n${started}\n`);
      app = start();
      const fourth = await running(other.pid!);
      assert.notEqual(fourth.pid, other.pid);
      app.kill("SIGTERM");
      assert.ok(await gone(app.pid!, 10_000));
      assert.ok(await gone(fourth.pid, 2000));
    } finally {
      other.kill();
    }
  } finally {
    app.kill("SIGKILL");
    squatter.close();
    // The settings this run kept apart from the person's own (Pako.swift: a run with its own PAKO_HOME).
    sh("defaults", ["delete", `io.github.anxovatomicaes.pako.home-${fnv(home)}`]);
  }
});

test("mac app: the app updates itself from a local feed: Update pressed, the dmg checked, swapped in, the new version restarted with its Pako", { skip }, async () => {
  assert.equal(built.code, 0, built.out);
  const dir = mkdtempSync(join(tmpdir(), "pako-update-e2e-"));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // Version B: the same build with the next version and build number, signed again (sign.sh), in its dmg (dmg.sh), described by feed.sh.
  const parts = version().split(".").map(Number);
  const next = `${parts[0]}.${parts[1]}.${parts[2]! + 1}`;
  const b = join(dir, "b", "Pako.app");
  assert.equal(sh("ditto", [app, b]).code, 0);
  for (const [k, v] of [["CFBundleShortVersionString", next], ["CFBundleVersion", String(Number(BUILD) + 1)]]) {
    assert.equal(sh("plutil", ["-replace", k!, "-string", v!, join(b, "Contents", "Info.plist")]).code, 0);
  }
  const step = (cmd: string, args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...env } });
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
  };
  step("sh", [join(repo, "desktop/mac/sign.sh"), b], { PAKO_SIGN_IDENTITY: "-" });
  step("sh", [join(repo, "desktop/mac/dmg.sh"), b, join(dir, "b")], { PAKO_SIGN_IDENTITY: "-" });
  step("sh", [join(repo, "desktop/mac/feed.sh"), join(dir, "b", `Pako-${next}.dmg`), join(dir, "b", "feed.json")]);
  const feed = JSON.parse(readFileSync(join(dir, "b", "feed.json"), "utf8")) as Record<string, unknown>;
  const dmg = readFileSync(join(dir, "b", `Pako-${next}.dmg`));
  const hits: string[] = [];
  let served = feed;
  const srv: Server = createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/feed.json") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(served));
    if (req.url === "/Pako.dmg") return void res.writeHead(200, { "content-type": "application/octet-stream" }).end(dmg);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  served = signFeed({ ...feed, url: `${base}/Pako.dmg` }, KEY.privateKey);
  const freePort = () => new Promise<number>((r) => {
    const s = netServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => r(p));
    });
  });
  const suites: string[] = [];
  /** Version A, installed in its own Applications folder, started headless with its own HOME, PAKO_HOME and port, told to press Update. */
  const startA = async (name: string) => {
    const apps = join(dir, name, "Applications");
    const a = join(apps, "Pako.app");
    assert.equal(sh("ditto", [app, a]).code, 0);
    const home = join(dir, name, "pako-home");
    mkdirSync(join(dir, name, "user"), { recursive: true });
    mkdirSync(home, { recursive: true });
    suites.push(`io.github.anxovatomicaes.pako.home-${fnv(home)}`);
    const child = spawn(join(a, "Contents", "MacOS", "Pako"), [], {
      env: {
        PATH: `${join(process.execPath, "..")}:/usr/bin:/bin`, HOME: join(dir, name, "user"), PAKO_HOME: home, PORT: String(await freePort()),
        PAKO_REPO: repo, PAKO_APP_SELFTEST: "update", PAKO_APP_UPDATE_FEED: `${base}/feed.json`,
      },
      stdio: "ignore",
    });
    const log = () => {
      try {
        return readFileSync(join(home, "logs", "app.log"), "utf8");
      } catch {
        return "";
      }
    };
    const until = async (re: RegExp, ms: number) => {
      const end = Date.now() + ms;
      while (!re.test(log()) && Date.now() < end) await sleep(250);
      assert.match(log(), re);
    };
    return { a, apps, home, user: join(dir, name, "user"), child, log, until };
  };
  const pidsOf = (path: string) => sh("pgrep", ["-f", path]).out.split("\n").filter(Boolean).map(Number);
  try {
    // ---- the update: installed, the old one in the Trash, the new version running with its own Pako ----
    const one = await startA("one");
    await one.until(/update: installed Pako .* \(SHA-256 and signature checked\); restarting/, 180_000);
    await one.until(new RegExp(`Pako\\.app updated: now ${next.replace(/\./g, "\\.")} \\(build ${Number(BUILD) + 1}\\)`), 60_000);
    assert.ok(await (async () => {
      const end = Date.now() + 15_000;
      while (alive(one.child.pid!) && Date.now() < end) await sleep(100);
      return !alive(one.child.pid!);
    })(), "the old version quit");
    assert.equal(plistOf(one.a, "CFBundleShortVersionString").out, next, "the new version is in the old one's place");
    assert.equal(plistOf(one.a, "CFBundleVersion").out, String(Number(BUILD) + 1));
    assert.equal(plistOf(join(one.user, ".Trash", `Pako ${version()}.app`), "CFBundleVersion").out, BUILD, "the old one is in (this HOME's) Trash");
    assert.deepEqual(readdirSync(one.apps), ["Pako.app"], "nothing else left beside it");
    // The new version runs from the same place, and its Pako comes up (the old one's stopped with it).
    const newPids = pidsOf(join(one.a, "Contents", "MacOS", "Pako"));
    assert.equal(newPids.length, 1, "the new version is running");
    const up = async () => {
      const end = Date.now() + 90_000;
      while (Date.now() < end) {
        const m = /Pako is up \(process (\d+), port (\d+)\)/.exec(one.log().split("Pako.app updated: now")[1] ?? "");
        if (m) return { pid: Number(m[1]), port: Number(m[2]) };
        await sleep(250);
      }
      throw new Error(`the new version's Pako did not come up:\n${one.log().slice(-2500)}`);
    };
    const pako = await up();
    assert.ok((await fetch(`http://127.0.0.1:${pako.port}/health`)).ok, "the new version's Pako answers");
    assert.match(one.log(), /update: downloading Pako [\d.]+ \(build \d+\)[\s\S]*update: checking the download[\s\S]*update: installing[\s\S]*update: installed/);
    assert.deepEqual(hits.filter((h) => h === "/Pako.dmg").length, 1, "downloaded once");
    // The new version found nothing newer, and does not install again.
    await sleep(3000);
    assert.doesNotMatch(one.log().split("Pako.app updated: now")[1]!, /update: downloading/);
    process.kill(newPids[0]!, "SIGTERM");
    const end = Date.now() + 15_000;
    while ((alive(newPids[0]!) || alive(pako.pid)) && Date.now() < end) await sleep(100);
    assert.ok(!alive(newPids[0]!) && !alive(pako.pid), "the new version quit with its Pako");

    // ---- a download that does not match the feed: refused, and the version in use keeps running, untouched ----
    served = signFeed({ ...served, sha256: "0".repeat(64) }, KEY.privateKey);
    const two = await startA("two");
    await two.until(/update failed: checksum \(this version keeps running\)/, 180_000);
    await sleep(1500);
    assert.ok(alive(two.child.pid!), "the app in use still runs");
    assert.equal(plistOf(two.a, "CFBundleShortVersionString").out, version());
    assert.deepEqual(readdirSync(two.apps), ["Pako.app"]);
    assert.ok(!existsSync(join(two.user, ".Trash")), "nothing went to the Trash");
    two.child.kill("SIGTERM");

    // ---- a feed not signed by the key this app carries (another key): not offered, nothing downloaded ----
    const downloads = hits.filter((h) => h === "/Pako.dmg").length;
    served = signFeed({ ...feed, url: `${base}/Pako.dmg` }, generateFeedKey().privateKey);
    const three = await startA("three");
    await three.until(/update: the feed offers Pako [\d.]+, but its signature does not verify against this app's release key: ignored/, 120_000);
    await sleep(1500);
    assert.equal(hits.filter((h) => h === "/Pako.dmg").length, downloads, "nothing downloaded");
    assert.doesNotMatch(three.log(), /update: downloading/);
    assert.equal(plistOf(three.a, "CFBundleShortVersionString").out, version());
    three.child.kill("SIGTERM");
  } finally {
    srv.close();
    for (const p of pidsOf(dir)) {
      try {
        process.kill(p, "SIGKILL");
      } catch {
        // gone already
      }
    }
    for (const s of suites) sh("defaults", ["delete", s]);
  }
});
