// Which Claude Code this bridge drives. What decides whether it works is the self-test (cli-probe.ts), run on each new version; the range
// below is only what Pako's captured outputs (test/fixtures/claude-cli/) come from, and what is said when the self-test could not run.

import { spawnSync } from "node:child_process";
import { childEnv, claudeCommand } from "./cli.ts";

/**
 * The Claude Code versions Pako has been tested with. `min`: the oldest the bridge's flags, stream-json and tool events were checked on
 * (2.1.325: assistant/bridge/warm.ts, test/bench/latency.ts). `maxTested`: the newest whose outputs were captured into the tests
 * (test/fixtures/claude-cli/). Raise `maxTested` after capturing a newer version's outputs and running the gate against it.
 */
export const CLAUDE_CODE_TESTED = { min: "2.1.325", maxTested: "2.1.327" } as const;

/**
 * How this Claude Code stands; `note` is the sentence for the log and the panel, absent when all is well. "ok": it passed the self-test
 * (or, untested, is in the captured range); "probed": it passed the self-test, outside the captured range; "failed": it did not, and `note`
 * says what and how to go back to `lastGood`; "newer" / "older": the self-test could not run, and it is outside the range; "unknown": no version;
 * "behind": it refused a model Pako asks for as too new for it (runs.ts, cli-models.ts), and `note` says to update it.
 */
export interface CliCompat {
  version: string;
  status: "ok" | "probed" | "failed" | "newer" | "older" | "unknown" | "behind";
  note?: string;
  /** The version to go back to, when it failed. */
  lastGood?: string;
}

/** The version in `claude --version`'s output ("2.1.327 (Claude Code)"); null when there is none. */
export function parseClaudeVersion(out: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/.exec(out)?.[1] ?? null;
}

/** Compares two x.y.z versions: negative when a is older, 0 when equal, positive when newer. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Where `out` (`claude --version`'s output, "" when it gave none) stands against CLAUDE_CODE_TESTED alone, with no self-test. */
export function cliCompat(out: string, tested: { min: string; maxTested: string } = CLAUDE_CODE_TESTED): CliCompat {
  const version = parseClaudeVersion(out);
  if (!version) return { version: "", status: "unknown", note: "Pako could not read which Claude Code this is (claude --version said no version)" };
  if (compareVersions(version, tested.maxTested) > 0) {
    return { version, status: "newer", note: `Claude Code ${version} is newer than Pako has been tested with (up to ${tested.maxTested})` };
  }
  if (compareVersions(version, tested.min) < 0) {
    return { version, status: "older", note: `Claude Code ${version} is older than Pako has been tested with (from ${tested.min}): run claude update` };
  }
  return { version, status: "ok" };
}

/** `claude --version`, once, at the bridge's start. "" when it could not be run. */
export function readClaudeVersion(bin: string): string {
  try {
    const [cmd, args] = claudeCommand(bin, ["--version"]);
    return spawnSync(cmd, args, { encoding: "utf8", timeout: 10_000, env: childEnv(process.env), windowsHide: true }).stdout ?? "";
  } catch {
    return ""; // not runnable here: the first run says why (missing), and the panel shows it
  }
}
