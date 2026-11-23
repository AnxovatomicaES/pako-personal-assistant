// Every run of Claude goes through here: counted by kind, held back by the budget, and how Claude is doing reported to the server.

import { isOwnerRun, LIGHT, resetAt, usageLine, WRITING, type RunKind, type Usage } from "../budget.ts";
import { ClaudeError, modelUnavailable, type ClaudeResult, type RunConfig } from "./claude.ts";
import { overloaded } from "./claude-errors.ts";
import { cliModelsPath, createCliModels, neededVersion } from "./cli-models.ts";
import { compareVersions, type CliCompat } from "./cli-version.ts";
import type { ClaudeHealth } from "./core.ts";
import { limitText, limitWait } from "./limits.ts";
import type { AfterCore } from "./parts.ts";
import { T } from "./texts.ts";

/** Claude overloaded for this long (and no message of the owner's waiting on it) before the owner is told: most overloads pass sooner. */
const BUSY_TELL_MS = 10 * 60_000;

export function mountRuns(b: AfterCore) {
  const { config, log, budget, warm, runOnce, api, say, retryAt } = b;
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
  // Claude Code this is and how it did in the self-test (cli-probe.ts): the Health card says it. An older server reads only what
  // it knows of the body (the version), and one that takes no `cli` alone answers 400: not asked again until either changes.
  let version: { sha: string; committedAt: number; updatedAt?: number; autoupdate: string } | null = null;
  let cli: CliCompat | null = null;
  // The models this Claude Code is too old to run (cli-models.ts), kept for its version: they go on the Health card with it.
  const cliModels = createCliModels({ file: cliModelsPath(config.stateDir), log });
  /** Which Claude Code this is as the Health card shows it: with what it is too old to run, when it refused a model ("behind"). */
  const cliShown = (): CliCompat | null => {
    const gap = cliModels.gap();
    if (!gap) return cli;
    const needs = neededVersion(gap, compareVersions);
    const which = cli?.version || gap.version;
    const note = `Claude Code ${which || "(version unknown)"} is older than ${Object.keys(gap.models).join(" and ")} needs`
      + `${needs ? ` (${needs} or newer)` : ""}: Pako writes with another model meanwhile. To fix: run claude update, or update the Claude desktop app`;
    // A failed self-test keeps its own status and sentence first: both are said.
    if (cli?.status === "failed") return { ...cli, note: `${cli.note ?? ""} ${note}`.trim() };
    return { version: which, status: "behind", note };
  };
  let versionSent = "";
  const versionKey = (): string => {
    const c = cliShown();
    return (version ? `${version.sha}|${version.updatedAt ?? 0}|${version.autoupdate}` : "") + (c ? `|${c.version}|${c.status}|${c.note ?? ""}` : "");
  };
  const reportVersion = async (): Promise<void> => {
    const key = versionKey();
    const shown = cliShown();
    if ((!version && !shown) || versionSent === key) return;
    const body = { ...(version ? { version } : {}), ...(shown ? { cli: shown } : {}) };
    try {
      const r = await api("/assistant/health", { method: "POST", body, timeoutMs: 5000 });
      // An older server, or one that takes no reports from here: not asked again until the version changes.
      if (r.ok || r.status === 404 || r.status === 403 || r.status === 400) versionSent = key;
      else log(`version report refused: ${r.status} (sent again on the next round)`);
    } catch (err) {
      log(`version report failed: ${(err as Error).message} (sent again on the next round)`);
    }
  };
  // The day's numbers (assistant/budget.ts) go to the server with the health reports, for the panel's Health card, and to the log now and then.
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
  // Claude's limit, told once: the first run that finds it (the owner's or a background one) says what is paused, what keeps working and when
  // what waits is done; the first run that works again says "back" and lets the held items go at once. Whether it was told is kept by the
  // budget (budget.json), so a restart neither says it again nor forgets the "back". The items held meanwhile stay in the server's inbox,
  // unacknowledged: nothing is dropped, and each is tried again after a wait that grows (limitWait), never later than the named reset.
  /** Items held for the limit, by id: how many times each met it. */
  const held = new Map<string, number>();
  /** Since when Claude has been overloaded (not this plan's limit); 0 when it is not. */
  let busySince = 0;
  /** An item that met Claude's limit (or whose run the pause held back) waits: until `until` when given, else the growing wait. */
  const hold = (id: string, until?: number): void => {
    const tries = (held.get(id) ?? 0) + 1;
    held.set(id, tries);
    const now = Date.now();
    retryAt.set(id, until && until > now ? until : now + limitWait(tries, budget.usage().pausedUntil, now));
  };
  const tellLimit = async (kind: RunKind, err: ClaudeError): Promise<void> => {
    if (budget.limitTold()) return;
    const now = Date.now();
    const busy = overloaded(err);
    if (busy) {
      busySince ||= now;
      // An overload that may pass in a minute is said only when the owner waits on it, or once it has lasted.
      if (!isOwnerRun(kind) && now - busySince < BUSY_TELL_MS) return;
    }
    const named = err.resetsAt && err.resetsAt > now ? err.resetsAt : resetAt(err.message, now);
    if (await say({ text: limitText({ resetsAt: named, busy, now }), notice: true })) {
      budget.markLimitTold();
      log(`told the owner Claude is ${busy ? "overloaded" : "at its limit"}${named ? ` (resets ${new Date(named).toISOString()})` : ""}`);
    }
  };
  /** The "back" note on its way: two runs that end together say it once. */
  let backing = false;
  const tellBack = async (): Promise<void> => {
    busySince = 0;
    const told = budget.working();
    // The held items go on the next round, in their order, instead of waiting out their backoff.
    for (const id of held.keys()) retryAt.delete(id);
    held.clear();
    if (!told || backing) return;
    // The limit's notice promised it: the told mark is let go only once the note went, and a note not taken is said by the next run that works.
    backing = true;
    try {
      if (await say({ text: T()("back"), notice: true })) {
        budget.backTold();
        log("told the owner Claude answers again");
      }
    } finally {
      backing = false;
    }
  };
  /** The refused models whose skip was logged by this process: once each, not for every message. */
  const skipSaid = new Set<string>();
  /** A model this Claude Code is too old for, told once for its version (kept across restarts, cli-models.ts): what runs instead, and the fix. */
  const tellCliModel = async (model: string, using: string, err: ClaudeError): Promise<void> => {
    if (cliModels.told()) return;
    const t = T();
    const text = t("cliModel", {
      using: using || t("cliModelDefault"), model, version: err.cliVersion || cli?.version || t("cliModelYours"),
      needs: err.needsCli ? t("cliModelNeeds", { version: err.needsCli }) : "",
    });
    if (await say({ text, notice: true })) {
      cliModels.markTold();
      log(`told the owner Claude Code is too old for ${model}`);
    }
  };
  /**
   * Every run of Claude (an answer, an email, a meeting, a Slack search) says whether Claude is signed in and within its limit, and is counted
   * by kind. The owner's turns of their conversation go to the process kept up for it (createWarmClaude), the rest to a run of their own.
   * The writing kinds (the brief, a draft) run on the writing model; when the account cannot use it (not in the plan, not there, its own
   * limit), the same run goes again on the general model at once, and the writing model is set aside for the rest of the day, said once.
   * A model this Claude Code is too old to run (a 400 that names the version needed) goes the same way, to the general model and then to
   * Claude Code's own default (no --model): each model is tried once, and one refused so is skipped until Claude Code changes version.
   */
  const run = async (kind: RunKind, prompt: string, c: RunConfig, sessionId?: string): Promise<ClaudeResult> => {
    const giveBack = budget.started(kind);
    const once = (rc: RunConfig): Promise<ClaudeResult> =>
      // config.warmMs at 0 (the self-test found this Claude Code's stream-json broken, cli-probe.ts): every message on a run of its own.
      warm && config.warmMs !== 0 && (kind === "message" || kind === "routine") ? warm.run(prompt, rc, sessionId) : runOnce(prompt, rc, sessionId);
    try {
      const strong = writingModel(kind, c.model);
      // The models to try, in order, each once: the writing model, the general one, Claude Code's default ("": no --model). One this Claude
      // Code refused as too new is left out. Only that refusal, or the account's for the writing model, moves on to the next: any other
      // failure is the run's. The default ("") is never refused so, and is always last.
      const ladder = [...new Set([...(strong ? [strong] : []), c.model ?? "", ""])].filter((m) => !cliModels.refused(m));
      const configured = strong ?? c.model ?? "";
      if (configured && cliModels.refused(configured) && !skipSaid.has(configured)) {
        skipSaid.add(configured);
        log(`${kind}: this Claude Code is too old for ${configured}: ${ladder[0] || "the default model"} runs instead (said once)`);
      }
      let result: ClaudeResult | null = null;
      let model = ladder[0] ?? "";
      for (let i = 0; i < ladder.length && !result; i++) {
        const m = ladder[i]!;
        try {
          result = await once({ ...c, model: m });
          model = m;
        } catch (err) {
          if (!(err instanceof ClaudeError) || i === ladder.length - 1) throw err;
          if (err.kind === "model-needs-newer-cli" && m) {
            if (cliModels.refuse(m, err.needsCli, err.cliVersion || cli?.version)) {
              log(`${kind}: Claude Code ${err.cliVersion ?? cli?.version ?? ""} is too old for ${m} (needs ${err.needsCli ?? "a newer one"}): `
                + `${ladder[i + 1] || "the default model"} runs instead until Claude Code is updated`);
            }
            await tellCliModel(m, ladder[i + 1] ?? "", err);
            continue;
          }
          if (m !== strong || !modelUnavailable(err.message, strong, err)) throw err;
          if (budget.modelOff(strong)) {
            log(`${kind}: ${strong} is not available to this account (${err.message.slice(0, 120)}): ${c.model || "the default model"} runs instead until tomorrow`);
          }
        }
      }
      if (!result) throw new ClaudeError("no model left to try", "other");
      health = "ok";
      loginFails = 0;
      await tellBack();
      budget.answeredBy(model);
      return strong || model !== (c.model ?? "") ? { ...result, model } : result;
    } catch (err) {
      // A missing command is not reported as the health: the server finds that itself (src/local.ts, BridgeStatus "missing").
      if (err instanceof ClaudeError && (err.kind === "login" || err.kind === "limit")) health = err.kind;
      // A run that never reached Claude (signed out, the command not there) is not one of the day's: a lost login tried again every few minutes
      // would spend the whole background cap on nothing, and the mail or meeting that waited would then be kept without Claude for good.
      if (err instanceof ClaudeError && (err.kind === "login" || err.kind === "missing")) giveBack();
      // Any run that finds the limit (the owner's too) stops the background work until it resets, and the owner hears it once.
      if (err instanceof ClaudeError && err.kind === "limit") {
        budget.limited(err.message, err.resetsAt);
        await tellLimit(kind, err);
        void reportUsage(true);
      }
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
   * none (over the day's cap, or Claude's limit; either ends at `until`): the caller then answers without Claude, or waits for `until`. A
   * rehearsal's or a page's document is the owner's own (isOwnerRun) and always runs. The short verdicts get the lighter effort when this
   * Claude Code takes one.
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
  const versionDue = (): boolean => (!!version || !!cliShown()) && versionSent !== versionKey();
  /** What this computer runs (assistant/update.ts), told to the server on the next round. */
  const setVersion = (v: { sha: string; committedAt: number; updatedAt?: number; autoupdate: string }): void => {
    version = v;
  };
  /** Which Claude Code this is and how it did in the self-test (cli-probe.ts), told to the server with the version. */
  const setCli = (c: CliCompat): void => {
    cli = c;
    // A new version of Claude Code: the models the last one was too old for are tried again.
    cliModels.setVersion(c.version);
  };
  return { reportHealth, reportVersion, reportUsage, run, background, rehearsal, loginWait, healthDue, versionDue, setVersion, setCli, hold };
}

export type Runs = ReturnType<typeof mountRuns>;
