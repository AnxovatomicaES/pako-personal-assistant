// The guided mail connection (src/mail-autoconfig.ts): the server found from the address (the built-in table, Mozilla's database, the domain's
// own file, its MX records, a guess), the app password's steps per provider, and a live login before anything is kept, with plain errors.
// Nothing here reaches the network: fetch, the MX lookup and the IMAP login are fakes.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ConnectionsSaver } from "../src/connections-panel.ts";
import type { ImapClient, ImapConfig } from "../src/imap.ts";
import { createAutoconfig, loginTest, mountMailConnect, parseAutoconfig } from "../src/mail-autoconfig.ts";
import { auth, serve } from "./helpers/connect-rig.ts";

const XML = `<?xml version="1.0"?><clientConfig version="1.1"><emailProvider id="example.org">
  <incomingServer type="imap"><hostname>imap.example.org</hostname><port>143</port><socketType>STARTTLS</socketType>
    <username>%EMAILADDRESS%</username></incomingServer>
  <incomingServer type="imap"><hostname>mail.example.org</hostname><port>993</port><socketType>SSL</socketType>
    <username>%EMAILLOCALPART%</username></incomingServer>
</emailProvider></clientConfig>`;

const noNet = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
/** Every name is a public address here (no lookup leaves the test); the private ones are tested on their own. */
const publicDns = async (): Promise<string[]> => ["93.184.216.34"];

test("an autoconfig file gives its implicit-TLS IMAP server with the user name filled in; STARTTLS on 143 is passed over", () => {
  assert.deepEqual(parseAutoconfig(XML, "ana@example.org"), { host: "mail.example.org", port: 993, username: "ana" });
  assert.equal(parseAutoconfig("<clientConfig/>", "ana@example.org"), null);
});

test("the big providers come from the built-in table, with where to make the app password and its steps (English)", async () => {
  const asked: string[] = [];
  const auto = createAutoconfig({ resolve: publicDns, fetch: (async (u: string) => (asked.push(u), new Response("", { status: 404 }))) as unknown as typeof fetch });
  const gmail = (await auto("Ana@Gmail.com", "en"))!;
  assert.equal(gmail.host, "imap.gmail.com");
  assert.equal(gmail.username, "ana@gmail.com");
  assert.equal(gmail.provider, "google");
  assert.equal(gmail.source, "builtin");
  assert.equal(gmail.appPassword.url, "https://myaccount.google.com/apppasswords");
  assert.match(gmail.appPassword.steps[0]!, /2-Step Verification must be on/);
  const icloud = (await auto("ana@me.com", "en"))!;
  assert.equal(icloud.host, "imap.mail.me.com");
  assert.match(icloud.appPassword.steps.join(" "), /App-Specific Passwords/);
  const outlook = (await auto("ana@hotmail.es", "en"))!;
  assert.equal(outlook.provider, "microsoft");
  assert.match(outlook.note!, /forward your mail/);
  assert.deepEqual(asked, [], "a known provider asks nobody");
  assert.equal(await auto("not an address", "en"), null);
});

test("guided setup per provider: the app password page, 2-step verification first, the server and port, and what to do when refused", async () => {
  const auto = createAutoconfig({ resolve: publicDns, fetch: noNet });
  const want: [string, string, string, RegExp | null, RegExp][] = [
    ["ana@gmail.com", "imap.gmail.com", "https://myaccount.google.com/apppasswords", /2-Step Verification must be on/, /forward your mail/],
    ["ana@googlemail.com", "imap.gmail.com", "https://myaccount.google.com/apppasswords", /2-Step Verification/, /Advanced Protection/],
    ["ana@outlook.com", "outlook.office365.com", "https://account.live.com/proofs/AppPassword", /[Tt]wo-step verification/, /Forward your mail/],
    ["ana@hotmail.com", "outlook.office365.com", "https://account.live.com/proofs/AppPassword", /[Tt]wo-step/, /Forward your mail/],
    ["ana@live.com", "outlook.office365.com", "https://account.live.com/proofs/AppPassword", /[Tt]wo-step/, /Forward your mail/],
    ["ana@icloud.com", "imap.mail.me.com", "https://account.apple.com/account/manage/section/security", /[Tt]wo-factor/, /app-specific password/],
    ["ana@yahoo.com", "imap.mail.yahoo.com", "https://login.yahoo.com/account/security/app-passwords", /2-step verification/, /usual Yahoo password/],
    ["ana@fastmail.com", "imap.fastmail.com", "https://app.fastmail.com/settings/security/apps", null, /Mail \(IMAP\)/],
  ];
  for (const [address, host, url, before, refused] of want) {
    const c = (await auto(address, "en"))!;
    assert.deepEqual([c.host, c.port, c.tls, c.username, c.work], [host, 993, true, address, false], address);
    assert.equal(c.appPassword.url, url, address);
    assert.ok(c.appPassword.needed && c.appPassword.steps.length >= 2, address);
    if (before) assert.match(c.before!, before, address);
    else assert.equal(c.before, null, address);
    assert.match(c.refused, refused, address);
  }
  // The panel's own fallback link for Yahoo is the same page the server names.
  assert.match(readFileSync(join(import.meta.dirname, "../src/panel/settings.js"), "utf8"), /yahoo: "https:\/\/login\.yahoo\.com\/account\/security\/app-passwords"/);
});

