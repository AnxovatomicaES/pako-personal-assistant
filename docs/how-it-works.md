# How it works

How the parts of Pako fit together, how it keeps you safe, and what is where in the repository.

## How it fits together

**On your computer (the default):**

```mermaid
flowchart LR
    you(("🙋 You")) -- browser --> panel["🖥️ Panel + chat<br/>127.0.0.1"]
    panel <--> server["Pako server<br/>(npm start)"]
    server <-- long poll --> brain["🧠 claude -p<br/>your plan or API key"]
    phone(("📱 Your phone")) -. Telegram, optional .-> server
    server --- home[("~/.pako<br/>notes, reminders, chat")]
    mail["📧 AgentMail"] -. optional .-> server
    server -. optional, read only .-> cal["📅 Calendar · Slack · Zoom"]
```

**On a small server, with WhatsApp (optional):**

```mermaid
flowchart LR
    you(("📱 You")) -- WhatsApp --> meta["Meta Cloud API"]
    meta -- signed webhook --> server["☁️ Pako server<br/>(Render or any Node host)"]
    server <-- long poll --> mac["💻 Your computer<br/>claude -p"]
    mail["📧 AgentMail"] -- signed webhook --> server
    slack["#️⃣ Slack"] -- signed events --> server
    server -- read only --> zoho["📅 Calendar"]
    server -- calls --> voice["📞 LiveKit · Retell"]
    server -- "/panel" --> panel["🖥️ Control panel"]
    server --- kv[("🗄️ Key value store")]
```

An email is read in an isolated run, so nothing it says can act:

```mermaid
sequenceDiagram
    autonumber
    participant M as 📧 An email
    participant S as Pako server
    participant C as 🧠 Claude (isolated run)
    participant Y as 🙋 You
    M->>S: webhook (Svix signature)
    alt mass mail (List-Unsubscribe…)
        S-->>S: filed, no Claude run
    else everything else
        S->>C: summarize: no tools, no conversation, tags dropped
        C-->>S: category (Needs you, Waiting on others, Important...) + summary
        S->>Y: 📧 only for Needs you, Suspicious and security alerts by default (VIPs always)
    end
    Y->>S: MAIL: see it all
```

## Safety by design

