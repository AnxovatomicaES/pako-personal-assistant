# Privacy: what Pako keeps, what leaves, and how to take it or delete it

**No data to the project.** Pako sends nothing to the Pako project: no telemetry, no analytics, no crash reports, no project-owned keys,
endpoints or relays. What leaves your computer goes only to the services you connect, under their terms (the table below). The public
privacy notice is at https://pako-os.com/privacy.html.

**Pako Relay, only if you turn it on.** The relay ([docs/relay.md](relay.md)) is a Pako you run yourself on a host that stays awake, so
reminders still come with your laptop's lid shut. While it is on, that host keeps the text and time of your reminders for the week ahead,
which ones it sent in the last 30 days (ids and times only), and the bot token you give it. Nothing else of yours goes there. Turning it
off (unsetting `RELAY_URL`) stops the syncing; `DELETE /relay/sync`, or deleting the host, wipes what it holds.


This page is written from the code (`src/data.ts` holds the same facts, and `test/data.test.ts` fails when a module starts keeping
something this page and that file do not describe). On a computer the panel shows it too: the **Privacy and your
data** card.

Pako has two ways to run. **On your computer** (local mode, the default) everything it keeps is in one folder on that computer. **On a
server** (hosted, with WhatsApp) it keeps the same things in the server's Key Value store (`VOICE_RESULTS_URL`); the export and the
delete below exist only on a computer.

## In the panel

On a computer, everything Pako keeps is in `~/.pako`. The panel's **Privacy and your data** card shows each file and each kind of thing it
keeps with how long, what leaves the computer and to whom (each service marked on only when connected; for a calendar link, the host only),
and what never leaves. Two buttons:

- **Export my data**: a JSON file with every stored item decoded, your choices and your connections by name. No secret goes in it.
- **Delete everything**: type `DELETE EVERYTHING` (or `BORRAR TODO`). Pako pauses, empties the store and the chat, unpairs Telegram, forgets
  the panel's connections and your choices, empties its logs and starts again as on the first day. What stays, and the answer says so: the
  three secrets Pako needs to run, your own `~/.pako/.env`, Claude Code's own history of the conversations, and autostart as you set it.

The routes are `GET /panel/api/privacy`, `GET /panel/api/export` and `POST /panel/api/delete-all`, behind the panel's session (and the `x-pako`
header for export and delete); a server answers 404 to all three. The rest of this page is the long form.

## Where it is kept

The folder is `~/.pako` (or `PAKO_HOME`). Every file in it is readable only by you (folder mode 700, files 600).

**Pako's secrets are in your system's secret store when it has one** (`PAKO_SECRET_STORE`, `auto` by default; see `docs/configuration.md`):
the login keychain on macOS (service `Pako`, one item per secret, in Keychain Access), the Credential Manager on Windows (generic
credentials named `Pako:…`, kept on this computer only), and libsecret (GNOME Keyring, KWallet) on a Linux desktop with `secret-tool`.
There they are encrypted with your login, and a copy or backup of `~/.pako` carries none of them. `secrets.json` then holds only a marker
(which store, and the account names), no value. The move happens at a start: each secret is written to the store and read back before
the file is replaced, so a failure leaves the file as it was. Where there is no store (a server, Render, a Linux box with no desktop) or
it does not work, they stay in `secrets.json`, mode 600, as before. A secret never goes on a command line, where other programs could
see it: macOS gets it on stdin (`security -i`), Windows and Linux too. If the store stops giving them (a keychain still locked, a folder
copied from another computer), Pako starts on temporary ones, writes nothing over the real ones, and says so in the chat.

Anything running as you can still ask for them (the keychain items trust the `security` tool, which is how Pako reads them back):
the store protects them at rest and in copies, not from your own programs.

