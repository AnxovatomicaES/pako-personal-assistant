// Wires the core every other part leans on: the watchdog, the store (watched by the store guard), the kill switch and action log,
// the durable jobs' clock, and /admin/log.

import { fileURLToPath } from "node:url";
import { type Control, createControl } from "../control.ts";
import { createJobs } from "../jobs.ts";
import { loadKv } from "../kv.ts";
import { createLog } from "../log.ts";
import { watchStore } from "../store-guard.ts";
import { type ClaudeState, createWatchdog, loadWatchdogConfig, readServerVersion, reportingKv, type Version } from "../watchdog.ts";
import type { AfterGuards } from "./context.ts";

const logWatchdog = createLog("watchdog");

export function wireCore(ctx: AfterGuards) {
  const { env, local, app, uiLang, ownerZone, waHealth, waComputer, adminLimiter, adminOnly } = ctx;
  // The watchdog (src/watchdog.ts): each part says how its rounds go, and the owner hears once when one stays broken. Built first, as the
  // store reports to it; what it needs from the door (the chat to tell, the computer's last request) is looked up once that exists.
  const dogCfg = loadWatchdogConfig(env);
  if (dogCfg.problems.length) logWatchdog.error(`${dogCfg.problems.join("; ")}`);
  const dogRef: {
    tell: ((text: string) => Promise<unknown>) | null;
    lastPoll: (() => number) | null;
  } = { tell: null, lastPoll: null };
  // This server's version, read once when first asked (git, or Render's RENDER_GIT_COMMIT): only a server compares it with its computer's.
  let ownVersion: Version | null | undefined;
  const rawKv = local ? local.kv : loadKv(env.VOICE_RESULTS_URL);
  const dog = createWatchdog({
    config: dogCfg.config,
    local: !!local,
    timeZone: ownerZone,
    lang: uiLang,
    kv: rawKv,
    notify: () => dogRef.tell,
    ...(local
      ? {
          claude: (): ClaudeState | null => {
            const s = local.bridge.status();
            // Signed in but not running for a quarter of an hour: the bridge keeps stopping (src/local.ts restarts it).
            return s.claude === "starting" ? null : s.claude === "ok" && !s.running ? "stopped" : s.claude;
          },
        }
      : {
          lastPoll: () => (dogRef.lastPoll ? dogRef.lastPoll() : null),
          serverVersion: () => (ownVersion === undefined ? (ownVersion = readServerVersion(env, fileURLToPath(new URL("..", import.meta.url)))) : ownVersion),
        }),
  });
  // On a computer only: a server's WhatsApp part comes from its sends (src/whatsapp.ts health), a computer's from registering its webhook.
  if (waComputer) waHealth.report = dog.reporter("whatsapp");
  if (rawKv) dog.watch("store");
  local?.kv.onSave?.(dog.reporter("store"));
  // The kill switch and the action log, shared by the phone line, WhatsApp and the mail (src/control.ts). The store notes which of the keys
  // the store guard looks at this process writes itself, so the guard (below) never takes them for an older Pako's. A server's store says
  // how each write went (a computer's file store says it on each save, above).
  const store = watchStore(local ? local.kv : rawKv ? reportingKv(rawKv, dog.reporter("store")) : null);
  const kv = store.kv;
  const control: Control = createControl(kv);
  // The durable jobs (src/jobs.ts): the one clock for the brief, reminders, routines and follow-up checks, kept in the store. A computer
  // sleeps, so its late runs follow each kind's rule; a server is always on and behaves as before.
  const jobs = createJobs({ kv, sleeps: !!local });
  // The owner's chat for the store guard's notice, the line it leaves in the assistant's context, and what else this server keeps in the
  // store: set once the door is built.
  app.get("/admin/log", adminLimiter, async (req, res) => {
    if (!adminOnly(req, res)) return;
    res.json({ paused: await control.paused(), log: await control.recent(300) });
  });
  return { dogRef, dog, store, kv, control, jobs };
}
