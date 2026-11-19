# Security

Pako holds the keys to someone's mail, calendar and chat, so please report problems **privately**.

## Reporting a problem

- Open a **private security advisory** on the repository (its *Security* tab → *Report a vulnerability*). Do not open a public issue for a
  security problem.
- Say what you found, how to reproduce it, and what it lets an attacker do. A minimal proof is enough.
- You will get an answer within a few days. Fixes are released first, then described.

What counts: a way to make Pako act on text it should only read (prompt injection that reaches a tool, a call, a message or an email); reaching
the panel or the chat without signing in; a website reaching the Pako on your computer (DNS rebinding, requests sent through your browser);
reading another person's data; leaking a secret; bypassing STOP; request forgery against the panel's buttons.

Reports against the latest version of the main branch help most. The promises below are the ones to test.

## What Pako protects

### On your computer (the default, local mode)

- **Nothing on the network can connect.** The server listens on `127.0.0.1` only (`PAKO_HOST` changes that: see the limits below).
- **It answers only its own names.** A request whose `Host` is not `127.0.0.1`, `localhost` or `[::1]` (or the `PAKO_HOST` address; with `0.0.0.0` or `::`,
  this computer's network addresses and host name) is refused with 421 before any route. This stops DNS rebinding: a website that points its own name at your computer gets nothing.
- **It refuses what other websites send through your browser** (403): by the browser's `Sec-Fetch-Site` or the page's `Origin` (and, for
  anything that changes something, its `Referer`). A link to the panel on another site still opens it. So no page you
  visit can press STOP, type in the chat, press a card's button, ask for a sign-in link, or use up the rate limits that the brain and
  `npm run panel` share with it (on one computer every request comes from the same address).
- **The terminal's and the brain's own routes** (`npm run panel` asking for a link, the brain reporting on Claude) answer connections from this
  computer only, by the socket's own address, and only with the bridge token.
- **`~/.pako` is private.** The folder is `700`, and Pako writes its files there (`secrets.json`, `config.json`, the store `kv.json`) as
  `600`. At each start the folder, its `.env` and `secrets.json` are made private again, should they have been made by hand or copied without
  their modes.
- **Telegram's bot token, pasted in the panel**, is checked with Telegram, then kept in `secrets.json`. It is never written to the log and
  never sent back to the page. The QR codes are drawn by Pako itself, not by an outside service.

### The panel (on your computer and on a server)

- **Sign-in is a one-time link**: 192 random bits, valid for 10 minutes, used once. There is no password to steal. It sets a signed session
  cookie: `HttpOnly`, `SameSite=Strict`, `Secure` over https, sent to `/panel` only, for 30 days. Failed links are rate limited.
- **Whatever changes something needs a custom header** besides the cookie, so another site cannot do it: STOP, the chat, a card's buttons,
  and on your computer the language and name and the Telegram card. Those last two do not exist on a server (they answer 404).
- **The page is locked down**: a strict Content-Security-Policy (no inline script, no framing, no forms, nothing from other origins), no
  referrer, `nosniff`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy` set to same-origin, its answers never cached. Nothing
  a stranger wrote (mail, Slack, web pages, a restaurant's reply) is ever read as HTML.

### The server's other doors

- **The brain's routes** (`/assistant/*`): a token of 32 characters or more, compared in constant time; refused tokens are rate limited.
- **Webhooks are checked before anything is done**: Meta's by HMAC-SHA256 of the body with the app secret, Slack's by its signing secret
  (within five minutes), AgentMail's by its Svix signature (within a time window), Telegram's by its secret header, the voice worker's by
  HMAC (its questions also fresh and used once).
- **The phone connector** (`/personal/<token>`): a wrong token is a plain 404, and failures are rate limited.
- **`/admin`** is closed unless `ADMIN_KEY` (24 characters or more) is set; the key is compared in constant time, failures are rate limited,
  and the answers are never cached or framed.
- **Every request body has a size limit**, and errors are answered without a stack trace.

### What Claude can do

- Every message is a run of `claude -p` with **no tool that runs commands or touches files** (web search, and web fetch if you allow it: an
  allowlist), no settings or plugins, from an empty folder. The only MCP server is Pako's own (`assistant/mcp-server.ts`, for your
  conversation only, never for a run that reads mail, a transcript or a paper): it holds no key, opens no connection and changes nothing. Its
  action tools answer "queued", and the bridge sends the accepted calls down the same path as the old tags, so every check below applies to them.
- **Claude gets only the settings it needs**: the path, the home folder, its own `CLAUDE_*` and `ANTHROPIC_*` settings (an API key too),
  proxies and a cloud provider's. Never the keys of your other connections.
- **What others wrote is information, never instructions.** Mail and meeting transcripts are summarized in runs of their own whose tags are
  dropped; whatever an email, a Slack message, an invitation, a restaurant's page or a web result asks for, a call, a message or a table still
  needs your press.
- **Nothing goes out without your press**: a call, a message to someone, a table request. **STOP** halts every call and outgoing message at the
  server and survives a restart. Calls and messages have daily caps.

### Secrets and logs

- Secrets live in `~/.pako/secrets.json` or in your server's settings, never in the repository.
- Logs never print tokens, keys or one-time codes. Codes found in mail are hidden (`[code hidden · type CODE]`)
  everywhere but the `CODE` command, unless you set `MAIL_SHOW_CODES=1`. On your computer the terminal prints the panel's one-time sign-in link: it is for you.

## What Pako does not protect against

- **Anything running as you.** A program running under your account (malware, a rogue package, another app) can read `~/.pako`: the secrets,
  the notes, the reminders, the chat and the keys in `.env`. They are kept unencrypted: turn on your disk's encryption. Pako is not a sandbox
  against your own account.
- **What Claude says.** Text Claude reads (an email, a web page) can mislead it into a wrong answer. Pako limits what such text can *do* (no
  tools, and every action needs your press), not what Claude writes in the chat. Read a card before you press it.
- **The services in between.** What you write, and what Pako reads to answer it, goes to Anthropic (through your Claude plan or your API key).
  Meta, Telegram, AgentMail, Slack, Zoho, Zoom, Retell, LiveKit and Google see what passes through them, under their own terms.
- **`PAKO_HOST`.** Listening on another address (a network address, `0.0.0.0`) puts the panel on that network over plain http: anyone on it
  can read the traffic, sign-in links included. Keep the default.
- **A signed-in browser.** It stays signed in for 30 days, and there is no sign-out button. To sign every browser out, delete
  `~/.pako/secrets.json` and start Pako again; the phone connector gets a new address too, and a Telegram bot token pasted in the panel
  goes with the file, so paste it again (on a server, change `ASSISTANT_BRIDGE_TOKEN` there and on the brain's computer).
- **A `.env` in the Pako folder.** Pako reads `./.env` too, but tightens only `~/.pako/.env`. Keep your keys in `~/.pako/.env`.
- **Older browsers.** The checks against other websites rely on what browsers send. One without Fetch Metadata (Safari before 16.4) still sends
  `Origin` with anything that changes something and with a script's reads, which are refused; but a page could make it load an image from
  Pako, and enough of those use up the brain's rate limit for a quarter of an hour. Nothing is read or changed that way.
- **A server on the internet** (the hosted way) does not get the local checks above: it is reached by name, through proxies. Its doors rely on
  signatures, tokens and the panel's `SameSite=Strict` cookie, and its safety also depends on long random values in its settings, https at
  the edge and your host. A page you visit that knows your server's address could use up a rate limit for your network's address (the
  sign-in links, or the brain's if it shares that address) for a quarter of an hour.
- **No outside audit.** Nobody outside the project has reviewed the code. It is tested on macOS and Linux.

## No data to the project

The Pako project runs no server for you and receives none of your data: no telemetry, analytics, crash reports, project-owned keys,
endpoints or relays. Pako never reads, copies or relays your Claude login: it runs Anthropic's unmodified `claude` command, which you sign
in to yourself. A change that adds any of these is a security change and is refused.
