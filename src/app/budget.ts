// The day's shared nudge cap: every part that speaks to the owner on its own counts what it sent today, and each one checks the others'
// total before it speaks. One list, so a new part is counted by all the others at once (before this, each part summed the others by hand).
// The check and the count are one turn (`take`): the jobs' clock runs the parts side by side, and two that each read the others before
// either had counted its own would both send the last place of the day.

// Not in it, by design: the morning brief and the evening wrap-up (src/shutdown.ts), one scheduled summary each a day with its own setting
// and switch; and an owner's own reminders and check-ins they asked for at a time.

/** The parts that spend the day's cap. */
export type Spender = "followups" | "life" | "checkins" | "time" | "alerts" | "after";

/**
 * The day's cap for one part: the standard one (FOLLOWUP_MAX_PER_DAY), or gentle mode's when that is lower. Gentle mode only ever says less,
 * so a gentle number above the standard one changes nothing. `gentle`: null (or absent) when gentle mode is off.
 */
export const cap = (standard: number, gentle?: number | null): number => (typeof gentle === "number" ? Math.min(standard, gentle) : standard);

/**
 * One part's turn at the cap (createBudget().take with the part bound): `fn` is given the room left for the part's own count (the cap
 * less what the others sent), and must count what it sends before it returns: the next part's turn reads that count.
 */
export type Take = <R>(cap: number, fn: (room: number) => Promise<R>) => Promise<R>;

/**
 * A part's turn: its `take` when the budget gave it one, else (a part on its own, the tests) the same without waiting for the others'
 * turns. `others` that cannot say counts as none.
 */
export const takeOf = (take: Take | undefined, others: (() => Promise<number>) | undefined): Take =>
  take ?? (async (limit, fn) => fn(limit - (await (others?.() ?? Promise.resolve(0)).catch(() => 0))));

export function createBudget() {
  const parts = new Map<Spender, () => Promise<number> | number | undefined>();
  /** What every other part sent today; a part that cannot say counts as none. */
  const others = async (self: Spender): Promise<number> => {
    let n = 0;
    for (const [name, spent] of parts) {
      if (name === self) continue;
      n += await Promise.resolve().then(spent).then((x) => (typeof x === "number" && Number.isFinite(x) ? x : 0), () => 0);
    }
    return n;
  };
  /** The parts' turns, one after the other. */
  let turn: Promise<unknown> = Promise.resolve();
  return {
    /** Counts this part from now on (its "sent today", read each time). */
    add: (name: Spender, spent: () => Promise<number> | number | undefined): void => void parts.set(name, spent),
    others,
    /**
     * A part's turn to check the day's room and count what it spends, alone: the others' total is read inside it, after every earlier turn
     * has counted. `fn` gets the room left for `self`'s own count (`cap` less the others'; none when 0 or below) and counts before it returns.
     * Keep it short (a store write, never a long wait): every part waits for it.
     */
    take: <R>(self: Spender, limit: number, fn: (room: number) => Promise<R>): Promise<R> => {
      const run = turn.then(async () => fn(limit - (await others(self))));
      turn = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}
export type Budget = ReturnType<typeof createBudget>;
