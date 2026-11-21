// The day's shared nudge cap: every part that speaks to the owner on its own counts what it sent today, and each one checks the others'
// total before it speaks. One list, so a new part is counted by all the others at once (before this, each part summed the others by hand).

// Not in it, by design: the morning brief and the evening wrap-up (src/shutdown.ts), one scheduled summary each a day with its own setting
// and switch; and an owner's own reminders and check-ins they asked for at a time.

/** The parts that spend the day's cap. */
export type Spender = "followups" | "life" | "checkins" | "time" | "alerts" | "after";

export function createBudget() {
  const parts = new Map<Spender, () => Promise<number> | number | undefined>();
  return {
    /** Counts this part from now on (its "sent today", read each time). */
    add: (name: Spender, spent: () => Promise<number> | number | undefined): void => void parts.set(name, spent),
    /** What every other part sent today; a part that cannot say counts as none. */
    others: async (self: Spender): Promise<number> => {
      let n = 0;
      for (const [name, spent] of parts) {
        if (name === self) continue;
        n += await Promise.resolve().then(spent).then((x) => (typeof x === "number" && Number.isFinite(x) ? x : 0), () => 0);
      }
      return n;
    },
  };
}
export type Budget = ReturnType<typeof createBudget>;
