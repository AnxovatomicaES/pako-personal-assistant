// The operating system's own secret store, behind one small interface, with no npm package: each system's own tool is run.
//
// - macOS: the login keychain, through /usr/bin/security. Values go in through `security -i` (its interactive mode, fed on stdin) with the
//   -X hex form, so a secret is never on a command line: `add-generic-password -w <value>` would show it to anyone running `ps`, and a bare
//   `-w` prompts on the terminal, which a background process does not have. Reading is `find-generic-password -w`, whose answer comes on
//   stdout. An item made by `security` trusts `security` itself, so reading it back never shows a dialog (the Mac app reads the bridge token
//   the same way, desktop/mac/Pako.swift).
// - Windows: the Credential Manager, through Windows PowerShell and a few lines of C# (Add-Type) calling CredReadW, CredWriteW and
//   CredDeleteW, the documented Win32 calls. `cmdkey` can write and delete but has no way to read a password back, and a store we cannot read
//   from is no store; the CredentialManager PowerShell module is not installed by default. The script goes on the command line (it holds no
//   secret); the values travel on stdin, one line each, in both directions.
// - Linux: libsecret's `secret-tool` (GNOME Keyring, KWallet's Secret Service), when it is installed and a desktop session's bus is there.
//   `secret-tool store` reads the value on stdin, `lookup` answers on stdout.
// - Anything else (a headless server, Render, no secret-tool, no session bus): no store; the caller keeps the file (src/secrets.ts).
//
// Every call has a timeout and is killed past it: a keychain asking to be unlocked, a Secret Service waiting for a password dialog nobody
// sees, a PowerShell that never starts, must never hang Pako. A failure is a StoreError; the caller decides what that means.
//
// Values are printable ASCII on one line (src/secrets.ts encodes them so): nothing in them can break a line protocol or be read as a
// command by `security -i`, and every tool hands them back byte for byte.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join, win32 } from "node:path";

type Env = Record<string, string | undefined>;

export type StoreKind = "keychain" | "wincred" | "libsecret";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the program could not start, or was killed at its timeout (code ETIMEDOUT). */
  error?: Error;
}

/** Runs a program to its end, giving `input` on stdin; killed past `timeoutMs`. Injected in tests. */
export type Runner = (cmd: string, args: string[], o: { input?: string; timeoutMs: number }) => RunResult;

