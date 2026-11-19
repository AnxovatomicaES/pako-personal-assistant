# Status: what works, and what is tested

What works today, what needs a server, the limits, and how far each part has been tested.

## What works today, and what does not

**Works on your computer, with nothing else set up:**

- A chat in the panel. Claude answers questions and searches the web.
- Notes about you (up to 60), which you can list, correct and delete, and reminders (up to 20 waiting, up to a year ahead), which can repeat.
- Lists (shopping, home...) and tasks with a day.
- A daily brief at 08:00.
- A receipt with an **Undo** button each time Pako changes a note, a reminder, a list or a task by itself.
- Photos and PDFs you send, read and summed up; routines, watches and the people in your life ([Deeper help](features.md#deeper-help)).
- **STOP** and **RESUME**, a log of what Pako did, and the panel that shows it all.
- Telegram on your phone, set up from the panel.

**Works once you add its keys** (see [Add things when you want them](channels.md#add-things-when-you-want-them)): a mail inbox for Pako, your own
mailbox read only, your calendar (any calendar by its secret ICS link, Zoho, or the calendars of this Mac through Pako for Mac), your
contacts, Zoom summaries, Slack (live messages by Socket Mode, and search), WhatsApp (through a tunnel you turn on), booking a table.

### What runs on your computer, and what still needs a server

Pako is meant to run whole on your own computer, with no server of your own. Most of it does today. Two parts still need an address on the
internet that someone else's servers can call, and a computer at home has none:

| Part | On your computer alone | Why |
| --- | :-: | --- |
| Chat in the panel and in the Mac app | ✅ | It is this computer. |
| Telegram | ✅ | Pako asks Telegram for new messages (long polling): nothing has to reach your computer. |
| Slack (messages for you, search) | ✅ | Connected with one paste and one Allow; Pako looks every minute, or live with Socket Mode ([Slack and Zoom from the panel](channels.md#slack-and-zoom-from-the-panel)). |
| Zoom (summaries, recordings, upcoming meetings) | ✅ | Pako lists them every 10 minutes; no webhook is used. A computer that was off catches up on the days it missed (up to 14). |
| Calendar (ICS link, Zoho, or this Mac's calendars) | ✅ | Read every 10 minutes; Pako for Mac sends the calendars you picked; nothing has to reach the computer from outside. |
| Mail (Pako's AgentMail inbox, your own mailbox by IMAP) | ✅ | Listed every few minutes; no webhook is needed. |
| Reminders, routines, notes, people, lists, the daily brief, follow-ups | ✅ | They run inside Pako. |
| WhatsApp | ✅ with a tunnel you turn on | Meta delivers each message to a public https address (a webhook). With your yes, Pako opens Cloudflare's official tunnel and lets only the webhook through ([WhatsApp from your computer](channels.md#whatsapp-from-your-computer)). Meta's 24-hour window and template approvals apply. |
| Phone calls | ❌ needs a server or a tunnel | Retell needs no public address (Pako reads each call's result itself); the LiveKit voice worker posts to Pako while a call happens, which the same tunnel can carry. |

The one thing every part shares: **the computer must be on and awake.** While it sleeps nothing is answered, and what came in is caught up when
it wakes (reminders late, Slack and Zoom from where they left off).

## The limits

- **One person per Pako.** There are no accounts. Whoever is signed in to the panel is the owner.
- **The computer must be on, with Pako running.** While it is off or asleep, nothing is answered and a reminder that comes due is sent late,
  when Pako starts again, saying so ("late: your computer was asleep"); one more than 12 hours late is told as missed. The
  morning brief comes late only until 11:00 (after that `BRIEF` says it was skipped), a routine whose time passed is skipped and said
  once, and a proactive suggestion is never late. The brief and each reminder sent are rows in the store (`jobs`), so none goes twice. Pako can start by itself when you log in ([Start with the computer](install.md#starting-by-itself)); on Linux, before
  anyone logs in only with `loginctl enable-linger`.
- **The panel is on that computer only.** From anywhere else, Telegram is how you reach Pako.
- **WhatsApp needs Meta.** It takes a Meta developer app (the panel walks you through it in five steps), and Meta's business terms do not cover
  personal use. From a computer it goes through a tunnel you turn on ([WhatsApp from your computer](channels.md#whatsapp-from-your-computer)); on a server
  see [Run it on a server](server.md#run-it-on-a-server-whatsapp-phone-always-on).
- **Slack's live messages need Socket Mode** on a computer at home (an App-Level Token, one more value in the Slack card):
  [Slack and Zoom from the panel](channels.md#slack-and-zoom-from-the-panel).
- **The calendar is read only**: Zoho, any calendar's secret ICS link (read every 10 minutes, so a change can take that long to show),
  or the calendars of this Mac through Pako for Mac. **Mail is Pako's own inbox** (at AgentMail), which you forward your mail to, and, if
  you set it, your own mailbox read by IMAP ([Deeper help](features.md#deeper-help)). Your own mailbox is never written to. Pako's own inbox sends
  only what you ask for: a table request you approve, or an email to one of your contacts when you ask in your own words (see `AUTONOMY`
  under [Settings reference](configuration.md#settings-reference)).
- **Photos and PDFs are read, not kept for long** ([Deeper help](features.md#deeper-help)); other files are not read. Voice notes work on Telegram and WhatsApp, once Whisper is installed on the
  computer; the script for that is for macOS with Homebrew ([Voice notes](../assistant/README.md#voice-notes)).
- **Claude's limits are yours.** Every message is a run of `claude -p` and counts against your plan, or is billed to your API key.
- **The phone line is the least tested part**, and off unless you set it up ([docs/personal-caller.md](personal-caller.md)).
- **Updates are by hand:** run the install line again (or `git pull`, `npm install`, `npm start`).
- **Nobody outside the project has audited the code.** Read [SECURITY.md](../SECURITY.md) before you give Pako your mail.

## Honest notes

- **Tested on macOS, Linux and Windows.** The public repository's CI runs `install.sh` on macOS and Ubuntu and `install.ps1` on Windows
  (PowerShell 5.1) on every change, and checks that the started Pako answers `/health`. That run found and fixed a real Windows bug (native
  commands' stderr treated as errors). The sign-in task and `claude.exe` / npm's `claude.cmd` ([docs/install-windows.md](install-windows.md))
  are still covered by tests with stand-ins only.
- **Phase 3:** the installers and autostart are tested with pretend `launchctl`, `systemctl` and `schtasks`, and dry runs of
  `install.sh`; export and delete everything were run once by hand on a Mac.
- **Pako uses your Claude.** Every message is a run of `claude -p` on your computer, so it counts against your own Claude plan (or is billed to your API key), and Anthropic's terms for it apply. Pako gives Claude no tool that runs commands or edits files, only web search.
- **WhatsApp has rules.** Its business platform is meant for business use; read [docs/whatsapp-unofficial.md](whatsapp-unofficial.md) before putting Pako on it. Local mode has no such question.
- **English fixed texts.** Pako's own texts (buttons, commands, notices, the panel) are in English only (see [Languages](features.md#languages)). Claude answers in whatever language you write, and commands are English words.
- **The phone line is the least tested part.** It needs accounts at Retell and LiveKit, and calls to friends through Retell were failing on the provider's side for the author at the time of writing.
- **The newest parts:** the settings page and its wizards, what Pako for Mac finds on the Mac, dated memory and the people graph, the
  durable jobs behind the brief and reminders, and the autonomy levels. They are covered by tests and the golden evals, and the settings
  page and the figure were looked at in a browser. The Mac's own permission prompts (calendars, contacts) have only run in an ad hoc
  build with made-up sources (`PAKO_APP_FAKE_SOURCES`), not yet in a Developer ID build on a clean Mac.
- **Phase 2 is newer still:** the ICS calendar, the brief, repeating reminders, lists and tasks, the Memory card and the settings page are
  covered by tests, and both were looked at in a browser; the restart after a save has not been run
  under a real supervisor (launchd, systemd, pm2) or on Windows.
- **Phase 4 is the newest:** papers, routines, watches, people and IMAP are covered by tests with stand-ins (a fake `claude`, a stand-in IMAP
  client). Reading a photo or PDF through the real `claude` command and logging in to a real mailbox have not been run yet.
- **The Mac app is new:** the self-contained release (Node.js and the server inside) was built, put in a dmg, copied out of it and run on an
  Intel Mac with macOS 15 with no Node.js on its PATH (it started its own Pako, signed in, showed the dashboard, stopped everything on Quit).
  It has not been run on Apple silicon or macOS 13 and 14, and it is not signed with a Developer ID or notarized yet (the scripts are ready:
  [docs/desktop-mac.md](desktop-mac.md#make-a-release)); until then a downloaded copy is blocked by Gatekeeper.
- **Not affiliated** with Anthropic, Meta, Google, Zoho, Slack, Zoom, Retell, LiveKit or AgentMail; their names belong to them.
