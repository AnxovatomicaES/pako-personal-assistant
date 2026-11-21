# The owner's WhatsApp assistant

Your own assistant, in a WhatsApp chat: you write to it like to a person, it answers with Claude, keeps notes about you (the same notes the
phone line reads), looks things up on the web, and can propose a call to one of your approved friends.

**This guide is for the advanced, hosted way**: a server on the internet with WhatsApp as the chat, and Claude on your own computer. On a
computer alone (the default) none of the WhatsApp steps are needed: see the [README](../README.md). The guides further down (calendar, Zoom,
Slack, email, tables) apply to both; on a computer, put the values in `~/.pako/.env` instead of Render.

Pako's own words are English (the buttons read **Call**, **Send**, **Cancel**, **Undo** and **Email them**); Claude answers in the language
you write in. See [Commands](#commands) and [Languages](#languages).

```
your WhatsApp ──► Meta ──► this server (src/whatsapp.ts) ◄── long poll ── your Mac (assistant/bridge.ts) ──► claude -p
                              │  checks Meta's signature, serves only your number          (your own Claude login)
                              └─► sends the answers back to you, and only to you
```

- **The server is the door.** It holds the Meta token, accepts messages from your number only, and sends messages to your number only.
- **Your Mac is the brain.** It asks the server for your messages, runs the unmodified `claude` program with your own login, and posts the
  answer back. It holds a separate bridge token that can fetch your messages and message you, nothing more. If the Mac is off or asleep, the
  server tells you ("My brain (Claude on your computer) is offline right now", at most every half hour) and keeps your message until it is back.
- **Claude can only talk.** No shell, no files, no connectors, no plugins (they make every call a hundred times bigger and slower). It has a
  web search and tags in its answer that the bridge reads and removes: `<remember>`, `<forget>`, `<call to="Name">`, `<message to="Name">`, and
  for reminders, lists and tasks `<remind>`, `<unremind>`, `<list>`, `<task>` and `<done>` (see "Reminders" and "Lists and tasks"), and
  `<person>`, `<routine>` and `<watch>` (see "Deeper help"); `<send>` is
  read but off: see "Terms" below. The bridge never runs anything Claude wrote.
- **A WhatsApp in your name is sent by you, not by the assistant.** Ask it to write to someone ("write to Ana that I'm running late") and it
  prepares the text; the server answers with a `wa.me` link that opens *your own* WhatsApp with that text filled in, and you press send. The
  number comes from your approved contacts (Claude never sees it) or from a full number you typed in the chat (+44…). It is your message from
  your account, so nothing here sends as a bot and nothing can go out without your tap.
- **A message from the assistant's own number is off** (`WHATSAPP_FRIEND_MESSAGES`, see "Terms" below). The owner tried it on, then chose chat only. With
  `WHATSAPP_FRIEND_MESSAGES=1` it needs your tap, and the prompt must offer `<send>` again (it did in PR 47). Ask it to send, write or message someone ("send Ana a message that I'm running late") and the
  server shows you a card with the exact words and **Send** / **Cancel** (or type "yes" as the very next message). Only then does it go out, from the
  assistant's WhatsApp number, to a contact from your list or to a +number you typed in this chat in the last six hours (an invented number is
  refused). The server writes the first line ("Message on behalf of <you>, sent by their AI assistant:"): a friend always knows it is an AI. At
  most 3 a day to one number and 10 a day in all. When the friend answers, the server passes the answer on to you for two days (anyone else who
  writes is still dropped). You are told when it is delivered, and when WhatsApp refuses, why, with the link to send it yourself instead.
- **A call is never placed on Claude's say-so.** A proposed call comes to you as a message with the exact words, written by the server, and
  buttons. Tap **Call**, or just type "yes" (it must be your very next message), and the call goes through the same checks as the voice line:
  approved contacts only, caps, quiet hours, your name. "No", "cancel" or any other message drops it. Buttons expire after five minutes. The
  server drops a greeting or "it's <your name>" from the message (the call opens by saying it is your AI assistant), then looks the call up every
  20 seconds and tells you how it ended; the assistant is given the same line, so "how did it go?" gets a real answer.

## What it costs

- **Claude:** your subscription (the unmodified `claude` program, your own login, only for you). One message costs about 1.5 cents at list price
  (about 2,000 tokens of context, measured), which is counted against your plan's limits. Anthropic's terms: your own use on your own machine is
  ordinary use; building this for other people, or sharing your login, is not allowed. Read the current terms before relying on it.
- **WhatsApp:** see "WhatsApp" below. Replying inside the 24 hours after you write is the normal case. Meta's free test number costs nothing.
- Nothing else new.

## Terms: read this before relying on WhatsApp (checked 2026-11-14, not from Meta's own pages in full)

This is a personal project, and that is exactly what Meta's WhatsApp *Business* Platform does not allow:

- [WhatsApp Business Terms](https://www.whatsapp.com/legal/business-terms?lang=en): you warrant you will use the Business Services "solely for business,
  commercial, and authorized purposes, and not for personal use" (quote read in a search summary of that page).
- Since 2026-01-15 the Business Solution Terms bar AI providers from using the Business API for general-purpose assistants
  ([TechCrunch](https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform)). It was aimed at services
  such as ChatGPT; how it is applied to a private bot with one user is not known.
- So the WhatsApp chat with the assistant (owner only, Meta's free test number) is a terms risk: the likely worst case is Meta closing that test app or its
  business account. Messaging friends from the assistant's number is the riskier part (a bot writing first to people who never asked), which is why
  `<send>` is off. A WhatsApp message to a friend in the owner's name stays possible as a link (`<message>`): it opens the owner's *own* WhatsApp, with
  no API, and the owner presses send.
- The route without Meta's API (an unofficial client on a number of its own) is not built; how it works, its risks and the three routes side by side are in
  [docs/whatsapp-unofficial.md](../docs/whatsapp-unofficial.md).

## 1. WhatsApp (Meta Cloud API)

The official route. Meta's screens change: follow [their current guide](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started)
(steps 1 to 5 there); these are the parts that matter, and where each value comes from.

1. <https://developers.facebook.com> → create a **new app** with the **WhatsApp use case** (pick or create a business portfolio; it is free).
2. **Customize use case → Connect on WhatsApp → Quickstart → API Setup**: connect (or create) the Messaging account, and under *From* pick the free
   **test number**. Its **Phone number ID** (a long number, not the phone number itself) is `WHATSAPP_PHONE_NUMBER_ID`. Under *To* add your own
   mobile (the test number can message up to five recipients; Meta sends a code to verify it) and press *Send message*. Reply from your phone: your
   reply opens the 24-hour window that the assistant's answers use.
3. **App settings → Basic → App secret** (*Show*) is `WHATSAPP_APP_SECRET`.
4. The temporary token on that page expires within a day. A token that does not: **Business settings → Users → System users → Add**, then *Assign
   assets* (your app and your WhatsApp account, full control), *Generate token*, expiry *Never*, permissions `whatsapp_business_messaging` and
   `whatsapp_business_management`. Copy it at once: it is shown once. That is `WHATSAPP_ACCESS_TOKEN`.
5. Put these values in the server (section 2: the three above plus `WHATSAPP_VERIFY_TOKEN` and `ASSISTANT_BRIDGE_TOKEN`, which you make up yourself, and the three
   `PERSONAL_*` settings) and wait for it to redeploy. **Only then**: *Configuration → Webhook*: callback URL
   `https://<your server>/whatsapp/webhook`, verify token = the server's `WHATSAPP_VERIFY_TOKEN`, subscribe to the `messages` field. Meta checks the
   address the moment you save, and the server only answers once the feature is on.
6. From your phone, write to the test number.

To use your own number later instead of the test number: *WhatsApp Manager → Phone numbers → Add*. It must be able to receive a
verification call or SMS, and it can no longer be used in the WhatsApp app.

## 2. The server (Render environment)

| Variable | What |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | the Meta token. Setting it turns the feature on |
| `WHATSAPP_PHONE_NUMBER_ID` | the numeric phone number id |
| `WHATSAPP_APP_SECRET` | Meta's app secret: every webhook is checked against it |
| `WHATSAPP_VERIFY_TOKEN` | any text of 16+ letters, digits, `-` `_`: the same you give Meta |
| `ASSISTANT_BRIDGE_TOKEN` | 32+ characters: `openssl rand -hex 24`. The same goes in the Mac's `.env` |
| `PERSONAL_CALLER_TOKEN`, `PERSONAL_OWNER_NAME`, `PERSONAL_OWNER_NUMBER` | required: the phone line's settings (the token: `openssl rand -hex 24`; your name; your number as `+14155550100`). Without them the whole door stays off, and the log says so |
| `WHATSAPP_TEMPLATE_NAME`, `WHATSAPP_TEMPLATE_LANG` | optional: an approved message template, to start a conversation with a friend from the assistant's number when the 24-hour window is closed (see "What WhatsApp allows" below). Its body has two variables: `{{1}}` your name, `{{2}}` the message. Language default `en` |
| `WHATSAPP_OWNER_NUMBER` | optional: your WhatsApp number, if it is not `PERSONAL_OWNER_NUMBER` |
| `WHATSAPP_OWNER_BSUID` | optional, only if you use a WhatsApp **username**: then WhatsApp leaves your number out of your messages and identifies you by a user id (like `US.13491208655302741918`). The server learns it by itself from a message that carries both; if your messages are ignored, the server log says `a message came from a sender known only by the user id ...`: put that id here |

`VOICE_RESULTS_URL` keeps your messages, notes and STOP across restarts of the free web service (the Blueprint in `render.yaml` creates it for you).
Anything wrong is logged as `[whatsapp] off, because: ...` and the server starts anyway.

### What WhatsApp allows, for messages from the assistant's number

These are Meta's rules, not ours, and they limit "anyone I want":

- **The free test number** can message only the numbers on its recipient list (Meta dashboard, API Setup, "To", up to five; each gets a code to confirm).
  Anyone else is refused (error 131030): the server says so and offers the link instead.
- **A free-form message** goes through only if that person wrote to the assistant's number in the last 24 hours. Otherwise (error 131047) WhatsApp wants an
  **approved template**. To make one: WhatsApp Manager, Message templates, Create: category *Utility*, language English, name `assistant_message`, body
  `Hi, this is {{1}}'s AI assistant writing. A message from them: {{2}}`, with an example for each variable. Meta may
  re-label it *Marketing* (and charge for it); once approved, set `WHATSAPP_TEMPLATE_NAME=assistant_message` in Render (and
  `WHATSAPP_TEMPLATE_LANG` if you made it in another language). A template variable cannot hold a
  line break, a tab or more than four spaces in a row: the server flattens the message onto one line for it. Pricing: not checked.
- **A real number for the assistant** (instead of the test number) also lifts the recipient list: it must be registered in WhatsApp Manager and can no
  longer be used in the WhatsApp app. Meta's business messaging policy asks for the recipient's opt-in before a business writes first: use it for people who
  expect messages from you. Not re-checked here.
- Error codes (131030, 131047) are from vendors' and forum descriptions, not Meta's own reference page.

## 3. Your Mac

Needs Node 22.18 or newer and Claude Code logged in (run `claude` once).

```bash
cd /path/to/pako && git pull && bash assistant/install.sh
```

It checks Node and Claude Code, asks for the bridge token (the `ASSISTANT_BRIDGE_TOKEN` in Render; it is not shown as you type), writes
`assistant/.env` readable by you only, and installs a LaunchAgent that starts the assistant now and at every login and restarts it if it stops.
It asks the server whether the token is accepted and tells you if not. `bash assistant/install.sh --uninstall` stops and removes it.

It keeps asking the server for messages while it runs. It runs `claude` from its own empty folder (`~/.pako-assistant`), which also holds the
conversation id and the log (`tail -f ~/.pako-assistant/assistant.log`); nothing else of yours is read. It uses `caffeinate` so an idle Mac does
not sleep, but a closed lid or a battery shutdown still stops it. The same polling keeps the free web service awake while the Mac is on.

A Mac set up before Pako had its name keeps its folder, `~/.ai-buyer-assistant`, with the conversation, the log and the voice model in it.
Its LaunchAgent was `com.aibuyer.assistant`: running `bash assistant/install.sh` again replaces it with `local.pako.assistant`.

By hand instead: `cp assistant/env.example assistant/.env`, fill it in, and
`node --disable-warning=ExperimentalWarning --env-file=assistant/.env assistant/run.ts` (or adapt `local.pako.assistant.plist.example`).

### Updates: off by default, signed releases only when on

This computer holds your Claude sign-in and the bridge token, so it never runs whatever happens to be on GitHub. By default it **does not
update itself**: every 30 minutes (the first look 5 minutes after it starts), between two messages, it asks `origin` where its default
branch is, and when that is ahead of what runs here it logs `update available: <commit> ...` once and stops there. You update by hand:
`git pull` and restart the assistant.

To let it update itself, set `BRIDGE_AUTO_UPDATE=1` **and** pin the key that signs releases in `BRIDGE_UPDATE_SIGNER`. It then only ever
moves to a **release tag** (`vX.Y.Z`) whose signature verifies against that key; with no key pinned it refuses (`not updating: no signer
pinned ...` in its log), and a tag that is unsigned, lightweight, or signed by any other key is refused too (`refusing v0.4.0: ...`).
`BRIDGE_UPDATE_SIGNER` is either:

- an **SSH allowed-signers file** (the path), checked with `git verify-tag` and `gpg.minTrustLevel=fully`, so a valid signature by a key
  that is not in the file never passes. One line per key: `release ssh-ed25519 AAAA...` (the public key that signs the tags,
  `git tag -s vX.Y.Z` with `gpg.format=ssh`);
- or a **GPG fingerprint** (40 hex characters; spaces are fine). Import that public key into this computer's keyring first; the
  `VALIDSIG` line of `git verify-tag --raw` must name it, so another key in the keyring does not count.

When it is on, each look:

1. asks `origin` which branch is its default (`git ls-remote --symref origin HEAD`), then fetches it and its tags;
2. stops there, and only says why, when this checkout is **not on that branch**, has **local changes** to tracked files (`git status
   --porcelain --untracked-files=no`; your untracked `assistant/.env` does not count), or the newest release tag is **not a fast-forward**
   (commits here that origin does not have);
3. verifies the newest `vX.Y.Z` tag against the pinned key, then `git merge --ff-only` to that tag's commit, then `npm ci` **only when
   `package-lock.json` changed**;
4. checks itself: every bridge file parses (with Node's own TypeScript parser: `node --check` passes any `.ts` file),
   `assistant/bridge.ts` and `assistant/update.ts` load with everything they import, and the new `assistant/run.ts` starts with
   `--self-check`, the way the running bridge was started (the same node flags, `--env-file` among them, and the same settings): it loads
   everything it imports, accepts its settings, builds the bridge and stops before its loop;
5. starts itself again on the new version: in place (`execve`, the same process, so the LaunchAgent and `caffeinate` notice nothing), or,
   where Node cannot, by exiting with code **75**, on which the LaunchAgent's `KeepAlive` starts it again.

If `npm ci` or the self-check fails it goes back to the commit it ran (`git reset --keep`, and `npm ci` again when the lock had changed),
keeps running as before, and does not try that commit again (a newer one, yes; the refusal is kept in `update.json`, so a restart remembers
it). A new version is also on probation until its first good round with the server (or two minutes up): if it stops before that and is
started again (the LaunchAgent), it goes back to the commit it came from at that start, refuses the new one, and starts again on the old.
Its log says each step (`updating abc1234 → def5678 (v0.4.0, signature verified)`, `updated to <sha>`, `not updating: local changes`).

At each start it tells the server its version on `POST /assistant/health` (`{version: {sha, committedAt, updatedAt, autoupdate}}`): the
panel's **System** card shows it ("updated itself on ..."), and the server's watchdog tells you once when this computer stays **more than a day
behind** the server, with the reason it did not update itself. `BRIDGE_AUTOUPDATE=off` (the older setting) stops even the look. Updating is
always off for the bridge that Pako starts beside itself on a computer (local mode), which is updated with Pako itself.

| Setting | Default | What it does |
| --- | --- | --- |
| `BRIDGE_AUTO_UPDATE` | off | `1`: this computer updates itself, to release tags signed by `BRIDGE_UPDATE_SIGNER` only. Off: it only logs "update available". |
| `BRIDGE_UPDATE_SIGNER` | none | The key releases must be signed with: an SSH allowed-signers file (path) or a GPG fingerprint. None: auto-update refuses. |
| `BRIDGE_AUTOUPDATE` | | `off`: not even the "update available" look. |

**With an API key instead of a Claude plan:** add `ANTHROPIC_API_KEY=your-key` to `assistant/.env`. The bridge passes it to the `claude`
command and to nothing else; Claude Code must still be installed, but need not be signed in. Every message is then billed to that API account.

### What the first public release changed in the bridge

Run `git pull` on this computer and restart the assistant after the server is updated. The two still work together when only one is new.

- **It writes in English.** The bridge's own lines ("One moment…", what it says when Claude fails, the answers about a voice note it could not
  hear, the heads of email and meeting summaries, the lines of context Claude gets around your message) are English, and Claude is told to
  answer in the language you write in. A server still sends `uiLanguage` on the inbox (`GET /assistant/context`); the bridge ignores it. A
  bridge from before the English-only change may still write its own lines in Spanish until it is pulled.
- **It runs from the repository.** The bridge now uses one file from `src/` (`src/i18n.ts`): keep the whole checkout, not a copy of the
  `assistant/` folder.
- **It knows why Pako is paused.** The context says whether you wrote STOP or Pako paused itself (its store came back empty, or cannot be
  read), and Claude is told which.
- **An API account out of credit counts as Claude's limit**, not as a failure: your message waits and is tried again, instead of being
  dropped with an apology.

### The chief-of-staff jobs (follow-ups, meeting reviews, the written brief)

The server now queues three more kinds of job for this computer. Run `git pull` here and restart the assistant to get them. Each job's
`text` is empty, so an older bridge lets it go unread and acknowledges it, and nothing breaks:
- no follow-ups;
- Zoom's summary comes as it is;
- the old brief goes at once.

Each job is read in an isolated `claude` run: no tools, no session, a fence with a random name made up for that run, and other people's text
neutralised. The bridge posts back the raw answer, and the server takes only the JSON it asked for, field by field. The bridge itself never
tells you anything about these jobs.

| Inbox field | What it carries | Prompt (`assistant/prompt.ts`) | Answer posted to |
| --- | --- | --- | --- |
| `followup` `{source, label, text}` | A Slack conversation's new messages (with its last 15 and your replies marked), an email thread's new emails (cleaned words, yours marked YOU), a Needs you mail summary when email reading is off or spent, or a meeting's summary when it could not be reviewed | `FOLLOWUP_PROMPT` | `POST /assistant/followups` `{id: "fu:<hex10>", text}` |
| `review` `{source, topic, when, head, text}` | Zoom's AI Companion summary (`id: "review:<uuid>"`), or, beside `meeting`, a cloud transcript (`id: "zoom:<uuid>"`) | `REVIEW_PROMPT` | `POST /assistant/meeting-review` `{id, text}` |
| `brief` `{kind: "brief" \| "do" \| "prep", label, text}` | The day's facts with their ids (L, Z, S, E, Q, T, M, B, R); `do` and `prep` add your request from the brief's page | `BRIEF_PROMPT` (brief), `BRIEF_TASK_PROMPT` (do, prep) | `POST /assistant/brief` `{id: "br:<hex10>", text}` |

- **Acknowledgements:** this bridge sends `briefs: 1` with `papers: 1` on `POST /assistant/ack`, so the server knows it answered. An older
  bridge does not, and the old brief goes at once.
  - A review acknowledged with no answer gets Zoom's summary sent as before.
  - A transcript is also summarized by an older bridge, as before, from its `meeting` field.
- **Order:** your own messages always go first. These jobs wait behind them, like emails and transcripts.
- **Waiting:** if this computer is off, the server stops waiting:
  - after `ZOOM_REVIEW_WAIT_MIN` (120 minutes), Zoom's summary goes as it is;
  - after `BRIEF_WAIT_MIN` (15 minutes), the old brief goes.

  A follow-up job stays in the inbox until the computer reads it.

## Deeper help: papers, routines, watches, people, and other people's text

Run `git pull` on this computer and restart the assistant after the server is updated. An old bridge keeps working with a new server: its
replies are unmarked and act as before, a photo or PDF is answered by the server with a line asking for the update, and the new commands
(`PEOPLE`, `ROUTINES`, `WATCHES`) work because the server answers them itself.

**Other people's text never acts without your press** (`src/quarantine.ts`).

- Every context line that comes from someone else (mail, calendar, Zoom, Slack, bookings, papers) is cleaned before Claude sees it, so it
  cannot open a context note, fake a list or carry a live tag. A forwarded message is wrapped in a `⟦outside source=…⟧ … ⟦/outside⟧` block.
- Emails, transcripts, Slack search results and papers are read in full only in isolated runs with no tools, whose tags are never acted on.
- **A turn is marked** when its message was forwarded (a forwarded voice note too: its transcription is a forwarded block, not your words),
  or when its run read the web: `claude -p`'s result counts more than one turn (a tool ran inside that run; with `--resume` the count is the
  run's own, starting at 1) or a web search or fetch request. That text stays in the conversation the next turns resume, so they are marked
  too until a new conversation starts; with an older server the next message starts a new conversation instead.
- A marked turn's tags (a call, a message, a reminder, a list, a task, a note, a person, a table) go to a new server as `outside: [...]`.
  The server sends the text, holds the rest and shows one card: *"⚠️ This answer was written while reading other people's text (…)"*,
  with **Do it** / **Cancel** (`q1:` / `q0:`). **Do it** runs them, with the usual receipt and **Undo**. The card lasts 15 minutes and ends
  with `STOP` or a restart (it is kept in memory only); pressed while paused it is refused. Each hold, press and drop is in `LOG`.
- A new bridge talking to an older server (no `quarantine: 1` in the context) drops a marked turn's tags itself and adds one line saying so.
- `<routine>` and `<watch>` from a marked turn are not held: the server does not make them and tells you, so ask again in your own words.

**The new tags**, each read and removed by the bridge, and acted on by the server only from a turn of your own:

| Tag | What the server does |
|---|---|
| `<person name="Ana" relation="my sister" birthday="1990-03-14" likes="jazz; chocolate">…</person>` | Keeps or adds to Ana's record (at most three per answer). A birthday (`MM-DD` or `YYYY-MM-DD`) becomes a yearly reminder at 09:00 that does not count toward your 20. There is no tag to forget someone. |
| `<routine at="2026-11-20 18:00" every="week">…</routine>` | Makes a routine: at each time (`day`, `weekday`, `week`, `month` or `year`) the words come back to Claude as your message, with no "One moment…". One per answer; a routine's own run cannot make another. |
| `<watch on="mail" from="mybank.com" words="…" once="false">…</watch>` | Makes a watch on `mail` (sender's address, subject), `calendar` (event title) or `slack` (who wrote, text). One per answer. |

Each one made gets a receipt with **Undo**. A new bridge that meets a server without routines drops `<routine>` and `<watch>` and says
so; one that meets a server without people turns `<person>` into a `<remember>` note.

**Papers.** A photo or PDF (WhatsApp image or document, Telegram photo or document, the panel's paperclip) is checked by its bytes on the
server (JPEG, PNG, WebP up to 5 MB, PDF up to 15 MB) and queued with empty text. The bridge fetches it from `GET /assistant/paper/:id`,
checks it again, reads it in one isolated `claude` run (`--input-format stream-json`, the file as a content block, no tools, every tag
dropped), hides any one-time code and posts the summary to `POST /assistant/paper-summary`. The answer goes to the chat the file came
from, and the server gives Claude the summary for a day, as other people's text, so your next words ("remind me about it") can act on it.

**People in the context.** The server sends names and relations (30 at most) and every record; the bridge gives Claude a person's full
record only in a turn whose message names them. A contact's number never goes to the bridge.

**Your own mailbox (IMAP)** is read by the server, not the bridge: its emails arrive like those of Pako's own inbox and are summarized in
the same isolated run. With IMAP on, stop forwarding that mailbox to Pako's inbox: an email that comes both ways is taken once when the
forward keeps its Message-ID and sender, but not every forward does.

## Commands

A command is the whole message; capitals, accents and punctuation do not matter. The server answers them itself, at once, even when the Mac is
off. Commands are English words; anything else, in any language, goes to Claude. `HELP` lists the ones that are on.

| Command | What happens |
|---|---|
| `HELP` | What Pako does, and the commands that work on this server |
| `STOP` · `PAUSE` | Nothing goes out to anyone (see "STOP, RESUME and the log") |
| `RESUME` | Back to normal |
| `LOG` | The last 15 things Pako did |
| `UNDO` | Undoes Pako's latest change to a note, a reminder, a list or a task (see "Receipts and UNDO") |
| `BRIEF` · `DAILY BRIEF` · `TODAY'S BRIEF` · `BRIEFING` | Today's brief now, also while paused (see "The daily brief") |
| `NOTES` · `MY NOTES` | Your notes, numbered, oldest first, each with its day (see "Notes: NOTES, FORGET, EDIT") |
| `FORGET 3` · `FORGET NOTE 3` · `DELETE NOTE 3` | Deletes note 3 |
| `EDIT 3: text` · `EDIT NOTE 3: text` | Replaces note 3's words |
| `REMINDERS` | Your pending reminders, repeats marked |
| `LISTS`, or `LIST` and a name | Your lists, or one list (only for a list that exists; otherwise the words go to Claude) |
| `TASKS` | Your open tasks |
| `PEOPLE` · `MY PEOPLE` | The people Pako keeps (see "Deeper help") |
| `PERSON Ana`, or `PERSON Ana: relation …` (`birthday`, `likes`, `notes`, `name`) | One person, or changes one part (nothing after it clears it); only for a person that exists |
| `FORGET PERSON Ana` · `DELETE PERSON Ana` | Forgets that person and their birthday reminder |
| `ROUTINES` | Your routines, numbered |
| `WATCHES` | Your watches, numbered |
| `DELETE` · `PAUSE` · `RESUME` + `ROUTINE 2` or `WATCH 2` | Deletes, pauses or restarts one by its number |
| `PANEL` · `DASHBOARD` | A one-time link to the control panel |
| `TELEGRAM` | A one-time link that pairs your Telegram account (see "Telegram") |
| `TELEGRAM OFF` · `TELEGRAM DISCONNECT` | Unpairs it |
| `MAIL` · `INBOX` | The last 24 hours of mail (with the email inbox) |
| `CODE` · `CODES` | The one-time codes of the last 30 minutes (with the email inbox) |
| `CALENDAR` · `AGENDA`, alone or with `TODAY` / `TOMORROW` | Today and tomorrow, or one day (with the calendar) |
| `ZOOM` · `MEETINGS` | The coming meetings and the latest summaries (with Zoom) |
| `BOOKINGS` · `MY BOOKINGS` | The tables asked for (with table booking) |
| `SLACK` | The last 24 hours of Slack messages for you (with Slack) |

A command whose feature is off is not a command: the word goes to Claude like any other message. `STOP` and `RESUME` also take "pako" after
them ("stop pako").

## Languages

- **Pako's own texts** (the answers to commands, cards and buttons, receipts, reminders, notices, the digests of mail, calendar, Slack, Zoom
  and tables, the panel) are in English, on a server and on a computer alike. `PAKO_LANGUAGE` is accepted and ignored (the log says so once).
- **Claude's answers** follow the language of each message you write, whatever it is.
- **Summaries of emails and meetings** are in your language: the language heard from your own messages, else
  English.
- **WhatsApp templates have one language**, the one Meta approved (`WHATSAPP_TEMPLATE_LANG`, default `en`). Create the templates in English;
  one approved in another language works when `WHATSAPP_TEMPLATE_LANG` names it, but the English notice then arrives inside its words.
- **The phone line** opens in English and switches to the other person's language if they answer in another one. The email and the
  `wa.me` text to a restaurant are in English.

## Telegram

A second chat beside WhatsApp (on a server) or beside the panel's chat (on a computer). It is a bot of your own, from
[@BotFather](https://t.me/BotFather): `/newbot`, a name, a username ending in `bot`, and it gives you a token.

**On a server:** put the token in `TELEGRAM_BOT_TOKEN`, restart, and write `TELEGRAM` in your chat with Pako. Open the link on your phone and
press **Start** (the link works once, for 10 minutes). What Pako starts by itself goes where you wrote last, and to Telegram when WhatsApp's
24 hours are over.

**On a computer, from the panel:** no file and no restart.

1. Paste the token in the panel's **Telegram** card. Pako checks it with Telegram first. Only a token Telegram accepts is kept, in
   `~/.pako/secrets.json` beside Pako's other secrets (readable only by you); it is never written to the log and never sent back to the page.
2. The card shows a QR code of the same one-time link `TELEGRAM` gives. Scan it with your phone and press **Start**. A newer code replaces
   an older one. Pako tells you in the chat which account it paired.
3. From then on, what Pako starts by itself goes to your phone: **reminders**, notices, receipts and the cards that wait for your press. The
   panel's chat keeps a copy, marked as sent to Telegram. Answers go where you wrote. If Telegram refuses a message, it appears in the panel's
   chat instead.

`TELEGRAM_BOT_TOKEN`, when it is set, wins over the token pasted in the panel: the panel can pair and unpair that bot, not change it.
A bot that already has a webhook (a server uses it) or that another Pako polls is refused, and the card says why; the card also offers
**Use another bot**, unless `TELEGRAM_BOT_TOKEN` sets it. `TELEGRAM OFF`, or **Disconnect** in the card, unpairs your account and keeps the token. A pairing belongs to one bot: another bot needs a new
pairing. Only the paired account is answered; `TELEGRAM_OWNER_ID` (your numeric Telegram user id) pins the owner to one account.

## Reminders

Ask it ("remind me tomorrow at 9 to call Ana", "remind me in 20 minutes to take the bread out") and it keeps the reminder **on the server** (so it survives a
restart and does not need your Mac on) and writes to you at that time. It says the exact day and hour it set; "what reminders do I have?" and "delete the
one about Ana" work. At most 20 waiting, up to a year ahead, the time is read in your time zone (daylight saving included).

The limit is WhatsApp's: this server can write to you first only **within 24 hours of your last message**. After that, reminders and every other
notice Pako starts (the morning brief, a meeting about to begin, an email, Slack) go through the **notice template** below; without it they wait for
your next message. See "The notice template".

**Repeats.** "Remind me every day at 8 to take my pill": Claude adds `every="day"` (or `weekday`, Monday to Friday, `week`, `month`,
`year`) to its `<remind>` tag, and the server sets each next time as one fires (the 31st becomes the last day of a shorter month). A repeat
keeps its id, so **Undo** on its receipt removes the whole series; `<unremind>` stops it too. A repeat that comes due while Pako cannot
reach you goes on to its next time and leaves one late copy for your next message: days missed in a row are one card (the latest), not one a
day, that copy does not count toward the 20, and removing the series removes it too.

**Buttons.** A reminder arrives as a card with **Done**, **+10 min** and **Tomorrow** (at the same hour). Each card is
answered once, also after a restart (kept 7 days under `assistant-reminders-fired`). **Done** on a repeat only acknowledges it and names the
next time. A reminder held while the 24-hour window was closed arrives as the same card when you next write; one sent by the notice template
has no buttons.

It checks every half minute and each time your Mac asks for messages (which also keeps the free web service awake). If the server and the Mac are both off, a
reminder is late. Not checked: the template route against Meta (the test number may not take custom templates), and a reminder across a real restart on Render.

## Lists and tasks

"Add milk and bread to the shopping list", "take the milk off", "I need to call the bank on Friday", "I've called the bank". Claude answers with tags
the bridge reads and removes:

- `<list name="shopping" add>milk; bread</list>` adds items (the list is made if it is new); `<list name="shopping" remove>milk</list>` takes them off.
- `<task due="2026-11-20">call the bank</task>` keeps a task; `due` only when you give a day.
- `<done>call the bank</done>` marks the open tasks with those words as done.

Each change gets a receipt with **Undo**, like a note. `LISTS`, `LIST shopping` and `TASKS` read them at once, the Mac off too, and the
brief names the tasks due today or overdue ("✅ Tasks for today: …"). They are kept on the server under `assistant-lists`: up to 20 lists, 100
items each, 100 tasks; a done task is kept for 7 days. The panel's **Lists and tasks** card shows them; on a computer an entry can be ticked or
removed there (`POST /panel/api/tasks/item`, `/panel/api/tasks/task`, signed-in cookie and `x-pako` header; a server answers 404).

**Old bridges.** The tags work once your Mac's bridge has the new code (`git pull`). An older bridge keeps working: its prompt does not offer
the new tags, so Claude does not write them, and the server accepts its answers as before. A new bridge talking to an older server sends fields that server ignores: Claude may say "noted" with no receipt.

## Notes: NOTES, FORGET, EDIT

The notes Pako keeps about you (60 at most) each have a number that never moves to another note: once note 3 is deleted, `FORGET 3` again
just says there is no note 3. `NOTES` lists them, oldest first, each with its day. `FORGET 3` (`FORGET NOTE 3`, `DELETE NOTE 3`) deletes one;
`EDIT 3: text` replaces its words and keeps its number and date. Each change gets a receipt with **Undo**, and an
undo puts a note back under its own number. These commands work while paused and with the Mac off. A sentence without the colon ("edit 3 photos
for me") goes to Claude.

The panel's **Memory** card says in a sentence what Pako knows (how many notes, recent calls, the latest note), then lists the notes by number.
On a computer each has **Correct** and **Delete** (Delete asks twice); a change there goes to the log, with no receipt in the chat. A server's
panel is read only and points to the chat commands. Routes: `GET /panel/api/memory` (signed in); `POST /panel/api/memory/edit` and
`/panel/api/memory/delete` (signed in, `x-pako` header, a computer only; 404 on a server, 409 when the note changed since the page showed it).

## The daily brief

One message a day at `MORNING_BRIEF` (default `08:00` in your time zone; `off` = only when asked), with or without a calendar: a greeting
with the day and your name, today's events from every calendar (Zoho and the ICS links; overlaps marked, join links, 15 at most and the rest
counted), the reminders still due today, the tasks due today or overdue, a mail line and a Slack line when those are on, and an invitation to ask.
With nothing connected it is two lines.

- It is urgent: Telegram when paired, WhatsApp inside the 24-hour window, else the notice template; without one it waits for your next message
  (cut to 1,500 characters if it is long). `STOP` does not hold it.
- Once a day: the day it was sent is kept in the store (`brief-state`), so a restart does not repeat it, and a server asleep at the hour sends
  it until noon (four hours for an hour of noon or later). If the store cannot be read it waits rather than risk a second one. A server
  upgraded from the version where the calendar sent the brief reads that day too, and both are read again just before sending, so the day of
  the upgrade (an old server still running beside the new one while Render deploys) gets no second brief.
- A calendar that could not be read is said: the brief lists the events of the others and adds that something may be missing.
- `BRIEF`, or the panel's **Today's brief** button (`POST /panel/api/brief`), gives it at once, and counts as that day's brief.
- A wrong `MORNING_BRIEF` is logged and turns off only the scheduled brief; before Phase 2 it turned the whole Zoho calendar off.

## Connections (on a computer)

The panel's **Connections** card, in local mode only: the Claude API key (optional; a Claude plan login is the default), the calendar's ICS
link (`CALENDAR_ICS_URL`), AgentMail (`AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX`, optional `AGENTMAIL_POLL_MINUTES`, `AGENTMAIL_WORK_DOMAINS`,
`AGENTMAIL_VIP`), Slack (`SLACK_USER_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_QUIET_HOURS`), Zoom (`ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`,
`ZOOM_CLIENT_SECRET`, `ZOOM_USER`, `ZOOM_POLL_MINUTES`) and table booking (`GOOGLE_PLACES_API_KEY`). Telegram points to its own card; the phone
line stays in [docs/personal-caller.md](../docs/personal-caller.md).

- Each value is checked as Pako checks it at start (an AgentMail key and inbox also with AgentMail itself) before it is kept, in
  `~/.pako/secrets.json` under `settings` (mode 600). It is never sent back: the card shows "set" and, for a long value, its last 4 characters.
- At start the stored values fill only what is unset: a value in the terminal, `~/.pako/.env` or `./.env` wins, and the card says so.
- After a save Pako restarts itself: the same process (`execve`) under `npm start`, launchd or systemd; exit code 75 for a pm2-like parent;
  the watcher restarts it under `npm run dev`; a new process on Windows (not tested there). The panel reloads when `/health` answers.
- **Desconectar** (**Disconnect**) removes a connection's values; an empty field leaves a value unchanged, so one optional value cannot be
  cleared alone from the card.
- Routes: `GET` / `POST /panel/api/connections` and `POST /panel/api/connections/remove`: signed-in cookie, `x-pako` header on writes, rate
  limited; a server answers 404.

## The notice template (so briefs, reminders and alerts always arrive)

WhatsApp lets a business number write first only within 24 hours of your last message. Outside that window only an **approved template** goes
through. With one, Pako always reaches you:

- **A notice that fits** (up to 600 characters on one line: a meeting in 10 minutes with its Zoom link, a reminder, a short email alert) arrives whole.
- **A longer one** (the morning brief, a long summary) is kept; a preview arrives with a **Ver** button. Tap **Ver**, or write anything, and Pako sends
  everything that was waiting.
- **Urgent notices** (a meeting about to start, the brief, reminders) always ping. Ordinary ones (emails, Slack) ping at most every half hour, saying
  how many are waiting.

### Create it (about three minutes, in Meta)

1. Open [WhatsApp Manager → Message templates](https://business.facebook.com/wa/manage/message-templates/) for the business account of your app
   (the one with the test number) and **Create template**.
2. **Category:** Utility. **Name:** `pako_notice`. **Language:** English (`en`).
3. **Body:** `Notice from your assistant Pako: {{1}}. If there is more, tap See.` with the sample for `{{1}}`: `Meeting "Committee" in 10 minutes`.
4. **Buttons:** Quick reply, text `See`. No header, no footer.
5. **Submit.** Approval usually takes minutes; WhatsApp Manager shows "Active" when it is approved.
6. In **Render** (the service, Environment): `WHATSAPP_REMINDER_TEMPLATE` = `pako_notice` (`WHATSAPP_TEMPLATE_LANG` = `en` is the default).
   A template already approved in another language (an older Spanish `pako_aviso`, say) still works: name it here and set
   `WHATSAPP_TEMPLATE_LANG` to its language (`es`).

Meta charges for templates sent outside the 24-hour window (Utility, a few cents each; see Meta's pricing page); inside the window nothing changes.
If Meta changes the category or refuses the template, the log says so on the first send and notices simply wait for your next message, as before.

## Voice notes

Send it a voice note on WhatsApp or Telegram and it answers in text. The audio is fetched from WhatsApp by the server (the Meta token never leaves it), handed to your
Mac, and turned into words **on your Mac** with [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and ffmpeg: no speech-to-text service, no key, no
bill, and the audio is deleted as soon as it is transcribed. Claude sees the words, marked as "[Voice note, transcribed automatically]" so it asks when a name or a number
is unclear. A forwarded voice note is someone else's words: it is given to Claude as a forwarded block, and its turn is marked.

```bash
bash assistant/voice-setup.sh        # installs whisper-cpp and ffmpeg with Homebrew, downloads the "small" model (about 470 MB), sets ASSISTANT_WHISPER_MODEL
launchctl kickstart -k gui/$(id -u)/local.pako.assistant
```

On a computer alone (local mode) the assistant reads `~/.pako/.env`, not `assistant/.env`: run
`ASSISTANT_ENV_FILE=~/.pako/.env bash assistant/voice-setup.sh` instead, then stop Pako and start it again. The script needs macOS and
Homebrew; elsewhere, install whisper.cpp and ffmpeg yourself and set `ASSISTANT_WHISPER_MODEL` to the model's path.

`WHISPER_SIZE=medium bash assistant/voice-setup.sh` is better with names and noise, about 1.5 GB and slower. Until a model is set, a voice note gets one line
saying this Mac cannot listen yet. Not checked: a real voice note through Meta and a real Whisper run (the tests use fakes for both); the model is
downloaded from Hugging Face's `ggerganov/whisper.cpp` repository and its checksum is not verified by the script. Nothing here hears the owner's phone calls:
the phone line has its own voice stack.

Settings (all optional, in `assistant/.env`): `ASSISTANT_WHISPER_MODEL` (path of the model; set by the script), `ASSISTANT_WHISPER_BIN` (default `whisper-cli`),
`ASSISTANT_FFMPEG_BIN` (default `ffmpeg`), `ASSISTANT_WHISPER_LANG` (`auto` by default, or a code like `es`), `ASSISTANT_MODEL` (the model `claude` runs: by default the one named in
`assistant/bridge.ts`, or any other model id your plan allows; one message costs about 1.4 cents at list price on the default),
`ASSISTANT_WRITING_MODEL` (the morning brief and the drafts: `claude-opus-5-5` by default; `off` or empty for `ASSISTANT_MODEL`; when the plan
cannot use it they run on `ASSISTANT_MODEL` for the rest of the day, see [docs/configuration.md](../docs/configuration.md)),
`ASSISTANT_TOOLS` (default `WebSearch`; empty for none; tools that run commands
or edit files are refused; **adding `WebFetch` is a risk: a web page or a forwarded message can make Pako fetch a link that carries your notes
out to someone else's site, before any card asks you**), `ASSISTANT_ROTATE_AFTER` (a new conversation every N messages, default 30), `ASSISTANT_RUN_TIMEOUT_MS`,
`ASSISTANT_TYPED_TOOLS` (on when this Claude Code can load Pako's own MCP server, `assistant/mcp-server.ts`; `off` for the tags alone, as before).

Typed tools: the conversation's `claude -p` gets Pako's MCP server through a generated `--mcp-config` (with `--strict-mcp-config`, so no other
server) and `--allowedTools` naming each of its tools, `mcp__pako__remind` and so on (`assistant/tools.ts` has the list, each with a zod schema).
Its side-effect tools never act: they check the arguments and answer "queued"; the bridge reads the accepted calls from the run's stream-json
output and folds them into the same reply a tag gives (`readReply`), so the server path is unchanged. A wrong argument is a tool error that names
the field, and Claude calls again within the turn. The read tools answer from `tool-data.json` in the state folder, a copy of the turn's context.
With tools on, the system prompt's tag section (about 11,600 characters) becomes a short tools section; the tag parser still runs on every answer,
and a run whose MCP server did not load turns the tools off for the rest of the bridge's run.

How much of the plan Pako uses (`assistant/budget.ts`; on a computer these go in `~/.pako/.env`): your own messages are never held back. The runs
Pako starts by itself (an email to triage, a meeting to summarize or review, follow-ups to extract, a proactive check, a judge, the morning brief) share
`ASSISTANT_BACKGROUND_PER_DAY` (default 40; proactive checks and judges stop at half of it; 0 for none). A job whose material is the same as one answered
in the last `ASSISTANT_COALESCE_MIN` minutes (default 10) gets that answer again; a proactive check that found nothing to say is not asked again for
`ASSISTANT_UNCHANGED_MIN` (default 120) while what it reads stays the same. When Claude says the plan's limit was reached, the background work waits
until the reset it names. A job left without a run is answered without Claude: an email is kept with its first lines (a VIP sender is still told), a
review leaves Zoom's own summary, the morning brief goes as the server builds it by itself. The short verdicts (an email, a proactive check, a judge) ask
for `ASSISTANT_BACKGROUND_EFFORT` (default `low`; empty for none). `ASSISTANT_WARM_MIN` (default 10; 0 for a new process per message) keeps your
conversation's `claude` process up between messages, which saves its start (about 1 to 3 s a message). The System card shows the day's runs: yours,
the background ones against the cap, and the jobs handled without Claude; the bridge's log says it too (`npm run bench:latency` times the answers).

## STOP, RESUME and the log

These are answered by the server itself, at once, even when the Mac is off (accents, capitals and a final "!" do not matter):

- **`STOP`** (or `PAUSE`): nothing goes out to anyone. No call is placed (to you or a friend; from WhatsApp, the Caller connector
  or the voice line) and no WhatsApp is sent from the assistant's number; a card that was waiting is dropped, and a later press says it is paused.
  The chat with you, your reminders and the email summaries go on (they only reach you), and the assistant is told it is paused. It survives a
  restart of the server (it is kept in the key value store).
  If the store comes back empty (Render's free Key Value keeps nothing when Render restarts it), Pako starts **paused** and tells you, with what
  may be lost; while it cannot read the store at all, it acts as paused. A sentinel key (`pako-store-id`) tells a wiped store from one in use.
  Each of the three pauses has its own wording, and only yours says STOP; the log names the reason ("paused (STOP)", "paused (store empty)").
- **`RESUME`**: back to normal.
- **`LOG`**: the last 15 things it did, one line each: calls placed or stopped, messages sent or failed, reminders set and sent,
  emails passed on, notes kept or deleted, pauses. The server keeps the last 300 for 90 days; `GET /admin/log` (admin key) gives them as JSON.

## Receipts and UNDO

When the assistant changes something by itself (it keeps or deletes a note, sets or removes a reminder), the server sends you one short receipt
with exactly what changed, from what it really did, and an **Undo** button. Pressing it (within 7 days), or writing **`UNDO`** (the latest change of the last 24 hours, never one further back; older changes keep their own button), puts it back: a deleted
note returns with its date, a reminder that has already fired or was moved since is named instead of brought back, and an undo that finds no room
(60 notes) stays open until you make some. The receipt goes to the chat you wrote on, right after the answer; one held while WhatsApp's 24-hour
window was closed arrives with its own button when you next write.

## One-time codes and CODE

Sign-in and verification codes in the emails Pako's inbox receives are replaced by
`[code hidden · type CODE]` before anything else sees them: the summary, the notice on your lock screen, `MAIL`, the panel, the log and Claude itself. **`CODE`** (also `CODES`) shows the codes of
the last 30 minutes, newest first; the log records that you looked, never the code. `MAIL_SHOW_CODES=1` leaves codes visible.

## Calendar (Zoho, read only)

Pako reads your Zoho Calendar with read-only access (it cannot create, move or answer events). Without Zoho, any calendar's secret ICS link
(`CALENDAR_ICS_URL`; Google, Outlook, iCloud) gives the same `CALENDAR`, reminders before events and brief events, read every 10 minutes; with
both, a meeting in both is said once and reminded of once (also when one of the two fails to load between two looks). Rules no calendar app
writes (repeating every second or minute) are left out, with a line in the log. See the README's "Every day" and [docs/personal-caller.md](../docs/personal-caller.md).

- **`CALENDAR`** (or `AGENDA`) on WhatsApp: today and tomorrow; **`CALENDAR TODAY`** or **`CALENDAR TOMORROW`**: one day (a bare "tomorrow" is an answer to the assistant, not a command). Events that overlap are marked ⚠️.
- **In the chat**: the assistant sees the next seven days ("do I have anything on Thursday afternoon?", "when do I have a free slot?").
- **⏰ A few minutes before each timed event** (`CALENDAR_REMIND_MINUTES`, default 10; 0 = off), with its place and the **Zoom link** from the
  invitation (or Meet / Teams). The owner's meetings are on Zoom with the invitations sent from Zoho Calendar, so this covers them without the Zoom app.
  `CALENDAR` marks those events (Zoom).
- **☀️ Today's events in the daily brief**, which is no longer part of the calendar: see "The daily brief" (`MORNING_BRIEF`, `src/brief.ts`).
- It reads the events of the next two weeks every five minutes. `ZOHO_CALENDARS` (comma list of calendar names) limits it to some calendars.

### Set it up (about three minutes, no terminal)

1. Go to the Zoho API console for your region (for Europe: [api-console.zoho.eu](https://api-console.zoho.eu); `.com` for the US).
   **Add Client**, **Self Client**, **Create**. Under **Client Secret** you see the Client ID and the Client Secret.
2. In Render (the service, Environment), type `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, and `ZOHO_DC` (`eu` if your Zoho address ends in `zoho.eu`,
   `com` for `zoho.com`; default `eu`). Do not save yet.
3. Back in Zoho, **Generate Code**: Scope `ZohoCalendar.calendar.READ,ZohoCalendar.event.READ`, the longest time it offers, any description,
   **Create**, copy the code.
4. In Render, add `ZOHO_GRANT_CODE` with that code and **save at once** (the code lasts only a few minutes). Render restarts; the log says
   `[calendar] the grant code was exchanged`. The access is kept in the key value store and does not expire; `ZOHO_GRANT_CODE` can be removed later.
5. On the Mac: `git pull` and restart the assistant. Write `AGENDA`.

If the log says the grant code was refused, it expired: generate a new one and save it again.

## Zoom (read only)

Pako reads your Zoom with read permissions only (it cannot create, change or join meetings). There are two ways in:
- On your computer, connected from the panel with one button (the project's app) or your own app (one paste)
  ([docs/channels.md](../docs/channels.md#slack-and-zoom-from-the-panel)).
- On a server, or for an admin who prefers it, **a Server-to-Server app** on the company's Zoom account (the steps below).

Either way:

- **After a meeting, every meeting is reviewed.** Zoom's **AI Companion** summary (or, without one, the **cloud recording transcript**, 30
  minutes after the recording ends in case Zoom's own summary comes) goes to the Mac, which reads it in a separate run (no tools, no
  conversation: what people said cannot make Pako act) and answers with JSON only, which the server checks field by field:
  - **your to-dos** (who is waiting, by when, the words that show it), **what others promised you**, the **decisions**, the **follow-up
    meetings agreed** (with their time zone) and the **open questions**;
  - you get **one short message with your own to-dos only** (`🎥 From the meeting “Topic” (13/11 16:00), on you: …`), or **nothing** when the
    meeting left you none. The rest is in the panel, with the summary;
  - the to-dos, the promises and the meetings become follow-ups (see "Follow-ups"): a meeting to set up is looked for on your Zoom two hours
    later; someone's promise with no time is asked about once, two days later.
- **`MEETING TODOS`**: what is still open from the last 7 days of meetings, by meeting, with the open questions.
- **As before when it can't review:** with `ZOOM_REVIEW=off`, an older assistant computer (it lets the review go: `git pull` and restart it
  to get reviews), the computer not asking for messages in the last three minutes (off or asleep: the summary comes at once), or no answer
  within `ZOOM_REVIEW_WAIT_MIN` minutes (default 120), Zoom's summary comes as it is; an older computer summarizes a transcript and tells it,
  as before. A transcript the computer never answers is told as not reviewed after a day.
- **`ZOOM`** (or `MEETINGS`) on WhatsApp: the meetings of the next seven days and the latest summaries. The assistant knows them too ("what
  meetings do I have tomorrow?", "what was decided at the committee?").
- It looks every 10 minutes (`ZOOM_POLL_MINUTES`); the first look only marks the meetings already there.

### Set it up (about five minutes; you need to be an admin of the Zoom account, or ask one)

1. Go to [marketplace.zoom.us](https://marketplace.zoom.us), **Develop**, **Build App**, **Server-to-Server OAuth App**, name it `Pako`.
2. **App Credentials:** keep the page open: Account ID, Client ID, Client Secret.
3. **Information:** fill in the short required fields (company, your name and email).
4. **Scopes:** **Add Scopes** and pick only these (all are read):
   `meeting:read:list_meetings:admin`, `meeting:read:summary:admin`, `meeting:read:list_summaries:admin`,
   `cloud_recording:read:list_user_recordings:admin`, `cloud_recording:read:list_recording_files:admin`.
5. **Activation:** **Activate your app**.
6. In **Render** (the service, Environment), type yourself: `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` (from step 2) and
   `ZOOM_USER` (your Zoom email). Optional: `ZOOM_POLL_MINUTES` (default 10).
7. Render restarts; its log says `[zoom] ON`. On the Mac: `git pull` and restart the assistant (for the meeting reviews and the transcript
   summaries). Write `ZOOM`.

The reviews use the same scopes: Zoom's summaries (`meeting:read:summary:admin`, `meeting:read:list_summaries:admin`) and the cloud
recordings' transcripts (`cloud_recording:read:*`). Nothing new to add. Pako lists the summaries and recordings of `ZOOM_USER`
(the meetings you host); a meeting someone else hosted is not covered yet. Notes typed in Zoom (Zoom Docs / Notes) are not read.

For summaries without a recording, AI Companion's "Meeting summary" must be on in Zoom's settings, and the account setting "Only share meeting
summaries by email" off. For transcripts, cloud recording with "Create audio transcript" on.

## Slack (read only)

Pako reads your work Slack through a Slack app that only has read permissions (it cannot write anything):

- **A direct message, a group DM, or a mention of you in a channel** becomes a WhatsApp at once: `💬 Slack · Ana (privado): …`. Several messages
  from one conversation within 15 seconds come together. Other channel messages do not ping you.
- **Not copied by default** (`SLACK_FORWARD`, default `off`): Slack already notifies you, so Pako keeps the messages for `SLACK`, its answers and the
  morning brief without sending you a copy. `SLACK_FORWARD=on` sends each one as before.
- **At night** (`SLACK_QUIET_HOURS`, default `23:00-08:00` in your time zone; `off` for never) they wait and come in one message in the morning.
- **`SLACK`** on WhatsApp: the last 24 hours of those messages, answered by the server at once.
- **In the chat** ("what did Ana say about the report on Slack?") the assistant searches Slack (`<slack>`, Slack's search syntax) and answers from the
  results. Slack text is other people's words: the answer built on it can carry no tag, so a Slack message can never make Pako call, send or note anything.
- When WhatsApp's 24-hour window is closed (you have not written for a day) a notice is kept and given with your next message; emails work the same way.

On your own computer (no public address), use Socket Mode instead of the events address: the steps are in the main
[docs/channels.md, "Slack and Zoom from the panel"](../docs/channels.md#slack-and-zoom-from-the-panel) (one paste and one Allow). The steps below are for a server.

### Set it up (about five minutes; an admin of the workspace may have to approve the app)

1. Go to [api.slack.com/apps](https://api.slack.com/apps), **Create New App**, **From a manifest**, pick your workspace, choose YAML and paste:

```yaml
display_information:
  name: Pako
  description: Your assistant (read only)
oauth_config:
  scopes:
    user:
      - channels:history
      - channels:read
      - groups:history
      - groups:read
      - im:history
      - im:read
      - mpim:history
      - mpim:read
      - users:read
      - search:read
settings:
  event_subscriptions:
    request_url: https://YOUR-SERVER/slack/events # your server's own https address
    user_events:
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

2. **Create**. Slack checks the events address; the server answers it even before it has the app's values.
3. **Install to Workspace** (OAuth & Permissions) and allow. If the workspace needs an admin's approval, Slack asks for it.
4. In **Render** (the service, Environment), type yourself:
   - `SLACK_USER_TOKEN`: the **User OAuth Token** (OAuth & Permissions, starts with `xoxp-`).
   - `SLACK_SIGNING_SECRET`: the **Signing Secret** (Basic Information, App Credentials).
   - Optional: `SLACK_QUIET_HOURS` (default `23:00-08:00`, or `off`).
5. Render restarts; its log says `[slack] ON`. On the Mac: `git pull` and restart the assistant (for the `<slack>` search). Ask someone to send you
   a direct message, or write `SLACK`.

## Follow-ups (what you were asked or promised)

Pako notices what other people ask of you and what you promise, and reminds you only when it can't see it done:

- **Where from:** the Slack messages kept for you (direct messages, group DMs, mentions), your email, and meeting outcomes (Zoom's own
  summary, or the Mac's summary of a transcript). A conversation's messages are gathered for a few minutes (`FOLLOWUP_BATCH_MIN`, default
  3) and read together with its last messages and your own replies.
- **Email, from the real words:** the server picks the mail (never a model): what the triage filed as Needs you, Waiting on others,
  Important or Personal, told to you or not, and every email you sent (your Sent folder, by IMAP). Never Updates, Read later, Promotions,
  Suspicious, a scam, or mail sent to a list (`List-Unsubscribe`, `List-Id`, a bulk `Precedence`). What is read is the email's newest
  message as plain text (the quoted history, reply headers and signature removed; about 4,000 characters at most), with its From, To, Cc,
  date and subject, and the thread's open follow-ups, so your reply ("attached is the signed NDA") closes what was asked and your promise
  ("I'll send it Friday") becomes yours. A thread's new emails are read as one job; an email is never read twice. At most
  `FOLLOWUP_MAIL_JOBS_PER_DAY` jobs a day (default 40); past that, or with `0`, the triage's own LOOP line is used, as before.
- **Read in isolation:** the assistant's computer reads them in a run of their own (no tools, no conversation, nothing acted on) and answers
  with JSON only; the server checks every field. Thanks, FYIs and chit-chat make nothing. Other people's text can never make Pako act: a
  follow-up never posts, schedules or writes anything; it only reminds you.
- **Checked, then said once:** `FOLLOWUP_DELAY_MIN` minutes (default 10) after the ask, Pako looks: your Zoom (a meeting near that time, or
  whose topic names those people), your calendar, your own posts in that Slack conversation (a reply, a Zoom link). Done: nothing is said (the
  log has it). Not done: one message that says what it checked and what it could not see, with the time in both zones ("at 5:15 AM ET
  (10:15 London)"), and three buttons: **Done**, **In 1 h**, **Not mine**. Near the deadline it looks again and, if still not done, says it
  once more. Mail you sent can't be seen: Pako says so instead of guessing.
- **Never late, never stale:** once a meeting's time has passed (a late check, a restart, the quiet hours), nothing more is said about it; a
  few hours later it leaves `PENDING` and the brief. After its reminder a follow-up is still looked at silently (every few hours when it
  has no time; just before its time when it has one), so one you did without pressing **Done** closes by itself. The brief says when each
  check ran.
- **What counts as the meeting:** a repeating meeting (a weekly standup, a 1:1) never does; one at the time asked counts whatever its topic only
  if it was set up after the ask; otherwise its topic must name the people asked for. If you answered in that Slack conversation (the meeting
  hosted by someone else, say), the 10-minute reminder is skipped and only the one near the time comes, saying you replied.
- **Later messages count:** the reading is given the conversation's open follow-ups, so "nvm, Stan set it up" closes one and "any news on
  the setup?" is not a second one. A Slack thread is read as its own conversation (its first message and its replies), and your reply in
  the thread counts.
- **Someone else's promise** ("I'll set up a tech call…"): their meeting is never on your Zoom, so Pako looks once, an hour before the time,
  for their invitation on your calendar, and says so only if it is not there.
- **Budgets:** at most `FOLLOWUP_MAX_PER_DAY` reminders a day (default 6), none in `FOLLOWUP_QUIET_HOURS` (default your Slack quiet hours).
- **Not mine** keeps a short rule (that person, that place, that kind of thing), and the next reading is given it.
- **`PENDING`** (`OPEN`, `OPEN LOOPS`): what is still open, newest first, with where each came from. The assistant gets the same list briefly,
  so you can ask it "what am I forgetting?".
- **Update the assistant's computer:** `git pull` and restart it. An older one lets these jobs go unread: no follow-ups, no reminders, and
  nothing else changes. A computer updated before the "later messages count" change still works, but cannot close a follow-up from a later
  message until it is pulled again. `FOLLOWUPS=off` turns the whole thing off.
- **The rehearsal** (`REHEARSAL`, or the panel's **Rehearsal** card) sends the same isolated jobs (inbox ids `rh:` and `rb:`) over the last 48 h of
  what the server already keeps, at most 20 a run, and the server reads their answers against a copy: nothing is kept, nothing is sent. No
  change is needed here; a computer too old for follow-up or brief jobs lets them go, and the card says to update it.

## The written brief (the morning brief, like a chief of staff's)

At `MORNING_BRIEF` the server gathers the day's facts, with no model: your open follow-ups (with what Pako checked), the last week's meeting
summaries, the Slack messages kept for you, today's and tomorrow's events and Zoom meetings, your tasks, the mail summaries, birthdays and
today's reminders. Each fact gets a short id (L1, Z1, S1, E1…), and its text is neutralised: other people's words are information, never
instructions.

- **Written in isolation:** the assistant's computer writes the brief in a run of its own (no tools, no conversation, nothing acted on) and
  answers JSON only: an opening line, the one piece of work to push forward (with an offer of something Pako can prepare), three to five
  to-dos, two to four updates, and your day. The server checks every field: an item that cites no fact, or an id it never gave, is dropped;
  the times of real events come from the calendar, and a meeting only agreed in a message stays "(time unconfirmed)". Times are in your time zone,
  other zones converted.
- **Delivered:** a short version on the chat (the opening, the focus, the to-dos, the day) with the address of the full page,
  `/panel/brief`: an editorial page with each item's sources, a box per to-do (ticking it closes its follow-up or its task), **Let's do it** on
  the focus and **Prep me** per meeting. Each of those is another isolated run whose document shows on the page and goes to the chat.
- **Nothing breaks without it:** an older assistant lets the job go and the brief goes as before at once; a computer that is off, or a run
  that fails, gives the old brief after `BRIEF_WAIT_MIN` minutes (default 15). `BRIEF_SMART=off` keeps only the old brief.
- **Update the assistant's computer:** `git pull` and restart it to get the written brief.

## Email: the assistant's own inbox (AgentMail)

The assistant has an email address of its own (not yours) at [AgentMail](https://agentmail.to), on the free plan: an `@agentmail.to` address, no domain
and no card. It **reads and tells you**; it sends only the table request you approve with a button (see "Tables").

```
someone ──email──► AgentMail ──signed webhook──► this server (src/mail.ts) ──► your assistant inbox ──► your Mac ──► WhatsApp: "📧 Email from …"
                                  ▲ every 10 min the server also lists the inbox, in case a webhook was missed
```

- **Only what matters reaches you.** All your mail (personal and work) can be forwarded here, so each email is sorted:
  - **Before Claude** (it costs nothing): a sender rule you taught with Move to…; mass mail (`List-Unsubscribe`, `List-Id` or `Precedence: bulk`)
    goes to Read later (newsletters) or Promotions; a known carrier's or shop's notice goes to Updates.
  - Everything else is read by Claude, which files it in one of eight categories: **Needs you**, **Waiting on others**, **Important**,
    **Personal**, **Updates**, **Read later**, **Promotions** or **Suspicious**, with a one-line why (docs/features.md, "Mail categories").
  - Only Needs you, Suspicious and security alerts come as a message by default; the switches are in the panel's Mail settings.
    **VIP senders** (`AGENTMAIL_VIP`) always reach you.
  - A message says who sent it, the subject, and two or three lines with the dates and amounts that matter; work mail is marked 💼. Something
    that looks like a scam starts with a warning, in your language, and the panel shows it in red, whatever language the summary is in.
- **`MAIL`** (or `INBOX`) on WhatsApp: the server answers at once with the last 24 hours,
  category by category (newsletters and offers by sender).
- **An email cannot make the assistant act.** Its words are a stranger's: the Mac summarizes it in a separate run with no web search, outside your
  conversation, with a prompt that only asks for a summary, and every tag in the answer is thrown away. No call, note, message or reminder can come
  from an email; only you can ask for those, in the chat.
- **You can ask about it.** The assistant sees its address, its latest fifteen emails that are not mass mail (account, sender, subject, summary)
  and how many mass emails came, marked as other people's text: "did anything come from Amazon?" works. It does not see attachments, only their names.
- **Spam, blocked and unauthenticated mail** (no SPF, DKIM or DMARC pass) is filtered by AgentMail and never reaches you. Viruses are dropped by AgentMail.
- **What the server keeps:** the ids of the last 300 emails and the last 150 with their summary, in the key value store. The emails themselves stay
  at AgentMail (a third party).
- **The first listing** of an inbox that already has mail marks it as seen without telling you, so you are not flooded.

> **On a computer at home** (local mode) AgentMail cannot reach Pako with a webhook, and that is fine: put `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX` in
> `~/.pako/.env`, leave the webhook secret out, and Pako lists the inbox every 10 minutes (`AGENTMAIL_POLL_MINUTES`). Steps 3 and the secret are for a server.

### Set it up (about ten minutes, in AgentMail's console)

1. Sign up at [agentmail.to](https://agentmail.to) (free plan) and create an inbox with the name you like, for example `my-assistant@agentmail.to`.
2. **API key:** create one scoped to that inbox with only `inbox_read` and `message_read` (not `message_send`).
3. **Webhook:** URL `https://YOUR-SERVER/email/webhook`, event `message.received`, only that inbox. Copy its signing secret (it starts
   with `whsec_`).
4. In **Render** (the service, Environment), type the three values yourself; never paste them in a chat:
   - `AGENTMAIL_API_KEY`: the key from step 2.
   - `AGENTMAIL_INBOX`: the inbox id, which is its address (`my-assistant@agentmail.to`).
   - `AGENTMAIL_WEBHOOK_SECRET`: the `whsec_…` secret from step 3.
   - Optional: `AGENTMAIL_POLL_MINUTES` (default 10; 0 turns the listing off).
5. Render restarts; its log says `[mail] ON`. On the Mac: `git pull` and restart the assistant (the summary prompt lives there).
6. Send an email to that address from your own mail. The WhatsApp should come within a minute; if it does not, the webhook's delivery log in
   AgentMail's console says what the server answered.

Optional settings: `AGENTMAIL_WORK_DOMAINS` (a comma list of domains, for example `mycompany.com`; empty by default: mail forwarded from an address on these domains is marked as
work) and `AGENTMAIL_VIP` (a comma list of addresses or `@domains` that always reach you, for example `ceo@example.com,@example.org`).

### Forward all your mail here

Do it once the sorting above is deployed and the Mac has pulled it (otherwise every email is a WhatsApp). Keep a copy in your own inbox.

- **Gmail (personal):** Settings, See all settings, Forwarding and POP/IMAP, Add a forwarding address: `<your-inbox>@agentmail.to`. Google sends a
  confirmation code to that address: it reaches you on WhatsApp; type it in Gmail. Then choose "forward a copy" and "keep Gmail's copy in the Inbox".
- **Google Workspace or Microsoft 365 (work):** the same in Gmail, or in Outlook: Settings, Mail, Forwarding (or a rule "Redirect to"). Microsoft 365
  blocks forwarding outside the company by default: an administrator must allow it (Defender, outbound spam policy, automatic forwarding).
- **Check it:** send yourself a test email to each address, then write `MAIL`. Forwarded mail sometimes fails the sender checks (SPF) and AgentMail
  drops what it labels unauthenticated; mail signed with DKIM (most of it) survives forwarding. If a sender never arrives, tell the session.
- **Limits:** AgentMail's free plan holds 3,000 emails a month. Each email that is not mass mail is one run of Claude (about a cent), on your own Claude plan.

## Tables: book a restaurant (Google Maps, the restaurant's own site, and the assistant's inbox)

You write "book a table for 4 on Friday at 21:00, a Japanese place in Soho" (or say it in a voice note, or ask Claude through the connector **Pako
Assistant**). What happens:

1. **It searches for real.** Google Places gives the restaurants (open at that time by Google's hours, rating, price) and Pako reads each one's own
   website for how it takes bookings: an email address, a booking page (CoverManager, TheFork, SevenRooms, OpenTable, Resy…), a WhatsApp, a walk-in-only
   notice, and what it says about paying to book (a deposit). Nothing is invented; if the site cannot be read it says so.
2. **You pick.** Up to three, best first (a restaurant Pako can actually write to ranks above a slightly better rated one it cannot). You answer `1`, `2`,
   `3` or `NO` (in words too: "option 2", "the 2", "none").
3. **One card.** For a restaurant that takes email, you get the exact action ("I'll email bookings@… from <your-inbox>@agentmail.to asking for a table at … for 4,
   Friday 21:00, under the name …") with a button **Email them**, or your next message "yes". Only that press sends the email. The text of the email is
   fixed (the facts filled in, never written by a model), says it comes from an AI assistant with your permission, and asks the restaurant to reply to the
   same address: the reply lands in the inbox and reaches you like any other email ("📧 Email from …").
4. **No card needed when Pako sends nothing.** For a restaurant with a booking page you get the link; with a WhatsApp, a `wa.me` link with the request
   written (you press send, as with every message in your name); with only a phone, the number. Pako cannot confirm those for you.

Limits and rules: nothing is written while paused (**STOP**); at most 5 requests a day and one per restaurant a day; at most 4 months ahead and 20 people;
a restaurant's text is shown, never obeyed. `BOOKINGS` (and the panel's Bookings card) lists what was asked: "requested by email, waiting for an answer" is **not**
a confirmation until the restaurant answers. Table booking comes from an earlier project's restaurant engine (git tag `connector-final`), trimmed to
what Pako uses (the old connector's accounts, approvals, payments and call jobs are not part of it).

### Set it up (about ten minutes)

1. **Google Places key.** In [Google Cloud](https://console.cloud.google.com/), create a project, turn on **Places API (New)**, create an API key and restrict it
   to that API. In Render → Environment add `GOOGLE_PLACES_API_KEY`. Google bills each search (Enterprise-tier fields: roughly a few cents per search of ten
   restaurants; there is a monthly free allowance); one request to Pako costs one search plus one details lookup at most.
2. **An AgentMail key that can send.** The key you made for reading may be read-only. Email is sent only if the key has the `message_send` permission: create
   a new key in AgentMail's console limited to the `pako-assistant` inbox with the read and **send** permissions and put it in `AGENTMAIL_API_KEY`. Without it,
   Pako tells you the AgentMail key isn't allowed to send and gives you the other ways (page, WhatsApp, phone). AgentMail's free plan allows 100
   emails a day and does not support cold outreach: a single reservation request to a restaurant that publishes its address is the intended use, but if
   AgentMail ever objects, requests stop and the other ways remain.
3. Nothing else: the assistant's prompt already knows the `<book>` tag, and the Mac needs the new code (`git pull`, then restart the assistant).

Not built, and why: **Pako does not phone restaurants yet** (the phone line's friend calls are broken on the Zadarma/Retell side since 11-12; the restaurant
call script is the next step once it works), and it does not drive booking websites itself (the platforms' terms forbid bots; their pages are handed to you
filled in). The connector in Claude (**Pako Assistant**, one connector for the phone line and tables) shows `find_restaurants` (reads only) and
`book_restaurant` (puts the options on your WhatsApp; books nothing).

## What it does not do yet

- Files other than photos (JPEG, PNG, WebP) and PDFs: it says it cannot read them. HEIC photos are refused with a way round.
- Your files: Claude cannot see them. Your own email only when you set IMAP (read only, see "Deeper help").
- Sending email, except the one table request you approve with a button (see "Tables").
- Messages of its own outside WhatsApp's 24-hour window, unless you set up the notice template (above) or Telegram: WhatsApp only allows pre-approved templates there.
- Sending a WhatsApp as your own personal account: not possible with the official API (it sends from the business number); the `<message>` link is the honest
  way, and an unofficial linked-device library is not used (it breaks WhatsApp's terms and risks your number).
- Calls to the owner or on the phone line are unchanged: the voice line stays on Gemini Live.

## Checked, and not

Checked by tests: the server's signature, owner-only, duplicate and bridge-token rules, the call confirmation (buttons and words), the call's
outcome report, persistence (`test/whatsapp.test.ts`); the bridge with a fake `claude` and a fake server (`test/assistant-bridge.test.ts`).

Checked live (2026-11-14, Meta's test number, the owner's phone and Mac): a message through Meta and back, owner recognition, a web search, a kept
note, and a proposed call with its button.

Not checked: a call that really connects (the phone line is down at the time of writing), the renewal of the Meta token (a temporary one ends
after 60 days: use a system-user token), a reply longer than 4,000 characters.