| File | What it holds |
|---|---|
| `config.json` | What you choose in the panel: language, name, whether you saw the welcome. |
| `secrets.json` | Pako's three own secrets (the bridge's token to Claude, the phone line's token, the key that signs your panel session), the Telegram bot token if you set it in the panel, Meta's values for WhatsApp if you set it up in the panel (forgotten with the card's **Forget**), and the connections you set in the panel. With a secret store (above), only a marker that says they are there. |
| `.env` | Your own settings and keys, if you wrote any. Pako reads it and never writes it. |
| `kv.db` | The store: everything in the next table, in one SQLite file. Each change is on disk as soon as it is made, and what is deleted is overwritten in the file. |
| `kv.db.made` | A mark that the store existed, so that if `kv.db` goes missing Pako starts paused and says so. |
| `kv.db.bad` | A damaged store kept aside, if there ever was one (`kv.json.bad` for an older Pako's). |
| `kv.json.migrated` | Only if copying an older Pako's JSON store into `kv.db` did not check out exactly: that old file, kept aside. A checked copy deletes the old file. |
| `import-backup-<time>.json` | What an import from another Pako replaced, kept in case you want it back (only after an import). |
| `.lock` | That Pako is running: its process number, port, the computer's uptime and when that process started. |
| `assistant/state.json` | The conversation in progress with Claude: its session id and a count. (`ASSISTANT_STATE_DIR` moves this folder.) |
| `assistant/tool-data.json` | A copy of your last message's context for Pako's tools in the chat: your message, notes, reminders, lists, tasks and agenda. Rewritten at each message. |
| `assistant/handled-unacked.json` | The ids of items the bridge answered whose receipt the server has not confirmed yet (no text), so a restart never answers one twice. Kept two days at most. |
| `logs/pako.log`, `logs/pako.err.log` | What the Pako that starts by itself writes: its notices and errors, which can quote a message. Only with autostart on (on Windows the previous start's are kept as `.old`). |
| `logs/app.log` (and `app.log.1` to `.3`) | What the Pako started by the Mac app writes, and the app's own lines (a crash, a restart): notices and errors, which can quote a message. Rotated past 5 MB, three kept. No sign-in link is ever written there. |
| `autostart/` | Windows only: the small launcher the sign-in task runs. |
| `papers/` | The photos and PDFs you send Pako to read (by WhatsApp, Telegram or the panel's chat): the last 50, for 30 days at most. On a server they are kept in memory only, for two days at most, and dropped once read. |

**Autostart is a file, not a key in the store.** On macOS it is `~/Library/LaunchAgents/local.pako.plist`, on Linux
`~/.config/systemd/user/pako.service`, on Windows a Task Scheduler task (`Pako-<your user>`) with its launcher in `~/.pako/autostart`. It
holds the paths to Node.js and Pako and the few settings it carries (see `docs/install.md`), nothing of yours. The panel's card lists it.

**The Connections settings** (the panel's Connections card: the calendar's ICS link, the mail, Slack, Zoom, Claude with an API key) are kept
with the other secrets (the store, or `secrets.json`) under `settings`. They are used exactly like the same settings in `.env`, and they are never shown again in the panel or
put in the export: only their names.

Outside the folder: the `claude` command runs from `~/.pako/assistant`, and **Claude Code keeps its own history** of those conversations in
`~/.claude/projects/<that path with every character but letters and digits made a dash>` (for example `-Users-ana--pako-assistant`). That
is Claude Code's, under Claude Code's own settings; Pako neither reads nor deletes it.

## What it keeps, and for how long

Each entry is deleted by itself once this long has passed without a change (the time is each module's own constant). The lists inside are
also capped, as said.

| Key | What | Kept |
|---|---|---|
| `pako-local-chat` | The panel's chat: the last 300 messages | 90 days |
| `owner-memory` | The notes about you (60 at most) and a summary of your last 8 calls | 1 year |
| `assistant-reminders` | Your reminders, repeating ones too | 400 days |
| `assistant-reminders-fired` | The reminders already sent (the last 40), so none is sent twice | 7 days |
| `assistant-lists` | Your lists and tasks (done ones for 7 more days) | 400 days |
| `assistant-people` | The people in your life you told Pako about: name, relation, birthday, likes, things to remember (100 at most) | 400 days |
| `memory-facts` | What Pako knows, dated: each fact (about you or someone) with since when it holds, until when (when it changed), when Pako learnt it, who said it and where; your notes and people read in; what a reviewed meeting left with each person named in it ("last meeting": what you agreed, what they will do, what was decided; never the transcript, and no phone number, IBAN or link). A closed fact is kept a year as history; 800 at most besides the current ones read in from your notes and people. A short, dated block per person is made from here, the identities and the open follow-ups when the extraction, a draft, the brief or a meeting prep needs it, and goes only inside that run's job to your assistant's computer; it is not stored | 400 days |
| `people-identities` | The people Pako has seen in Slack, the mail, the calendar's invitations and Zoom: names, email addresses, Slack ids, Zoom display names (never what they wrote), the last 5 times each appeared (with the Slack conversation's name for a Slack message), and the "same person?" questions with your answers (400 people at most) | 400 days |
| `assistant-autonomy-held` | The messages, emails and calls you asked for that waited a few seconds so you could undo them (who, the words, and whether they went out): so none goes out twice after a restart (40 at most) | 2 days |
| `assistant-autonomy-settings` | What Pako does at once and what it asks first, set in the panel's Settings | 5 years |
| `assistant-routines` | Your routines and what Pako watches for you, and which emails and Slack alerts it already looked at for them | 400 days |
| `assistant-routine-run:<id>` | A routine or a heads-up already done, so none is done twice (a random mark, no content) | 8 days |
| `assistant-undo` | What UNDO can put back (the last 30 changes) | 7 days |
| `assistant-log` | The activity log: one line per action (the last 300) | 90 days |
| `assistant-paused` | Whether STOP is on, and since when | 1 year |
| `assistant-paused-why` | Why the pause was set, when it wasn't you | 1 year |
| `assistant-inbox` | Messages waiting for Claude's answer | 2 days |
| `assistant-held-notices` | Notices kept to give you later | 7 days |
| `assistant-last-owner-at` | When you last wrote | 3 days |
| `assistant-last-channel` | Which chat you last wrote from | 1 year |
| `owner-language` | The language you write in, as Pako heard it | 1 year |
| `whatsapp-owner-bsuid` | Your WhatsApp user id (with WhatsApp only) | 1 year |
| `assistant-mail` | Pako's inbox: a summary of the last 150 emails (with each one's To and Cc lines, cut short, whether it was sent to a list, and a hash naming its thread) and the ids of the last 300 seen | 60 days |
| `assistant-mail-codes` | One-time codes found in the mail | 30 minutes |
| `assistant-mail-body:<id>` | The words of one email (one-time codes hidden), for the panel's reader | 60 days |
| `mail-prefs` | Your mail choices: the sender rules you taught with Move to…, and which categories notify you | 5 years |
| `assistant-imap` | Your own mailbox (IMAP, read only): the account name and server, and per folder the number of the last email already looked at. Never the password | 60 days |
| `mail-backfill` | A newly connected mailbox's catch-up: the emails of its last days waiting to be read (one a minute; for one you sent, its newest words, about 4,000 characters at most, its recipients and subject) and its progress | 30 days |
| `mail-invites` | Invitations caught from your mail (title, time, organizer, place), shown on the dashboard until your calendar has them. Never the mail itself | 60 days |
| `slack-alerts` | Slack messages it told you about (the last 100) | 14 days |
| `slack-held` | Slack notices kept during quiet hours | 2 days |
| `slack-poll` | Where Pako is in each Slack conversation it looks at (no message text) | 60 days |
| `teams-poll` | Where Pako is in each Teams chat and channel it looks at, and the last read and error (no message text) | 60 days |
| `apple-mail-poll` | Mail on this Mac: the last message already looked at (its number in Apple Mail's index), when it was turned on, the numbers of messages Mail had not downloaded yet, and the last read and error (no message text, subject or address) | 60 days |
| `imessage-poll` | Messages on this Mac: the last message already looked at (its number in Messages' history), when it was turned on, and the last read and error (no message text, number or address) | 60 days |
| `zoom-state` | Zoom meetings seen and the last 20 summaries | 60 days |
| `meeting-reviews` | The last 40 Zoom meetings reviewed: their summary, your to-dos (who waits, by when, the words that show it), what others promised you, the decisions, the meetings agreed and the open questions | 30 days |
| `lessons` | What Pako learned from your corrections: a short dated line for each "Not mine", undo, 👎 on a reminder or a brief item, and draft you changed before sending it (what you changed, measured: length, greeting, sign-off, language), with how often you taught it, and for a draft both texts (60 at most; Settings › How Pako acts shows and deletes them). Also Pako's drafts of the last 3 days (10 at most), to compare with what you sent | 400 days |
| `followups` | Open items Pako follows up (what you were asked or promised, with where each was said; in gentle mode also the items you parked, for 45 days (the weekly reset asks about them after 30), and a stuck item's first tiny step), the "Not mine" rules and today's reminder count; the new emails of a thread waiting a few minutes to be read together (their newest words, about 4,000 characters each, gone once the thread's job is queued), the ids of the emails already read (600 at most, so none is read twice) and today's count of email reading jobs. No excerpt of an email is kept with an item | 60 days (an open item 14 days, a closed one 7; a waiting email 2 days at most) |
| `zoho-refresh` | Access to Zoho Calendar (a secret) | 10 years |
| `calendar-state` | Which meeting reminders were already sent | 30 days |
| `meeting-prep` | Which meetings already got their prep note (an id and a time per meeting, a week) | 8 days |
| `calendar-changes` | Your next two weeks of meetings as last seen (title and time), and what was new, moved or gone in the last 3 days | 30 days |
| `brief-state` | The day the last daily brief was sent, and a day whose brief was skipped because the computer slept (until BRIEF says so) | 30 days |
| `brief-v2` | Today's written brief, the facts it was written from (follow-ups, meeting summaries, Slack messages, events, tasks, mail summaries) and the documents asked from its page | 7 days |
| `feedback` | Your 👍/👎 on the follow-up reminders and the written brief (what was judged, your answer, when, and whether it was a reminder, the brief or one of its items), and for each reminder sent what you pressed on it (Done, In 1 h, Not mine). Read back as the panel's Quality card and one Monday line; only when you run `npm run evals:from-feedback`, your 👎 and Not mine are also copied into draft test cases in `.claude/evals/drafts/` on your computer, with names, addresses, numbers and links replaced by placeholders | 90 days |
| `life` | What Pako learnt from your own words about your tastes, diet, trips, hobbies (how often, when last), sport, people who matter and goals, each with its date; the topics you let it suggest about; its suggestions of the last 30 days and what you pressed on each; the day's count | 400 days (suggestions 30) |
| `life-health` | What you told Pako about your health and mood: kept apart, never in the log or the conversation's context, on disk only on your own computer (a hosted server keeps it in memory). `FORGET MY HEALTH` / "forget my health data" (asked twice) deletes it with the diary | 400 days |
| `rehearsal` | The last rehearsal (REHEARSAL, or the panel's button): what Pako would have said from the last 48 h of what it already keeps, and the facts of the trial brief. Nothing of it was sent | 7 days |
| `telegram-owner` | The Telegram account paired with Pako | 5 years |
| `telegram-pair` | A pairing code in use (a secret) | 10 minutes |
| `telegram-off` | You wrote TELEGRAM OFF: Telegram stays unpaired | 5 years |
| `mobile-access` | Whether "Use on my phone (same Wi-Fi)" is on, and each paired phone's name, when it was paired and last seen, and a hash of its token (a secret; never the token itself) | 10 years, or until you remove the phone |
| `telegram-file:<id>` | Where to fetch a voice note or photo you sent by Telegram | 2 days |
| `whatsapp-computer-last-owner` | When you last wrote to Pako on WhatsApp from a computer (WhatsApp's 24 hours) | 3 days |
| `pako-bookings` | The tables Pako asked a restaurant for | 120 days |
| `pako-booking-sent` | Booking emails already sent, so none is sent twice | 2 days |
| `maitre-ledger` | The bookings Pako made on a restaurant's website: state, proof and cancel link, so nothing is booked twice | 400 days |
| `maitre-passports` | What Pako remembers about each restaurant it booked: its booking system, its page and how long it took | 400 days |
| `voice-result:<call>` | The result of a phone call (what was said and its summary) | 30 days |
| `pako-store-id` | A random number that tells Pako its store wasn't emptied | 10 years |
| `pako-store-era` | The same, for when two copies of Pako share one store | 10 years |
| `watchdog` | Which part of Pako is failing now, since when, and whether you were told | 30 days |
| `claude-keeper` | Whether Claude has worked on this computer and whether you were already asked to sign in again (two yes/no flags: never your address or a token) | 400 days |
| `discovery` | What Pako for Mac found on this computer when you said yes to "Can I look at what you have on this Mac?": which apps are installed (Zoom, Slack, Telegram, WhatsApp, Mail, Outlook, Teams), your calendars' names, your mail accounts' addresses, how many contacts you have, the Zoom recordings folder, and which macOS permissions you gave. Never a mail's or an event's text. Forgotten in one click in the connections page | 10 years (until you forget it) |
| `calendar-local` | The events of the calendars on this Mac you picked, from 2 days ago to 14 ahead: title, times, place and the video call's link (never the notes or the attendees). Forgotten with the discovery | 30 days |
| `reminders-mirror` | Apple Reminders (off until you turn it on in Pako for Mac): whether it is on, whether "Pako: waiting on" is too, and for each follow-up its reminder's id and the title and time both sides last agreed on (never the reminder's notes). Forgotten with the discovery | 400 days |
| `time-to-do` | Time to do it: the focus blocks offered (which follow-up, the proposed time, and whether you blocked it, asked for another or said not needed; the last 100) and today's count of those cards | 15 days |
| `calendar-writes` | The calendar changes you said yes to (move, add, delete: title and times), and what was there before, for Undo (a week) | 8 days |
| `relay-state` | On a host running as your relay only: your reminders of the week ahead (text and time) and which it sent | 31 days |
| `assistant-contacts` | The contacts you chose to import from this Mac: name, email addresses, phone numbers and company (5000 at most), listed in the panel and forgotten in one click | 400 days |
| `people-hidden` | The people you hid from the People list in the panel: only the addresses, numbers or ids that name them (2000 at most), so they stay hidden. The People list itself is not stored: it is worked out each time from the data above (your contacts, the people Pako has seen, your calendar, your mail, your follow-ups and what you told Pako), and what it shows from other people's mail, invitations and Slack never becomes something you said | 400 days |
| `zoom-local` | Which Zoom recordings on this Mac were already sent to be reviewed (a fingerprint of each folder's name; the captions themselves go to the review like a cloud transcript) | 60 days |
| `health` | Your health diary (symptoms, mood, sleep, exercise, water, appointments) and the medication you stated, in your words. Never sent to anyone, never given to Claude as context, never written to a log; on disk only on your own computer (a hosted server keeps it in memory); `FORGET MY HEALTH` (asked twice) deletes it with `life-health` | 1 year |
| `learning` | Your learning goals, the quiz cards from your lessons and when each is due | 400 days |
| `friend` | Whether the weekly check-in is on, when it last went, and which birthdays were already mentioned the day before | 400 days |
| `job-claim:<slot>` | A mark while one scheduled run is being done (its slot hashed, and which Pako took it), so two Pakos on one store never do it twice at once | 10 minutes |
| `corrupt:<key>:<time>` | A record above that was damaged (not valid JSON), kept aside as it was instead of written over; the owner is told. Never exported | 180 days |
| `demo-seeded` | When the demo week was set up. Only in the demo's own folder, `~/.pako/demo`, deleted by Leave demo | 90 days |
| `demo-calendar` | The demo week's invented calendar. Only in `~/.pako/demo`, deleted by Leave demo | 90 days |
| `gentle-settings` | Gentle mode: whether it is on, its nudges a day, how long before a meeting it says to wrap up or leave, the check-ins' minutes and the weekly reset's day and time | 5 years |
| `gentle-steps` | Gentle mode: the first tiny steps asked today and for which follow-ups (a step itself is kept on its follow-up, in `followups`) | 7 days |
| `gentle-anchors` | Gentle mode: the meeting nudges already sent, and how long past meetings took, by the words of their titles (for "this usually takes you about") | 200 days |
| `brain-dumps` | Your last brain dumps (10 at most): each item as it was sorted, and what it changed, so one can be removed or all undone | 2 days |
| `gentle-checkins` | Your check-ins: what each is about (your words), its time, its "Not yet" count, how it ended; today's count | 10 days (ended: 2 days) |
| `gentle-reset` | Weekly reset: items each reset listed (id, title, person), the week's focus, parked items asked about, what was let go | 120 days (history: 90) |
| `beta-audit` | Only if you turned on *Beta: help measure Pako*: the conversations the follow-ups read in the last 8 days (where, who, their first two lines, how many follow-ups each gave), each week's questions and your Yes/No/Skip answers. The lines go once a question is answered, its week is over, or you turn it off; the answers stay as counts. Nothing of it leaves the computer: `npm run beta:report -- --export` writes counts only, and only if you say yes (`docs/beta.md`) | 8 days (answers: a year) |
| `places-ok` | That your Google Places key has answered once: a fingerprint of the key (a hash), never the key, so the settings page can say "connected" | 400 days |
| `jobs` | The runs due at a time (the daily brief, each reminder sent): when each was due, whether it was done, missed (the computer slept past its last hour) or failed, and the error. The brief's and the reminders' own words are not in it | 8 days |

**Pako for Mac** keeps a few things of its own outside the folder: its settings (window place, the chosen port, first-run marks, when it
last checked for updates and up to when it notified you) in `~/Library/Preferences/io.github.anxovatomicaes.pako.plist`; the panel's
session cookie (30 days) and cache in `~/Library/WebKit/io.github.anxovatomicaes.pako`, `~/Library/HTTPStorages/…` and
`~/Library/Caches/…` under the same name. *Connect Claude* installs Anthropic's Claude Code (`~/.local/bin/claude`, `~/.local/share/claude`),
whose sign-in Claude Code keeps in your Keychain: the app never reads it. See `docs/desktop-mac.md`, *Remove it*.

## What leaves the computer, and to whom

Only to what you have connected. Each line is off until its settings are there.

| To | What | When |
|---|---|---|
| **Anthropic** (Claude) | What you write, what Pako needs to answer it (notes, reminders, agenda lines, the summaries you ask for) and voice notes already turned into text. | Always: it is the brain. Through the `claude` command signed in to your Claude plan, or with `ANTHROPIC_API_KEY`, paid by use. |
| **Telegram** | Messages between Pako and your phone, and the voice notes and photos you send it. | With a bot token (the panel's Telegram card, or `TELEGRAM_BOT_TOKEN`). |
| **Meta** (WhatsApp) | Messages between Pako and your WhatsApp. | On a server with `WHATSAPP_ACCESS_TOKEN`, or on a computer once set up in the WhatsApp card. |
| **Cloudflare** (the tunnel) | On a computer with WhatsApp's tunnel on: Meta's webhook requests, which carry your WhatsApp messages, pass through Cloudflare's quick tunnel. Nothing else can go through it. | Only once you turn the tunnel on in the WhatsApp card. |
| **AgentMail** | Pako reads the inbox you gave it, and sends from it the booking emails you approve. | With `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX`. |
| **Your own mail server** (IMAP) | Your user name and password, to log in (TLS only). Pako only reads: it opens folders read only and never marks, moves, deletes or sends anything. | With `IMAP_HOST`, `IMAP_USER` and `IMAP_PASSWORD` (see `docs/personal-caller.md`). |
| **Google** (Places) | Restaurant searches: what, where, when. None of your notes. | With `GOOGLE_PLACES_API_KEY`. |
| **Slack** | What you search for in your Slack; Pako only reads. | With `SLACK_USER_TOKEN`. |
| **Zoom** | Requests for your meetings and their summaries; Pako only reads. | With the Zoom app's settings (`ZOOM_CLIENT_ID` and the rest). |
| **Your calendar's host** (ICS) | A request for your calendar by its private link; nothing of yours. | With `CALENDAR_ICS_URL` (in `.env` or the panel's Connections card). The panel names the host (or hosts) only: the rest of each link is its secret. |
| **Mozilla** (autoconfig.thunderbird.net), then your mail's domain | Your mail address's domain (never the address), to find its server: Mozilla's database, then that domain's own `autoconfig` file and its MX records. | Only when you type an address in the guided mail connection. Kept a day in memory. |
| **Zoho** Calendar | Pako reads your calendar; it doesn't write to it. | With the Zoho settings (`ZOHO_CLIENT_ID` and the rest). |
| **LiveKit / Retell** | On calls: your voice and the other person's, the numbers, and what Pako should say, through the speech services they use. | Only with the phone line set up (`LIVEKIT_URL` or `RETELL_API_KEY`; see `docs/personal-caller.md`). |

**Mail on this Mac** (off until you turn it on) adds no service to this list either, and needs no password. Pako reads the mail Apple Mail
already downloaded, from Mail's own folder on this Mac, read only (it never writes there, and with Mail closed it opens the index immutable),
and each email then goes exactly where mail read by IMAP goes: kept in Pako's mailbox store, and summarized and read for follow-ups by your
own Claude (fenced as other people's words). Your own addresses, learnt from your Sent mail, stay in memory; no message text, subject or
address is written to a log or to the reader's own record.

**Apple Reminders** (off until you turn it on in Pako for Mac's calendar card) adds no service of Pako's either, but what Pako writes there
goes wherever your Reminders go: with iCloud on, to Apple's iCloud and your iPhone and Watch. For each open follow-up, in Pako's own lists
("Pako" and, unless you turn it off, "Pako: waiting on"): its title, its time, who and where ("Where: Slack · Dana (private)"), the line it
came from ("From Slack · Dana (private), 16 Nov, 09:30") and a tag with its id (`pako:<id>`, also as the reminder's link,
`pako://loop/<id>`). Never a message's words beyond the follow-up's own title. Pako reads back from those two lists only (a reminder's title,
time, whether it is completed, and its id): never another list, and never the notes. Turning it off stops it; Pako's lists stay in Reminders
for you to delete there.

**Messages on your Mac** (iMessage and SMS, off until you turn it on) adds no service to this list. Pako reads Messages' own history file
on this Mac, read only, and the new messages of a chat go only where Slack's and mail's already go: to your own Claude, as the material of a
follow-up (fenced as other people's words, never instructions). The messages themselves are not kept in Pako's store, and no message text,
phone number or address is written to a log.

## What never leaves

- The files in `~/.pako` as files: nothing uploads them anywhere.
- The keys: each goes only to its own service, and Pako's own secrets to none.
- The panel: it opens from this computer only (unless `PAKO_HOST` says otherwise). With **Use on my phone (same Wi-Fi)** on, your paired
  phones read the brief and your follow-ups over your home network (plain `http`), and keep the last copy in their browser until unpaired;
  nothing goes through any server of ours. See [On your phone](features.md#on-your-phone).
- Pako sends no statistics, usage or error reports to anyone. (The `claude` command follows its own settings.)
- The audio of your voice notes: it is turned into text on this computer, when the bridge has whisper.
- **Pako for Mac** talks to the Pako on this computer only, except: *Connect Claude* downloads Anthropic's installer from `claude.ai` (and it
  downloads Claude Code from `downloads.claude.ai`), and, when the release has an update address, a daily check of that one https address
  with a `User-Agent` of just `Pako`, no cookie and nothing that tells one person from another. Notifications stay on the Mac.

## Export

In the panel, **Privacy and your data**, **Export my data**: a file `pako-export-<date>.json` with

- every key of the store, decoded, with what it is and when it expires;
- `config.json` (your choices);
- the connections by name only: which are set in the panel, which outside it (`.env`, the terminal), whether a Telegram bot is set;
- the list of files in the folder.

It never holds a secret: not Pako's three tokens, not a connection's value, not `zoho-refresh`, `telegram-pair` or `mobile-access` (written as
`[secret: not exported]`), not the one-time codes found in the mail (written as `[hidden]`, with the email they came in), nor the chat's copy of
Pako's answer to CODE, which shows them (its text is written as `[hidden]` too). As a last guard
every text in it is searched for the secret values this computer holds (every setting whose name has `TOKEN`, `SECRET`, `KEY` or
`PASSWORD` in it or ends in `_URL`, and every secret Pako keeps, from the store or `secrets.json`), and each one found is replaced, even inside a note.

The route is `GET /panel/api/export`, with the panel's session and the `x-pako: 1` header, like STOP: another website cannot read it.

## Delete everything

In the same card, type **DELETE EVERYTHING** (or **BORRAR TODO**) and press **Delete everything**. Pako then:

1. pauses, so nothing goes out while it empties things;
2. empties the store (every key above) and the chat, keeping one line in the log that says it was done. If the emptied `kv.db` cannot be
   written (a full disk), the old one is removed instead; if even that fails, nothing is started again (it would read your data back): the
   answer says so, Pako stays paused and keeps nothing new, and pressing again once there is space finishes the job;
3. unpairs Telegram and removes its bot token, with every connection set in the panel, from `secrets.json` or the secret store;
4. forgets your choices in `config.json` (it keeps only the computer's own language, as on the very first start);
5. deletes `kv.db.bad`, `kv.json.bad` and `kv.json.migrated`, any `import-backup-<time>.json`, the photos and PDFs in `~/.pako/papers`, the booking screenshots in `~/.pako/maitre` and the booking browser's profile in `~/.pako/browser` (your sign-ins to booking sites), `assistant/state.json` (Claude starts a fresh conversation), `assistant/tool-data.json`, `assistant/outside-seen.json` and `assistant/handled-unacked.json` and any voice note being turned into text, and
   empties the logs in `~/.pako/logs` (the background Pako's and the Mac app's `app.log`; the `.old` and rotated `app.log.1` to `.3` are deleted);
6. starts again, and the panel shows the welcome, as on the first day.

What stays, and the answer says so:

- Pako's three own secrets stay (in the secret store, or `secrets.json`): the server needs them to run, and they say nothing about you (your browser stays signed in);
- `~/.pako/.env` and settings given in the terminal or `./.env`: they are your files, which Pako never writes. Delete the keys there yourself;
- Claude Code's history in `~/.claude/projects/…` (see above);
- autostart, as you set it: it is a file, not your data. Turn it off in the **Start with this computer** card or with
  `npm run autostart -- off` (on Windows also `node src/autostart-windows.ts disable`).

The route is `POST /panel/api/delete-all` with `{ "confirm": "DELETE EVERYTHING" }`, the panel's session and the `x-pako: 1` header. Where
Pako cannot start again by itself, the delete is done all the same, Pako stays paused and keeps nothing new, and the answer says to stop it
and start it again.

On a server none of these routes exist (they answer 404): there the data lives in its Key Value store, managed where it is hosted.
