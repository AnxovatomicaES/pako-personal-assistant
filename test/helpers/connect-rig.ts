// A bare express app on a free port for the connection helpers' routes (src/connect-routes.ts and the modules using it), and a store in memory.
// "Signed in" is a cookie named ok, as the panel's real check is a cookie; the Mac app's token is APP_TOKEN. Nothing here reaches the network.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import type { Kv } from "../../src/kv.ts";

export const APP_TOKEN = "t".repeat(43);
export const PANEL = { cookie: "ok=1", "x-pako": "1" };
export const APP = { authorization: `Bearer ${APP_TOKEN}` };
export const auth = { signedIn: (req: express.Request) => req.get("cookie") === "ok=1", appToken: APP_TOKEN };

export function memoryKv(): Kv & { data: Map<string, string>; ttl: Map<string, number> } {
  const data = new Map<string, string>();
  const ttl = new Map<string, number>();
  return {
    data,
    ttl,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v, t) => {
      data.set(k, v);
      ttl.set(k, t);
    },
  };
}

export async function serve(mount: (app: Express) => void) {
  const app = express();
  mount(app);
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = PANEL) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: r.status, body: json as Record<string, any> };
  };
  return {
    base,
    get: (path: string, headers: Record<string, string> = { cookie: "ok=1" }) => call("GET", path, undefined, headers),
    post: (path: string, body: unknown, headers: Record<string, string> = PANEL) => call("POST", path, body, headers),
    del: (path: string, headers: Record<string, string> = PANEL) => call("DELETE", path, undefined, headers),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
