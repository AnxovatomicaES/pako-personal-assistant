// A test that checks what Pako does with "this computer's own time zone" says which zone that is, here, instead of leaning on the TZ the
// suite happens to run under (the gate runs it under Madrid, Los Angeles and Kolkata: docs/testing.md). Node reads process.env.TZ again
// whenever it is set, so the zone holds for the code called inside `fn`, and the one before it is put back after.

/** Runs `fn` with this process's own time zone set to `zone`, then puts the previous one back (also when `fn` throws or rejects). */
export function withSystemZone<T>(zone: string, fn: () => T): T {
  const before = process.env.TZ;
  const restore = (): void => {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  };
  process.env.TZ = zone;
  let out: T;
  try {
    out = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (out instanceof Promise) return out.finally(restore) as T;
  restore();
  return out;
}
