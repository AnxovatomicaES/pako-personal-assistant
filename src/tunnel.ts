// A public https address for this computer, only when the person asks for it (src/whatsapp-computer.ts): Cloudflare's official quick tunnel.
//
// WhatsApp's Cloud API delivers the owner's messages to a webhook on the internet, which a computer at home does not have. With the person's
// yes in the panel, Pako downloads the official cloudflared release for this computer's system and processor from Cloudflare's own GitHub
// releases, checks its SHA-256 against the checksums Cloudflare publishes with that release (and against GitHub's own digest of the file when
// it gives one), keeps it in ~/.pako/bin and runs `cloudflared tunnel --url http://127.0.0.1:<port>` as a child of Pako: started again when it
// stops, stopped when Pako stops. The address it prints (https://<words>.trycloudflare.com) changes each time it starts: `onUrl` hears it.
//
// What the tunnel lets through is decided by Pako, not here: src/whatsapp-computer.ts answers 404 to anything that came through it except the
// webhook paths, and src/guard-http.ts refuses the tunnel's host name for everything else anyway.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLog } from "./log.ts";

const log = createLog("tunnel");

/** The address a quick tunnel prints, once it is ready. */
export const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

const RELEASES = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";
/** Only files from Cloudflare's own release pages are downloaded (GitHub sends the bytes from its storage after a redirect). */
const DOWNLOAD_FROM = "https://github.com/cloudflare/cloudflared/releases/download/";
const MAX_BYTES = 120 * 1024 * 1024;

/** The release file for a system and a processor, as Cloudflare names them; null where there is none. */
export function cloudflaredAsset(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === "darwin") return arch === "arm64" ? "cloudflared-darwin-arm64.tgz" : arch === "x64" ? "cloudflared-darwin-amd64.tgz" : null;
  if (platform === "linux") {
    const a = ({ x64: "amd64", arm64: "arm64", arm: "arm", ia32: "386" } as Record<string, string>)[arch];
    return a ? `cloudflared-linux-${a}` : null;
  }
  if (platform === "win32") return arch === "x64" ? "cloudflared-windows-amd64.exe" : arch === "ia32" ? "cloudflared-windows-386.exe" : null;
  return null;
}

/** The checksum Cloudflare published for a file in a release's notes ("cloudflared-darwin-arm64.tgz: <64 hex>"), or null. */
export function publishedSha256(notes: string, asset: string): string | null {
  const escaped = asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|[\\s\`*-])${escaped}\\s*:\\s*([0-9a-f]{64})\\b`, "im").exec(notes);
  return m ? m[1]!.toLowerCase() : null;
}

export type InstallResult = { ok: true; bin: string; version: string } | { ok: false; why: "platform" | "network" | "checksum" | "unpack" | "disk" };

/**
 * Downloads the latest official cloudflared for this computer into `dir` (~/.pako/bin), verified, and returns its path. A binary already
 * there is used as it is (it was verified when it was put there). Nothing is kept unless its checksum matched.
 */
