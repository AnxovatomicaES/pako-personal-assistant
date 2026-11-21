// The items the bridge has answered but the server has not yet confirmed (their ack), kept on disk as well as in memory. Without it, a
// restart between an answer (an email's or a meeting's notice already sent to the owner) and its ack ran Claude again on that item and told
// the owner twice. An id is kept two days at most: the server drops an item it never got an ack for well before that.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const KEEP_MS = 2 * 24 * 3600_000;

export const HANDLED_FILE = "handled-unacked.json";

/** A Set of item ids that writes itself to `path` on every change (0600, through a temporary file). */
export class HandledIds extends Set<string> {
  private readonly at = new Map<string, number>();
  private ready = false;
  private readonly path: string;
  private readonly log: (s: string) => void;
  private readonly now: () => number;

  constructor(path: string, log: (s: string) => void = () => {}, now: () => number = Date.now) {
    super();
    this.path = path;
    this.log = log;
    this.now = now;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [id, t] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof t === "number" && this.now() - t < KEEP_MS && id.length <= 200) {
            super.add(id);
            this.at.set(id, t);
          }
        }
      }
    } catch {
      /* no file yet, or unreadable: nothing answered and unconfirmed is known, as before this file existed */
    }
    this.ready = true;
  }

  override add(id: string): this {
    super.add(id);
    if (this.ready) {
      this.at.set(id, this.now());
      this.save();
    }
    return this;
  }

  override delete(id: string): boolean {
    const had = super.delete(id);
    this.at.delete(id);
    if (had && this.ready) this.save();
    return had;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(`${this.path}.tmp`, JSON.stringify(Object.fromEntries(this.at)), { mode: 0o600 });
      renameSync(`${this.path}.tmp`, this.path);
    } catch (err) {
      this.log(`could not keep the answered items: ${(err as Error).message}`);
    }
  }
}
