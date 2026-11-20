// The update feed's signature (docs/desktop-mac.md, "Make a release"). Pako.app checks the dmg it downloads against the SHA-256 in feed.json,
// but that hash comes from the same place as the dmg: whoever can change one can change both. So feed.json is signed with an Ed25519 key
// whose private half never leaves the owner's keychain (or the PAKO_FEED_SIGNING_KEY setting of a release machine), and the app carries
// the public half (desktop/mac/feed-key.pub, baked into Info.plist as PakoFeedPublicKey by build.sh): it installs nothing from a feed whose
// signature does not verify against it (Core.swift, feedSignatureValid). Node's own crypto signs; CryptoKit (Curve25519.Signing) verifies.
//
// What is signed is not the JSON text (its spacing and key order are plutil's) but the fields themselves, one per line, in a fixed order:
//
//   pako-feed-v1\nversion=<v>\nbuild=<n>\nurl=<u>\nsha256=<hex>\nminimumMacOS=<m>\nnotes=<one line>\npage=<p>\n
//
// A field that is absent is empty; one that is there but not a string (build: not a whole number), or holds a line break, cannot be signed
// and never verifies. The signature (64 bytes, base64) goes into the feed as "signature"; apps from before it ignore the new key.
//
//   node desktop/mac/feed-sign.ts keygen         a new key: the private half into the login keychain (pako-feed-signing), the public
//                                                half into desktop/mac/feed-key.pub (commit that one). Refuses when either exists.
//   node desktop/mac/feed-sign.ts check          the signing key is there and is the one the app will carry (release.sh, first thing)
//   node desktop/mac/feed-sign.ts sign <feed>    signs feed.json in place
//   node desktop/mac/feed-sign.ts verify <feed>  checks it against the public key, as the app will
//
// The signing key: PAKO_FEED_SIGNING_KEY (base64 of its PKCS#8 form, one line), else the login keychain's "pako-feed-signing" item
// (PAKO_FEED_KEYCHAIN=off: never the keychain, for a machine with none). The public key: PAKO_FEED_PUBLIC_KEY (base64 of its 32 bytes),
// else desktop/mac/feed-key.pub. Nothing here prints the private key.

import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FEED_FIELDS = ["version", "build", "url", "sha256", "minimumMacOS", "notes", "page"] as const;
export const KEYCHAIN_SERVICE = "pako-feed-signing";
export const PUBLIC_KEY_FILE = fileURLToPath(new URL("./feed-key.pub", import.meta.url));
/** DER prefix of an Ed25519 SubjectPublicKeyInfo: these 12 bytes, then the 32-byte key. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** The bytes the signature covers (see the header), or null for a feed that cannot be signed. */
export function feedMessage(feed: Record<string, unknown>): Buffer | null {
  let text = "pako-feed-v1\n";
  for (const k of FEED_FIELDS) {
    const v = feed[k];
    let s: string;
    if (v === undefined) s = "";
    else if (k === "build") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return null;
      s = String(v);
    } else {
      if (typeof v !== "string") return null;
      s = v;
    }
    if (/[\r\n]/.test(s)) return null;
    text += `${k}=${s}\n`;
  }
  return Buffer.from(text, "utf8");
}

const privateKeyOf = (b64: string): KeyObject => {
  const t = b64.trim();
  if (t.startsWith("-----BEGIN")) return createPrivateKey(t);
  return createPrivateKey({ key: Buffer.from(t, "base64"), format: "der", type: "pkcs8" });
};

/** The 32-byte raw public key, base64, as the app carries it. */
export function publicKeyOf(privateKey: string): string {
  const spki = createPublicKey(privateKeyOf(privateKey)).export({ format: "der", type: "spki" });
  return spki.subarray(spki.length - 32).toString("base64");
}

const publicKeyObject = (raw: string): KeyObject | null => {
  const b = Buffer.from(raw.trim(), "base64");
  if (b.length !== 32) return null;
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, b]), format: "der", type: "spki" });
};

/** A new key pair: the private half as base64 PKCS#8 (one line), the public half as base64 of its 32 bytes. */
export function generateFeedKey(): { privateKey: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pk = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  return { privateKey: pk, publicKey: publicKeyOf(pk) };
}

