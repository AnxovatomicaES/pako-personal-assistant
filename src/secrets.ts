// Pako's secrets on this computer: the bridge token, the phone line's token, the key that signs the panel's session, the Telegram bot token,
// Meta's values for WhatsApp and the connections set in the panel. They used to sit in ~/.pako/secrets.json only (mode 600); where the
// system has a secret store (src/secret-store.ts: the macOS keychain, the Windows Credential Manager, libsecret), they now live there, and
// secrets.json keeps only a marker that says so:
//
//   {"_store": "keychain", "_service": "Pako", "_account": "<hash of the folder>", "_keys": ["bridgeToken", ...], "_rev": "<random>"}
//
// Each secret is one entry, its account "<_account>:<key>", so two Pako folders on one computer never meet. The marker carries the service
// and the account it was made with: a folder renamed or moved on the same computer still finds its secrets, and the Mac app and `npm run
// panel` read the bridge token from the marker's own names, with no hash of their own to agree on.
//
// The switch is PAKO_SECRET_STORE: "auto" (the default) uses the store when there is one that works, "keychain" asks for it (and says so
// when it cannot), "file" keeps the file, and moves secrets that are in the store back into it. Under node's test runner, or with a HOME
// that is not this account's own (a test, a release check), "auto" means the file: the keychain belongs to the person's real home.
//
// Moving into the store never loses a secret: every value is written, then read back and compared, and only then is the file replaced by
// the marker, in one rename. A failure anywhere before that rename leaves the file as it was (what was already written to the store is
// removed again, best effort, and would be written over next time anyway). A store that cannot be read later (a keychain still locked, a
// folder copied from another computer) is never papered over: readSecrets says it cannot read, and nothing is written over it.
//
// Every value is kept as JSON with anything outside printable ASCII escaped, so every store and every reader hands it back as it was.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { texts, type Lang } from "./i18n.ts";
import { StoreError, storeOfKind, systemStore, type SecretStore, type StoreKind } from "./secret-store.ts";

type Env = Record<string, string | undefined>;

export const SECRETS_FILE = "secrets.json";
/** The service every entry is kept under. Tests use one of their own. */
export const SERVICE = "Pako";

export type SecretMode = "file" | "keychain" | "auto";

const KINDS: readonly StoreKind[] = ["keychain", "wincred", "libsecret"];

/** PAKO_SECRET_STORE: file, keychain or auto (the default, also for anything else). */
export function secretMode(env: Env): SecretMode {
  const v = (env.PAKO_SECRET_STORE ?? "").trim().toLowerCase();
  return v === "file" || v === "keychain" ? v : "auto";
}

/** The marker's account: a hash of the folder's full path, short, so the entries stay readable in Keychain Access. */
export const folderAccount = (dir: string): string => createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 16);

/** A key that can be an account name as it is. Anything else (none today) stays in the file beside the marker. */
const STORABLE = /^[A-Za-z0-9_]{1,64}$/;

interface Marker {
  _store: StoreKind;
  _service: string;
  _account: string;
  _keys: string[];
  _rev?: string;
}

function asMarker(v: Record<string, unknown>): Marker | null {
  const m = v as Partial<Marker>;
  if (!KINDS.includes(m._store as StoreKind)) return null;
  if (typeof m._service !== "string" || typeof m._account !== "string" || !Array.isArray(m._keys)) return null;
  if (!m._keys.every((k) => typeof k === "string" && STORABLE.test(k))) return null;
  return m as Marker;
}

