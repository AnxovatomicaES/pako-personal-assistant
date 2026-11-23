// A Chrome DevTools Protocol driver with no dependency: Maître drives the browser already installed on the owner's computer (Chrome, Edge,
// Brave or Chromium) instead of shipping one. One browser process, with Pako's own profile in <PAKO_HOME>/browser so that a sign-in to
// TheFork or OpenTable is done once and kept. Headless for Look and Book; a visible window only for a Handoff (a gate the owner clears).
//
// Every call has a timeout: a page that hangs must turn into a typed "timeout" for the planner, never into a booking left half-done.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { Socket } from "node:net";

// ---------- finding a browser ----------

/** Where the usual Chromium browsers live, per system, in the order they are preferred. */
export function browserCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "darwin") {
    const apps = ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium", "Google Chrome Canary"];
    const roots = ["/Applications", join(homedir(), "Applications")];
    return roots.flatMap((r) => apps.map((a) => join(r, `${a}.app`, "Contents", "MacOS", a)));
  }
  if (platform === "win32") {
    // Windows' own folders (system variables, not Pako settings).
    const roots = ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"].map((k) => env[k]).filter((x): x is string => !!x);
    const rel = [
      ["Google", "Chrome", "Application", "chrome.exe"],
      ["Microsoft", "Edge", "Application", "msedge.exe"],
      ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
      ["Chromium", "Application", "chrome.exe"],
    ];
    return rel.flatMap((r) => roots.map((root) => join(root, ...r)));
  }
  // Linux and the other Unixes: by name on the PATH.
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser"];
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  return names.flatMap((n) => dirs.map((d) => join(d, n)));
}

/**
 * The browser to drive: PAKO_CHROME when it names a file, else the first installed one. Null when there is none (a server, or CI): Maître is
 * then off and the booking keeps today's routes.
 */
export function findBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const own = (env.PAKO_CHROME ?? "").trim();
  if (own) return existsSync(own) ? own : null;
  return browserCandidates(platform, env).find((p) => existsSync(p)) ?? null;
}

// ---------- the socket ----------

/** The little a CDP connection needs from a WebSocket. */
interface Wire {
  send(text: string): void;
  close(): void;
  onMessage(fn: (text: string) => void): void;
  onClose(fn: () => void): void;
}

/** Node 22's own WebSocket (stable since 22.4; Pako needs 22.18). */
function globalWire(url: string, timeoutMs: number): Promise<Wire> {
  const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket!;
  return new Promise((resolve, reject) => {
    const ws = new WS(url);
    const timer = setTimeout(() => {
      reject(new Error("cdp: the browser's socket did not open in time"));
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    const closers: (() => void)[] = [];
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({
        send: (t) => ws.send(t),
        close: () => ws.close(),
        onMessage: (fn) => ws.addEventListener("message", (e) => fn(typeof e.data === "string" ? e.data : Buffer.from(e.data as ArrayBuffer).toString())),
        onClose: (fn) => closers.push(fn),
      });
    });
    ws.addEventListener("close", () => closers.forEach((f) => f()));
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("cdp: the browser's socket failed"));
    });
  });
}

/**
 * A minimal WebSocket client (RFC 6455: text frames, masking, ping and close) for a Node without the global one. Only ever talks to the
 * browser on 127.0.0.1, so no TLS and no extensions.
 */