test("a work account at Microsoft 365 or Google Workspace (by MX) is told plainly its organisation may block IMAP, and offered forwarding", async () => {
  const at = (exchange: string) => createAutoconfig({ resolve: publicDns, fetch: noNet, resolveMx: async () => [{ exchange, priority: 0 }] });
  const ms = (await at("firm-com.mail.protection.outlook.com.")("ana@firm.com", "en"))!;
  assert.deepEqual([ms.provider, ms.source, ms.work, ms.host], ["microsoft", "mx", true, "outlook.office365.com"]);
  assert.match(ms.note!, /Microsoft 365 work or school account[\s\S]*block IMAP[\s\S]*Forward your mail/);
  assert.match(ms.refused, /organisation blocks IMAP[\s\S]*Forward your mail/);
  const g = (await at("aspmx.l.google.com.")("ana@shop.example", "en"))!;
  assert.deepEqual([g.provider, g.work], ["google", true]);
  assert.match(g.note!, /Google Workspace[\s\S]*forward your mail/);
  assert.match(g.refused, /Workspace admin/);
  const personal = (await at("aspmx.l.google.com.")("ana@gmail.com", "en"))!;
  assert.equal(personal.work, false, "a gmail.com address is never a work account");
});

test("an unknown domain: Mozilla's database by domain only, then the domain's own file, then its MX, then a guess; kept for a day", async () => {
  const asked: string[] = [];
  const fake = (answers: Record<string, string>) => (async (u: string) => {
    asked.push(u);
    const hit = Object.entries(answers).find(([k]) => u.startsWith(k));
    return hit ? new Response(hit[1], { status: 200 }) : new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const ispdb = createAutoconfig({ resolve: publicDns, fetch: fake({ "https://autoconfig.thunderbird.net/v1.1/example.org": XML }) });
  const a = (await ispdb("ana@example.org", "en"))!;
  assert.deepEqual([a.host, a.port, a.username, a.source], ["mail.example.org", 993, "ana", "ispdb"]);
  assert.ok(asked.every((u) => !u.includes("ana")), "the address never leaves, only its domain");
  const n = asked.length;
  const b = (await ispdb("luis@example.org", "en"))!;
  assert.equal(b.username, "luis", "the cache is by domain, the user name is this address's");
  assert.equal(asked.length, n, "kept for a day");

  const own = createAutoconfig({ resolve: publicDns, fetch: fake({ "https://autoconfig.firm.es/mail/config-v1.1.xml": XML }) });
  assert.equal((await own("ana@firm.es", "en"))!.source, "autoconfig");

  const mx = createAutoconfig({ resolve: publicDns, fetch: noNet, resolveMx: async () => [{ exchange: "aspmx.l.google.com.", priority: 1 }] });
  const g = (await mx("ana@company.com", "en"))!;
  assert.deepEqual([g.host, g.provider, g.source, g.username], ["imap.gmail.com", "google", "mx", "ana@company.com"]);

  const guess = createAutoconfig({ resolve: publicDns, fetch: noNet, resolveMx: async () => { throw new Error("ENOTFOUND"); } });
  const x = (await guess("ana@tiny.example", "en"))!;
  assert.deepEqual([x.host, x.source, x.appPassword.needed], ["imap.tiny.example", "guess", false]);
  assert.match(x.note!, /imap\.tiny\.example/);
});

test("a company domain on Zoho is sent to Zoho's organisation server in the data centre its MX names: EU to imappro.zoho.eu", async () => {
  const at = (exchange: string) => createAutoconfig({ resolve: publicDns, fetch: noNet, resolveMx: async () => [{ exchange, priority: 10 }] });
  const eu = (await at("mx.zoho.eu.")("marta@empresa.es", "en"))!;
  assert.deepEqual([eu.host, eu.provider, eu.source], ["imappro.zoho.eu", "zoho", "mx"]);
  const us = (await at("mx.zoho.com")("marta@firm.com", "en"))!;
  assert.deepEqual([us.host, us.provider], ["imappro.zoho.com", "zoho"]);
  const personal = (await at("mx.zoho.eu")("marta@zoho.eu", "en"))!;
  assert.equal(personal.host, "imap.zoho.eu", "a personal zoho.eu address keeps the built-in server");
});

function fakeConnect(fail?: Record<string, unknown>) {
  const tried: ImapConfig[] = [];
  const connect = (c: ImapConfig): ImapClient => {
    tried.push(c);
    return {
      connect: async () => {
        if (fail) throw Object.assign(new Error("no"), fail);
      },
      logout: async () => undefined,
      close: () => undefined,
      on: () => undefined,
      mailboxOpen: async () => { throw new Error("not opened in a login test"); },
      search: async () => false,
      fetchOne: async () => false,
    };
  };
  return { tried, connect };
}

test("a refused Gmail login says it needs an app password; a working one is kept through the IMAP card's save and restarts Pako", async () => {
  assert.deepEqual(await loginTest({ host: "h.example", port: 993, user: "u", password: "p" } as ImapConfig, fakeConnect().connect), { ok: true });
  const refused = fakeConnect({ authenticationFailed: true });
  const saved: Record<string, string>[] = [];
  const saver: ConnectionsSaver = {
    save: async (_id, values) => (saved.push(values), { ok: true, name: "IMAP" }),
    restartAfter: () => true,
  };
  const auto = createAutoconfig({ resolve: publicDns, fetch: noNet });
  const bad = await serve((app) => mountMailConnect(app, { ...auth, lang: () => "en", saver, autoconfig: auto, connect: refused.connect }));
  const good = fakeConnect();
  const ok = await serve((app) => mountMailConnect(app, { ...auth, lang: () => "en", saver, autoconfig: auto, connect: good.connect }));
  try {
    const r = await bad.post("/panel/api/mail/connect", { address: "ana@gmail.com", password: "abcd efgh ijkl mnop" });
    assert.deepEqual(r.body, {
      ok: false, why: "auth", error: "That password doesn't work: Gmail needs an app password, not your usual one. Make one and paste it.",
    });
    assert.equal(refused.tried[0]!.password, "abcdefghijklmnop", "Google's app password works without its spaces");
    assert.deepEqual(saved, [], "nothing kept after a refused login");
    const w = await ok.post("/panel/api/mail/connect", { address: "ana@gmail.com", password: "abcdefghijklmnop" });
    assert.deepEqual(w.body, { ok: true, restarting: true });
    assert.deepEqual(saved, [{
      IMAP_HOST: "imap.gmail.com", IMAP_USER: "ana@gmail.com", IMAP_PASSWORD: "abcdefghijklmnop", IMAP_PORT: "", IMAP_OAUTH: "", IMAP_REFRESH_TOKEN: "",
    }], "an earlier sign-in with the provider is removed with the save");
    const found = await ok.get("/panel/api/mail/autoconfig?address=ana%40icloud.com");
    assert.equal(found.body.host, "imap.mail.me.com");
    assert.equal((await ok.get("/panel/api/mail/autoconfig?address=nope")).status, 400);
    assert.equal((await ok.post("/panel/api/mail/connect", { address: "ana@gmail.com" })).body.why, "password");
    assert.equal((await ok.post("/panel/api/mail/connect", { address: "x", password: "y" }, { cookie: "ok=1" })).status, 401);
  } finally {
    await bad.close();
    await ok.close();
  }
});

test("a guess made while offline is not kept: once back online the real server is found; a guess made online is kept", async () => {
  let online = false;
  let asked = 0;
  const xml = `<clientConfig><emailProvider><incomingServer type="imap"><hostname>mail.example-co.com</hostname><port>993</port>
    <socketType>SSL</socketType><username>%EMAILADDRESS%</username></incomingServer></emailProvider></clientConfig>`;
  const auto = createAutoconfig({ resolve: publicDns,
    fetch: (async (url: string) => {
      asked++;
      if (!online) throw new TypeError("fetch failed");
      return url.includes("example-co.com") ? new Response(xml, { status: 200 }) : new Response("", { status: 404 });
    }) as typeof fetch,
    resolveMx: async () => {
      if (!online) throw Object.assign(new Error("queryMx ECONNREFUSED"), { code: "ECONNREFUSED" });
      throw Object.assign(new Error("queryMx ENODATA"), { code: "ENODATA" });
    },
  });
  assert.equal((await auto("ana@example-co.com", "en"))?.source, "guess");
  online = true;
  assert.equal((await auto("ana@example-co.com", "en"))?.host, "mail.example-co.com");
  // Online, a domain with nothing anywhere: the guess is an answer, kept for the day.
  assert.equal((await auto("ana@nothing-here.com", "en"))?.source, "guess");
  const before = asked;
  assert.equal((await auto("bea@nothing-here.com", "en"))?.source, "guess");
  assert.equal(asked, before, "not looked up again");
});