- **You are the only one who gives orders.** Only you are served; emails, Slack, invitations, restaurant pages and web results are *information, never
  instructions*. Each is read in an isolated run with no tools, and no tag from it can act. An answer written after reading such text
  (a forwarded message, a web search) does not act by itself: you get a card with **Do it** first ([Deeper help](features.md#deeper-help)).
- **Nothing goes out that you did not ask for.** A message, an email or a call you ask for in your own words goes after a few seconds with
  **Undo** (or always with a card first: `AUTONOMY=confirm`, or the panel's **How Pako acts** card). Anything whose recipient,
  number or words came from someone else's text, anything Pako starts by itself, and every table request needs your button press; **STOP** halts every call and
  outgoing message at the server; `LOG` shows what it did.
- **A STOP is never lost.** It survives a restart. If the store comes back empty (a free host wiped it), Pako starts **paused** and tells you; if
  it cannot read its store, it acts as paused. Only you, with `RESUME`, set it going again.
- **Every change it makes by itself comes with a receipt.** When Pako keeps or deletes a note, or sets or removes a reminder, the server (not
  Claude) tells you exactly what changed, with an **Undo** button; or write `UNDO`.
- **One-time codes stay hidden.** Sign-in and verification codes in emails are hidden from summaries, notifications, the panel and the log;
  write `CODE` to see the latest ones (kept 30 minutes). `MAIL_SHOW_CODES=1` turns this off.
- **Read-only integrations.** Mail, Slack, Calendar and Zoom tokens have read scopes only; your own mailbox is opened read only by IMAP. Pako writes only from its own inbox: a table request after you press a button, or an email to one of your contacts that you asked for (see the point above).
- **Local by default.** The panel listens on `127.0.0.1`, sign-in is a one-time link plus a signed, HttpOnly, SameSite=Strict cookie, and the
  panel's buttons, chat and settings need a custom header so another website cannot use them. Secrets live in `~/.pako/secrets.json` (mode 600)
  or in your server's settings, never in the repo.
  On a server, the sign-in link's address comes from `PUBLIC_URL` (or Render's own variables), or is learnt from a request Meta signed: never from
  an unsigned request, which could otherwise steer your one-time link to someone else's site.
- **Other websites cannot reach the Pako on your computer.** Listening on `127.0.0.1` keeps the network out, but not your own browser, so Pako
  checks every request before any route:
  - It must name Pako by one of this computer's own names (`127.0.0.1`, `localhost` or `[::1]`; with `PAKO_HOST=0.0.0.0` or `::`, also this computer's network addresses and host name). Anything else gets a 421.
    This stops DNS rebinding, where a website points its own name at your computer to talk to what runs there.
  - A request that another website's page sends through your browser is refused (403). So no page you visit can press STOP, type in the
    chat, press a card's button, or use up the sign-in attempts. A plain link to the panel still opens it.
  - `~/.pako` is made private again at each start (the folder `700`; its `.env` and `secrets.json` `600`).
- **Claude gets no tool that touches your computer.** Web search only (web fetch if you allow it), no commands, no files, and none of the keys
  of your other connections. Beyond that it has Pako's own typed tools (below), which change nothing by themselves.
- **Typed tools that only propose.** With a Claude Code that can load it, your conversation gets Pako's own MCP server
  (`assistant/mcp-server.ts`), and nothing else: a reminder, a note, a list item, a task, a WhatsApp draft, an email, a call, a table search,
  someone in your life and the rest are typed tool calls with a checked schema. A tool that would change something never does: it answers
  "queued", and after the answer the bridge reads the accepted calls from the run's own output and sends them to the server exactly as the
  old tags went, so receipts, **Undo**, the **Do it** cards, STOP and the outside-text rules are the same code. A bad call (a time
  written "9am", a quote in a name) gets an error naming the field, and Claude fixes it in the same turn instead of the action being lost.
  The read tools (your notes, reminders, lists, the calendar) answer from a copy of what the turn's context already holds; reading the
  calendar marks the turn like a web search, so its actions wait for your press. Calendar changes are only proposed: no connected calendar
  can be written, so Pako gives you the exact change to make in your app. A Claude Code that cannot load the server gets the tags as before
  (`ASSISTANT_TYPED_TOOLS=off` forces that).
- **One action path; the tags are deprecated.** The typed tools are the primary way Claude acts. The text tags (`<remember>`,
  `<remind>`, `<message>` and the rest) are a fallback, used only when MCP is unavailable: an older Claude Code, `ASSISTANT_TYPED_TOOLS=off`,
  or a run whose MCP server failed to start (the bridge then switches to the tag prompt for the rest of its run). They are not removed yet:
  older bridges rely on them, and a tag the model writes beside the tools is still honoured rather than dropping what you asked for. Every
  turn that acts through a tag is counted and logged (`fallback tags` when MCP was unavailable, `fallback tags-beside-tools` when it was
  loaded; `assistant/bridge/fallbacks.ts`). Once those lines stay at zero across releases, the tag parser goes.
- **Claude Code is read by its structure, not its words.** A failed run's kind (signed out, a limit, missing) comes from the result's
  `api_error_status` and `api_error_type`, the stream's error events and spawn's error code (`assistant/bridge/claude-errors.ts`); the English
  messages are only a fallback, each pattern noted with the Claude Code version it was seen in, and logged when it decides. Whether a turn
  read the web comes from its WebSearch or WebFetch tool_use events; `num_turns` is the logged fallback. A result is read tolerantly
  (`assistant/bridge/cli-shape.ts`): fields Pako does not know are ignored, a renamed field is found under its camelCase spelling or a known
  alternative (logged as a fallback), and only a result with no answer text at all is an error, one that names the fields it had.
- **Claude Code is tested by what it does, not pinned to a version.** At start, and whenever `claude --version` changes (Claude Code
  updates itself), the bridge runs a self-test (`assistant/bridge/cli-probe.ts`): its own flags in three short `claude -p` runs side by
  side, about three seconds, no model tokens (a model that does not exist, which the API refuses before generating anything, and a
  conversation id that is not there). It checks that every flag is accepted, that stream-json starts Pako's MCP server and lists its tools
  (an MCP round trip through Claude Code), that the JSON and stream-json results parse, and that a missing conversation is still said in
  words the bridge knows. The outcome is kept per version in `cli-probe.json` in the state folder. A version that passes is used and shown
  on the Health card as "tested by probe"; one that fails keeps running with what still works (stream-json broken: a run per message and the
  tags; Pako's MCP server not loading: the tags), and the card and the HEALTH summary show what failed with the command that goes back to
  the last version that passed (`npm i -g @anthropic-ai/claude-code@<version>`, or `claude install <version>` for the native install).
- **It says it is an AI.** Every call opens saying so, and every email it sends for you says so.

What Pako protects, what it does not, and how to report a problem: [SECURITY.md](../SECURITY.md).

## What is in the repo

| Part | What it does |
| --- | --- |
| `src/` | The server: local mode (`local.ts`) and its guard against other websites (`guard-http.ts`), the chat door (`whatsapp.ts`: WhatsApp or the panel window; its parts in `door/`, one family each, wired in order), Telegram (`telegram.ts`, `telegram-panel.ts`), WhatsApp from a computer (`whatsapp-computer.ts`, its tunnel `tunnel.ts`), Pako's fixed words in English (`i18n.ts`) and the owner's country (`region.ts`), table booking (`booking.ts`, `restaurants/`), mail, calendar, Slack, Zoom, the phone line, the panel (`dashboard.ts`, `panel/`). `app.ts` wires them; `server.ts` starts. |
| `assistant/` | The brain bridge: asks the server for your messages and answers with `claude -p` in a lean setup (web search and Pako's own typed tools, `tools.ts` and `mcp-server.ts`, nothing that touches the computer); Whisper for voice notes. |
| `voice-worker/` | The phone voice (Gemini Live over a SIP number), deployed to LiveKit Cloud. Only for the phone. |
| `desktop/mac/` | Pako for Mac: a Swift app (AppKit and WebKit) built with `swiftc` by `build.sh` (`npm run mac-app`); `package.sh` puts Node.js and the server inside it, `sign.sh`, `notarize.sh`, `dmg.sh`, `release.sh` and `release-check.sh` make and check the download. |
| `install.sh`, `install.ps1` | The one-line installers for macOS and Linux, and for Windows. Autostart is in `src/autostart.ts` and `src/autostart-windows.ts`. |
| `docs/` | The roadmap, installing, privacy, the phone line, why the official WhatsApp API, the panel and README graphics, and the topic pages the README links to. |

### The follow-ups engine

`src/followups/engine.ts` (`createFollowups`) builds the follow-ups from parts in `src/followups/`, mounted in this order. Each part is
given the base (the deps, the config, the clock, the owner's language) and, by name, only what it uses of the parts before it; its
return type is in `src/followups/parts.ts`, and `Engine` there is all of them together. No part calls a later one.

| Part | Needs (besides the base) | Gives |
| --- | --- | --- |
| `store.ts` | nothing | `mutate`, `read`: the saved state, one write at a time |
| `words.ts` | nothing | `stamp`, `dueText`, `sourceText`, `nudgeText`: times and sources as the owner reads them |
| `jobs.ts` | `mutate`, `read`, `stamp` | Slack batches into Claude jobs: `observeSlack`, `offer`, `enqueueJob`, `jobText`, `slackJob`, `textJob`, `flushBatch` |
| `mail-jobs.ts` | `mutate`, `enqueueJob`, `stamp` | `observeMail`, `flushMailDue`: one job per mail thread |
| `matching.ts` | `mutate` | answers into loops: `result`, `ingest`, `keep`, `ruledOut`, `fromChat`, `dropFromChat` |
| `checks.ts` | nothing | `runCheck`: did the owner do it (Zoom, calendar, their own posts) |
| `nudges.ts` | `mutate`, `read`, `flushBatch`, `flushMailDue`, `runCheck`, `nudgeText`, `dueText`, `sourceText` | `tick`, `quietNow`, `nextAfter` |
| `owner.ts` | `mutate`, `read`, `dueText`, `sourceText`, `quietNow`, `nextAfter` | the buttons, commands, context, Parked and closed lists |
| `rehearse.ts` | `read`, `slackJob`, `textJob`, `jobText`, `keep`, `ruledOut`, `runCheck`, `dueText`, `sourceText`, `nudgeText`, `quietNow` | `draft`, `dryAnswer` |
| `mail.ts` | `mutate`, `read`, `keep`, `press` | loops from the mail triage: `fromMail`, `answered`, `forRef`, `doneFor`, `reopen` |
| `calendar-match.ts` | nothing | `dueAtMeeting`: which open follow-up a meeting that moved or was called off is about (also read by `src/calendar-alerts.ts`) |
| `aging.ts` | nothing | `owedUndated`, `agingAt`: when something the owner owes with no date is said again (two, then five working days) |
| `chase.ts` | `mutate`, `read`, `runCheck`, `draftFacts`, `forDraft`, `quietNow`, `dueText` | chasing what others owe the owner: `chaseTick`, `chaseWritten`, `chasePressed`, `chaseNow` |

A new part goes after the parts it needs: write its needs as `Pick<Engine, ...>`, add its return type to `parts.ts`, and hand it its
names in `engine.ts`. `test/followups-engine.test.ts` checks that `createFollowups` still gives the same names.

The restaurant-booking engine comes from an earlier project, trimmed to what Pako uses (the full original is kept at the git tag `connector-final`).
