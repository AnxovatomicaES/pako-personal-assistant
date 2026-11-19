// Starting the `claude` program: the command line on each platform, the settings it may see, and the flags this Claude Code offers.

import { spawnSync } from "node:child_process";

/**
 * What `claude` gets to see of this process's settings: the ones it needs to run and to sign in (its own, a proxy, a cloud provider's), and nothing of
 * the rest. In local mode this process holds every key of every connection; Claude reads web pages written by strangers and must not hold them.
 */
const CHILD_ENV = new RegExp(
  "^(PATH|HOME|USER|LOGNAME|SHELL|TERM|LANG|LC_[A-Z0-9_]+|TMPDIR|TZ|NO_COLOR|(?:HTTPS?|ALL|NO)_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS"
    + "|XDG_[A-Z0-9_]+|CLAUDE_[A-Z0-9_]+|CLAUDECODE|ANTHROPIC_[A-Z0-9_]+|AWS_[A-Z0-9_]+|GOOGLE_APPLICATION_CREDENTIALS|CLOUD_ML_REGION"
    + "|SYSTEMROOT|APPDATA|LOCALAPPDATA|USERPROFILE|PATHEXT|COMSPEC|TEMP|TMP|SYSTEMDRIVE|WINDIR|HOMEDRIVE|HOMEPATH|PROGRAMFILES|PROGRAMDATA)$",
  "i",
);
/**
 * How to start the claude command `bin` with `args`. On Windows a script cannot be started on its own: Claude Code installed with npm is a
 * claude.cmd that runs a .js file with Node, and Node refuses to start a .cmd without a shell (whose quoting would mangle the system prompt).
 * src/local.ts finds the .js behind such a .cmd and passes it here; it is run with this same Node. Anything else is started as it is.
 */
export function claudeCommand(bin: string, args: string[], platform: NodeJS.Platform = process.platform): [string, string[]] {
  return platform === "win32" && /\.[cm]?js$/i.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
}

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  // CLAUDE_CODE_SIMPLE is Claude Code's bare mode: it never reads the plan's sign-in (OAuth, keychain), only ANTHROPIC_API_KEY. A plan user
  // would suddenly be "not signed in", so it is never passed on.
  for (const [k, v] of Object.entries(env)) if (v !== undefined && CHILD_ENV.test(k) && k.toUpperCase() !== "CLAUDE_CODE_SIMPLE") out[k] = v;
  return out;
}

/**
 * Whether this Claude Code takes `--no-bare`. Anthropic says `--bare` (no plan sign-in, API key only) will become the default for `-p`; a
 * Claude Code that offers the opt-out gets it on every run, so a plan's sign-in keeps working. Asked once per program (its --help), cached.
 */
const noBareSeen = new Map<string, boolean>();
export function offersNoBare(bin: string, help?: () => string): boolean {
  const known = noBareSeen.get(bin);
  if (known !== undefined) return known;
  let text = "";
  try {
    text = help ? help() : spawnSync(bin, ["--help"], { encoding: "utf8", timeout: 5000, env: childEnv(process.env), windowsHide: true }).stdout ?? "";
  } catch {
    text = "";
  }
  const yes = /(^|\s)--no-bare\b/m.test(text);
  noBareSeen.set(bin, yes);
  return yes;
}

/**
 * Whether this Claude Code lists `flag` in its --help (asked once per program, like --no-bare): `--effort` for the background verdicts, and
 * `--input-format` for the conversation's process kept up between messages (a program that cannot read messages as JSON lines would wait
 * for the end of its input for ever).
 */
const helpSeen = new Map<string, string>();
export function offersFlag(bin: string, flag: string, help?: () => string): boolean {
  let text = helpSeen.get(bin);
  if (text === undefined) {
    try {
      text = help ? help() : spawnSync(bin, ["--help"], { encoding: "utf8", timeout: 5000, env: childEnv(process.env), windowsHide: true }).stdout ?? "";
    } catch {
      text = "";
    }
    helpSeen.set(bin, text);
  }
  return text.split(/\s+/).includes(flag);
}
