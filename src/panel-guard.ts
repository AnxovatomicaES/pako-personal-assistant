// The panel's API guard, one for every route the owner's browser calls (before this, 26 hand-written copies that agreed on what matters
// but had drifted on order and headers: an independent audit). In this order, for every route:
//   1. the answer's headers: never cached, never sniffed, never read by another site;
//   2. signed in (the panel's session), and for a change the x-pako header a cross-site form cannot send (with the strict cookie: like STOP);
//   3. only then whether the feature is on (404 "off"), so a stranger learns nothing of what is switched on;
//   4. and whether a change can be made here at all (404 "read only here", a server's panel).
// And the one constant-time comparison of two secrets, whatever their lengths.

import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";

export const API_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
} as const;

export interface GuardOptions {
  /** The feature is off now (or not built): its routes answer 404 "off", after the sign-in check. */
  off?: () => boolean;
  /** Changes are refused here (a server's read-only panel): 404 "read only here". */
  readOnly?: () => boolean;
}

/** guard(false) for a read, guard(true) for a change. */
export function panelGuard(signedIn: (req: Request) => boolean, o: GuardOptions = {}): (change: boolean) => RequestHandler {
  return (change) => (req, res, next) => {
    res.set(API_HEADERS);
    if (!signedIn(req) || (change && req.get("x-pako") !== "1")) return void res.status(401).json({ error: "sign in" });
    if (o.off?.()) return void res.status(404).json({ error: "off" });
    if (change && o.readOnly?.()) return void res.status(404).json({ error: "read only here" });
    next();
  };
}

/** Two secrets compared in constant time, whatever their lengths (each is hashed first: nothing of either length leaks). */
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}
