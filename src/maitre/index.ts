// Maître, switched on where it can run: on the owner's computer, with a Chromium browser installed. A server (Render) has none, and its
// bookings keep today's routes. Its browser profile and screenshots live in <PAKO_HOME>, never in the owner's own browser profile.

import { join } from "node:path";
import type { Kv } from "../kv.ts";
import { BrowserPool, findBrowser } from "./cdp.ts";
import type { HandoffEnd } from "./handoff.ts";
import type { MailLine } from "./ledger.ts";
import { createMaitre, type Maitre } from "./planner.ts";

export interface MaitreSetup {
  maitre: Maitre | null;
  /** Why it is off, for the start log; empty when on. */
  why: string;
  /** PAKO_BOOKING_CONFIRM=1: a card even for the owner's own order. */
  confirmFirst: boolean;
}

export function loadMaitre(
  env: NodeJS.ProcessEnv,
  o: { local: boolean; home: string; kv: Kv | null; recentMail?: () => Promise<MailLine[]>; onHandoffEnd?: (end: HandoffEnd) => void | Promise<void> },
): MaitreSetup {
  const confirmFirst = /^(1|on|true|yes)$/i.test((env.PAKO_BOOKING_CONFIRM ?? "").trim());
  if (/^(0|off|false|no)$/i.test((env.PAKO_MAITRE ?? "").trim())) return { maitre: null, why: "PAKO_MAITRE=off", confirmFirst };
  if (!o.local) return { maitre: null, why: "not on a computer", confirmFirst };
  const exe = findBrowser(env);
  if (!exe) return { maitre: null, why: "no Chrome, Edge, Brave or Chromium found (PAKO_CHROME names one)", confirmFirst };
  const idle = Number(env.PAKO_BROWSER_IDLE_MIN ?? "");
  const pool = new BrowserPool({ executable: exe, profileDir: join(o.home, "browser"), idleMs: (Number.isFinite(idle) && idle >= 1 && idle <= 120 ? idle : 10) * 60_000 });
  const maitre = createMaitre({
    kv: o.kv,
    pool,
    dir: join(o.home, "maitre"),
    ...(o.recentMail ? { recentMail: o.recentMail } : {}),
    ...(o.onHandoffEnd ? { onHandoffEnd: o.onHandoffEnd } : {}),
  });
  return { maitre, why: "", confirmFirst };
}
