# Personal caller

A private connector that lets your own Claude phone **you**, and a short list of **friends you approve by name**, from the Retell number this server already uses. It has its own secret address, its own Retell agent and its own limits (the Retell account may still hold the old restaurant agent from the `connector-final` tag; this never uses it). Off until you set `PERSONAL_CALLER_TOKEN`; a dry run (nobody is rung) until you set `PERSONAL_LIVE=1`.

This chat cannot be on the line itself (a chat turn is text, not live audio): the call is Retell's phone and speech layer with a Claude model, chosen below, as the brain.

Source: `src/personal-caller.ts` (tools, limits, routes) and `src/personal-agent.ts` (the agent's prompt and voice settings).

## Settings (Render, Environment: type the values yourself)

| Variable | Needed | What |
|---|---|---|
| `PERSONAL_CALLER_TOKEN` | yes | The secret in the connector address. 24+ letters, digits, `-` or `_` (`openssl rand -hex 24`). Remove it and the feature is off |
| `PERSONAL_OWNER_NUMBER` | yes | Your mobile, E.164 (`+14155550100`). `call_me` can dial only this |
| `PERSONAL_OWNER_NAME` | yes | How the assistant names you ("I'm Ana's AI assistant") |
| `PERSONAL_CONTACTS` | no | Friends as JSON, name to number: `{"Ana":"+447700900123"}`. Without it the friend tools do not exist |
| `PERSONAL_CONTACTS_EXTRA` | no | More friends, same format and same checks, added on top of `PERSONAL_CONTACTS` (a name in both is an error; the limit of 50 counts both). Lets a friend be added without rewriting the whole list |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `ASSISTANT_BRIDGE_TOKEN` | no | The owner's WhatsApp assistant (`src/whatsapp.ts`, `assistant/README.md`): all five turn it on; the owner's number is `PERSONAL_OWNER_NUMBER` unless `WHATSAPP_OWNER_NUMBER` says otherwise |
| `WHATSAPP_TEMPLATE_NAME`, `WHATSAPP_TEMPLATE_LANG` | no | An approved WhatsApp message template (two text variables: the owner's name and the message; language default `en`) for starting a conversation with a friend from the assistant's own number when the 24-hour window is closed; see `assistant/README.md` |
| `WHATSAPP_FRIEND_MESSAGES` | no | `1` lets the assistant write to friends from its own WhatsApp number after the owner's tap. Off by default: WhatsApp's business terms do not allow personal use (see `assistant/README.md`, Terms) |
| `WHATSAPP_REMINDER_TEMPLATE` | no | An approved WhatsApp template with one text variable (the reminder) for a reminder due more than 24 hours after the owner's last message; without it such a reminder waits until the owner writes (see `assistant/README.md`, Reminders) |
| `PAKO_LANGUAGE` | no | Accepted and ignored: Pako's own texts are English (the log says so once). The summaries Pako writes when you have not just written to it (emails, Zoom meetings) follow the language you write in (English, Spanish, Catalan, French, German, Italian, Portuguese and Dutch are told apart); before you have written, English. Another language counts once two clear messages in a row are in it, so a text you paste or forward (with a short line of yours) does not switch it. The chat always answers in the language you write in. |
| `PAKO_DIR`, `PAKO_REPO`, `PAKO_AUTOSTART`, `PAKO_DRY_RUN` | no | Read by `install.sh` only (see `docs/install.md`): the folder Pako is installed in (default `~/pako`), the git address it comes from (default the one in `package.json`), `1` or `0` to answer the "start by itself" question beforehand, and `1` to print what it would do without changing anything |
| `PERSONAL_LIVE` | no | `1` = real calls. Anything else = dry run (fake `dryrun_...` call ids) |
| `PERSONAL_AGENT_ID` | no | Pin the personal agent. Empty = the server finds it by its name (`Pako personal caller`, or `AI Buyer personal caller` for one made before Pako had its name; the next sync renames it). Never the restaurant agent: that turns the feature off |
| `PERSONAL_QUIET_HOURS`, `PERSONAL_TIMEZONE` | no | No friend calls in these hours. Default `22:00-09:00`, in your time zone: `PERSONAL_TIMEZONE` (an IANA name like `America/New_York`), else your computer's own, else UTC (a server on Render runs in UTC: set it there; the log says so once). It is also the zone of reminders, the brief and bookings; `off` disables the quiet hours. Your own `call_me` is exempt |
| `PERSONAL_DAILY_CAP`, `PERSONAL_MIN_GAP_SECONDS` | no | Calls to you in any 24 h (5), and the gap between two calls (60 s): between calls to you, and between calls to friends |
| `PERSONAL_CONTACT_DAILY_CAP`, `PERSONAL_PER_CONTACT_DAILY_CAP` | no | Calls to all friends (5) and to one friend (2) in any 24 h |
| `MAIL_SHOW_CODES` | no | `1` leaves one-time codes (sign-in and verification codes) visible in the emails' notices, `MAIL`, the panel, the log and what Claude reads. By default Pako hides each one as `[code hidden · type CODE]` (`src/codes.ts`), and the codes of the last 30 minutes are kept for the `CODE` command |
| `IMAP_HOST`, `IMAP_USER`, `IMAP_PASSWORD` | no | Your own mailbox, read only (`src/imap.ts`): the IMAP server's name (`imap.gmail.com`, `outlook.office365.com`, `imap.mail.me.com`), the account's user name (usually its address) and an **app password** made for Pako in the account's security settings. All three turn it on; without them nothing changes. Pako connects over TLS only, opens each folder read-only (EXAMINE), never sets a flag (nothing is marked read), never moves, deletes or sends. Each email goes through the same summaries, VIP senders, work domains (`AGENTMAIL_VIP`, `AGENTMAIL_WORK_DOMAINS`), hidden codes and mass-mail filing as Pako's own inbox. The first look reads only the last 24 hours; mail older than that is never announced. A refused login is said once (the log, and the panel's Connections card on a computer) and tried again later and later (30 minutes up to 6 hours); the password is never logged. While Pako is paused (STOP) it does not log in |
| `IMAP_PORT` | no | The server's port for IMAP over TLS. Default `993`; `143` (no TLS, or STARTTLS) is refused |
| `IMAP_FOLDERS` | no | The folders read, separated by commas (10 at most). Default `INBOX` |
| `IMAP_POLL_MINUTES` | no | Minutes between two looks at the mailbox, 1 to 1440. Default `5` |
| `PAKO_BACKFILL_DAYS` | no | Days a newly connected mailbox is caught up on, quietly (INBOX and Sent; no notice for any of it), 1 to 60. Default `14` |
| `PAKO_BACKFILL_RUNS` | no | Claude runs that catch-up may use, once, apart from the day's background budget; one a minute at most, 0 to 500. Default `60` |
| `RETELL_API_KEY`, `RETELL_FROM_NUMBER` | for real calls | The Retell account's key and the number calls are placed from. Without both, the line stays a dry run even with `PERSONAL_LIVE=1`, and the log says so |
| `PERSONAL_ENGINE` | no | `livekit` starts your own calls on the LiveKit engine (below) instead of Retell's; `set_engine` changes it while the server runs, and a restart goes back to this setting. Default `retell` |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | no | The LiveKit voice stack (below). The `livekit` engine exists only with all three |
| `LIVEKIT_VOICE`, `LIVEKIT_MODEL` | no | The Gemini voice (default `Puck`) and model (default: the one named in `src/voice-bridge.ts`) for LiveKit calls; `set_voice` changes the voice while the server runs |
| `VOICE_WORKER_URL` | no | The voice worker's address, pinged to wake it before a LiveKit call |
| `VOICE_RESULTS_URL` | no | A Redis-protocol key value store (`redis://` or `rediss://`). With it STOP, the notes, the reminders and the calls' results survive a restart; without it they live in memory |
| `ZOOM_REVIEW`, `ZOOM_REVIEW_WAIT_MIN` | no | Every Zoom meeting reviewed (`src/meeting-review.ts`, `assistant/README.md` "Zoom"): `off` sends Zoom's summary as it is, as before (default `on`); minutes the assistant's computer has to review a meeting before Zoom's summary goes as it is (default `120`, 5 to 1440). Needs a `git pull` on the assistant's computer: an older bridge cannot review, and the summary goes as before |
| `FOLLOWUPS`, `FOLLOWUP_DELAY_MIN`, `FOLLOWUP_MAX_PER_DAY`, `FOLLOWUP_BATCH_MIN`, `FOLLOWUP_QUIET_HOURS`, `FOLLOWUP_MAIL_JOBS_PER_DAY` | no | Follow-ups (`src/followups.ts`, `assistant/README.md` "Follow-ups"): `off` turns them off (default `on`); minutes after an ask before Pako checks whether it was done (default `10`, 1 to 240); reminders a day at most (default `6`, 0 to 50); minutes a Slack conversation's messages are gathered before they are read (default `3`, 0 to 30); hours with no reminder (default `SLACK_QUIET_HOURS`, else `23:00-08:00`; `off` for none); email threads read whole a day (default `40`, 0 to 200; `0` reads only the triage's lines). Needs a `git pull` on the assistant's computer: an older bridge reads nothing, so nothing is followed up |
| `BRIEF_SMART`, `BRIEF_WAIT_MIN` | no | The written morning brief (`src/brief-v2.ts`, `assistant/README.md` "The written brief"): `off` keeps only the old one (default `on`); minutes the written brief is waited for before the old one goes instead (default `15`, 1 to 120). Needs a `git pull` on the assistant's computer: an older bridge lets the job go and the brief goes as before |
| `CALENDAR_ICS_URL` | no | Any calendar (Google, Apple iCloud, Outlook) by its secret ICS link (`src/ics.ts`): one or more `https://` or `webcal://` links, separated by spaces or commas (10 at most). The same AGENDA, reminders before events and morning brief as Zoho, with `CALENDAR_REMIND_MINUTES` and `MORNING_BRIEF`; with Zoho too, both are read together and a meeting in both is said once and reminded of once. Read every 10 minutes (5 MB at most per link); a link that fails keeps its last good copy and is reported once in the log. The link is a secret: the panel and the log show its host only. On a computer it goes in `~/.pako/.env` (or the panel's settings) |
| `WATCH_REPORT_DEPENDENCIES` | no | Set by Node itself under `node --watch` (`npm run dev`), never by you. Local mode then applies the panel's connections by touching `src/server.ts` so the watcher restarts it, instead of restarting itself |
| `USERDOMAIN`, `PATH`, `APPDATA` | no | Set by Windows itself, never by you. On Windows, `src/autostart-windows.ts` gives the sign-in task the account `USERDOMAIN\name`, and local mode looks for `claude.exe` or npm's `claude.cmd` on the `PATH` and in `APPDATA\npm` (see `docs/install-windows.md`) |
| `PAKO_DIR`, `PAKO_REPO`, `PAKO_AUTOSTART` | no | Read by `install.ps1` only (Windows, `docs/install-windows.md`): the folder Pako goes in (default `%USERPROFILE%\pako`), the git address it is cloned from, and `1` or `0` to answer the autostart question without being asked |

A wrong `PERSONAL_*` setting turns the feature off and says why in the log; it never stops the server from starting. Counters live in memory and reset on restart. Settings of the other parts (the chat, mail, calendar, Slack, Zoom, Telegram, local mode) are in [configuration.md](configuration.md#settings-reference) and in [assistant/README.md](../assistant/README.md); the voice worker's own are in `voice-worker/README.md`.

## Tools Claude gets

`call_me(message, language)`, `get_call(call_id)`, `list_voices()`, `set_voice(voice_id)`, `set_engine(engine)`, and with `PERSONAL_CONTACTS`: `list_contacts()` and `call_contact(name, message, language, direct, say)`.

`call_contact` rings nobody by itself. It sends you a card on the chat you last used: WhatsApp, Telegram, or the panel's chat when Pako runs on your computer. The card says the request came from the connector, who would be called, and every word the call would use. The call is placed only if you press **Call** on that card within 5 minutes. A typed "yes" in the chat does not count for it. Claude gets back a `request_id`, and `get_call` with that id says whether you approved and, once the call is placed, how it went. Without WhatsApp (or the local chat) there is no card to send, so the connector cannot call friends at all. WhatsApp lets Pako write first only within 24 hours of your last message there (Pako keeps half an hour of margin): if you have not written to Pako in that time, the tool says so and sends nothing, so write to Pako and ask again.

## Set up

1. Add the settings above (the token is the one you type yourself), save, let Render redeploy.
2. In Claude: Settings, Connectors, add a custom connector with `https://<host>/personal/<PERSONAL_CALLER_TOKEN>`. Treat the address like a password; to rotate it, change the token and add the connector again.
3. Ask Claude to call you. In a dry run it answers with a `dryrun_...` id and nobody rings.
4. Set `PERSONAL_LIVE=1`, redeploy, ask Claude to call you with a short message. **The first live call creates the personal Retell agent** (and its LLM) with an English voice as a first guess, then rings. This first real call is the proof: none of the Retell requests here had been run against a live account when this was written.
5. **Choose the voice by ear, through Claude**: "list the voices, call me with each one and I'll pick". `list_voices` gives English-speaking voices (and any voice you added yourself) with a link to hear each; `set_voice` switches the agent (changes are paced: one every 5 seconds at most); `call_me` plays it. The chosen voice stays.
6. **Choose who thinks and speaks**, also by ear: `set_engine` picks `claude-haiku` (default, fastest), `claude-sonnet` or `claude-opus` (smarter, slower), `realtime`, `realtime-mini` or `gpt-live`. These are Claude models that write the words; Retell turns speech into text and the chosen voice reads the reply out. `realtime` and `realtime-mini` are OpenAI speech-to-speech models that hear and speak themselves (often more natural and quicker to answer, but not Claude). Every engine gets the same prompt, so the neutral-register rules, the "I am an AI if you ask" rule, the short turns and the answer-at-once rule apply to realtime too; the speech-to-speech models run at temperature 0.7 for a looser, more human rhythm. The realtime models speak only with OpenAI voices: switching to one sets `openai-Santiago` by itself, and `set_voice` refuses any other voice until you go back to a Claude engine. `gpt-live` is OpenAI's full-duplex model on Retell ("duplex": it listens and speaks at once, so it handles interruptions itself; OpenAI reports 0.8 s turn-taking against 1.4 s for its earlier realtime model, its own figures). The voice prompt carries the same rules, a Claude model runs behind it as the backend (the end of the call), and it speaks only with OpenAI voices too. Quality in each language is not documented by Retell: judge it by ear. `grok-voice` is xAI's speech-to-speech model (Retell does not say which voices it takes, so the current voice is tried and a refusal is reported). `set_voice` also takes an optional `speech_model` (for example `eleven_v4_turbo`, `sonic-3.6`), which stays while the voice stays. The choice stays across later voice changes and prompt syncs.

7. Friends: the same, one at a time, after telling each of them beforehand that an assistant may call for you.

Without Claude, with the admin key (optional): `GET /admin/personal-caller/status`, `GET /admin/personal-caller/voices`, and
```
curl -X POST https://<host>/admin/personal-caller/agent-sync -H "Authorization: Bearer <ADMIN_KEY>" -H "X-Admin-Action: personal-agent-sync" -H "Content-Type: application/json" -d '{"voiceId":"<id>","engine":"claude-sonnet"}'
```
creates or updates the agent. Syncing again also pushes a prompt change from a new build.

## Retell settings the agent uses (dashboard names in brackets)

- One language for speech recognition, `en-US` ([Language]): a multilingual agent listens less precisely. The agent speaks the language of the opening and switches to the other person's if they answer in another one; a call in another language is understood less precisely.
- Claude on Retell's `fast` tier ([model settings]): dedicated capacity for lower, steadier latency, and dearer. If Retell refuses it for a model, the standard tier is used and `set_engine` says so.
- The voice's own newest speech model ([voice settings]): `eleven_v3_conversational` for `11labs-` voices, `sonic-3.6` for `cartesia-`, `inworld-tts-2` for `inworld-`; none for realtime. If Retell refuses a pair, the voice's own default is used and the result says so.
- Not changed yet, to try by ear if it still sounds off: `stt_mode` accurate, `custom_stt_config` with a short endpointing time, `denoising_mode`, a backup model.

## What makes it sound natural

Set in `personalAgentBody()` and the prompt, so every change is in the repository: a conversation-style personality with natural filler words; backchannels ("okay", "right", "sure", "uh-huh") at a moderate rate; the voice speeds up and slows down with the other person; it answers at their pace and stops when they talk; short turns in a neutral everyday register (no regional slang, no imitated accent), numbers and times said the way people say them; a short pause after pick-up so their "Hello?" is not talked over; a short owner opening ("Hi Ana, it's your assistant. Quick one for you."); prompt rules to write for the ear (short sentences, react first, at most one hesitation per turn, no repeated phrases); interruption sensitivity 0.7 and a 15 s wait before the single "are you still there?" nudge. No fake room sound (ambient noise would imply a place the assistant is not in). It does not use expressive mode, fake laughter or sighs. The rest is the voice you choose in step 5.

## What the server enforces (not the prompt)

- `call_me` dials only `PERSONAL_OWNER_NUMBER`. `call_contact` dials only a name in `PERSONAL_CONTACTS`, and only after you press **Call** on its card; a raw number is never accepted.
- At most 12 of those cards in any 24 hours, so a connector gone wrong cannot flood your phone. A call the caps would refuse gets no card. Several cards can wait at once; a newer request for the same friend replaces the older card. A press too soon after another friend call sends a fresh card and says how many seconds to wait before pressing it; if the wait is longer than a card lasts, nothing is kept and the request has to be made again later. Typing STOP ends every card that is waiting, and while Pako is paused (STOP, the panel's switch, or a pause it sets by itself when its store comes back empty or cannot be read) **Call** places nothing and ends that card.
- The card and the call use one text, cleaned once: no WhatsApp formatting marks (a word struck through on the card would still be said), no invisible or blank-looking characters, plain quotes, no "it's <you>" or greeting at the start. A message that is only that is refused. The assistant's own proposed calls on WhatsApp get the same cleaning.
- Rolling 24 h caps and a gap (above); quiet hours for friends; Retell's do-not-call list is honoured for friends; premium-rate numbers are refused at startup.
- Personal calls use the personal agent only, and carry no webhook to the restaurant flow. `get_call` reads only calls this connector placed: the restaurant customers' calls in the same Retell account are not readable through it.
- A call that Retell refuses gives its slot back. The key and token are never in a tool result or the status page.

## Honesty and limits

- The voice is made to sound natural; it still **never claims to be a person**. The opening says whose assistant is calling ("Hi Ana, I'm Sam's AI assistant, calling on Sam's behalf. Got a minute?"; with `direct: true` it asks nothing and says the message straight after), and if anyone asks whether it is an AI, a bot or a person, even as a joke, it says plainly that it is an AI assistant. The prompt and Retell's AI-disclosure preset both say so; the server cannot enforce a prompt, so listen to the first calls.
- Recordings and transcripts are kept 30 days (`data_storage_retention_days` on the agent). Tell friends.
- Friends see the same Retell number the restaurant caller uses, and a call back to it reaches whatever that number is set to do for inbound calls.
- Not checked: whether the opening line has to say "AI" in so many words for a personal call (EU AI Act Art. 50), and consent rules for friends in other countries. Calls to businesses or to numbers outside the list are not possible here on purpose.
- Every call is made in the owner's name (`PERSONAL_OWNER_NAME`): the opening, the prompt and the screening answer all say whose assistant it is, and a call that names anyone else (`on_behalf_of`) is refused by the server.

## The livekit engine (own voice stack)

`set_engine livekit` makes `call_me` ring the owner through `voice-worker/` (LiveKit + Gemini Live over the owner's Zadarma SIP
number, from a European server) instead of through Retell. It exists only when `LIVEKIT_URL`, `LIVEKIT_API_KEY` and
`LIVEKIT_API_SECRET` are set on the main server; `PERSONAL_ENGINE=livekit` makes it the default after a restart.

- Every rule stays on the main server: caps, the owner's number, the opening line, the owner-name lock. The worker dials only
  the number in the job metadata and says only the opening it is given.
- Calls to friends always use the Retell agent. The livekit engine is for the owner's own calls until real transcripts
  (`disclosed_ai` in `get_call`) show that the AI line is said reliably.
- `call_me` returns at once; the voice server (a free Render service sleeps) is woken in the background before LiveKit is asked to
  start the call, so the phone can take up to a minute to ring. A start that fails there is reported by `get_call` and gives the
  owner's slot back.
- `set_voice gemini-<Name>` picks a Gemini voice (listed by `list_voices` when the engine exists); `LIVEKIT_MODEL` picks the model.
- `get_call` for an `lk_...` id returns what the worker reported when the call ended: transcript, duration, why it ended, answer
  speed (`latency_ms.e2e`, from the person finishing a turn to the assistant's first sound), and `disclosed_ai`.
- The worker signs its result post with the LiveKit API secret; an unsigned or altered post is refused.