/** JSON with every character outside printable ASCII escaped (é): one line of plain characters, the same JSON once parsed. */
export function encodeValue(v: unknown): string {
  return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// ---------- which store, for tests ----------

type Opener = (kind: StoreKind, service: string) => SecretStore | null;
type Chooser = (service: string) => SecretStore | null;
let openKind: Opener = (kind, service) => storeOfKind(kind, service);
let chooseStore: Chooser = (service) => systemStore(service);

/** Tests put a stub store in place of the system's (and null puts the system's back). Never used by Pako itself. */
export function useStoreForTests(store: SecretStore | ((service: string) => SecretStore | null) | null): void {
  if (store === null) {
    openKind = (kind, service) => storeOfKind(kind, service);
    chooseStore = (service) => systemStore(service);
    return;
  }
  const pick = typeof store === "function" ? store : () => store;
  openKind = (kind, service) => {
    const s = pick(service);
    return s && s.kind === kind ? s : null;
  };
  chooseStore = pick;
  cache.clear();
}

// ---------- values split across entries (the Credential Manager's size) ----------

const PARTS = /^#parts:(\d{1,4})$/;

/** The entries one value takes: itself, or a "#parts:n" head and n pieces at "<account>#1" and on. */
function entriesFor(store: SecretStore, account: string, enc: string): [string, string][] {
  if (enc.length <= store.maxValue) return [[account, enc]];
  const size = Math.max(1, store.maxValue);
  const n = Math.ceil(enc.length / size);
  const out: [string, string][] = [[account, `#parts:${n}`]];
  for (let i = 0; i < n; i++) out.push([`${account}#${i + 1}`, enc.slice(i * size, (i + 1) * size)]);
  return out;
}

/** Reads values by account, joining split ones. A missing entry (or piece) is null. Throws a StoreError. */
function getValues(store: SecretStore, accounts: string[]): { values: Map<string, string | null>; parts: Map<string, number> } {
  const heads = store.get(accounts);
  const values = new Map<string, string | null>();
  const parts = new Map<string, number>();
  const pieces: string[] = [];
  for (const a of accounts) {
    const h = heads.get(a) ?? null;
    const m = h === null ? null : PARTS.exec(h);
    if (m) {
      parts.set(a, Number(m[1]));
      for (let i = 1; i <= Number(m[1]); i++) pieces.push(`${a}#${i}`);
    } else values.set(a, h);
  }
  if (pieces.length) {
    const got = store.get(pieces);
    for (const [a, n] of parts) {
      let whole: string | null = "";
      for (let i = 1; i <= n && whole !== null; i++) {
        const p = got.get(`${a}#${i}`) ?? null;
        whole = p === null ? null : whole + p;
      }
      values.set(a, whole);
    }
  }
  return { values, parts };
}

/** Writes values (key -> encoded) under `base`, then reads them back: a StoreError unless every one is there as written. */
function putValues(store: SecretStore, base: string, values: Map<string, string>): Map<string, number> {
  const entries: [string, string][] = [];
  for (const [k, enc] of values) entries.push(...entriesFor(store, `${base}:${k}`, enc));
  store.set(entries);
  const back = getValues(store, [...values.keys()].map((k) => `${base}:${k}`));
  for (const [k, enc] of values) {
    if (back.values.get(`${base}:${k}`) !== enc) throw new StoreError("a value read back from the store is not the one written");
  }
  const parts = new Map<string, number>();
  for (const [k, enc] of values) {
    const e = entriesFor(store, "x", enc);
    if (e.length > 1) parts.set(k, e.length - 1);
  }
  return parts;
}

/** Removes keys' entries (and their pieces, `parts` of them), best effort: what stays is unreachable, and written over next time. */
function dropValues(store: SecretStore, base: string, keys: string[], parts: Map<string, number> = new Map()): boolean {
  const accounts: string[] = [];
  for (const k of keys) {
    accounts.push(`${base}:${k}`);
    for (let i = 1; i <= (parts.get(k) ?? 0); i++) accounts.push(`${base}:${k}#${i}`);
  }
  if (!accounts.length) return true;
  try {
    store.remove(accounts);
    return true;
  } catch {
    return false;
  }
}

// ---------- the file ----------

/**
 * renameSync, tried again for a moment on Windows: there an antivirus or the search indexer that has just opened the file makes the rename fail
 * with EPERM, EACCES or EBUSY for a few milliseconds. Elsewhere a failure is real and is thrown at once.
 */
export function renameRetry(from: string, to: string, platform: NodeJS.Platform = process.platform, rename: typeof renameSync = renameSync): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (platform !== "win32" || attempt >= 9 || !["EPERM", "EACCES", "EBUSY"].includes(code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1)); // a short pause, keeping the write synchronous
    }
  }
}

