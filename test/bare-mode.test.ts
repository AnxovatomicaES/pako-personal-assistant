// Claude Code's bare mode (--bare, CLAUDE_CODE_SIMPLE=1) never reads a plan's sign-in, only ANTHROPIC_API_KEY, and Anthropic says it will
// become the default for -p. Pako never passes the bare switch on, and asks for --no-bare as soon as a Claude Code offers it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildClaudeArgs, childEnv, offersNoBare } from "../assistant/bridge.ts";

test("the bare-mode switch in the environment is never passed to claude; the sign-in's own settings are", () => {
  const env = childEnv({ PATH: "/bin", CLAUDE_CODE_SIMPLE: "1", CLAUDE_CONFIG_DIR: "/x", ANTHROPIC_API_KEY: "k" });
  assert.equal(env.CLAUDE_CODE_SIMPLE, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, "/x");
  assert.equal(env.ANTHROPIC_API_KEY, "k");
});

test("--no-bare is asked for only when this Claude Code offers it (read once from its --help)", () => {
  let asked = 0;
  const yes = () => (asked++, "  --bare  Minimal mode\n  --no-bare  Read the sign-in even with -p\n");
  assert.equal(offersNoBare("/fake/claude-new", yes), true);
  assert.equal(offersNoBare("/fake/claude-new", yes), true);
  assert.equal(asked, 1, "cached per program");
  assert.equal(offersNoBare("/fake/claude-today", () => "  --bare  Minimal mode: ... ANTHROPIC_API_KEY ...\n"), false);
  assert.ok(buildClaudeArgs({ tools: [], model: "", noBare: true }).includes("--no-bare"));
  assert.ok(!buildClaudeArgs({ tools: [], model: "" }).includes("--no-bare"));
});
