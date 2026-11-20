# Roadmap

Where Pako is going, in the order it will get there, and the decisions behind it. Each phase ships on its own; nothing here is a promise of a date.

**Where it stands:** Phases 0 to 3 are built and the clean repository is public ([pako-personal-assistant](https://github.com/AnxovatomicaES/pako-personal-assistant)), with Pako for Mac 0.3.9 (unsigned preview, beta) in its Releases. Phase 4 is built too; of Phase 5, the Mac desktop app is built.

## Who Pako is for

**One Pako per person, on their own computer or their own server, with their own Claude.** There is no hosted Pako service and there will not be one:

- Pako's brain is Claude, through *your* Claude subscription (Pro or higher, used by the `claude` command on your computer) or *your* Anthropic API key. A service that ran other people's assistants on their subscriptions would be a middleman between them and Anthropic, which Anthropic's terms do not allow.
- An assistant reads mail, calendars and chats. Running it for strangers would make whoever runs it responsible for strangers' mail. On your own machine, it is yours.

**What it costs:** Pako is free and open source (MIT). It needs a Claude Pro (or higher) plan, or an Anthropic API key, both paid by you to Anthropic. Everything else is optional.

## Design decisions

| # | Question | Decision |
|---|---|---|
| 1 | Who it is for | One Pako per person, self-hosted. No hosted service. |
| 2 | Price | Said plainly: it needs Claude Pro (or higher) or an Anthropic API key. API keys are supported officially. |
| 3 | Language | English for everything Pako writes itself, for owners anywhere (since 18 November 2026; Spanish and English before). Claude's answers follow the language you write in. |
| 4 | Can the panel change things? | Yes, in local mode only, with the same protection as STOP: settings, deleting notes, export and delete everything. |
| 5 | Default chat | Telegram plus the panel. WhatsApp is an advanced option (Meta's rules make it hard for personal use). |
| 6 | Before publishing | Phase 0 complete. |
| 7 | Calendar | A secret ICS link by default (Google, Apple, Outlook). Zoho stays as an advanced option. |
| 8 | Mail | Pako's own inbox (AgentMail) now; reading your own mail and drafting replies later; sending, much later. |
| 9 | Install | One line, macOS and Linux first; Windows in Phase 3; a desktop app later. |
| 10 | Phone | For the public, only "call me" to the owner, as an advanced option. Calls to friends stay off until there is a consent system. |
| 11 | Privacy | Notifications show a generic preview for what third parties write; one-time codes are hidden unless you turn that off. |

## Phases

### Phase 0 — Pako keeps its promises (done)

**Done.** Shipped: a STOP that survives a wiped store, receipts with Undo, hidden one-time codes, answers in your language, a first start
that says what is missing, and a sign-in link that cannot be steered elsewhere.

- STOP is never lost: if the store comes back empty (a host wiped it), Pako starts paused and tells you; if it cannot read the store, it does not act.
- Every change Pako makes by itself (a note, a reminder) comes with a receipt and an **Undo** button.
- One-time codes are hidden from email summaries and notifications; you can still ask for them (`CODE`).
- Pako answers in the language each person writes in.
- A first start that never gets stuck: clear checks for Node and dependencies, `npm run panel` for a new sign-in link, and a panel that says exactly what Claude needs.
- The panel's sign-in link cannot be steered to another host.

### Phase 1 — First public release (done)

**Built.** Shipped: Spanish and English for everything Pako writes itself (English only since 18 November 2026); a welcome in the panel (name,
three things to try); Telegram set up from the panel with a QR code, so reminders reach the phone; a guard that keeps other websites and DNS
rebinding away from the Pako on your computer; an Anthropic API key as an alternative to a Claude plan; and documentation rewritten to say
what works and what does not. It was published from a clean repository on 18 November 2026.

- Claude's replies in the language you write in; the panel and notices in English.
- Reminders reach your phone: connect Telegram from the panel with a QR code.
- The first five minutes: a guided start that shows what Pako does.
- Honest documentation and security hardening.
- Published from a clean repository.

### Phase 2 — Useful every day, with one key or none (built)

**Built.** Shipped: a Connections card on a computer that keeps the keys and restarts Pako to apply them; any calendar by its secret ICS link;
a daily brief with or without a calendar; reminders that repeat, with Done, +10 min and Tomorrow buttons; lists and tasks; and notes you can
list, correct and delete by number, in the chat and in the panel's Memory card.

- Connect services from the panel.
- Any calendar (Google, Apple, Outlook) through its secret ICS link.
- A daily brief for everyone.
- Repeating reminders, with buttons.
- Lists and tasks.
- A memory you can see and correct.

### Phase 3 — Install and forget (built)

**Built.** Shipped: one-line installers (`install.sh` for macOS and Linux, `install.ps1` for Windows) that also update; starting by itself at
login (LaunchAgent, systemd user unit, Task Scheduler task) from the installer, `npm run autostart` or the panel; and a Privacy card with an
export of everything and a delete-everything. Both installers now run on real macOS, Ubuntu and Windows machines in the public repository's CI.

- One-line install on macOS, Linux and Windows.
- Starts by itself when you log in (on Linux, at boot with lingering).
- A privacy page.
- Export everything, delete everything.

### Phase 4 — Deeper help (built)

**Built.** Shipped: other people's text (mail, forwarded messages, calendar, Slack, meetings, papers, the web) is cleaned before Claude
reads it, and an answer written after reading it holds what it asks for behind a **Do it / Cancel** card; photos and PDFs read in an
isolated run and summed up; routines on a schedule and watches on the mail, calendar and Slack Pako already reads; a record of the people
in your life, with birthdays as yearly reminders and in the brief; your own mailbox read only by IMAP (`imapflow`, the one new
dependency). All of it is covered by tests with stand-ins: a paper has not yet been read through the real `claude` command, nor a real
mailbox logged in to.

- First, by design: text written by third parties is kept apart from the part of Pako that acts.
- Read your papers (photos, PDFs).
- Routines and watches.
- Memory of the people in your life.
- Read your own mail (never sending).

### Phase 5 — Optional

**The Mac desktop app is built** ([desktop-mac.md](desktop-mac.md)): `npm run mac-app` makes `Pako.app`, a native Swift app (AppKit and
WebKit, no Electron, no new dependency) for Intel and Apple silicon. It finds Pako and Node.js, starts Pako (or asks launchd when autostart
is on), signs in as `npm run panel` does and shows the whole panel, dashboard and chat, in its own window, with a menu-bar item (Open,
Dashboard, STOP, start with this Mac, logs). It stops only a Pako it started. It is signed ad hoc, not notarized: Gatekeeper asks once. It
was run on an Intel Mac with macOS 15; not yet on Apple silicon. Windows and Linux desktop apps are not planned yet.

- An always-on server that does not depend on Meta, and a Docker image.
- A desktop app: built for macOS.
- Talk to Pako by voice from the panel.
- Ask businesses for appointments.
