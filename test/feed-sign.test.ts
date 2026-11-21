// The update feed's signature (desktop/mac/feed-sign.ts): what is signed, that any change breaks it, the command release.sh runs, and
// release.sh itself refusing a public release with no signing key. That Pako.app (CryptoKit) verifies what this signs is in
// test/mac-app.test.ts and test/mac-update.test.ts, with the Swift compiled.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkKeys, feedMessage, generateFeedKey, HOW_TO_MAKE_ONE, publicKeyList, publicKeyOf, signFeed, verifyFeed } from "../desktop/mac/feed-sign.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const FEED = {
  version: "0.4.0", build: 600, url: "https://github.com/o/r/releases/download/v0.4.0/Pako-0.4.0.dmg", sha256: "a".repeat(64),
  minimumMacOS: "13.0", notes: "Signed feeds.", page: "https://github.com/o/r/releases/tag/v0.4.0",
};
/** No keychain and no key from the person running the tests: only what each case gives. */
const NOKEY = { PAKO_FEED_KEYCHAIN: "off", PAKO_FEED_SIGNING_KEY: "", PAKO_FEED_PUBLIC_KEY: "" };
const cli = (args: string[], env: Record<string, string>) =>
  spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(repo, "desktop/mac/feed-sign.ts"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...NOKEY, ...env },
  });

test("feed signature: the signed bytes are the fields one per line in a fixed order; a line break or a wrong type cannot be signed", () => {
  assert.equal(feedMessage(FEED)?.toString("utf8"), [
    "pako-feed-v1", "version=0.4.0", "build=600", `url=${FEED.url}`, `sha256=${"a".repeat(64)}`, "minimumMacOS=13.0", "notes=Signed feeds.",
    `page=${FEED.page}`, "",
  ].join("\n"));
  // Key order and spacing in the JSON do not matter; an absent field is empty; a signature already there is not part of it.
  assert.deepEqual(feedMessage(Object.fromEntries(Object.entries(FEED).reverse())), feedMessage(FEED));
  assert.match(feedMessage({ version: "1.0.0", url: "https://e.com/x.dmg" })!.toString(), /\nbuild=\nurl=https:\/\/e\.com\/x\.dmg\nsha256=\n/);
  for (const bad of [{ notes: "two\nlines" }, { url: "https://e.com/\r" }, { build: "600" }, { build: 1.5 }, { build: 0 }, { version: 4 }, { page: null }]) {
    assert.equal(feedMessage({ ...FEED, ...bad }), null, JSON.stringify(bad));
    assert.throws(() => signFeed({ ...FEED, ...bad }, generateFeedKey().privateKey), /cannot be signed/);
  }
});

test("feed signature: signed by the key verifies; any changed field, another key or a broken signature does not", () => {
  const key = generateFeedKey();
  assert.equal(publicKeyOf(key.privateKey), key.publicKey);
  assert.equal(Buffer.from(key.publicKey, "base64").length, 32);
  const signed = signFeed(FEED, key.privateKey);
  assert.equal(Buffer.from(signed.signature as string, "base64").length, 64);
  assert.equal(verifyFeed(signed, key.publicKey), true);
  assert.equal(verifyFeed(JSON.parse(JSON.stringify(signed)), key.publicKey), true, "through JSON and back");
  assert.equal(verifyFeed(signFeed(signed, key.privateKey), key.publicKey), true, "signed again: the old signature is replaced");
  for (const [k, v] of Object.entries({ version: "0.4.1", build: 601, url: "https://evil.example/Pako.dmg", sha256: "b".repeat(64), minimumMacOS: "12.0",
    notes: "x", page: "https://evil.example/" })) {
    assert.equal(verifyFeed({ ...signed, [k]: v }, key.publicKey), false, k);
  }
  const { page: _, ...noPage } = signed;
  assert.equal(verifyFeed(noPage, key.publicKey), false, "a field taken out");
  assert.equal(verifyFeed(signed, generateFeedKey().publicKey), false, "another key");
  assert.equal(verifyFeed(FEED, key.publicKey), false, "no signature");
  for (const sig of ["", "AAAA", "A".repeat(86) + "==", 42]) assert.equal(verifyFeed({ ...signed, signature: sig }, key.publicKey), false, String(sig));
  for (const pub of ["", "abc", "A".repeat(44)]) assert.equal(verifyFeed(signed, pub), false, pub);
});

