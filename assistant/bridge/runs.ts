// Every run of Claude goes through here: counted by kind, held back by the budget, and how Claude is doing reported to the server.

import { LIGHT, usageLine, type RunKind, type Usage } from "../budget.ts";
import { ClaudeError, type ClaudeResult, type RunConfig } from "./claude.ts";
import type { ClaudeHealth } from "./core.ts";
import type { AfterCore } from "./parts.ts";

export function mountRuns(b: AfterCore) {
  const { config, log, budget, warm, runOnce, api } = b;
  /** Lost logins in a row: tried again soon at first (the person is signing in), then no more often than every two minutes. */
  let loginFails = 0;
  // How Claude is doing, as its last run found it, and what the server last took: on a computer (local mode) the chat's banner then says what
  // to do ("sign in", "wait for the limit") instead of a message that waits with no word. Sent when it changes, and again on the next round
  // until the server has it. A server that takes no such report (a hosted one, an older one, or one that takes it from its own computer only)
  // is not asked again until the state changes.
  let health: ClaudeHealth | null = null;
  let reported: ClaudeHealth | null = null;
  let reporting: Promise<void> | null = null;
  let noRoute = false;
  const reportHealth = (): Promise<void> => {
    reporting ??= (async () => {
      try {
        while (health && health !== reported) {
          const now = health;
          const r = await api("/assistant/health", { method: "POST", body: { claude: now }, timeoutMs: 5000 });
          if (r.status === 404 || r.status === 403) {
            if (!noRoute) log("the server takes no health reports from here: a lost login reaches the owner as a message only");
            noRoute = true;
          } else if (!r.ok) {
            log(`health refused: ${r.status} (sent again on the next round)`);
            return;
          }
          reported = now;
        }
      } catch (err) {
        log(`health failed: ${(err as Error).message} (sent again on the next round)`);
      } finally {
        reporting = null;
      }
    })();
    return reporting;
  };
  // The version this computer runs and whether it updates itself (assistant/update.ts), said once at the start and again when it changes:
  // the server's watchdog (src/watchdog.ts) shows it, and warns the owner when this computer stays more than a day behind.
  let version: { sha: string; committedAt: number; updatedAt?: number; autoupdate: string } | null = null;
  let versionSent = "";
  const versionKey = (v: NonNullable<typeof version>): string => `${v.sha}|${v.updatedAt ?? 0}|${v.autoupdate}`;
  const reportVersion = async (): Promise<void> => {
    if (!version || versionSent === versionKey(version)) return;
    const v = version;
    try {
      const r = await api("/assistant/health", { method: "POST", body: { version: v }, timeoutMs: 5000 });
      // An older server, or one that takes no reports from here: not asked again until the version changes.
      if (r.ok || r.status === 404 || r.status === 403 || r.status === 400) versionSent = versionKey(v);
      else log(`version report refused: ${r.status} (sent again on the next round)`);
    } catch (err) {
      log(`version report failed: ${(err as Error).message} (sent again on the next round)`);
    }
  };
  // The day's numbers (assistant/budget.ts) go to the server with the health reports, for the panel's Salud card, and to the log now and then.
  // A server that does not take them (an older one answers 400) is not sent them again until this process starts again.
  let usageSent = "";
  let usageSentAt = 0;
  let usageRefused = false;
  let usageLoggedAt = 0;
  const usageKey = (u: Usage): string => JSON.stringify([u.day, u.interactive, u.background, u.skipped, u.pausedUntil]);
  const reportUsage = async (force = false): Promise<void> => {
    const u = budget.usage();
    if (Date.now() - usageLoggedAt >= 10 * 60_000 && usageKey(u) !== usageSent) {
      usageLoggedAt = Date.now();
      log(usageLine(u));
    }
    if (usageRefused || usageKey(u) === usageSent || (!force && Date.now() - usageSentAt < 60_000)) return;
    usageSentAt = Date.now();
    try {
      const r = await api("/assistant/health", { method: "POST", body: { usage: u }, timeoutMs: 5000 });
      if (r.ok) usageSent = usageKey(u);
      else if (r.status === 400 || r.status === 404 || r.status === 403) usageRefused = true;
    } catch {
      /* sent again on a later round */
    }
  };
  /**
   * Every run of Claude (an answer, an email, a meeting, a Slack search) says whether Claude is signed in and within its limit, and is counted
   * by kind. The owner's turns of their conversation go to the process kept up for it (createWarmClaude), the rest to a run of their own.
   */
  const run = async (kind: RunKind, prompt: string, c: RunConfig, sessionId?: string): Promise<ClaudeResult> => {
    budget.started(kind);
    try {
      const result = await (warm && (kind === "message" || kind === "routine") ? warm.run(prompt, c, sessionId) : runOnce(prompt, c, sessionId));
      health = "ok";
      loginFails = 0;
      budget.working();
      return result;
    } catch (err) {
      if (err instanceof ClaudeError && err.kind !== "other") health = err.kind;
      // Any run that finds the limit (the owner's too) stops the background work until it resets.
      if (err instanceof ClaudeError && err.kind === "limit") budget.limited(err.message);
      throw err;
    } finally {
      if (health !== reported) await reportHealth();
    }
  };
  /**
   * A background job's run, when the budget lets it: its answer, the same answer as a job with the same material a moment ago, or why there is
   * none (over the day's cap, or Claude's limit until `until`): the caller then answers without Claude. A rehearsal's or a page's document is
   * the owner's own (isOwnerRun) and always runs. The short verdicts get the lighter effort when this Claude Code takes one.
   */
  const background = async (
    kind: RunKind, material: string, prompt: string, c: RunConfig,
  ): Promise<{ text: string; costUsd: number; reused?: true } | { skipped: "cap" | "paused"; until: number }> => {
    const a = budget.admit(kind, material);
    if (!a.go) {
      void reportUsage();
      if (a.why === "same") {
        log(`${kind}: same material as a moment ago, its answer given again without a run`);
        return { text: a.text, costUsd: 0, reused: true };
      }
      return { skipped: a.why, until: a.until };
    }
    const light = LIGHT.has(kind) && config.effortOk && config.backgroundEffort;
    const result = await run(kind, prompt, light ? { ...c, effort: config.backgroundEffort } : c);
    budget.answered(kind, a.key, result.text);
    void reportUsage();
    return { text: result.text, costUsd: result.costUsd };
  };
  /** A rehearsal's job (src/rehearsal.ts, ids rh: and rb:) is the owner's own request: counted apart, never held back by the budget. */
  const rehearsal = (id: string): boolean => /^r[hb]:/.test(id);

  // On this computer a lost login is tried again every 20 s, so the answer comes soon after the person signs in; after about ten minutes
  // of that (thirty tries) they have gone, and each try starts the claude program: every two minutes, as on a server.
  const loginWait = (): number => (loginFails++ < 30 ? (config.loginRetryMs ?? 2 * 60_000) : Math.max(config.loginRetryMs ?? 0, 2 * 60_000));
  /** Whether how Claude is doing changed since the server last took it: tick reports it then. */
  const healthDue = (): boolean => health !== reported;
  /** Whether the version this computer runs is still to be told: tick reports it then. */
  const versionDue = (): boolean => !!version && versionSent !== versionKey(version);
  /** What this computer runs (assistant/update.ts), told to the server on the next round. */
  const setVersion = (v: { sha: string; committedAt: number; updatedAt?: number; autoupdate: string }): void => {
    version = v;
  };
  return { reportHealth, reportVersion, reportUsage, run, background, rehearsal, loginWait, healthDue, versionDue, setVersion };
}

export type Runs = ReturnType<typeof mountRuns>;
