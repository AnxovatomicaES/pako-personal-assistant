// What the app hands src/server.ts: the parts that start once the server listens and stop on shutdown (a typed lifecycle registry that
// replaces the `app.locals.x as { start, stop }` casts), the panel's sign-in link, and the few app.locals keys Express and the tests share.

import type { Express } from "express";
import type { Lang } from "../i18n.ts";
import type { Labs } from "../labs.ts";
import { createLog } from "../log.ts";
import type { StoreGuard } from "../store-guard.ts";
import type { Watchdog } from "../watchdog.ts";

const logServices = createLog("services");

/** A part with a life of its own: started once the server listens, stopped on shutdown. */
export interface Service {
  name: string;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

/** Anything with a start and a stop (a module's own handle), named for the registry and the log. */
export const named = (name: string, part: { start(): Promise<void> | void; stop(): Promise<void> | void }): Service => ({
  name,
  start: () => part.start(),
  stop: () => part.stop(),
});

export interface ServiceRegistry {
  /** `after`: the names that must start before this one (a name never added is ignored: that part is off). */
  add(service: Service, o?: { after?: string[] }): void;
  /** The start order: each part after the parts it names, otherwise in the order added. */
  order(): string[];
  /**
   * Starts every part in order. A start that throws stops the start there, and the error goes to the caller as it is (thrown, or the
   * promise rejected). Starts that return nothing run one after the other in the same turn; one that returns a promise is waited for.
   * Called again: the first call's promise, nothing started twice.
   */
  start(): Promise<void>;
  /**
   * Stops every part, in the reverse of the start order, each one even when another failed (each failure logged, never thrown). The
   * stops that return nothing run in the same turn. Called again: the first call's promise, nothing stopped twice.
   */
  stop(): Promise<void>;
}

const thenable = (v: unknown): v is PromiseLike<void> => !!v && typeof (v as { then?: unknown }).then === "function";

export function createServiceRegistry(o: { log?: (text: string) => void } = {}): ServiceRegistry {
  const log = o.log ?? ((text: string) => logServices.error(text));
  const parts: { service: Service; after: string[] }[] = [];
  let started: Promise<void> | null = null;
  let stopped: Promise<void> | null = null;

  const order = (): Service[] => {
    const names = new Set(parts.map((p) => p.service.name));
    const done = new Set<string>();
    const out: Service[] = [];
    while (out.length < parts.length) {
      const next = parts.find((p) => !done.has(p.service.name) && p.after.every((a) => !names.has(a) || done.has(a)));
      if (!next) {
        const left = parts.filter((p) => !done.has(p.service.name)).map((p) => p.service.name);
        throw new Error(`services: a loop in the start order (${left.join(", ")})`);
      }
      done.add(next.service.name);
      out.push(next.service);
    }
    return out;
  };

  return {
    add: (service, a = {}) => {
      if (started) throw new Error(`services: ${service.name} added after the start`);
      if (parts.some((p) => p.service.name === service.name)) throw new Error(`services: ${service.name} added twice`);
      parts.push({ service, after: a.after ?? [] });
    },
    order: () => order().map((s) => s.name),
    start: () => {
      if (started) return started;
      const list = order();
      let chain: Promise<void> | null = null;
      for (const s of list) {
        if (chain) {
          chain = chain.then(() => s.start());
          continue;
        }
        const r = s.start();
        if (thenable(r)) chain = Promise.resolve(r);
      }
      started = chain ?? Promise.resolve();
      return started;
    },
    stop: () => {
      if (stopped) return stopped;
      const waits: Promise<void>[] = [];
      const failed = (s: Service, err: unknown): void => log(`${s.name} did not stop cleanly: ${(err as Error)?.message ?? String(err)}`);
      for (const s of [...order()].reverse()) {
        try {
          const r = s.stop();
          if (thenable(r)) waits.push(Promise.resolve(r).catch((err: unknown) => failed(s, err)));
        } catch (err) {
          failed(s, err);
        }
      }
      stopped = Promise.all(waits).then(() => undefined);
      return stopped;
    },
  };
}

/** What src/server.ts needs from the app it built: typed, instead of reading app.locals. */
export interface AppServices {
  /** The parts started once the server listens (the store guard first) and stopped on shutdown. */
  lifecycle: ServiceRegistry;
  /** The panel's one-time sign-in link; null without the owner's settings, or when no address is known yet. */
  panelLink: () => string | null;
}

const services = new WeakMap<Express, AppServices>();

export const setAppServices = (app: Express, s: AppServices): void => void services.set(app, s);

/** The services of an app made by createApp (src/app.ts). */
export function appServices(app: Express): AppServices {
  const s = services.get(app);
  if (!s) throw new Error("this app was not made by createApp");
  return s;
}

// The app.locals keys still in use, typed. `restart` is set by src/server.ts and read by the panel's routes (a test sets its own); the
// others are the same handles AppServices holds, kept for the tests that reach them there. Express's Locals is shared with res.locals,
// so every key is optional.
declare global {
  namespace Express {
    interface Locals {
      /** Starts Pako again (src/server.ts); `leaving`: the demo week ends. False: it cannot. */
      restart?: (o?: { leaving?: boolean }) => boolean | void;
      panelLink?: () => string | null;
      uiLang?: () => Lang;
      labs?: Labs;
      watchdog?: Watchdog;
      storeGuard?: StoreGuard;
      telegram?: { start(): void; stop(): void };
      slackSocket?: { start(): void; stop(): void };
      whatsappComputer?: { start(): void; stop(): void };
    }
  }
}
