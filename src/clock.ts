// Waits measured on the wall clock (a backoff, Retry-After, a retry): the computer's clock can be put back while one runs (it was wrong and
// is corrected), and a wait kept as "until this time" would then grow by the jump. Each one is held to the length it was set for.

/** What is left of a wait set to end at `until` and to last `ms`: 0 once over, or when more than `ms` is left (the clock went back). */
export function waitLeft(until: number, ms: number, now: number): number {
  const left = until - now;
  return left > 0 && left <= ms ? left : 0;
}