export const defaultRunner: Runner = (cmd, args, o) => {
  const r = spawnSync(cmd, args, {
    input: o.input ?? "",
    timeout: o.timeoutMs,
    killSignal: "SIGKILL",
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
};

/** Something the store could not do. Its message names the tool and its exit, never a value. */
export class StoreError extends Error {
  code = "ESTORE";
}

export interface SecretStore {
  readonly kind: StoreKind;
  readonly service: string;
  /** The longest value one entry holds (the Credential Manager's blob is 2,560 bytes): longer ones are split by the caller. */
  readonly maxValue: number;
  /** Each account's value, or null when it has none. Throws a StoreError when the store cannot answer. */
  get(accounts: string[]): Map<string, string | null>;
  /** Writes each value, replacing one already there. Throws a StoreError; the caller reads back to be sure. */
  set(entries: [string, string][]): void;
  /** Removes each account; one that is not there is no error. Throws a StoreError when the store cannot answer. */
  remove(accounts: string[]): void;
}

/** Service and account names: plain characters only, so they can sit in a `security -i` line or a tab-separated one as they are. */
const NAME = /^[A-Za-z0-9._:#-]{1,200}$/;
/** Values: printable ASCII on one line. */
const VALUE = /^[\x20-\x7e]*$/;

function checkNames(service: string, accounts: string[]): void {
  if (!NAME.test(service)) throw new StoreError("a service name with characters the store cannot take");
  for (const a of accounts) if (!NAME.test(a)) throw new StoreError("an account name with characters the store cannot take");
}

function checkValues(entries: [string, string][]): void {
  for (const [, v] of entries) if (!VALUE.test(v)) throw new StoreError("a value that is not printable ASCII on one line");
}

/** What a run that went wrong was, in a few words: the tool, then its timeout or its exit code. Never its output, which could echo a value. */
function failure(tool: string, r: RunResult): StoreError {
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT") return new StoreError(`${tool} did not answer in time`);
  if (r.error) return new StoreError(`${tool} could not run (${code ?? "error"})`);
  return new StoreError(`${tool} exited with ${r.status ?? "a signal"}`);
}

const hex = (s: string): string => Buffer.from(s, "utf8").toString("hex");

// ---------- macOS ----------

export const SECURITY = "/usr/bin/security";
/** errSecItemNotFound, as `security` exits for it. */
const MAC_NOT_FOUND = 44;

/**
 * The longest value one keychain entry is given: `security -i` reads each command into a 4,096-byte line, and a longer one fails (exit 1).
 * The value goes in as hex (two characters each) after the command and two names of up to 200 characters: 1,800 leaves room for all of it.
 * A longer value (a Microsoft sign-in in the settings) is split by the caller, as for the Credential Manager.
 */
export const MAC_MAX_VALUE = 1800;

export function macStore(service: string, run: Runner = defaultRunner, timeoutMs = 5000): SecretStore {
  return {
    kind: "keychain",
    service,
    maxValue: MAC_MAX_VALUE,
    get(accounts) {
      checkNames(service, accounts);
      const out = new Map<string, string | null>();
      // One run per account: `security -i` answers a batch of reads in one stream, with nothing to tell a missing item from a value.
      for (const a of accounts) {
        const r = run(SECURITY, ["find-generic-password", "-s", service, "-a", a, "-w"], { timeoutMs });
        if (r.status === 0 && !r.error) out.set(a, r.stdout.replace(/\n$/, ""));
        else if (r.status === MAC_NOT_FOUND && !r.error) out.set(a, null);
        // 36 is "user interaction is not allowed": a locked keychain, as over SSH. 51 and others: no keychain, denied. All are "cannot answer".
        else throw failure("security", r);
      }
      return out;
    },
    set(entries) {
      checkNames(service, entries.map(([a]) => a));
      checkValues(entries);
      if (!entries.length) return;
      // -U updates an item that is there. No -T and no -A: the item trusts only `security`, which made it, and asks before any other app.
      const input = entries.map(([a, v]) => `add-generic-password -U -s ${service} -a ${a} -X ${hex(v)}\n`).join("");
      const r = run(SECURITY, ["-i"], { input, timeoutMs: timeoutMs * 2 });
      if (r.error || r.status !== 0) throw failure("security", r);
    },
    remove(accounts) {
      checkNames(service, accounts);
      if (!accounts.length) return;
      // In interactive mode the exit code is the last command's: a missing item at the end would read as a failure. The caller reads back.
      const input = accounts.map((a) => `delete-generic-password -s ${service} -a ${a}\n`).join("");
      const r = run(SECURITY, ["-i"], { input, timeoutMs: timeoutMs * 2 });
      if (r.error) throw failure("security", r);
    },
  };
}

// ---------- Windows ----------

/**
 * The C# the PowerShell script compiles: one line in per operation ("get\t<target>", "set\t<target>\t<value>", "del\t<target>"), one line
 * out for each ("ok\t<target>[\t<value>]", "none\t<target>", "err\t<target>\t<win32 error>"). 1168 is ERROR_NOT_FOUND. The credentials are
 * generic ones (type 1), kept on this computer for this Windows user (persist 2, CRED_PERSIST_LOCAL_MACHINE: never roamed to other computers).
 */
const WIN_CS = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PakoCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static string Run(string input) {
    StringBuilder sb = new StringBuilder();
    foreach (string raw in input.Split('\n')) {
      string line = raw.TrimEnd('\r');
      if (line.Length == 0) continue;
      string[] p = line.Split(new char[] { '\t' }, 3);
      if (p.Length < 2) continue;
      string op = p[0], target = p[1];
      if (op == "get") {
        IntPtr ptr;
        if (CredReadW(target, 1, 0, out ptr)) {
          try {
            CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            byte[] bytes = new byte[c.CredentialBlobSize];
            if (bytes.Length > 0) Marshal.Copy(c.CredentialBlob, bytes, 0, bytes.Length);
            sb.Append("ok\t" + target + "\t" + Encoding.UTF8.GetString(bytes) + "\n");
          } finally { CredFree(ptr); }
        } else {
          int e = Marshal.GetLastWin32Error();
          sb.Append(e == 1168 ? "none\t" + target + "\n" : "err\t" + target + "\t" + e + "\n");
        }
      } else if (op == "set" && p.Length == 3) {
        byte[] bytes = Encoding.UTF8.GetBytes(p[2]);
        CREDENTIAL c = new CREDENTIAL();
        c.Type = 1; c.TargetName = target; c.Persist = 2; c.UserName = "Pako";
        c.CredentialBlobSize = bytes.Length;
        c.CredentialBlob = Marshal.AllocHGlobal(Math.Max(bytes.Length, 1));
        try {
          Marshal.Copy(bytes, 0, c.CredentialBlob, bytes.Length);
          if (CredWriteW(ref c, 0)) sb.Append("ok\t" + target + "\n");
          else sb.Append("err\t" + target + "\t" + Marshal.GetLastWin32Error() + "\n");
        } finally { Marshal.FreeHGlobal(c.CredentialBlob); }
      } else if (op == "del") {
        if (CredDeleteW(target, 1, 0)) sb.Append("ok\t" + target + "\n");
        else {
          int e = Marshal.GetLastWin32Error();
          sb.Append(e == 1168 ? "none\t" + target + "\n" : "err\t" + target + "\t" + e + "\n");
        }
      }
    }
    return sb.ToString();
  }
}
`;

/** The PowerShell around it: stdin in, the answer out, as UTF-8 both ways (the console's own code page could change a byte). */
export const WIN_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::InputEncoding = [Text.Encoding]::UTF8",
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  `Add-Type -TypeDefinition @'\n${WIN_CS}\n'@`,
  "[Console]::Out.Write([PakoCred]::Run([Console]::In.ReadToEnd()))",
].join("\n");

export function winPowerShell(env: Env): string {
  return win32.join((env.SystemRoot ?? env.windir ?? "C:\\Windows").trim(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function winStore(service: string, env: Env = process.env, run: Runner = defaultRunner, timeoutMs = 20000): SecretStore {
  // -EncodedCommand: the script as UTF-16LE base64, so no quoting of it can go wrong. It carries no secret.
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(WIN_SCRIPT, "utf16le").toString("base64")];
  const target = (a: string): string => `${service}:${a}`;
  const call = (lines: string[]): Map<string, string[]> => {
    // Compiling the C# takes a second or two the first time: a longer timeout than the other systems', still bounded.
    const r = run(winPowerShell(env), args, { input: lines.join("\n") + "\n", timeoutMs });
    if (r.error || r.status !== 0) throw failure("powershell", r);
    const out = new Map<string, string[]>();
    for (const line of r.stdout.split("\n")) {
      const parts = line.replace(/\r$/, "").split("\t");
      if (parts.length >= 2) out.set(parts[1]!, [parts[0]!, parts.slice(2).join("\t")]);
    }
    return out;
  };
  return {
    kind: "wincred",
    service,
    // CRED_MAX_CREDENTIAL_BLOB_SIZE is 2,560 bytes; the values are ASCII, one byte a character.
    maxValue: 2000,
    get(accounts) {
      checkNames(service, accounts);
      const res = accounts.length ? call(accounts.map((a) => `get\t${target(a)}`)) : new Map<string, string[]>();
      const out = new Map<string, string | null>();
      for (const a of accounts) {
        const [st, v] = res.get(target(a)) ?? ["err"];
        if (st === "ok") out.set(a, v ?? "");
        else if (st === "none") out.set(a, null);
        else throw new StoreError("the Credential Manager could not read an entry");
      }
      return out;
    },
    set(entries) {
      checkNames(service, entries.map(([a]) => a));
      checkValues(entries);
      if (!entries.length) return;
      const res = call(entries.map(([a, v]) => `set\t${target(a)}\t${v}`));
      for (const [a] of entries) if (res.get(target(a))?.[0] !== "ok") throw new StoreError("the Credential Manager could not write an entry");
    },
    remove(accounts) {
      checkNames(service, accounts);
      if (!accounts.length) return;
      const res = call(accounts.map((a) => `del\t${target(a)}`));
      for (const a of accounts) if (res.get(target(a))?.[0] === "err") throw new StoreError("the Credential Manager could not remove an entry");
    },
  };
}

// ---------- Linux ----------

export function linuxStore(service: string, tool = "secret-tool", run: Runner = defaultRunner, timeoutMs = 5000): SecretStore {
  return {
    kind: "libsecret",
    service,
    maxValue: Number.POSITIVE_INFINITY,
    get(accounts) {
      checkNames(service, accounts);
      const out = new Map<string, string | null>();
      for (const a of accounts) {
        const r = run(tool, ["lookup", "service", service, "account", a], { timeoutMs });
        if (r.status === 0 && !r.error) out.set(a, r.stdout.replace(/\n$/, ""));
        // Nothing found: exit 1 with nothing said. An error (no bus, a locked collection) says why on stderr.
        else if (r.status === 1 && !r.error && !r.stderr.trim()) out.set(a, null);
        else throw failure("secret-tool", r);
      }
      return out;
    },
    set(entries) {
      checkNames(service, entries.map(([a]) => a));
      checkValues(entries);
      for (const [a, v] of entries) {
        const r = run(tool, ["store", "--label=Pako", "service", service, "account", a], { input: v, timeoutMs });
        if (r.error || r.status !== 0) throw failure("secret-tool", r);
      }
    },
    remove(accounts) {
      checkNames(service, accounts);
      for (const a of accounts) {
        const r = run(tool, ["clear", "service", service, "account", a], { timeoutMs });
        // clear exits 1 when there was nothing to clear.
        if (r.error || (r.status !== 0 && (r.status !== 1 || r.stderr.trim()))) throw failure("secret-tool", r);
      }
    },
  };
}

/** A program on the PATH, or null. */
function onPath(name: string, env: Env): string | null {
  for (const d of (env.PATH ?? "").split(delimiter)) {
    if (!d) continue;
    const p = join(d, name);
    if (existsSync(p)) return p;
  }
  return null;
}

// ---------- which one ----------

/**
 * This computer's store, or null when it has none Pako can use: the kind is chosen by the system, and the store must at least be there to
 * ask (whether it answers is found out by using it). On Linux the session's bus must be there too: with none, secret-tool would try to
 * start one, or wait for a password prompt no one sees.
 */
export function systemStore(service: string, env: Env = process.env, platform: NodeJS.Platform = process.platform, run: Runner = defaultRunner): SecretStore | null {
  if (platform === "darwin") return existsSync(SECURITY) ? macStore(service, run) : null;
  if (platform === "win32") return existsSync(winPowerShell(env)) ? winStore(service, env, run) : null;
  if (platform === "linux") {
    if (!(env.DBUS_SESSION_BUS_ADDRESS ?? "").trim()) return null;
    const tool = onPath("secret-tool", env);
    return tool ? linuxStore(service, tool, run) : null;
  }
  return null;
}

/** The store of a given kind, as a secrets.json marker names it; null when that kind is not this system's (a folder copied from another one). */
export function storeOfKind(kind: StoreKind, service: string, env: Env = process.env, platform: NodeJS.Platform = process.platform, run: Runner = defaultRunner): SecretStore | null {
  const s = systemStore(service, env, platform, run);
  return s && s.kind === kind ? s : null;
}
