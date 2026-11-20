// Every run of Claude goes through here: counted by kind, held back by the budget, and how Claude is doing reported to the server.

import { LIGHT, usageLine, WRITING, type RunKind, type Usage } from "../budget.ts";
import { ClaudeError, modelUnavailable, type ClaudeResult, type RunConfig } from "./claude.ts";
import type { CliCompat } from "./cli-version.ts";
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
  // the server's watchdog (src/watchdog.ts) shows it, and warns the owner when this computer stays more than a day behind. With it, which
  // Claude Code this is against the tested range (cli-version.ts): the Salud card says when it is outside. An older server reads only what
  // it knows of the body (the version), and one that takes no `cli` alone answers 400: not asked again until either changes.
  let version: { sha: string; committedAt: number; updatedAt?: number; autoupdate: string } | null = null;
  let cli: CliCompat | null = null;
  let versionSent = "";
  const versionKey = (): string => (version ? `${version.sha}|${version.updatedAt ?? 0}|${version.autoupdate}` : "") + (cli ? `|${cli.version}|${cli.status}` : "");
  const reportVersion = async (): Promise<void> => {
    const key = versionKey();
    if ((!version && !cli) || versionSent === key) return;
    const body = { ...(version ? { version } : {}), ...(cli ? { cli } : {}) };
    try {
      const r = await api("/assistant/health", { method: "POST", body, timeoutMs: 5000 });
      // An older server, or one that takes no reports from here: not asked again until the version changes.
      if (r.ok || r.status === 404 || r.status === 403 || r.status === 400) versionSent = key;
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
   * The writing kinds (the brief, a draft) run on the writing model; when the account cannot use it (not in the plan, not there, its own
   * limit), the same run goes again on the general model at once, and the writing model is set aside for the rest of the day, said once.
   */
  const run = async (kind: RunKind, prompt: string, c: RunConfig, sessionId?: string): Promise<ClaudeResult> => {
    budget.started(kind);
    const once = (rc: RunConfig): Promise<ClaudeResult> =>
      warm && (kind === "message" || kind === "routine") ? warm.run(prompt, rc, sessionId) : runOnce(prompt, rc, sessionId);
    try {
      const strong = writingModel(kind, c.model);
      let result: ClaudeResult | null = null;
      let model = c.model;
      if (strong) {
        try {
          result = await once({ ...c, model: strong });
          model = strong;
        } catch (err) {
          if (!(err instanceof ClaudeError) || !modelUnavailable(err.message, strong, err)) throw err;
          if (budget.modelOff(strong)) {
            log(`${kind}: ${strong} is not available to this account (${err.message.slice(0, 120)}): ${c.model || "the default model"} runs instead until tomorrow`);
          }
        }
      }
      result ??= await once(c);
      health = "ok";
      loginFails = 0;
      budget.working();
      budget.answeredBy(model);
      return strong ? { ...result, model } : result;
    } catch (err) {
      // A missing command is not reported as the health: the server finds that itself (src/local.ts, BridgeStatus "missing").
      if (err instanceof ClaudeError && (err.kind === "login" || err.kind === "limit")) health = err.kind;
      // Any run that finds the limit (the owner's too) stops the background work until it resets.
      if (err instanceof ClaudeError && err.kind === "limit") budget.limited(err.message);
      throw err;
    } finally {
      if (health !== reported) await reportHealth();
    }
  };
  /** The writing model for this kind of run, when it has one that differs from the general model and was not set aside today. */
  const writingModel = (kind: RunKind, general: string): string | null => {
    const w = config.writingModel ?? "";
    return WRITING.has(kind) && w && w !== general && !budget.isModelOff(w) ? w : null;
  };
  /**
   * A background job's run, when the budget lets it: its answer, the same answer as a job with the same material a moment ago, or why there is
   * none (over the day's cap, or Claude's limit until `until`): the caller then answers without Claude. A rehearsal's or a page's document is
   * the owner's own (isOwnerRun) and always runs. The short verdicts get the lighter effort when this Claude Code takes one.
   */
  const background = async (
    kind: RunKind, material: string, prompt: string, c: RunConfig,
  ): Promise<{ text: string; costUsd: number; reused?: true; model?: string } | { skipped: "cap" | "paused"; until: number }> => {
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
    return { text: result.text, costUsd: result.costUsd, ...(result.model ? { model: result.model } : {}) };
  };
  /** A rehearsal's job (src/rehearsal.ts, ids rh: and rb:) is the owner's own request: counted apart, never held back by the budget. */
  const rehearsal = (id: string): boolean => /^r[hb]:/.test(id);

  // On this computer a lost login is tried again every 20 s, so the answer comes soon after the person signs in; after about ten minutes
  // of that (thirty tries) they have gone, and each try starts the claude program: every two minutes, as on a server.
  const loginWait = (): number => (loginFails++ < 30 ? (config.loginRetryMs ?? 2 * 60_000) : Math.max(config.loginRetryMs ?? 0, 2 * 60_000));
  /** Whether how Claude is doing changed since the server last took it: tick reports it then. */
  const healthDue = (): boolean => health !== reported;
  /** Whether the version this computer runs is still to be told: tick reports it then. */
  const versionDue = (): boolean => (!!version || !!cli) && versionSent !== versionKey();
  /** What this computer runs (assistant/update.ts), told to the server on the next round. */
  const setVersion = (v: { sha: string; committedAt: number; updatedAt?: number; autoupdate: string }): void => {
    version = v;
  };
  /** Which Claude Code this is against the tested range (cli-version.ts), told to the server with the version. */
  const setCli = (c: CliCompat): void => {
    cli = c;
  };
  return { reportHealth, reportVersion, reportUsage, run, background, rehearsal, loginWait, healthDue, versionDue, setVersion, setCli };
}

export type Runs = ReturnType<typeof mountRuns>;