export function miniWire(url: string, timeoutMs: number): Promise<Wire> {
  const u = new URL(url);
  const key = randomBytes(16).toString("base64");
  return new Promise((resolve, reject) => {
    const req = request({
      host: u.hostname, port: Number(u.port), path: u.pathname + u.search, timeout: timeoutMs,
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13" },
    });
    req.on("timeout", () => req.destroy(new Error("cdp: the browser's socket did not open in time")));
    req.on("error", reject);
    req.on("response", (res) => reject(new Error(`cdp: the browser refused the socket (${res.statusCode})`)));
    req.on("upgrade", (_res, socket: Socket, head: Buffer) => {
      socket.setTimeout(0);
      let buf = head;
      const messages: ((t: string) => void)[] = [];
      const closers: (() => void)[] = [];
      let parts: Buffer[] = [];
      const frame = (opcode: number, payload: Buffer): Buffer => {
        const mask = randomBytes(4);
        const len = payload.length;
        const header = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len]) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
        if (len >= 126 && len < 65536) {
          header[0] = 0x80 | opcode;
          header[1] = 0x80 | 126;
          header.writeUInt16BE(len, 2);
        } else if (len >= 65536) {
          header[0] = 0x80 | opcode;
          header[1] = 0x80 | 127;
          header.writeBigUInt64BE(BigInt(len), 2);
        }
        const body = Buffer.alloc(len);
        for (let i = 0; i < len; i++) body[i] = payload[i]! ^ mask[i % 4]!;
        return Buffer.concat([header, mask, body]);
      };
      socket.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) return;
          const fin = (buf[0]! & 0x80) !== 0;
          const opcode = buf[0]! & 0x0f;
          let len = buf[1]! & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            if (buf.length < 10) return;
            len = Number(buf.readBigUInt64BE(2));
            off = 10;
          }
          if (buf.length < off + len) return;
          const payload = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          if (opcode === 0x8) {
            socket.end();
            return;
          }
          if (opcode === 0x9) {
            socket.write(frame(0xa, payload));
            continue;
          }
          if (opcode === 0x1 || opcode === 0x0) {
            parts.push(Buffer.from(payload));
            if (fin) {
              const text = Buffer.concat(parts).toString();
              parts = [];
              messages.forEach((f) => f(text));
            }
          }
        }
      });
      socket.on("close", () => closers.forEach((f) => f()));
      resolve({
        send: (t) => void socket.write(frame(0x1, Buffer.from(t))),
        close: () => {
          try {
            socket.write(frame(0x8, Buffer.alloc(0)));
          } finally {
            socket.end();
          }
        },
        onMessage: (fn) => messages.push(fn),
        onClose: (fn) => closers.push(fn),
      });
    });
    req.end();
  });
}

const openWire = (url: string, timeoutMs: number): Promise<Wire> =>
  typeof (globalThis as { WebSocket?: unknown }).WebSocket === "function" ? globalWire(url, timeoutMs) : miniWire(url, timeoutMs);

// ---------- the connection ----------

type Handler = (params: Record<string, unknown>, sessionId?: string) => void;

export class CdpError extends Error {}

/** One socket to the browser; pages talk on it through their session id (flat mode). */
export class Connection {
  private next = 1;
  private waiting = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private handlers = new Map<string, Set<Handler>>();
  closed = false;
  private wire: Wire;
  private timeoutMs: number;

  constructor(wire: Wire, timeoutMs: number) {
    this.wire = wire;
    this.timeoutMs = timeoutMs;
    wire.onMessage((text) => this.onMessage(text));
    wire.onClose(() => {
      this.closed = true;
      for (const w of this.waiting.values()) {
        clearTimeout(w.timer);
        w.reject(new CdpError("cdp: the browser went away"));
      }
      this.waiting.clear();
    });
  }

