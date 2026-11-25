# Channels and connections

How to reach Pako besides the panel (Telegram, WhatsApp, Slack), and what you can connect. Every setting is in [configuration.md](configuration.md).

## Add things when you want them

Everything below is optional and independent. On your computer, the settings page (the gear, or *Settings…* in the Mac app) takes the values, one card and one wizard per connection, and restarts Pako for you.
Or put them in `~/.pako/.env` (one `NAME=value` per line; [`.env.example`](../.env.example) has the blocks to copy) and restart; the panel's **System** card shows what is connected. Telegram has its own card, with no file and no restart.
On your own computer these work as they are: **email** (the inbox is listed every 10 minutes; no webhook is needed), **calendar**, **Zoom** (listed every 10 minutes; no webhook), **tables**, **Telegram**, and **Slack** (looked at every minute, or live with Socket Mode), both connected with one paste and one Allow ([below](#slack-and-zoom-from-the-panel)). **WhatsApp** works through a tunnel you turn on ([WhatsApp from your computer](#whatsapp-from-your-computer)); only the LiveKit **phone line** still needs a server or that tunnel.

| You want | What you need | Keys | Guide |
| --- | --- | :-: | --- |
| 📧 **An email inbox for Pako** (forward your mail; it tells you only what matters, flags scams) | A free [AgentMail](https://agentmail.to) inbox | 3 | [Email](../assistant/README.md#email-the-assistants-own-inbox-agentmail) |
| 📬 **Your own mailbox, read only** (the same summaries, without forwarding) | IMAP access with an app password | 3 | [Deeper help](features.md#deeper-help) |
| 📅 **Your calendar** (agenda, reminders before meetings, events in the brief) | Its secret ICS link (Google, Outlook, iCloud) | 1 | [Every day](features.md#every-day) |
| 📅 **A Zoho calendar** (the same, through Zoho's API) | A Zoho Calendar app, read only | 3 | [Calendar](../assistant/README.md#calendar-zoho-read-only) |
| #️⃣ **Slack** (messages for you, search from the chat) | One Connect button (or your own app, one paste) | 0 | [Slack and Zoom](#slack-and-zoom-from-the-panel) |
| 🎥 **Zoom** (meeting summaries) | One Connect button (or your own app, one paste) | 0 | [Slack and Zoom](#slack-and-zoom-from-the-panel) |
| 🍽️ **Book a table** (real restaurants; it emails them only after you press a button) | A Google Places key (and the email inbox above, to write) | 1 | [Tables](../assistant/README.md#tables-book-a-restaurant-google-maps-the-restaurants-own-site-and-the-assistants-inbox) |
| 💬 **WhatsApp** next to the panel chat (from your computer through a tunnel you turn on, or on a server; Meta's rules apply) | A Meta WhatsApp Cloud API app | 4 | [WhatsApp from your computer](#whatsapp-from-your-computer) |
| ✈️ **Telegram** next to the panel chat or WhatsApp (Pako answers where you write, and reminders reach your phone) | A bot from @BotFather | 1 | [Telegram next to your chat](#telegram-next-to-your-chat), below |
| 📞 **Phone** (it calls you, and friends you approve) | LiveKit and Retell accounts | 5+ | [Phone line](personal-caller.md) |

## Telegram next to your chat

Telegram is how Pako reaches your phone. It is a bot of your own: you create it, and only your account is answered.

### From the panel (on your computer)

Open the **Telegram** card in the panel. It is also the last step of the welcome.

1. **Create the bot.** In Telegram, open [@BotFather](https://t.me/BotFather) (the card shows a QR code and a link for it). Send `/newbot`, then a
   name, then a username ending in `bot`. BotFather gives you a token.
2. **Paste the token in the card.** Pako checks it with Telegram, keeps it in `~/.pako/secrets.json` (readable only by you) and starts the bot
   at once. No restart.
3. **Scan the QR code** the card now shows with your phone, and press **Start** in Telegram. The code works once, for 10 minutes; **New code**
   gives another. Pako says in the chat which account it paired, so a code scanned by someone else shows up.

From then on:

- **What Pako starts by itself goes to your phone**: reminders, notices, receipts, cards that ask for your press. The panel's chat keeps a copy,
  marked *Sent to your Telegram*. If Telegram cannot be reached, the message appears in the panel's chat only.
- **Answers go where you wrote**: in the panel if you wrote in the panel, on Telegram if you wrote there.
- **Disconnect** in the card, or `TELEGRAM OFF` in the chat, unpairs your account. The token stays, so pairing again is one scan.
- The computer must still be on: Pako asks Telegram for your messages from there.

If `TELEGRAM_BOT_TOKEN` is set in `~/.pako/.env`, that bot is used: the panel can pair and unpair it, not change it. A pairing belongs to one
bot, so a new bot needs a new scan. If the token is revoked, or the bot deleted, the card asks for a new one.

### On a server

1. Create the bot with [@BotFather](https://t.me/BotFather), as above.
2. Put the token in `TELEGRAM_BOT_TOKEN` in the server's environment and restart it.
3. In your chat with Pako, write `TELEGRAM`. Open the link on your phone and press **Start**. The link works once, for 10 minutes. Pako tells
   you on your usual chat which account it paired.

There, what Pako starts by itself goes where you wrote last. Telegram has no 24-hour rule like WhatsApp's, so when WhatsApp would not let
Pako write first, it writes to you on Telegram.

### Either way

- Only the paired account is answered. Anyone else who finds the bot gets one line saying it is private.
- Buttons, `STOP`, the commands and voice notes work the same. A card's buttons go once you press one.
- On a server with a public address (`PUBLIC_URL`, or Render) Telegram sends its news to `/telegram/webhook`, checked by a secret header
  derived from the token. On a server without one, and always on a computer, Pako asks Telegram for them (long polling): a computer at home
  needs no public address.
- One bot per Pako: two Pakos with the same token would take each other's messages.
- Telegram sees what you and Pako write there ([SECURITY.md](../SECURITY.md)).

## WhatsApp from your computer

The **WhatsApp** card (on the panel, and on the settings page behind the gear) sets it up in five guided steps. Only Meta's official WhatsApp Cloud API is used:
unofficial WhatsApp Web libraries (Baileys, whatsapp-web.js) break WhatsApp's terms and can get your number banned, so Pako never uses them.

1. **Create a Meta app.** The card's button opens developers.facebook.com/apps/creation and says exactly what to choose: your name and email,
   the use case *Connect with customers through WhatsApp*, your business portfolio (or none yet), *Create app*.
2. **Add WhatsApp and copy its details.** In *WhatsApp → API Setup*: the test number's *Phone number ID*; under *To*, add your own number and
   confirm it with the code WhatsApp sends; *Generate access token* (it lasts 24 hours: for one that never expires, make a system user in your
   business settings, assign it the app, and generate a token with `whatsapp_business_messaging` and `whatsapp_business_management`, expiry
   *Never*). In *App settings → Basic*: the App ID and the App secret.
3. **Paste them in the card.** Pako checks them with Meta at once (the number, the token, the app id and secret together) and keeps them in
   `~/.pako/secrets.json` (mode 600). The page never gets a token or secret back.
4. **Open the tunnel.** With your yes, Pako downloads `cloudflared`, Cloudflare's official program, from Cloudflare's GitHub releases for this
   computer's system and processor, checks its SHA-256 against the checksums Cloudflare publishes with the release (and GitHub's own digest),
   keeps it in `~/.pako/bin`, and runs `cloudflared tunnel --url http://127.0.0.1:<port>` as a child of Pako: it starts again when it stops,
   comes back when Pako starts, and stops with Pako. Through the tunnel **only** `/whatsapp/webhook` answers (and, when the LiveKit voice line
   is set up, `/personal-voice/result`, `/tool` and `/inbound`): anything else that came through it (Cloudflare marks every such request) gets
   a 404, so the panel, the chat and `/assistant/*` are never public. A quick tunnel's address changes each time it starts: Pako registers
   the new one with Meta by itself (`POST /{app-id}/subscriptions` with the app's own token) and checks that Meta's verification arrived.
5. **"Send me a hi".** Pako sends a test message to your number (Meta's `hello_world` template) and waits: your reply puts the ✓, and from then
   on your WhatsApp is a chat with Pako beside the panel's (and Telegram's).

What to expect:

- **The 24-hour window.** WhatsApp lets Pako write to you freely only for 24 hours after your last message there; after that, what Pako starts
  (a reminder, a notice) comes to the panel's chat, or to Telegram when it is paired. The card shows until when the window is open.
- **Templates.** To write first after those 24 hours, Meta must approve a message template ([assistant/README.md](../assistant/README.md),
  `pako_notice` in English by default, or the name in `WHATSAPP_REMINDER_TEMPLATE` with its language in `WHATSAPP_TEMPLATE_LANG`); the card shows its status live. On a computer Pako does not send it by itself yet.
- **Text and buttons** work on WhatsApp from a computer. Voice notes, photos and documents are answered with a line asking for them in the
  panel's chat (their files would have to be fetched from Meta).
- **The phone line** needs no tunnel for Retell. The LiveKit voice worker posts its results to Pako: with the tunnel on, the card shows the
  address to give the worker as `PAKO_URL`. It changes with each start of a quick tunnel, so for that a server is still simpler.
- **Forget** in the card closes the tunnel and deletes Meta's values from this computer in one click. Turning the tunnel off stops it at
  once; `~/.pako/bin/cloudflared` stays until you delete it.
- The computer must be on and awake: while it sleeps Meta keeps the messages for a while and delivers them when the tunnel is back.

## Slack and Zoom from the panel

Slack and Zoom are where commitments are made: "I'll send it Friday" in a DM, a decision in a meeting. Pako reads both, read only.

**One button.** When this Pako has the project's own apps (`src/connect-clients.ts`, registered as in
[owner-app-setup.md](owner-app-setup.md)):
- Each card is one **Connect** button. You allow Pako on Slack's or Zoom's page, and you are done.
- Slack: some company workspaces need their admin to approve Pako; the card says so.
- Zoom: until the project's app is published in the Zoom Marketplace, only the users the project added can connect it.

**Your own app** (the card's "Advanced: use your own app", and the only way while this Pako has no built-in app):
- Pako writes the app for you, and you connect it with one paste of its Client ID and one **Allow**. You never copy a token or a secret.
- An app you create in your own workspace or account is yours.
- On Slack it also has the full rate limits: the project's app, until it is listed in the Slack Marketplace, may read one DM a minute.

How it works underneath:
- Both services now let a program on your own computer finish signing in by itself, with PKCE: a one-time secret that never leaves your Mac.
- The browser comes back from **Allow** to Pako on your computer (`http://localhost:<port>/connect/slack/callback`, `http://127.0.0.1:<port>/connect/zoom/callback`).
- Pako exchanges the sign-in for a token and keeps it in your secret store (the macOS keychain, or `~/.pako/secrets.json` readable only by you).
- The card then says **Connected as Ana Ruiz in Acme** (Slack) or **Connected as Ana Ruiz (ana@acme.com)** (Zoom).

### Slack with your own app: about 6 clicks and 1 paste

Open the **Slack** card in the settings page (the gear):

1. **Create the Slack app.** The button opens Slack with Pako's app already written. Pick your workspace, press **Next**, then **Create**.
2. **Paste the Client ID.** Slack now shows your app's page. Under **App Credentials**, copy the **Client ID** (two numbers joined by a dot)
   and paste it in the card. It is not a secret.
3. **Connect Slack**, then **Allow** on Slack's page. Come back to Pako: the card says who and where you are connected.

If your workspace requires an admin to approve new apps, **Allow** becomes a request to them; press **Connect Slack** again once approved.

What the app is: a user token (`xoxp-`) with read scopes only, so it sees what you see and cannot write:
`channels:history`, `channels:read`, `groups:history`, `groups:read`, `im:history`, `im:read`, `mpim:history`, `mpim:read`, `users:read`,
`search:read`. It has PKCE on, token rotation off (the token does not expire), no bot, and no Socket Mode.

How Pako reads it: every minute it looks for new direct messages and group DMs (`conversations.list`, `conversations.history`) and for
mentions of you in channels (`search.messages`), from the moment you connected. A conversation with news in the last two days is read every
minute; with hundreds of DMs the quiet ones are read in turn, a few minutes apart. What it finds goes to the follow-ups, the brief and the
`SLACK` command, exactly as before. Slack already notifies you, so Pako only copies a message to your chat with `SLACK_FORWARD=on`.

Limits:
- A thread reply in a DM that does not mention you is not seen (Slack's history lists threads by their first message).
- Slack's search can take a minute or two to index a new mention.

**Live instead of every minute (optional).** For messages within seconds, add an App-Level Token too:
1. In your app's **Basic Information**, under **App-Level Tokens**, press **Generate Token and Scopes**. Add `connections:write`, then **Generate**.
2. Turn **Socket Mode** on in the app.
3. Put the token (`xapp-`) in `SLACK_APP_TOKEN`: the **More settings** card, Slack, or `~/.pako/.env`.

Pako then opens the connection itself (`src/slack-socket.ts`) and stops looking every minute. On a server with a public address,
`SLACK_SIGNING_SECRET` and Slack's events address `/slack/events` do the same
([assistant/README.md](../assistant/README.md#slack-read-only)).

If something goes wrong, the card says it in plain words:
- **Cancel** pressed on Slack's page: nothing is kept.
- **Token rotation** turned on in the app: turn it off under **OAuth & Permissions**, then connect again.
- **An app made before this version** (Socket Mode, no PKCE): press **Create the Slack app** again. Slack makes a new app; delete the old
  one from [api.slack.com/apps](https://api.slack.com/apps) whenever you like.
- **A missing permission:** the card names it; create the app again from the button.

### Zoom with your own app: about 9 clicks and 1 paste

Open the **Zoom** card and choose **Connect my Zoom account**. On a Mac, the card also offers the recordings Zoom keeps on this computer,
with no account at all.

1. **Save the app file.** Pako writes your Zoom app as a file, `pako-zoom-app.json`, in your Downloads folder. **Download it** does the
   same in a browser.
2. **Upload it to Zoom.** Open the [Zoom Marketplace](https://marketplace.zoom.us/develop/create) and sign in. Choose **Develop** →
   **Build from an app manifest**, pick the file, press **Create**.
3. **Turn on "Use Public Client OAuth"** under **App Credentials** on the app's page. Copy the **Client ID** shown there and paste it in the
   card. It is not a secret.
4. **Connect Zoom**, then **Allow** on Zoom's page. The card says who you are connected as.

If Zoom asks for a redirect URL, the card shows it to copy: `http://127.0.0.1:<port>/connect/zoom/callback`, with Pako's own port. Zoom
matches the port too, so an app made on another computer, or before Pako's port changed, needs this address added (error 4,700 otherwise).

What the app is: a General app for your own use (`USER_OPERATION`), unpublished, with PKCE and these read scopes:
`meeting:read:list_meetings`, `meeting:read:summary`, `meeting:read:list_summaries`, `cloud_recording:read:list_user_recordings`,
`cloud_recording:read:list_recording_files`, `user:read:user`.

How Pako reads it:
- Every 10 minutes (`ZOOM_POLL_MINUTES`) it lists your meetings, the AI Companion summaries of the meetings you hosted, and your cloud
  recordings' transcripts.
- It finds who owes what in them: the meeting review and the follow-ups.
- Zoom renews the sign-in every hour. Each renewal comes with a new refresh token, which Pako keeps at once in your secret store.
- If Pako stays off for more than 90 days, connect again.

Limits:
- AI Companion summaries need a paid plan with meeting summaries turned on, and Zoom gives them to the meeting's host. Meetings someone else
  hosted reach Pako through their cloud recording's transcript, when you can see it.
- Some company accounts only let people with the "Zoom for developers" role build apps. If **Develop** is missing, ask your Zoom admin. An
  admin can also keep using a Server-to-Server OAuth app (`ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_USER`, the
  `:admin` scopes), which still works as before.

## Microsoft Teams

Teams chats and meetings are where many promises are made, so Pako reads them, read only, and feeds the same follow-ups as Slack: what
you were asked, what you promised ("I'll send it Friday"), and your later replies that close them.

- **Connect.** Settings → Advanced → **Microsoft Teams** → **Connect Teams**, then **Accept** on Microsoft's page. It uses the project's
  Microsoft app (`MS_CLIENT_ID`, the one mail and calendar use) and the same PKCE sign-in back to
  `http://127.0.0.1:<port>/connect/teams/callback`. If your Microsoft mail is already connected, Microsoft asks only for Teams'
  permissions: one Accept.
- **What it reads, without your admin** (where your company lets you consent alone): your 1:1, group and meeting chats (`Chat.Read`), and the
  Teams meetings on your calendar (`Calendars.Read`). Every new message to or from you goes to the follow-ups. Your own messages count:
  they carry your promises and close what they answer.
- **What needs your admin.** Channel messages that @mention you (`ChannelMessage.Read.All`) and meeting transcripts
  (`OnlineMeetingTranscript.Read.All`, when transcription was on). The card shows a request you copy and send to your IT admin, with what each
  permission adds and Microsoft's approval link. Once they approve, press **Add what my admin approved**. A transcript is read like a Zoom
  summary: decisions and who owes what become follow-ups. Without transcripts, the calendar's Teams meetings still tell the follow-ups
  that a meeting happened.
- **Many companies need the admin for chats too.** Since late 2025 Microsoft's default lets nobody consent alone to chats and calendars for
  apps like Pako. Microsoft's page then says "Need admin approval"; Pako's card shows the same request for your admin.
- **Personal Microsoft accounts (Teams free)** can't be read: Microsoft offers no API for their chats.
- **How often.** Every 5 minutes (`TEAMS_POLL_MINUTES`) Pako asks for your chats sorted by their last message, then reads only the chats
  with something new, each with a date filter. Microsoft's live notifications need a public web address, which your computer doesn't
  have. When Microsoft says "slow down" (429), Pako waits as long as it asks.
- **First connection.** A quiet catch-up of the last 14 days (`PAKO_BACKFILL_DAYS`), paced and with no notices: one line ("Connected to
  Teams as … Catching up…") and one summary at the end.
- **Third-party text.** Teams messages are other people's words: information for you, never instructions. Pako strips their markup and
  fences them like Slack's and mail's.
- **Read only.** Pako never sends a Teams message. Sending a reply you approved (`ChatMessage.Send`) is a next step.
- **The card** shows the account and organisation, what is granted (chats ✓, channel mentions: needs your admin, transcripts: needs your
  admin), the last read and the last error, and **Disconnect**. To remove Pako on Microsoft's side too: myapps.microsoft.com → Pako →
  Revoke.

## Messages on your Mac (iMessage and SMS)

Many personal promises are made in Messages, so on a Mac Pako reads them, read only, and feeds the same follow-ups as Slack and Teams:
what you were asked, what you promised, what people promised you, and your later replies that close them.

- **Turn it on.** Settings → **Messages** → **Turn on Messages** (it sets `IMESSAGE=on`, and Pako starts again). Off by default.
- **Full Disk Access.** Messages keeps its history in `~/Library/Messages/chat.db`, which macOS guards. Pako needs Full Disk Access to read
  it: System Settings → Privacy & Security → Full Disk Access → turn on **Pako** (for a source install, the terminal app you start Pako
  from). Until then the card says so, with **Open Full Disk Access** (`x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles`)
  and **Check again**.
- **What it reads.** Each new message of every chat, 1:1 and group, after a mark, so none is read twice: its text (modern macOS keeps most
  texts in `attributedBody`, which Pako decodes), who sent it, whether it is yours, which chat, and when. Reactions (tapbacks), group
  events and attachment-only messages are skipped. Nothing from before you turned it on.
- **How often.** Every 2 minutes (`IMESSAGE_POLL_MINUTES`). Each look opens the file read only and closes it at once: Messages keeps
  working while Pako reads.
- **Third-party text.** Other people's messages are information for you, never instructions; Pako fences them like Slack's and mail's.
- **Read only.** Pako never sends an iMessage or an SMS.
- **Mac only.** On another system the card says it is for a Mac.

## Mail on this Mac: no password

If you read your email in Apple's Mail app, Pako can read it from there: every account you added to Mail (iCloud, Gmail, Outlook,
Exchange, any IMAP) comes with it, with one switch and no password, app password or sign-in.

- **Turn it on.** Settings → **Mail on this Mac** → **Turn on Mail on this Mac** (it sets `APPLE_MAIL=on`, and Pako starts again). Off by
  default. A Mac only.
- **Full Disk Access.** Mail keeps its store in `~/Library/Mail`, which macOS guards. Pako needs Full Disk Access to read it, exactly as for
  Messages: System Settings → Privacy & Security → Full Disk Access → turn on **Pako** (for a source install, the terminal app you start
  Pako from). Until then the card says so, with **Open Full Disk Access** and **Check again**.
- **What it reads.** The newest store (`~/Library/Mail/V<N>/`): its index (`MailData/Envelope Index`, opened read only) and each new
  message's file (`.emlx` or `.partial.emlx`). Only your inboxes and your Sent mailboxes: never Junk, Trash, Drafts or archives, and never a
  message Mail marks deleted. Each message once, after a mark.
- **From when.** Only mail from the moment you turned it on: no backlog floods your mailbox or your follow-ups, and there is no catch-up of
  older mail (that is IMAP's). A message Mail has not finished downloading is looked for again for a while.
- **The same as IMAP from there on.** Each email goes through the same steps as mail read by IMAP: codes hidden, mail sent to many only
  kept, the summary, the categories, the follow-ups and the invitations. Your replies in Sent close what they answer, and your own promises
  in them become follow-ups.
- **With IMAP too.** If the same account is also connected with a password, nothing comes twice: an email is taken once, by its Message-ID
  and sender, whichever way reaches it first.
- **How often.** Every 3 minutes (`APPLE_MAIL_POLL_MINUTES`). Each look opens the index read only and closes it at once: Mail keeps working.
  With Mail closed the index is opened immutable, so not even a lock file is written.
- **Read only.** Pako never sends, moves, flags or deletes an email this way, and never writes to Mail's folder.

## Mail with Microsoft or Google

The **Mail** card first finds your addresses on this Mac (Pako for Mac, after your yes). It looks in:
- Apple Mail and Outlook;
- eM Client's and Thunderbird's account lists;
- your Apple Account;
- your own contact card.

Only addresses are read, never a message or a password. Next to each address the card says where it was found. It also says how Mail
itself went, exactly:
- "Mail isn't set up on this Mac"
- "Allow Pako to read Mail's account list: System Settings › Privacy & Security › Automation › Pako › Mail"
- "Mail is closed: open it, or press Find my accounts on this Mac"
- "Found 2 addresses on this Mac"

Then you connect one address, read only. How depends on its provider:

- **Microsoft (Outlook.com, Hotmail, Live, Microsoft 365).** Microsoft turned off passwords for IMAP. Press **Sign in with Microsoft**,
  choose the account on Microsoft's own page, then **Accept**. Pako signs in with OAuth and PKCE as a public client (no secret), and the
  browser comes back to `http://127.0.0.1:<port>/connect/microsoft/callback` on this computer. Pako tries one read-only login with the new
  token (IMAP, XOAUTH2) before it keeps anything, then renews the sign-in by itself. If Microsoft stops taking it (you revoked it, changed
  your password, or it went unused for 90 days), the card says **Sign in again**. A work account whose admin turned IMAP off is said plainly;
  forwarding to Pako's inbox still works there.
- **Google (Gmail, Google Workspace).** The same with **Sign in with Google**, back to `/connect/google/callback`. An **app password** stays as
  the other way: Google Account → Security → 2-Step Verification on → App passwords.
- **iCloud, Fastmail, Yahoo, your own domain.** Pako finds the server (for iCloud, `imap.mail.me.com`, port 993) and you paste one **app
  password**. For iCloud: [appleid.apple.com](https://appleid.apple.com) → **Sign-In and Security** → **App-Specific Passwords** → **+**, name it
  "Pako". An Apple ID with iCloud Mail on shows as **Connect iCloud Mail** in the list.

**A second mailbox.** After the first, **Connect another account** in the mail card connects one more address the same way; it is kept
apart (`IMAP2_*`, its own place in the store and its own line in Health) and never replaces the first. Pako reads both, each email remembers
the address it came to, and a reply draft on the phone says **Reply from** that address (a mail link cannot choose the sender). Each mailbox
has its own **Disconnect** in the card; with two connected, a third address is refused until one is disconnected.

### The project's own apps

Signing in with Microsoft or Google uses the project's own registrations: one public client each, used by every Pako. Pako never borrows
another program's client ID.
- **Microsoft:** one sign-in covers the mailbox and the calendar (`Calendars.ReadWrite`, for the calendar writes that are coming).
- **Google:** the calendar card gets **Connect Google Calendar**. Gmail by sign-in is offered only once Google allows the restricted Gmail
  scope for the app (`GOOGLE_GMAIL_ALLOWED`); until then Gmail uses an app password.

The exact registration steps, review times, and where to paste each ID are in [owner-app-setup.md](owner-app-setup.md).