/** Written whole to a new file and renamed over the old one, mode 600: a crash halfway leaves the old file. */
function writeFile(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameRetry(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* a file system without modes: nothing to do */
  }
}

type Raw = { ok: true; text: string | null; value: Record<string, unknown> } | { ok: false };

/** The file as it is: text null when there is none; not ok when it is there but cannot be read or is not a JSON object. */
function readRaw(path: string): Raw {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { ok: true, text: null, value: {} } : { ok: false };
  }
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? { ok: true, text, value: v as Record<string, unknown> } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** What the store held at a given marker (by its text): read once, then from memory until the marker changes. */
interface Cached {
  text: string;
  values: Map<string, string>;
  parts: Map<string, number>;
}
const cache = new Map<string, Cached>();

/** Why the last read of a folder's secrets failed, for the owner (loadHome tells them); null when it did not. */
const problems = new Map<string, string>();
export const secretsProblem = (dir: string): string | null => problems.get(resolve(dir)) ?? null;

const plainPart = (v: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith("_")));

/** The marker's values, from memory or from the store. Null (and the reason kept) when the store cannot give every one of them. */
function storedValues(dir: string, text: string, m: Marker): Cached | null {
  const key = resolve(dir);
  const hit = cache.get(key);
  if (hit && hit.text === text) return hit;
  const store = openKind(m._store, m._service);
  if (!store) {
    problems.set(key, `this computer has no ${m._store} store to read them from`);
    return null;
  }
  try {
    const got = getValues(store, m._keys.map((k) => `${m._account}:${k}`));
    const values = new Map<string, string>();
    const parts = new Map<string, number>();
    for (const k of m._keys) {
      const v = got.values.get(`${m._account}:${k}`);
      if (v === null || v === undefined) {
        problems.set(key, `${k} is missing from the ${m._store} store`);
        return null;
      }
      values.set(k, v);
      const n = got.parts.get(`${m._account}:${k}`);
      if (n) parts.set(k, n);
    }
    const c = { text, values, parts };
    cache.set(key, c);
    problems.delete(key);
    return c;
  } catch (err) {
    problems.set(key, (err as Error).message);
    return null;
  }
}

/**
 * Every secret of this folder, wherever it is kept: {} when there is no file yet; null when they cannot be read (a damaged file, a store
 * that does not answer). Null means "do not write": writing then would lose the others.
 */
export function readSecrets(dir: string): Record<string, unknown> | null {
  const raw = readRaw(join(dir, SECRETS_FILE));
  if (!raw.ok) {
    problems.set(resolve(dir), `${SECRETS_FILE} cannot be read`);
    return null;
  }
  if (raw.text === null || !("_store" in raw.value)) return raw.value;
  const m = asMarker(raw.value);
  if (!m) {
    problems.set(resolve(dir), `${SECRETS_FILE} has a marker that makes no sense`);
    return null;
  }
  const c = storedValues(dir, raw.text, m);
  if (!c) return null;
  const out: Record<string, unknown> = plainPart(raw.value);
  for (const [k, enc] of c.values) {
    try {
      out[k] = JSON.parse(enc) as unknown;
    } catch {
      problems.set(resolve(dir), `${k} in the store is not what Pako wrote`);
      return null;
    }
  }
  return out;
}

/** Where this folder's secrets are now: "file", or the kind of store the marker names. */
export function secretsWhere(dir: string): "file" | StoreKind {
  const raw = readRaw(join(dir, SECRETS_FILE));
  const m = raw.ok && raw.text !== null ? asMarker(raw.value) : null;
  return m ? m._store : "file";
}

