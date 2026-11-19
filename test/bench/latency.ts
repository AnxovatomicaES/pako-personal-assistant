// How long the owner waits for an answer: the bridge's handling of one message (its context read, the claude run, the reply sent), timed
// for a few messages in a row, with a new claude process for every message (ASSISTANT_WARM_MIN=0, as before) and with the conversation's
// process kept up between them (the default).
//
//   npm run bench:latency                 the stub (test/fixtures/claude-stub.mjs), with the start and answer times measured on the real one
//   npm run bench:latency -- --real       the real `claude` on this computer: it uses the plan's quota (a few one-line answers)
//   npm run bench:latency -- --messages 8
//   npm run bench:latency -- --real --same   the same one-word question each time (the least noise from the API)
//   npm run bench:latency -- --tools      Pako's typed tools on, each question answered after one read tool call (read_calendar) when the
//                                         model is offered it: what a read tool's round trip costs, and what not offering it saves
//
// Nothing here touches a running Pako: the server is a function in this process, the state folder a new temporary one.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBridge, DEFAULT_MODEL, offersNoBare, stopRunningClaude, type BridgeConfig } from "../../assistant/bridge.ts";
import { createBudget } from "../../assistant/budget.ts";

const argv = process.argv.slice(2);
const real = argv.includes("--real");
const count = Number(argv[argv.indexOf("--messages") + 1]) || 6;
// The same one-word question every time: the API's own time then varies least, and what changes is the process around it.
const same = argv.includes("--same");
const withTools = argv.includes("--tools");
if (withTools && !real) process.env.CLAUDE_STUB_TOOLS ??= JSON.stringify([{ name: "read_calendar", input: {} }]);
const stub = fileURLToPath(new URL("../fixtures/claude-stub.mjs", import.meta.url));
if (!real) {
  // Measured with Claude Code 2.1.325 (see createWarmClaude): a new process spends about 2.8 s before the API, a turn on a process already
  // up about 0.7 s besides the API's own time; the API's time grows a little with the prompt.
  process.env.CLAUDE_STUB_START_MS ??= "2800";
  process.env.CLAUDE_STUB_TURN_MS ??= "700";
  process.env.CLAUDE_STUB_MS_PER_KCHAR ??= "20";
  process.env.CLAUDE_STUB_REPLY ??= "Vale, apuntado.";
}

const context = {
  now: "miércoles 18 de noviembre de 2026, 10:00", ownerName: "Marta", contacts: ["Ana", "Luis"], memory: "Notes:\n- Tiene un perro",
  reminders: ["mañana 09:00 llamar a Ana"], events: [], emails: [],
};
const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  const path = new URL(String(url)).pathname;
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  if (path === "/assistant/context") return json(context);
  if (init?.method === "POST") return json({ ok: true });
  return json({ messages: [] });
}) as typeof fetch;

const QUESTIONS = ["¿Qué tengo mañana?", "Recuérdame comprar pan", "¿Cómo se dice gracias en japonés?", "Apunta que a Ana le gusta el té", "¿Qué hora es en Tokio?", "Gracias", "¿Y el viernes?", "Nada más"];

async function round(warmMs: number, prewarm: boolean): Promise<number[]> {
  const stateDir = mkdtempSync(join(tmpdir(), "pako-bench-"));
  const config: BridgeConfig = {
    server: "http://127.0.0.1:9", token: "t".repeat(48), claudeBin: real ? "claude" : stub, model: real ? DEFAULT_MODEL : "", stateDir,
    tools: real ? [] : ["WebSearch"], runTimeoutMs: 120_000, rotateAfter: 30, noticeMs: 600_000, whisperModel: "", whisperBin: "", ffmpegBin: "",
    whisperLang: "auto", warmMs, ...(withTools ? { mcpTools: true } : {}),
  };
  if (real) config.noBare = offersNoBare("claude");
  const bridge = createBridge({ config, fetch: fakeFetch, log: () => undefined, budget: createBudget({ config: { perDay: 40, coalesceMs: 0, unchangedMs: 0 } }) });
  if (prewarm) {
    bridge.warmUp();
    await new Promise((r) => setTimeout(r, Number(process.env.CLAUDE_STUB_START_MS ?? 3000) + 500));
  }
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    const t0 = performance.now();
    await bridge.handle({ id: `bench-${i}`, text: same ? "Contesta solo con la palabra «vale»." : QUESTIONS[i % QUESTIONS.length]!, at: Date.now() });
    times.push(Math.round(performance.now() - t0));
    // The owner reads the answer before writing again.
    await new Promise((r) => setTimeout(r, 1500));
  }
  bridge.stopWarm();
  stopRunningClaude("SIGKILL");
  rmSync(stateDir, { recursive: true, force: true });
  return times;
}

const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length));
const show = (name: string, xs: number[]) =>
  console.log(`${name.padEnd(46)} first ${String(xs[0]).padStart(5)} ms · then mean ${String(mean(xs.slice(1))).padStart(5)} ms · all ${xs.join(", ")}`);

console.log(`${real ? "real claude" : "stub claude"}${withTools ? ", Pako's typed tools on (one read_calendar planned per question)" : ""}, ${count} messages each\n`);
show("before: a new claude process per message", await round(0, false));
show("after: the conversation's process kept up", await round(10 * 60_000, false));
show("after, with the process started at launch", await round(10 * 60_000, true));
