// The models this Claude Code is too old to run, remembered for its version (cli-models.json in the state folder).
//
// An older Claude Code refuses a newer model with a 400 that names the version it needs (claude-errors.ts, modelNeedsNewerCli). The run
// that met it goes again at once on another model (runs.ts); the model is noted here, so the runs after it go straight to the other model
// instead of being refused first; and the owner is told once for this version, also after a restart. A new version of Claude Code
// (cli-probe.ts notices it, runs.ts setCli) forgets all of it: the models are tried again, and told again if still refused.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What is kept: the Claude Code version it holds for, each refused model with the version it needs ("" when unnamed), and whether told. */
export interface CliModelGap {
  version: string;
  models: Record<string, string>;
  told: boolean;
}

/** The file it is kept in. */
export const cliModelsPath = (stateDir: string): string => join(stateDir, "cli-models.json");

const empty = (version = ""): CliModelGap => ({ version, models: {}, told: false });

function load(file: string | null): CliModelGap {
  if (!file) return empty();
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as Partial<CliModelGap>;
    const models: Record<string, string> = {};
    for (const [m, n] of Object.entries(v.models && typeof v.models === "object" ? v.models : {})) {
      if (/^[A-Za-z0-9-]{1,80}$/.test(m)) models[m] = typeof n === "string" && /^\d+\.\d+\.\d+$/.test(n) ? n : "";
    }
    return { version: typeof v.version === "string" ? v.version : "", models, told: v.told === true };
  } catch {
    return empty(); // no file yet, or a broken one: a refused model is met again once, and noted anew
  }
}

/** `file`: where it is kept; null keeps it in memory only (the tests, a bridge with no state folder). */
export function createCliModels(o: { file: string | null; log?: (line: string) => void }) {
  const log = o.log ?? (() => undefined);
  let gap = load(o.file);
  const save = (): void => {
    if (!o.file) return;
    try {
      mkdirSync(dirname(o.file), { recursive: true, mode: 0o700 });
      writeFileSync(`${o.file}.tmp`, JSON.stringify(gap, null, 2), { mode: 0o600 });
      renameSync(`${o.file}.tmp`, o.file);
    } catch (err) {
      log(`could not keep the models this Claude Code refused: ${(err as Error).message} (met again after a restart)`);
    }
  };
  /** Forgets what was kept for another version. An unknown version ("") changes nothing. */
  const setVersion = (version: string): void => {
    if (!version || version === gap.version) return;
    const had = Object.keys(gap.models);
    if (had.length) log(`Claude Code is now ${version} (was ${gap.version || "unknown"}): trying ${had.join(", ")} again`);
    gap = empty(version);
    save();
  };
  return {
    setVersion,
    /** Whether this Claude Code refused `model` as too new for it. */
    refused: (model: string): boolean => !!model && Object.hasOwn(gap.models, model),
    /** Notes a refusal. `version`: the Claude Code that refused, when known. True the first time for this model and version. */
    refuse(model: string, needs: string | undefined, version: string | undefined): boolean {
      if (version) setVersion(version);
      if (!model || Object.hasOwn(gap.models, model)) return false;
      gap.models[model] = needs ?? "";
      save();
      return true;
    },
    /** Whether the owner was told for this version. */
    told: (): boolean => gap.told,
    markTold(): void {
      gap.told = true;
      save();
    },
    /** What is kept now: null when no model is refused. */
    gap: (): CliModelGap | null => (Object.keys(gap.models).length ? { ...gap, models: { ...gap.models } } : null),
  };
}

export type CliModels = ReturnType<typeof createCliModels>;

/** The newest version any refused model needs, "" when none was named. */
export function neededVersion(g: CliModelGap, compare: (a: string, b: string) => number): string {
  return Object.values(g.models).filter(Boolean).sort(compare).at(-1) ?? "";
}
