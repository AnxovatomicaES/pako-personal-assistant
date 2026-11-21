// Waiting in tests for something that happens in the background (a restart asked for, a message said): poll for it with a deadline, never
// a fixed sleep a loaded CI machine can overrun. `then`: a short look after, so "exactly one" still catches a second one.
export async function eventually(ok: () => boolean, o: { ms?: number; then?: number } = {}): Promise<void> {
  const end = Date.now() + (o.ms ?? 10_000);
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
  if (o.then) await new Promise((r) => setTimeout(r, o.then));
}