  private onMessage(text: string): void {
    let msg: { id?: number; result?: Record<string, unknown>; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
    try {
      msg = JSON.parse(text);
    } catch {
      /* not JSON: not a message of the protocol */
      return;
    }
    if (typeof msg.id === "number") {
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.error) w.reject(new CdpError(`cdp: ${msg.error.message}`));
      else w.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) for (const h of this.handlers.get(msg.method) ?? []) h(msg.params ?? {}, msg.sessionId);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = this.timeoutMs): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new CdpError("cdp: the browser is closed"));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new CdpError(`cdp: ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      this.wire.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method: string, h: Handler): () => void {
    let set = this.handlers.get(method);
    if (!set) this.handlers.set(method, (set = new Set()));
    set.add(h);
    return () => set!.delete(h);
  }

  close(): void {
    this.wire.close();
  }
}

// ---------- a page ----------

export interface NetResponse {
  url: string;
  status: number;
  /** The body, read once the response finished loading; empty when the browser no longer has it. */
  body: () => Promise<string>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A JSON-safe string literal for an expression run in the page. */
const lit = (s: string): string => JSON.stringify(s);

/** One tab, with the primitives a cartridge uses. Selectors are CSS; text matches are on what a person sees. */
export class Page {
  private responses: { url: string; status: number; requestId: string; finished: boolean; type: string }[] = [];
  private off: (() => void)[] = [];
  /** The main document's last HTTP status: a 403 on the page itself is how most bot walls answer. */
  docStatus = 0;
  /** The dialogs the page opened, in order (their messages). */
  dialogs: string[] = [];
  /** Whether a dialog is answered "yes" (only a cancel's "are you sure?" needs it). */
  acceptDialogs = false;
  private conn: Connection;
  readonly targetId: string;
  readonly sessionId: string;
  readonly timeoutMs: number;

  constructor(conn: Connection, targetId: string, sessionId: string, timeoutMs: number) {
    this.conn = conn;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.timeoutMs = timeoutMs;
    this.off.push(
      conn.on("Network.responseReceived", (p, s) => {
        if (s !== sessionId) return;
        const r = p.response as { url: string; status: number };
        const type = String(p.type ?? "");
        if (type === "Document" && p.frameId === targetId) this.docStatus = r.status;
        this.responses.push({ url: r.url, status: r.status, requestId: String(p.requestId), finished: false, type });
        if (this.responses.length > 400) this.responses.splice(0, 100);
      }),
      conn.on("Network.loadingFinished", (p, s) => {
        if (s !== sessionId) return;
        const r = this.responses.find((x) => x.requestId === p.requestId);
        if (r) r.finished = true;
      }),
      // A dialog (alert, confirm) would freeze the page: it is answered at once, "no" unless the cartridge said otherwise for this step.
      conn.on("Page.javascriptDialogOpening", (p, s) => {
        if (s !== sessionId) return;
        this.dialogs.push(String(p.message ?? ""));
        void this.send("Page.handleJavaScriptDialog", { accept: this.acceptDialogs }).catch(() => undefined);
      }),
    );
  }

  private send(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.conn.send(method, params, this.sessionId, timeoutMs ?? this.timeoutMs);
  }

  /** Runs an expression in the page and returns its value (promises awaited). A page exception is an error here. */
  async evaluate<T = unknown>(expression: string, timeoutMs?: number): Promise<T> {
    const r = (await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true }, timeoutMs)) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (r.exceptionDetails) throw new CdpError(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "exception"}`);
    return r.result?.value as T;
  }

  /** Opens a URL and waits for the page to load (the load event, or the document at least, by the deadline). */
  async goto(url: string, timeoutMs = this.timeoutMs): Promise<{ status: number }> {
    this.docStatus = 0;
    const loaded = new Promise<void>((resolve) => {
      const off = this.conn.on("Page.loadEventFired", (_p, s) => {
        if (s === this.sessionId) {
          off();
          resolve();
        }
      });
      setTimeout(() => {
        off();
        resolve();
      }, timeoutMs).unref?.();
    });
    const r = (await this.send("Page.navigate", { url }, timeoutMs)) as { errorText?: string };
    if (r.errorText) throw new CdpError(`navigate: ${r.errorText}`);
    await loaded;
    await this.waitFor("document.readyState !== 'loading'", { timeoutMs: Math.max(1000, timeoutMs / 2) });
    return { status: this.docStatus };
  }

  /** Waits until a page expression is truthy; returns its value. */
  async waitFor<T = unknown>(expression: string, o: { timeoutMs?: number; everyMs?: number } = {}): Promise<T> {
    const deadline = Date.now() + (o.timeoutMs ?? this.timeoutMs);
    let last: unknown;
    for (;;) {
      try {
        last = await this.evaluate(expression, Math.max(500, deadline - Date.now()));
        if (last) return last as T;
      } catch (err) {
        // The page navigated under us (its context was destroyed): try again on the new one.
        if (!/context|destroyed|navigat|Cannot find/i.test((err as Error).message)) throw err;
      }
      if (Date.now() >= deadline) throw new CdpError(`wait: timed out for ${expression.slice(0, 80)}`);
      await sleep(o.everyMs ?? 100);
    }
  }

  /** Waits for an element matching the selector, visible on screen. */
  waitForSelector(selector: string, timeoutMs?: number): Promise<boolean> {
    return this.waitFor(`(() => { const e = document.querySelector(${lit(selector)}); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0;` +
      ` })()`, timeoutMs ? { timeoutMs } : {});
  }

  /** Waits until the page's visible text contains the words (a string, or a regular expression's source). */
  waitForText(text: string | RegExp, timeoutMs?: number): Promise<boolean> {
    const test = typeof text === "string" ? `t.includes(${lit(text)})` : `new RegExp(${lit(text.source)}, ${lit(text.flags)}).test(t)`;
    return this.waitFor(`(() => { const t = document.body ? document.body.innerText : ''; return ${test}; })()`, timeoutMs ? { timeoutMs } : {});
  }

  /** Whether an element is there and visible now. */
  visible(selector: string): Promise<boolean> {
    return this.evaluate<boolean>(`(() => { const e = document.querySelector(${lit(selector)}); if (!e) return false; const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; })()`);
  }

  /**
   * Clicks an element like a person: scrolled into view, its centre measured right before the click, then a real mouse press and release.
   * (The TheFork playbook: a click on guessed coordinates twice hit the wrong control.)
   */
  async click(selector: string, timeoutMs?: number): Promise<void> {
    await this.waitForSelector(selector, timeoutMs);
    const box = await this.evaluate<{ x: number; y: number } | null>(
      `(() => { const e = document.querySelector(${lit(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    if (!box) throw new CdpError(`click: no ${selector}`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1 });
    }
  }

  /** Clicks the first visible element of `selector` whose own text is exactly `text` (a calendar's day "20"). */
  async clickText(selector: string, text: string, timeoutMs?: number): Promise<void> {
    const mark = `maitre-${randomBytes(4).toString("hex")}`;
    await this.waitFor(
      `(() => { const e = [...document.querySelectorAll(${lit(selector)})].find((x) => x.textContent.trim() === ${lit(text)} && x.getBoundingClientRect().width > 0); if (!e) return false;
        e.setAttribute('data-maitre', ${lit(mark)}); return true; })()`,
      timeoutMs ? { timeoutMs } : {},
    );
    await this.click(`[data-maitre="${mark}"]`, timeoutMs);
  }

  /** Types into a field: emptied first, then the text inserted as a person's typing would, then the field is left (change fires). */
  async type(selector: string, text: string, timeoutMs?: number): Promise<void> {
    await this.click(selector, timeoutMs);
    await this.evaluate(`(() => { const e = document.querySelector(${lit(selector)}); e.focus(); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    if (text) await this.send("Input.insertText", { text });
    await this.evaluate(`(() => { const e = document.querySelector(${lit(selector)}); e.dispatchEvent(new Event('change', { bubbles: true })); e.blur(); })()`);
  }

  /** Picks an option of a <select> by its value; false when the select has no such option. */
  async select(selector: string, value: string, timeoutMs?: number): Promise<boolean> {
    await this.waitForSelector(selector, timeoutMs);
    return this.evaluate<boolean>(
      `(() => { const e = document.querySelector(${lit(selector)}); if (![...e.options].some((o) => o.value === ${lit(value)})) return false; e.value = ${lit(value)};
        e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
    );
  }

  /** Ticks or unticks a checkbox (by clicking it, as a person does, only when it is not already as wanted). */
  async check(selector: string, on = true, timeoutMs?: number): Promise<void> {
    await this.waitFor(`!!document.querySelector(${lit(selector)})`, timeoutMs ? { timeoutMs } : {});
    const now = await this.evaluate<boolean>(`document.querySelector(${lit(selector)}).checked`);
    if (now !== on) {
      const shown = await this.visible(selector);
      // Many forms hide the real box behind a styled label: click the label then.
      if (shown) await this.click(selector, timeoutMs);
      else await this.evaluate(`(() => { const e = document.querySelector(${lit(selector)}); e.click(); })()`);
    }
  }

  /** The page's visible text, cut to `max` characters. */
  text(max = 20_000): Promise<string> {
    return this.evaluate<string>(`(document.body ? document.body.innerText : '').slice(0, ${max})`);
  }

  html(max = 200_000): Promise<string> {
    return this.evaluate<string>(`document.documentElement.outerHTML.slice(0, ${max})`);
  }

  /** The address and the visible text read together, in one call: two calls could straddle a navigation and mix two pages. */
  snapshot(max = 4000): Promise<{ url: string; text: string }> {
    return this.evaluate<{ url: string; text: string }>(`({ url: location.href, text: (document.body ? document.body.innerText : '').slice(0, ${max}) })`);
  }

  url(): Promise<string> {
    return this.evaluate<string>("location.href");
  }

  /** Forgets the responses seen so far: the next waitForResponse sees only what comes after. */
  clearResponses(): void {
    this.responses = [];
  }

  /** Waits for a network response whose URL matches, then gives its body (for engines whose widget reads JSON, like CoverManager's). */
  async waitForResponse(match: RegExp, timeoutMs = this.timeoutMs): Promise<NetResponse> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = this.responses.find((x) => match.test(x.url) && x.finished);
      if (r) {
        this.responses.splice(this.responses.indexOf(r), 1);
        return {
          url: r.url,
          status: r.status,
          body: async () => {
            try {
              const b = (await this.send("Network.getResponseBody", { requestId: r.requestId })) as { body: string; base64Encoded: boolean };
              return b.base64Encoded ? Buffer.from(b.body, "base64").toString() : b.body;
            } catch {
              /* the body is gone (a redirect, or evicted): empty */
              return "";
            }
          },
        };
      }
      if (Date.now() >= deadline) throw new CdpError(`response: none for ${match.source} in ${timeoutMs} ms`);
      await sleep(80);
    }
  }

  /** A PNG of what is on screen, written to `path`. */
  async screenshot(path: string): Promise<string> {
    const r = (await this.send("Page.captureScreenshot", { format: "png" }, 20_000)) as { data: string };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(r.data, "base64"));
    return path;
  }

  async close(): Promise<void> {
    this.off.forEach((f) => f());
    await this.conn.send("Target.closeTarget", { targetId: this.targetId }).catch(() => undefined);
  }
}

// ---------- the browser ----------

export interface BrowserOptions {
  executable: string;
  /** The profile folder: <PAKO_HOME>/browser for the owner; a temporary one in the tests. */
  profileDir: string;
  headless: boolean;
  /** The default for every call (ms). */
  timeoutMs?: number;
  /** How long to wait for the browser to start. */
  launchTimeoutMs?: number;
}

/**
 * The process holding a browser profile: Chrome's own lock in it is a link "host-pid" (macOS and Linux), and the process must be alive and be a
 * browser started on this very profile (after a restart of the computer a number in an old lock may be anyone's). Null otherwise.
 */
function holderOf(profileDir: string): number | null {
  let pid: number;
  try {
    pid = Number(/-(\d+)$/.exec(readlinkSync(join(profileDir, "SingletonLock")))?.[1]);
  } catch {
    /* no lock: nothing holds the profile (or Windows, which has none) */
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return null;
  try {
    process.kill(pid, 0);
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 }).includes(`--user-data-dir=${profileDir}`) ? pid : null;
  } catch {
    /* not running, or not ours to look at */
    return null;
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    /* no such process (or not ours to signal): not running for this purpose */
    return false;
  }
};

/**
 * A browser of an earlier Pako still running on this profile (that Pako ended without closing it) makes a new one stop at once: it hands its
 * window to the old process and exits. The profile is Pako's own and one Pako runs per home, so such a browser is stale: asked to end, then killed.
 */
async function releaseProfile(profileDir: string): Promise<void> {
  const pid = holderOf(profileDir);
  if (pid === null) return;
  const gone = async (ms: number): Promise<boolean> => {
    const end = Date.now() + ms;
    while (alive(pid) && Date.now() < end) await sleep(100);
    return !alive(pid);
  };
  try {
    process.kill(pid, "SIGTERM");
    if (await gone(4000)) return;
    process.kill(pid, "SIGKILL");
  } catch {
    /* gone meanwhile */
  }
  await gone(3000);
}

/** One running browser. */
export class Browser {
  private proc: ChildProcess;
  readonly conn: Connection;
  readonly headless: boolean;
  private timeoutMs: number;

  private constructor(proc: ChildProcess, conn: Connection, headless: boolean, timeoutMs: number) {
    this.proc = proc;
    this.conn = conn;
    this.headless = headless;
    this.timeoutMs = timeoutMs;
  }

  static async launch(o: BrowserOptions): Promise<Browser> {
    mkdirSync(o.profileDir, { recursive: true });
    const portFile = join(o.profileDir, "DevToolsActivePort");
    rmSync(portFile, { force: true });
    const args = [
      "--remote-debugging-port=0",
      `--user-data-dir=${o.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate,MediaRouter",
      "--password-store=basic",
      ...(o.headless ? ["--headless=new", "--window-size=1280,900"] : ["--new-window", "--window-size=1200,900"]),
      "about:blank",
    ];
    await releaseProfile(o.profileDir);
    const proc = spawn(o.executable, args, { stdio: "ignore", detached: false });
    // Whenever Pako ends (a stop, a restart in place, a crash with an exit), its browser ends with it: left running, it would keep the profile
    // and every later booking would find it in use. Only a kill of Pako itself leaves one, and the next launch deals with that (releaseProfile).
    const killWithPako = (): void => void proc.kill("SIGKILL");
    process.on("exit", killWithPako);
    proc.once("exit", () => process.off("exit", killWithPako));
    let failed: Error | null = null;
    proc.on("error", (err) => (failed = err));
    proc.on("exit", (code) => (failed ??= new Error(`the browser stopped at once (exit ${code}); is the profile in use by another Pako?`)));
    const deadline = Date.now() + (o.launchTimeoutMs ?? 20_000);
    let port = "";
    let path = "";
    while (!port) {
      if (failed) throw new CdpError(`cdp: ${(failed as Error).message}`);
      if (Date.now() > deadline) {
        proc.kill();
        throw new CdpError("cdp: the browser did not open its debugging port in time");
      }
      try {
        const lines = readFileSync(portFile, "utf8").split("\n");
        if (lines[0] && lines[1]) [port, path] = [lines[0].trim(), lines[1].trim()];
      } catch {
        /* not written yet */
      }
      if (!port) await sleep(50);
    }
    const timeoutMs = o.timeoutMs ?? 15_000;
    const wire = await openWire(`ws://127.0.0.1:${port}${path}`, timeoutMs);
    return new Browser(proc, new Connection(wire, timeoutMs), o.headless, timeoutMs);
  }

  get alive(): boolean {
    return !this.conn.closed && this.proc.exitCode === null;
  }

  /** A new tab with the network and page events on. */
  async newPage(timeoutMs = this.timeoutMs): Promise<Page> {
    const { targetId } = (await this.conn.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    const { sessionId } = (await this.conn.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
    const page = new Page(this.conn, targetId, sessionId, timeoutMs);
    await Promise.all([
      this.conn.send("Page.enable", {}, sessionId),
      this.conn.send("Runtime.enable", {}, sessionId),
      this.conn.send("Network.enable", {}, sessionId),
    ]);
    if (!this.headless) await this.conn.send("Target.activateTarget", { targetId }).catch(() => undefined);
    return page;
  }

  /** Closes the browser: politely first, then by force. */
  async close(): Promise<void> {
    const gone = new Promise<void>((r) => (this.proc.exitCode !== null ? r() : this.proc.once("exit", () => r())));
    await this.conn.send("Browser.close", {}, undefined, 3000).catch(() => undefined);
    const timer = setTimeout(() => this.proc.kill("SIGKILL"), 3000);
    await gone;
    clearTimeout(timer);
    this.conn.close();
  }
}

/**
 * The browser kept warm: started on first use, in the mode asked for (a Handoff needs a window, so an idle headless one is closed and a visible
 * one opened on the same profile, which only one process can hold), and closed after `idleMs` with nothing in use. A browser that is working is
 * never closed to change its mode: a window waits for the headless steps to end, and a step is turned away while a window is open.
 */
/** What Maître needs from the browser: a tab for a step, and a visible tab for a Handoff (the tests give a stand-in). */
export interface PagePool {
  withPage<T>(fn: (page: Page) => Promise<T>, o?: { headless?: boolean; keep?: boolean }): Promise<T>;
  openWindow(): Promise<{ page: Page; release: () => void }>;
}

/** What the pool needs of a running browser (the tests give a stand-in for the real one). */
export type BrowserLike = Pick<Browser, "alive" | "headless" | "newPage" | "close">;

export class BrowserPool implements PagePool {
  private browser: BrowserLike | null = null;
  private starting: Promise<BrowserLike> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inUse = 0;
  /** A Handoff holds the window open until it ends, whatever the idle clock says. */
  private holds = 0;
  private o: Omit<BrowserOptions, "headless"> & { idleMs?: number; switchWaitMs?: number; launch?: (o: BrowserOptions) => Promise<BrowserLike> };

  constructor(o: Omit<BrowserOptions, "headless"> & { idleMs?: number; switchWaitMs?: number; launch?: (o: BrowserOptions) => Promise<BrowserLike> }) {
    this.o = o;
  }

  get executable(): string {
    return this.o.executable;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.inUse === 0 && this.holds === 0) void this.close();
    }, this.o.idleMs ?? 10 * 60_000);
    this.timer.unref?.();
  }

  /**
   * The browser in the mode asked for. The caller has counted itself in `inUse` (a step) or `holds` (a window) already. A browser of the other
   * mode that is idle is closed for it; one that is working is not (closing it would take the owner's window from under them, or end a booking
   * between its press and its confirmation): a step is refused while a window is open (it becomes a typed failure the planner handles), and a
   * window waits for the steps running to end, each of which ends by its own deadline.
   */
  private async get(headless: boolean): Promise<BrowserLike> {
    const giveUp = Date.now() + (this.o.switchWaitMs ?? 3 * 60_000);
    for (;;) {
      if (this.starting) await this.starting.catch(() => undefined);
      const old = this.browser;
      if (old && old.alive && old.headless === headless) return old;
      if (old?.alive) {
        if (headless && this.holds > 0) throw new CdpError("cdp: a window the owner is working in is open: not now");
        if (!headless && this.inUse > 0) {
          if (Date.now() >= giveUp) throw new CdpError("cdp: the browser stayed busy too long to open a window");
          await sleep(100);
          continue;
        }
      }
      // The closing and the launch are one step others wait for (`starting`): two launches on one profile would stop each other.
      const launch = this.o.launch ?? Browser.launch.bind(Browser);
      this.starting = (async () => {
        if (old) {
          this.browser = null;
          await old.close().catch(() => undefined);
        }
        return launch({ ...this.o, headless });
      })();
      try {
        this.browser = await this.starting;
        return this.browser;
      } finally {
        this.starting = null;
      }
    }
  }

  /** Runs `fn` on a fresh tab, closed afterwards; the browser stays warm for the next one. */
  async withPage<T>(fn: (page: Page) => Promise<T>, o: { headless?: boolean; keep?: boolean } = {}): Promise<T> {
    this.inUse++;
    let page: Page | null = null;
    try {
      const b = await this.get(o.headless ?? true);
      page = await b.newPage();
      return await fn(page);
    } finally {
      if (page && !o.keep) await page.close().catch(() => undefined);
      this.inUse--;
      this.arm();
    }
  }

  /** A visible tab that stays open (a Handoff); `release` lets the idle clock close it later. */
  async openWindow(): Promise<{ page: Page; release: () => void }> {
    this.holds++;
    try {
      const b = await this.get(false);
      const page = await b.newPage();
      let released = false;
      return {
        page,
        release: () => {
          if (released) return;
          released = true;
          this.holds--;
          this.arm();
        },
      };
    } catch (err) {
      this.holds--;
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const b = this.browser;
    this.browser = null;
    await b?.close().catch(() => undefined);
  }
}
