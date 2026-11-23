# Pako on a server

The advanced way: a server that is always on, for WhatsApp and the phone line, with Claude still on your computer. And how to come back to your Mac.

## Run it on a server (WhatsApp, phone, always on)

This is the advanced way. Local mode stops when your computer does. To have Pako answer on **WhatsApp** and send your reminders while the
computer is off, run the server somewhere always on and keep the assistant's brain (Claude) on your computer. An answer still needs that
computer: while it is off, the server keeps your message and tells you its brain is offline.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/AnxovatomicaES/pako-personal-assistant)

1. **The server.** One click: the button above creates the server and its store on Render from [`render.yaml`](../render.yaml), on the free
   plan. Any other Node 22.18+ host works too: `npm ci --omit=dev` builds, `npm start` runs.
   Set the secrets it asks for (generate each with `openssl rand -hex 24`). When `WHATSAPP_ACCESS_TOKEN` is set, Pako stops using local mode by itself.
2. **WhatsApp.** A Meta WhatsApp Cloud API app and its webhook: [assistant/README.md](../assistant/README.md), steps 1 and 2.
3. **The brain.** On your computer: `assistant/install.sh` keeps the bridge running (a LaunchAgent on macOS) and answers with `claude -p`; see step 3 of the same guide.

Not on Render? Set `PUBLIC_URL` to the server's https address (for example `https://pako.example.com`): the panel's sign-in links use it.

What differs from a computer:

- **Language.** A server writes its own texts in English, like a computer. The brain's computer needs the same version of the code
  (`git pull` there, then restart the assistant): an older bridge may still write its own lines in Spanish.
- **The panel** has no welcome, no chat window, no language choice and no Telegram card. You get in with `PANEL` in the chat.
- **Telegram** is set with `TELEGRAM_BOT_TOKEN` and paired by writing `TELEGRAM` ([Telegram on a server](channels.md#on-a-server)).
- **The checks against other websites** described under *Safety by design* are for a computer. A server is reached by name, through proxies,
  and relies on signatures, tokens and the panel's cookie ([SECURITY.md](../SECURITY.md)).

Free hosts sleep and restart: set `VOICE_RESULTS_URL` (a Redis-protocol store, e.g. Render's Key Value) so STOP, notes, reminders and the inbox
survive. A store without persistence (Render's free Key Value) loses everything when the host restarts it: Pako then starts paused and tells you
what may be lost. A paid plan with persistence avoids it. During a deploy the new server and the old one share the store for a moment: only
the one holding the store's writer lease (a `pako-writer` key, renewed every 10 seconds) writes; on the other a job's claim answers
"taken" and a write waits for the lease (up to 36 seconds) instead of being dropped, so a message that reaches the new server first is
kept. It says so in its log and takes over once the old one stops (src/kv-lease.ts).

## Move from a server to your Mac

If you ran Pako on a server (Render, WhatsApp, a bridge on another computer) and want everything on your Mac instead, move it like this.
Nothing is lost: your notes, reminders, lists, people (and the ones you hid), routines, follow-ups and your 👍/👎 on them (the **Quality**
card's week), meeting reviews, your mail choices, what you chose about what Pako does by itself, gentle mode and the switches around your
day, what you told it about your health and what you are learning, the tables it asked for, and what Pako already told you (mail, Zoom,
Slack, calendar reminders, the day of the last brief) come along, so nothing is said twice. The server's own watchdog incidents and its last
rehearsal stay there: the Mac watches and rehearses for itself.

1. **Install Pako on the Mac** ([Pako for Mac](desktop-mac.md), or [Install](../README.md#install)) and open its panel once (the welcome asks your
   language and name; you can skip the name, the file brings it).
2. **On the server's panel** (write `PANEL` in WhatsApp), in **Move Pako to your computer**, press **Download for my computer**. You get
   `pako-move-YYYY-MM-DD.json`. It holds no secret: no token, key or password, and any that appeared inside a note is replaced.
3. **Stop the server** right away, so it does not send a reminder the Mac sends too: on Render, the service's **Settings**, **Suspend
   Web Service** (you can resume it later). Stop the bridge on the other computer too (`bash assistant/install.sh --uninstall`).
4. **On the Mac's panel**, in **Import from another Pako**, choose that file. Pako shows what comes in, what would replace something
   already there, and what stays out and why (secrets, the server's own state: its pause, its inbox, its Telegram pairing, its
   watchdog, and short-lived notes). Nothing is
   written yet.
5. Press **Import**. What it replaces is kept first in `~/.pako/import-backup-<time>.json`; then Pako starts again and reads it all.
6. **Connect again what needs a secret** (the file never carries one), in the settings page (the gear): the Slack card (with Socket Mode:
   [Slack and Zoom from the panel](channels.md#slack-and-zoom-from-the-panel)), Zoom, mail, the calendar. Settings that are not secrets (your Zoom email,
   the IMAP server, Slack's quiet hours) are already filled in where the panel has a place for them; the others (your brief's hour, your time
   zone when your computer's is not the one you want) are listed after the import for you to put in `~/.pako/.env`.
7. **Telegram:** set up its card with your bot's token (the same bot works) and pair your phone again with the QR code. WhatsApp and the phone
   line stay on the server: see [What runs on your computer](status.md#what-runs-on-your-computer-and-what-still-needs-a-server).

The file is checked before anything is taken: at most 8 MB, Pako's export format only, and only the keys on Pako's list, each with the shape
it must have. A file from another computer's **Export my data** (the Privacy card) works the same way.
