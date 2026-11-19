// The connections page, /panel/settings (src/panel/settings.html, .js, .css, settings-model.js, settings-words.js): on a person's computer it
// replaces the Settings drawer. The panel's gear opens it in a new tab (a new window in the Mac app). It speaks only to this server's own
// routes (the connections, Telegram, WhatsApp's setup, the discovery the Mac app posts, the mail autoconfiguration, people) and to the Mac app
// through window.webkit.messageHandlers.pako; nothing on the computer is looked at before the person says yes on the page.
//
// A server's panel has no such page (its connections are its environment): there /panel/settings goes back to /panel, as does a browser that
// is not signed in (the panel's own page says how to sign in).

import { readFileSync } from "node:fs";
import type { Express, Request } from "express";
import type { Lang } from "./i18n.ts";
import { regionAttr } from "./region.ts";

const PAGE_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export interface SettingsPageDeps {
  signedIn: (req: Request) => boolean;
  /** The language of Pako's texts (always English: src/i18n.ts); kept so the callers did not have to change. */
  lang: () => Lang;
  /** A person's computer: the page exists. A server: /panel/settings goes back to the panel. */
  local: boolean;
}

export function mountSettingsPage(app: Express, d: SettingsPageDeps): void {
  const page = new URL("./panel/settings.html", import.meta.url);
  let html: string | null = null;
  app.get("/panel/settings", (req, res) => {
    res.set({ ...PAGE_HEADERS, "Cache-Control": "no-store" });
    if (!d.local || !d.signedIn(req)) return void res.redirect(302, "/panel");
    html ??= readFileSync(page, "utf8");
    // The owner's country goes on <html>, so the page writes dates the way the server does.
    res.type("html").send(html.replace('<html lang="en">', `<html lang="en"${regionAttr()}>`));
  });
}