/**
 * Replaces this folder's secrets with `next`, where they are kept now: the file, or the store the marker names (then the marker is written
 * again, with the new keys). Throws (an Error with a code, ESTORE for the store) when it cannot; nothing is lost then: the store's new values
 * are written before the marker names them, and the old ones are removed only after.
 */
export function writeSecrets(dir: string, next: Record<string, unknown>): void {
  const path = join(dir, SECRETS_FILE);
  const raw = readRaw(path);
  const m = raw.ok && raw.text !== null ? asMarker(raw.value) : null;
  if (!m) {
    writeFile(path, next);
    return;
  }
  const now = storedValues(dir, raw.ok ? raw.text! : "", m);
  if (!now) throw new StoreError(`the secrets in the ${m._store} store cannot be read, so none are written`);
  const store = openKind(m._store, m._service)!;
  const keys = Object.keys(next).filter((k) => STORABLE.test(k));
  const plain = Object.fromEntries(Object.entries(next).filter(([k]) => !STORABLE.test(k) && !k.startsWith("_")));
  const changed = new Map<string, string>();
  for (const k of keys) {
    const enc = encodeValue(next[k]);
    if (now.values.get(k) !== enc) changed.set(k, enc);
  }
  const parts = new Map([...now.parts].filter(([k]) => keys.includes(k) && !changed.has(k)));
  for (const [k, n] of putValues(store, m._account, changed)) parts.set(k, n);
  const marker: Marker = { _store: m._store, _service: m._service, _account: m._account, _keys: keys, _rev: randomBytes(6).toString("hex") };
  writeFile(path, { ...plain, ...marker });
  // Gone keys, and the pieces a value no longer needs (it was split, it is shorter now), only once the new marker no longer names them.
  const gone = m._keys.filter((k) => !keys.includes(k));
  dropValues(store, m._account, gone, now.parts);
  for (const [k, n] of now.parts) {
    if (!changed.has(k)) continue;
    const kept = parts.get(k) ?? 0;
    const extra: string[] = [];
    for (let i = kept + 1; i <= n; i++) extra.push(`${m._account}:${k}#${i}`);
    try {
      if (extra.length) store.remove(extra);
    } catch {
      /* unreachable once the head says fewer pieces; written over next time */
    }
  }
  const values = new Map(now.values);
  for (const k of gone) values.delete(k);
  for (const [k, enc] of changed) values.set(k, enc);
  cache.set(resolve(dir), { text: readFileSync(path, "utf8"), values, parts });
}

// ---------- telling the owner ----------

const NOTICE = texts(
  {
    unreadable: "⚠️ I can't read my secrets from {where} ({why}). I've started with temporary ones, so Telegram, WhatsApp and the panel's "
      + "connections are off, and nothing new is saved to them. If the keychain is locked, unlock it (or sign in to your session) and "
      + "restart Pako. If you copied Pako's folder from another computer, its secrets stayed there: connect everything again, or start it "
      + "there with PAKO_SECRET_STORE=file before copying.",
    keychain: "the macOS keychain",
    wincred: "the Windows Credential Manager",
    libsecret: "your desktop's secret store",
  },
);

/** What the chat says when a start could not read the secrets from the store (src/server.ts). */
export function unreadableNotice(lang: Lang, where: StoreKind, why: string): string {
  const t = NOTICE(lang);
  return t("unreadable", { where: t(where), why });
}

// ---------- moving in and out of the store ----------

export interface MoveResult {
  /** Where the secrets are after this start's look. */
  where: "file" | StoreKind;
  /** The keys moved this time (into the store, or back to the file). */
  moved: string[];
  /** What went wrong, when something did (in English, for the log; never a value). The secrets are where `where` says either way. */
  problem?: string;
}

/** Whether "auto" may use the store in this process: not in a test, not with a HOME that is not this account's own. */
function autoAllowed(env: Env): boolean {
  if ((process.env.NODE_TEST_CONTEXT ?? "").trim() || (env.NODE_TEST_CONTEXT ?? "").trim()) return false;
  const home = (env.HOME ?? "").trim();
  if (!home || process.platform === "win32") return true;
  try {
    return resolve(home) === resolve(userInfo().homedir);
  } catch {
    return true;
  }
}

