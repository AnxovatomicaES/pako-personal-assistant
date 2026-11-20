// Starts the owner's assistant on this computer and keeps it asking for messages until it is stopped:
//   node --env-file=assistant/.env assistant/run.ts
// See assistant/README.md.

import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createBridge, createCliWatch, loadBridgeConfig, offersFlag, offersMcpTools, offersNoBare, stopRunningClaude, type BridgeConfig,
} from "./bridge.ts";
import { createUpdater, loadUpdateConfig, restartSelf } from "./update.ts";

// A wrong setting is said in a sentence, not a stack trace: on a computer (local mode) this lands in the terminal where the person typed
// `npm start`, and the panel's chat points there.
let config: BridgeConfig;
try {
  config = loadBridgeConfig(process.env);
} catch (err) {
  console.error(`\n  ${(err as Error).message}\n  Fix that setting where it is set (on a computer, ~/.pako/.env or ./.env; on a server's brain, assistant/.env) and start again.\n`);
  process.exit(1);
}
// Claude Code's bare mode ignores a plan's sign-in; a Claude Code that offers the opt-out gets it on every run (asked once, here).
config.noBare = offersNoBare(config.claudeBin);
if (config.noBare) console.log("Claude Code offers --no-bare: asking for it, so your plan's sign-in keeps working");
// The lighter effort for the short background verdicts (assistant/budget.ts LIGHT) only from a Claude Code that takes the flag.
config.effortOk = offersFlag(config.claudeBin, "--effort");
// The conversation's process kept up between messages only from a Claude Code that reads messages as JSON lines.
if (config.warmMs && !offersFlag(config.claudeBin, "--input-format")) {
  config.warmMs = 0;
  console.log("This Claude Code does not take --input-format: a new claude process for every message");
}
// Pako's typed tools (assistant/mcp-server.ts) only from a Claude Code that loads an MCP config and streams JSON, and when the server starts
// here; ASSISTANT_TYPED_TOOLS=off keeps the tags alone.
config.mcpTools = (process.env.ASSISTANT_TYPED_TOOLS ?? "").trim().toLowerCase() !== "off" && offersMcpTools(config.claudeBin);
// Whether this Claude Code works the way the bridge drives it (assistant/bridge/cli-probe.ts): a self-test of the bridge's own flags and of
// the outputs it reads, run once per version, no model tokens spent. Before the bridge is built, so what it finds broken is off from the
// first message; the outcome is logged and shown on the panel's Health card, and looked at again when Claude Code updates itself. Not in
// `--self-check` (assistant/update.ts): that only asks whether this code loads, and runs nothing of Claude Code's.
const cliWatch = createCliWatch({ config });
const cliAtStart = process.argv.includes("--self-check") ? null : await cliWatch.check();
console.log(config.mcpTools ? "Pako's tools are on: Claude acts through typed tool calls (the tags still work)" : "Pako's tools are off: Claude acts through tags");
const bridge = createBridge({ config });
if (cliAtStart) bridge.setCli(cliAtStart);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`${signal}: finishing the current message, then stopping`);
    stopping = true;
    // The server's long wait for a message (25 s) or a long answer must not keep it running for ever: a message it was in the middle of stays in the inbox, unanswered, and is taken again.
    // A Claude run under way gets two seconds to end by itself, then a SIGTERM; the exit below makes sure of it (SIGKILL).
    setTimeout(() => stopRunningClaude("SIGTERM"), 2000).unref();
    setTimeout(() => process.exit(0), 4000).unref();
  });
}
// However this process ends (the timers above, its parent gone, an error): no Claude run outlives it.
process.on("exit", () => stopRunningClaude("SIGKILL"));
// Started by the Pako server on a computer (local mode): when that server goes, this goes with it (even after a kill -9), instead of living on and answering twice.
const parent = Number(process.env.PAKO_PARENT_PID);
if (Number.isInteger(parent) && parent > 1) {
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") process.exit(0);
    }
  }, 3000).unref();
}

// Keeping itself up to date (assistant/update.ts): on a server's computer only, between two messages, every half hour. Its version goes to
// the server on the next round, for the panel's Health card and the server's warning when this computer falls behind.
const updater = createUpdater({ repo: fileURLToPath(new URL("..", import.meta.url)), stateDir: config.stateDir, config: loadUpdateConfig(process.env, config.server) });
// `--self-check` (assistant/update.ts, before it restarts onto a new version): everything above loaded, the settings were accepted, the
// bridge was built. That is all it asks: stop here, before the loop.
if (process.argv.includes("--self-check")) {
  console.log("self-check ok");
  process.exit(0);
}
const restart = (): void => {
  // The process kept up for the owner's conversation is this one's child: it would outlive the restart.
  bridge.stopWarm();
  restartSelf({ execve: (process as unknown as { execve?: Parameters<typeof restartSelf>[0]["execve"] }).execve?.bind(process), exit: (c) => process.exit(c) });
};
// After a self-update: a new version that already stopped once before its first good round is undone here, and this starts again on the old.
if ((await updater.started()) === "rolled-back") restart();
// Two minutes up count as proof too (a server that cannot be reached is no fault of the new version).
setTimeout(() => updater.proved(), 120_000).unref();
const said = await updater.version();
if (said) bridge.setVersion(said);

const models = `model ${config.model || "default"}, writing model ${config.writingModel || config.model || "default"}`;
console.log(`Assistant bridge started: server ${config.server}, tools [${config.tools.join(", ") || "none"}], ${models}`);
console.log(
  `Claude budget: ${config.budget?.perDay ?? 40} background runs a day, your own messages never held back; `
    + `${config.warmMs ? `your conversation's claude process kept up for ${Math.round(config.warmMs / 60_000)} min between messages` : "a new claude process for every message"}`,
);
// The first message need not wait for claude to start.
bridge.warmUp();
if (updater.status() !== "on") console.log(`Self-update: ${updater.status()}`);
let delay = 2000;
while (!stopping) {
  try {
    const { seen, done } = await bridge.tick();
    delay = 2000;
    updater.proved();
    // Messages were waiting but none could be handled (the server's context did not answer): do not spin.
    if (seen > 0 && done === 0) await sleep(5000);
    // Idle: Claude Code may have updated itself since the last look (every ten minutes); a new version gets the self-test.
    if (seen === 0 && !bridge.busy() && !stopping && cliWatch.due()) {
      const before = cliWatch.compat();
      const now = await cliWatch.check();
      if (now !== before) {
        bridge.setCli(now);
        // The self-test found this Claude Code's stream-json broken: the process kept up for the conversation goes too.
        if (config.warmMs === 0) bridge.stopWarm();
      }
    }
    // Idle (nothing came in this round, nothing under way): the time for the half-hourly look at origin.
    if (seen === 0 && !bridge.busy() && !stopping && updater.due()) {
      const outcome = await updater.check();
      const now = await updater.version();
      if (now) bridge.setVersion(now);
      if (outcome.kind === "updated" && !stopping) {
        // The new version says itself to the server when it starts. What the process-exit handler does (no Claude run can be under way:
        // the round was idle) is not needed before execve.
        restart();
      }
    }
  } catch (err) {
    console.error(`${new Date().toISOString()} could not reach the server: ${(err as Error).message}. Trying again in ${Math.round(delay / 1000)} s`);
    await sleep(delay);
    delay = Math.min(delay * 2, 60_000);
  }
}