test("feed signature: recovery keys: the app trusts every key in feed-key.pub, so a lost release key strands no one", () => {
  const release = generateFeedKey(), recovery = generateFeedKey(), stranger = generateFeedKey();
  const both = `${release.publicKey}\n${recovery.publicKey}\n`;
  assert.deepEqual(publicKeyList(both), [release.publicKey, recovery.publicKey]);
  assert.deepEqual(publicKeyList(`${release.publicKey},${recovery.publicKey}`), [release.publicKey, recovery.publicKey], "as build.sh gives it");
  for (const k of [release, recovery]) assert.equal(verifyFeed(signFeed(FEED, k.privateKey), both), true);
  assert.equal(verifyFeed(signFeed(FEED, stranger.privateKey), both), false, "a key not in the file");
  assert.equal(checkKeys({ ...NOKEY, PAKO_FEED_SIGNING_KEY: recovery.privateKey, PAKO_FEED_PUBLIC_KEY: both }), "", "signing with the recovery key");
  assert.match(checkKeys({ ...NOKEY, PAKO_FEED_SIGNING_KEY: stranger.privateKey, PAKO_FEED_PUBLIC_KEY: both }), /not the one the app carries/);
});

test("feed signature: the command checks the key against the app's public key, signs feed.json in place, and verifies it", () => {
  const dir = mkdtempSync(join(tmpdir(), "pako-feed-sign-"));
  const key = generateFeedKey();
  const feed = join(dir, "feed.json");
  writeFileSync(feed, JSON.stringify(FEED, null, 2));
  // No key at all: refused, saying how to make one.
  const none = cli(["check"], {});
  assert.equal(none.status, 1);
  assert.match(none.stdout, /node desktop\/mac\/feed-sign\.ts keygen/);
  assert.equal(checkKeys(NOKEY, join(dir, "no-such.pub")), HOW_TO_MAKE_ONE);
  assert.equal(cli(["sign", feed], {}).status, 1);
  assert.equal(JSON.parse(readFileSync(feed, "utf8")).signature, undefined, "nothing written");
  // A key that is not the one the app carries: refused (no app would install it).
  const wrong = cli(["sign", feed], { PAKO_FEED_SIGNING_KEY: key.privateKey, PAKO_FEED_PUBLIC_KEY: generateFeedKey().publicKey });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stdout, /not the one the app carries/);
  assert.match(checkKeys({ ...NOKEY, PAKO_FEED_SIGNING_KEY: key.privateKey }, join(dir, "no-such.pub")), /no public key/);
  assert.match(checkKeys({ ...NOKEY, PAKO_FEED_SIGNING_KEY: "junk", PAKO_FEED_PUBLIC_KEY: key.publicKey }), /cannot be read/);
  // The right one: signed in place, every field kept, and it verifies.
  const env = { PAKO_FEED_SIGNING_KEY: key.privateKey, PAKO_FEED_PUBLIC_KEY: key.publicKey };
  assert.equal(cli(["check"], env).status, 0);
  const signed = cli(["sign", feed], env);
  assert.equal(signed.status, 0, signed.stdout + signed.stderr);
  const out = JSON.parse(readFileSync(feed, "utf8")) as Record<string, unknown>;
  assert.deepEqual({ ...out, signature: undefined }, { ...FEED, signature: undefined });
  assert.equal(verifyFeed(out, key.publicKey), true);
  assert.equal(cli(["verify", feed], { PAKO_FEED_PUBLIC_KEY: key.publicKey }).status, 0);
  assert.equal(cli(["verify", feed], { PAKO_FEED_PUBLIC_KEY: generateFeedKey().publicKey }).status, 1);
  assert.doesNotMatch(signed.stdout + signed.stderr, new RegExp(key.privateKey.slice(0, 20).replace(/[+/]/g, ".")), "the private key is never printed");
  assert.equal(cli(["nonsense"], env).status, 2);
});

test("release.sh: a public release with no feed signing key stops before building anything, and says how to make one", { skip: process.platform !== "darwin" && "a Mac script" }, () => {
  const out = mkdtempSync(join(tmpdir(), "pako-release-"));
  const r = spawnSync("sh", [join(repo, "desktop/mac/release.sh"), out], { encoding: "utf8", env: { ...process.env, ...NOKEY } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /No feed signing key/);
  assert.match(r.stdout, /feed-sign\.ts keygen/);
  assert.match(r.stdout, /release: stopped/);
  assert.deepEqual(spawnSync("ls", ["-A", out], { encoding: "utf8" }).stdout, "", "nothing built");
  // And its order: the key is checked before build.sh, the feed signed after feed.sh.
  const script = readFileSync(join(repo, "desktop/mac/release.sh"), "utf8");
  assert.ok(script.indexOf("signer check") < script.indexOf('sh "$HERE/build.sh"'));
  assert.ok(script.indexOf('sh "$HERE/feed.sh"') < script.indexOf('signer sign "$OUT/feed.json"'));
});