/**
 * At start: secrets in the file move into the store when PAKO_SECRET_STORE allows it and the store works; secrets in the store move back
 * to the file with PAKO_SECRET_STORE=file. `service` is for tests. Never throws: a move that fails leaves everything where it was.
 */
export function settleSecrets(dir: string, env: Env, o: { service?: string } = {}): MoveResult {
  const path = join(dir, SECRETS_FILE);
  const mode = secretMode(env);
  const raw = readRaw(path);
  if (!raw.ok) return { where: "file", moved: [], problem: `${SECRETS_FILE} cannot be read` };
  if (raw.text === null) return { where: "file", moved: [] };
  const m = asMarker(raw.value);
  if (m) {
    if (mode !== "file") return { where: m._store, moved: [] };
    return toFile(dir, path, raw.text, raw.value, m);
  }
  if (mode === "file" || (mode === "auto" && !autoAllowed(env))) return { where: "file", moved: [] };
  const store = chooseStore(o.service ?? SERVICE);
  if (!store) return { where: "file", moved: [], ...(mode === "keychain" ? { problem: "this computer has no secret store Pako can use" } : {}) };
  return toStore(dir, path, raw.value, store);
}

function toStore(dir: string, path: string, value: Record<string, unknown>, store: SecretStore): MoveResult {
  const keys = Object.keys(value).filter((k) => STORABLE.test(k));
  if (!keys.length) return { where: "file", moved: [] };
  const account = folderAccount(dir);
  const values = new Map(keys.map((k) => [k, encodeValue(value[k])]));
  let parts: Map<string, number>;
  try {
    parts = putValues(store, account, values);
  } catch (err) {
    dropValues(store, account, keys, new Map(keys.map((k) => [k, entriesFor(store, "x", values.get(k)!).length - 1])));
    return { where: "file", moved: [], problem: `could not move the secrets into the ${store.kind} store: ${(err as Error).message}` };
  }
  const marker: Marker = { _store: store.kind, _service: store.service, _account: account, _keys: keys, _rev: randomBytes(6).toString("hex") };
  const plain = Object.fromEntries(Object.entries(value).filter(([k]) => !STORABLE.test(k) && !k.startsWith("_")));
  try {
    writeFile(path, { ...plain, ...marker });
  } catch (err) {
    // The rename did not happen: the file still holds every secret. What went into the store is taken out again.
    dropValues(store, account, keys, parts);
    return { where: "file", moved: [], problem: `could not write ${SECRETS_FILE} (${(err as NodeJS.ErrnoException).code ?? "error"})` };
  }
  cache.set(resolve(dir), { text: readFileSync(path, "utf8"), values, parts });
  return { where: store.kind, moved: keys };
}

function toFile(dir: string, path: string, text: string, value: Record<string, unknown>, m: Marker): MoveResult {
  const now = storedValues(dir, text, m);
  if (!now) return { where: m._store, moved: [], problem: `PAKO_SECRET_STORE=file, but the secrets cannot be read from the ${m._store} store: ${secretsProblem(dir)}` };
  const out: Record<string, unknown> = plainPart(value);
  for (const [k, enc] of now.values) out[k] = JSON.parse(enc) as unknown;
  try {
    writeFile(path, out);
  } catch (err) {
    return { where: m._store, moved: [], problem: `could not write ${SECRETS_FILE} (${(err as NodeJS.ErrnoException).code ?? "error"})` };
  }
  cache.delete(resolve(dir));
  // Only now, with every value in the file, do the store's copies go.
  const store = openKind(m._store, m._service);
  const removed = store ? dropValues(store, m._account, m._keys, now.parts) : false;
  return { where: "file", moved: m._keys, ...(removed ? {} : { problem: `the copies in the ${m._store} store could not be removed` }) };
}