export async function installCloudflared(o: {
  dir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetch?: typeof fetch;
  /** Unpacks a .tgz into a folder (default: the system's tar). */
  untar?: (file: string, into: string) => Promise<boolean>;
}): Promise<InstallResult> {
  const platform = o.platform ?? process.platform;
  const asset = cloudflaredAsset(platform, o.arch ?? process.arch);
  if (!asset) return { ok: false, why: "platform" };
  const bin = join(o.dir, platform === "win32" ? "cloudflared.exe" : "cloudflared");
  if (existsSync(bin)) return { ok: true, bin, version: "installed" };
  const f = o.fetch ?? fetch;
  let release: { tag_name?: string; body?: string; assets?: { name?: string; browser_download_url?: string; digest?: string }[] };
  try {
    const r = await f(RELEASES, { headers: { accept: "application/vnd.github+json", "user-agent": "pako-setup" }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return { ok: false, why: "network" };
    release = (await r.json()) as typeof release;
  } catch {
    /* offline: said as network */
    return { ok: false, why: "network" };
  }
  const file = (release.assets ?? []).find((a) => a.name === asset);
  const url = file?.browser_download_url ?? "";
  const expected = publishedSha256(release.body ?? "", asset);
  // No published checksum, or a file from anywhere but Cloudflare's own releases: nothing is downloaded.
  if (!file || !url.startsWith(DOWNLOAD_FROM) || !expected) return { ok: false, why: "checksum" };
  const githubDigest = /^sha256:([0-9a-f]{64})$/i.exec(file.digest ?? "")?.[1]?.toLowerCase();
  if (githubDigest && githubDigest !== expected) return { ok: false, why: "checksum" };
  let bytes: Buffer;
  try {
    const r = await f(url, { headers: { "user-agent": "pako-setup" }, signal: AbortSignal.timeout(180_000) });
    if (!r.ok) return { ok: false, why: "network" };
    const length = Number(r.headers.get("content-length") ?? 0);
    if (length > MAX_BYTES) return { ok: false, why: "network" };
    bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length > MAX_BYTES) return { ok: false, why: "network" };
  } catch {
    /* offline: said as network */
    return { ok: false, why: "network" };
  }
  if (createHash("sha256").update(bytes).digest("hex") !== expected) return { ok: false, why: "checksum" };
  let work = "";
  try {
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    work = mkdtempSync(join(o.dir, ".download-"));
    const downloaded = join(work, asset);
    writeFileSync(downloaded, bytes, { mode: 0o600 });
    let made = downloaded;
    if (asset.endsWith(".tgz")) {
      const untar = o.untar ?? systemUntar;
      if (!(await untar(downloaded, work)) || !existsSync(join(work, "cloudflared"))) return { ok: false, why: "unpack" };
      made = join(work, "cloudflared");
    }
    chmodSync(made, 0o755);
    renameSync(made, bin);
  } catch (err) {
    log.warn(`cloudflared could not be put in place: ${(err as Error).message}`);
    return { ok: false, why: "disk" };
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
  }
  return { ok: true, bin, version: String(release.tag_name ?? "") };
}

/** The system's tar (macOS and Windows 10+ have one, as does every Linux): only the one file the release holds is taken out. */
function systemUntar(file: string, into: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("tar", ["-xzf", file, "-C", into, "cloudflared"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

export type TunnelState = "off" | "downloading" | "starting" | "on" | "error";

export interface Tunnel {
  state: () => TunnelState;
  /** The public address while the tunnel is up, else null. */
  url: () => string | null;
  /** Why it is in "error": "platform", "network", "checksum", "unpack", "disk", "start" (the program would not run). */
  why: () => string | null;
  /** Turns it on (downloading cloudflared first if needed); it then stays on, started again whenever it stops, until `stop`. */
  start: () => void;
  stop: () => void;
}

/**
 * The tunnel as a supervised child. `install` gives the program's path (installCloudflared, or a stand-in in the tests); `onUrl` is called
 * each time a new address is printed (and with null when the tunnel goes down).
 */
export function createTunnel(o: {
  port: () => number;
  install: () => Promise<InstallResult>;
  onUrl: (url: string | null) => void;
  spawn?: (bin: string, args: string[]) => ChildProcess;
  /** The first wait before starting again after it stopped (default 2 s; doubled each time up to a minute, back to this after a minute up). */
  retryMs?: number;
}): Tunnel {
  const run = o.spawn ?? ((bin: string, args: string[]) => spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
  let state: TunnelState = "off";
  let url: string | null = null;
  let why: string | null = null;
  let wanted = false;
  let child: ChildProcess | null = null;
  let timer: NodeJS.Timeout | null = null;
  let wait = o.retryMs ?? 2000;
  let generation = 0;
  const setUrl = (u: string | null): void => {
    if (u === url) return;
    url = u;
    try {
      o.onUrl(u);
    } catch (err) {
      log.error(`${(err as Error).message}`);
    }
  };
  const launch = async (gen: number): Promise<void> => {
    if (!wanted || gen !== generation) return;
    if (state !== "on") state = "downloading";
    const got = await o.install();
    if (!wanted || gen !== generation) return;
    if (!got.ok) {
      state = "error";
      why = got.why;
      log.error(`cloudflared is not ready (${got.why})`);
      return;
    }
    state = "starting";
    why = null;
    const startedAt = Date.now();
    let c: ChildProcess;
    try {
      // No self-update: the program stays the one whose checksum was checked.
      c = run(got.bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${o.port()}`]);
    } catch (err) {
      log.warn(`cloudflared could not start: ${(err as Error).message}`);
      state = "error";
      why = "start";
      return;
    }
    child = c;
    let tail = "";
    const read = (chunk: Buffer): void => {
      tail = (tail + chunk.toString("utf8")).slice(-4000);
      const m = QUICK_URL.exec(tail);
      if (m && child === c) {
        state = "on";
        setUrl(m[0]);
      }
    };
    c.stdout?.on("data", read);
    c.stderr?.on("data", read);
    c.once("error", () => {
      if (child !== c) return;
      child = null;
      state = "error";
      why = "start";
      setUrl(null);
    });
    c.once("exit", () => {
      if (child !== c) return;
      child = null;
      setUrl(null);
      if (!wanted) return;
      // Up for a minute or more: a fresh failure, the short wait again; otherwise each failure waits twice as long, up to a minute.
      wait = Date.now() - startedAt > 60_000 ? (o.retryMs ?? 2000) : Math.min(wait * 2, 60_000);
      state = "starting";
      timer = setTimeout(() => void launch(gen), wait);
      timer.unref?.();
    });
  };
  const kill = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    const c = child;
    child = null;
    if (c && c.exitCode === null) c.kill("SIGTERM");
  };
  // Pako ending for any reason takes the tunnel with it: nothing public stays open with no Pako behind it. Listened to only while it is on.
  const onExit = (): void => kill();
  return {
    state: () => state,
    url: () => url,
    why: () => why,
    start: () => {
      if (wanted && state !== "error") return;
      wanted = true;
      generation++;
      kill();
      process.off("exit", onExit);
      process.on("exit", onExit);
      void launch(generation);
    },
    stop: () => {
      wanted = false;
      generation++;
      kill();
      process.off("exit", onExit);
      state = "off";
      why = null;
      setUrl(null);
    },
  };
}