/** The feed with its "signature" (any old one replaced). Throws for a feed that cannot be signed or a key that is not Ed25519. */
export function signFeed(feed: Record<string, unknown>, privateKey: string): Record<string, unknown> {
  const { signature: _old, ...rest } = feed;
  const msg = feedMessage(rest);
  if (!msg) throw new Error("this feed cannot be signed: a field is not a string (build: not a whole number), or holds a line break");
  const key = privateKeyOf(privateKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("the signing key is not an Ed25519 key");
  return { ...rest, signature: sign(null, msg, key).toString("base64") };
}

/** As the app checks it: a 64-byte signature over feedMessage, by this public key. */
export function verifyFeed(feed: Record<string, unknown>, publicKey: string): boolean {
  const sig = typeof feed.signature === "string" ? Buffer.from(feed.signature, "base64") : null;
  const msg = feedMessage(feed);
  const key = publicKeyObject(publicKey);
  if (!sig || sig.length !== 64 || !msg || !key) return false;
  try {
    return verify(null, msg, key, sig);
  } catch {
    return false;
  }
}

type Env = Record<string, string | undefined>;

/** The private key from the setting, else the login keychain; "" when there is none. */
export function loadSigningKey(env: Env): string {
  const set = (env.PAKO_FEED_SIGNING_KEY ?? "").trim();
  if (set) return set;
  if ((env.PAKO_FEED_KEYCHAIN ?? "").trim().toLowerCase() === "off" || process.platform !== "darwin") return "";
  const r = spawnSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

/** The public key the app will carry: the setting, else desktop/mac/feed-key.pub; "" when there is none. */
export function loadPublicKey(env: Env, file = PUBLIC_KEY_FILE): string {
  const set = (env.PAKO_FEED_PUBLIC_KEY ?? "").trim();
  if (set) return set;
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
}

export const HOW_TO_MAKE_ONE = [
  "No feed signing key. A public release must sign its feed.json, or no Pako.app installs it. Once, on the Mac that makes releases:",
  "  node desktop/mac/feed-sign.ts keygen",
  "puts a new key in your login keychain (pako-feed-signing) and its public half in desktop/mac/feed-key.pub: commit that file, then run",
  "the release again. On another machine, PAKO_FEED_SIGNING_KEY holds the private key (security find-generic-password -s pako-feed-signing -w).",
  "A build only for this Mac, never published: PAKO_LOCAL_RELEASE=1 (its feed is left unsigned).",
].join("\n");

/** "" when the signing key is there and matches the public key the app carries; else what is wrong. */
export function checkKeys(env: Env, file = PUBLIC_KEY_FILE): string {
  const priv = loadSigningKey(env);
  if (!priv) return HOW_TO_MAKE_ONE;
  const pub = loadPublicKey(env, file);
  if (!pub) return "There is a signing key but no public key for the app: desktop/mac/feed-key.pub (or PAKO_FEED_PUBLIC_KEY) is missing.";
  let mine: string;
  try {
    mine = publicKeyOf(priv);
  } catch (e) {
    return `The feed signing key cannot be read: ${(e as Error).message}`;
  }
  if (mine !== pub) return "The feed signing key is not the one the app carries (desktop/mac/feed-key.pub): no app would install this release.";
  return "";
}

function main(argv: string[], env: Env): number {
  const [cmd, file] = argv;
  const say = (s: string) => console.log(s);
  const readFeed = (): Record<string, unknown> => JSON.parse(readFileSync(file!, "utf8")) as Record<string, unknown>;
  if (cmd === "keygen") {
    if (loadSigningKey({ ...env, PAKO_FEED_SIGNING_KEY: "" })) return say(`The keychain already holds ${KEYCHAIN_SERVICE}: not replaced.`), 1;
    if (existsSync(PUBLIC_KEY_FILE)) return say(`${PUBLIC_KEY_FILE} exists already: not replaced (remove it first to start over).`), 1;
    const k = generateFeedKey();
    // security -i reads its command from stdin: the private key never appears in a process list.
    const r = spawnSync("security", ["-i"], { input: `add-generic-password -s ${KEYCHAIN_SERVICE} -a pako -w ${k.privateKey}\n`, encoding: "utf8" });
    if (r.status !== 0 || loadSigningKey({ ...env, PAKO_FEED_SIGNING_KEY: "" }) !== k.privateKey) {
      return say(`Could not put the key in the login keychain: ${(r.stderr || r.stdout).trim()}`), 1;
    }
    writeFileSync(PUBLIC_KEY_FILE, `${k.publicKey}\n`);
    say(`Made a feed signing key. The private key is in your login keychain (${KEYCHAIN_SERVICE}); back it up somewhere safe.`);
    say(`The public key is in ${PUBLIC_KEY_FILE}: commit it. Every Pako.app built from then on carries it.`);
    return 0;
  }
  if (cmd === "check") {
    const why = checkKeys(env);
    if (why) return say(why), 1;
    say("feed signing key: ok (it matches desktop/mac/feed-key.pub)");
    return 0;
  }
  if (cmd === "sign" && file) {
    const why = checkKeys(env);
    if (why) return say(why), 1;
    const signed = signFeed(readFeed(), loadSigningKey(env));
    writeFileSync(`${file}.part`, `${JSON.stringify(signed, null, 2)}\n`);
    renameSync(`${file}.part`, file);
    if (!verifyFeed(signed, loadPublicKey(env))) return say("the signed feed does not verify: not used"), 1;
    say(`feed signed: ${file}`);
    return 0;
  }
  if (cmd === "verify" && file) {
    const pub = loadPublicKey(env);
    const ok = !!pub && verifyFeed(readFeed(), pub);
    say(ok ? `feed signature: ok (${file})` : `feed signature: does NOT verify (${file})`);
    return ok ? 0 : 1;
  }
  say("usage: node desktop/mac/feed-sign.ts keygen | check | sign <feed.json> | verify <feed.json>");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2), process.env);
