// What a stranger meets before Pako runs: the site's link preview, the Windows steps they are told to type, the install docs' facts, and the
// words macOS shows when Pako asks for the calendars. Text checks only: nothing is installed or fetched.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

/** A JPEG's width and height, from its first SOF marker; null when it is not one. */
function jpegSize(buf: Buffer): { w: number; h: number } | null {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

test("site: a shared link to pako-os.com shows a picture (og:image and a large Twitter/X card, absolute, a 1200x630 file the site serves)", () => {
  const html = read("site/index.html");
  const meta = (attr: string, name: string) => new RegExp(`<meta ${attr}="${name}" content="([^"]+)"`).exec(html)?.[1];
  const image = meta("property", "og:image");
  assert.ok(image, "no og:image: WhatsApp, iMessage, Slack, LinkedIn and X show the link with no picture");
  assert.match(image!, /^https:\/\/pako-os\.com\/[\w./-]+\.(jpg|png)$/, "crawlers need an absolute https address");
  const file = join(root, "site", new URL(image!).pathname);
  assert.ok(statSync(file).size < 1_000_000, "a share image under 1 MB");
  assert.deepEqual(jpegSize(readFileSync(file)), { w: 1200, h: 630 });
  assert.equal(meta("property", "og:url"), "https://pako-os.com/");
  assert.equal(meta("property", "og:type"), "website");
  assert.ok(meta("property", "og:image:alt"));
  assert.equal(meta("name", "twitter:card"), "summary_large_image");
});

// Windows's default execution policy (Restricted) refuses npm.ps1, which PowerShell picks for a bare `npm`: "npm.ps1 cannot be loaded
// because running scripts is disabled on this system". install.ps1 already runs npm.cmd for that reason; what it tells the person must too.
const bareNpm = /(^|[\s`'"(;])npm (run|start)\b/;

test("windows: no step a person types in PowerShell is a bare npm (refused by the default policy): npm.cmd, as install.ps1 runs it", () => {
  const doc = read("docs/install-windows.md").split("\n").filter((l) => bareNpm.test(l));
  assert.deepEqual(doc, [], "docs/install-windows.md");
  const ps1 = read("install.ps1").split("\n").filter((l) => /^\s*(Say|Write-Host)\b/.test(l) && bareNpm.test(l));
  assert.deepEqual(ps1, [], "install.ps1's messages");
  // The task's own messages (src/autostart-windows.ts), printed in the same PowerShell window by install.ps1 and npm run autostart.
  const ts = read("src/autostart-windows.ts").split("\n").filter((l) => /^\s+\w+: "/.test(l) && bareNpm.test(l));
  assert.deepEqual(ts, [], "src/autostart-windows.ts's messages");
});

test("install docs: no stale fact (the public repository and its Windows CI exist)", () => {
  for (const f of ["docs/install.md", "docs/install-windows.md"]) {
    const t = read(f).replace(/\s+/g, " ");
    assert.ok(!/not public yet/i.test(t), `${f}: "not public yet"`);
    assert.ok(!/not yet tried on a real Windows machine/i.test(t), `${f}: "not yet tried on a real Windows machine"`);
  }
});

test("mac app: macOS's calendar prompt says Pako may also change events (after a yes), not that it only reads them", () => {
  const plist = read("desktop/mac/Info.plist");
  const strings = read("desktop/mac/InfoPlist.en.strings");
  for (const key of ["NSCalendarsFullAccessUsageDescription", "NSCalendarsUsageDescription"]) {
    const inPlist = new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(plist)?.[1] ?? "";
    const inStrings = new RegExp(`"${key}" = "([^"]+)";`).exec(strings)?.[1] ?? "";
    for (const [where, s] of [["Info.plist", inPlist], ["InfoPlist.en.strings", inStrings]] as const) {
      assert.match(s, /\b(add|change|move)/i, `${where} ${key}: "${s}"`);
    }
    assert.equal(inPlist, inStrings, key);
  }
});

test("mac app: an update check that could not read the feed (no network yet at login) does not count as the day's check", () => {
  const swift = read("desktop/mac/App.swift");
  const check = swift.slice(swift.indexOf("private func checkForUpdate("), swift.indexOf("@objc private func checkUpdatesNow()"));
  assert.ok(check.length > 100, "checkForUpdate is there");
  // The stamp is taken before the request (two checks never overlap), and put back when nothing could be read: else a login item that
  // starts before the Wi-Fi is up fails, stamps the day, and the six-hourly timer is refused until the next day's start fails the same way.
  const failed = check.slice(check.indexOf("else {", check.indexOf("parseUpdateFeed(data")), check.indexOf("let newer ="));
  assert.match(failed, /defaults\.set\(previous, forKey: "updateCheckedAt"\)/, failed);
  assert.match(check, /let previous = runner\.defaults\.double\(forKey: "updateCheckedAt"\)/);
});

test("site: the Gentle mode section says how to turn it on and that it is not a medical device, with no health claim", () => {
  const html = read("site/index.html");
  const start = html.indexOf('<section class="gentle"');
  assert.ok(start > 0, "the Gentle mode section is there");
  const sec = html.slice(start, html.indexOf("</section>", start)).replace(/\s+/g, " ");
  assert.match(sec, /Built with ADHD brains/);
  assert.match(sec, /Settings → How Pako acts/);
  assert.match(sec, /not a medical device or a treatment/);
  for (const w of ["Done", "Snooze", "Park", "Keep all", "Undo all", "this usually takes you about 40 min"]) assert.ok(sec.includes(w), w);
  // Wellness and productivity words only: never a claim to treat, cure, diagnose or manage ADHD.
  const claims = sec.replace("not a medical device or a treatment", "");
  assert.doesNotMatch(claims, /\b(treats?|treatment|cures?|diagnos\w*|clinically|manages? your)\b/i);
});

test("mac app, not notarized yet: README, site and the Mac doc give the exact first-run steps, and the no-warning installer", () => {
  for (const f of ["README.md", "site/index.html", "docs/desktop-mac.md"]) {
    const t = read(f).replace(/\s+/g, " ").replace(/&amp;/g, "&");
    assert.match(t, /macOS 15 Sequoia and newer/, f);
    assert.match(t, /Privacy & Security/, f);
    assert.match(t, /Open Anyway[\s\S]*Open Anyway/, `${f}: Open Anyway is pressed twice on macOS 15`);
    assert.match(t, /not Move to Trash/, f);
    assert.match(t, /Control-click/, `${f}: macOS 13 and 14`);
  }
  // The one-line installer downloads with git (no quarantine mark): recommended first in the README's install.
  const readme = read("README.md");
  assert.ok(readme.indexOf("install.sh | sh") < readme.indexOf("**Mac app:**"), "the one-line installer comes first");
  assert.match(readme.replace(/\s+/g, " "), /no "could not verify" warning/);
});

test("docs/notarization.md: the owner's costs, Apple steps and where they plug into the release script", () => {
  const t = read("docs/notarization.md").replace(/\s+/g, " ");
  for (const s of ["99 USD a year", "Developer ID Application", "xcrun notarytool store-credentials", "stapler", "desktop/mac/release.sh",
    "PAKO_SIGN_IDENTITY", "PAKO_NOTARY_PROFILE", "npm run mac-release"]) assert.ok(t.includes(s), s);
  // What it names must exist: the release script calls notarize.sh only with the profile set.
  assert.match(read("desktop/mac/release.sh"), /PAKO_NOTARY_PROFILE[\s\S]*notarize\.sh/);
  assert.match(read("package.json"), /"mac-release":/);
});
