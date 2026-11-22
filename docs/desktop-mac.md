# Pako for Mac (the desktop app)

`Pako.app` is a small native app (Swift, AppKit and WebKit) that runs Pako on your Mac and shows its panel in a window of its own, with an
item in the menu bar. It is **self-contained**: Node.js and Pako's server are inside it, so you install nothing else first. It is the same
Pako as `npm start` (the same `~/.pako`, the same panel), so you can also go on using a browser and the terminal.

## Install Pako for Mac

You need macOS 13 (Ventura) or newer, on an Intel Mac or Apple silicon, and a Claude account with a Pro, Max, Team or Enterprise plan.

**The quickest way, with no macOS warning:** paste this into Terminal.

```sh
curl -fsSL https://raw.githubusercontent.com/AnxovatomicaES/pako-personal-assistant/main/install-mac.sh | sh
```

It downloads the latest release, checks it against Pako's signed update feed (the same check the app makes on its own updates), puts
Pako in Applications and opens it. Files curl downloads carry no "quarantined" mark, so macOS opens Pako straight away. It never uses
`sudo`; running it again installs the newest release. Read it first if you like: [install-mac.sh](../install-mac.sh). The feed's Ed25519
signature is checked when your Mac has OpenSSL 3 (from Homebrew, say); macOS's own OpenSSL cannot, and then only the SHA-256 is.

**Or by hand:**

1. **Download** `Pako-<version>.dmg`. (To check the download, compare `shasum -a 256 Pako-<version>.dmg` with the `.sha256` file published
   next to it.)
2. **Open** it and **drag Pako to Applications**.
3. **Open Pako** from Applications (or Spotlight). Pako is not notarized by Apple yet ([why, and the plan](notarization.md)), so the
   first time macOS blocks it once:
   - **macOS 15 Sequoia and newer:** macOS says "Pako" Not Opened (Apple could not verify it): press **Done**, not Move to Trash. Open
     **System Settings → Privacy & Security**, scroll down to **Security**, press **Open Anyway** next to "Pako" was blocked to protect
     your Mac, enter your Mac password (or use Touch ID), and press **Open Anyway** once more. Control-click → Open no longer works there.
   - **macOS 13 Ventura and 14 Sonoma:** in Applications, Control-click (or right-click) **Pako**, choose **Open**, then **Open** again.
   - **In Terminal instead (any version):** `xattr -dr com.apple.quarantine /Applications/Pako.app`.

   Only once: after that it opens like any app. With no warning at all: the one-line installer (`install.sh`, [docs/install.md](install.md))
   downloads with git, not a browser, so macOS never asks; it needs Node.js 22.18+ and git.
   If you open it straight from the disk image (or from Downloads), Pako offers to **move itself to Applications** and opens again from
   there: from the disk image it would stop working once the disk is ejected, and it could not start with your Mac.
4. **Connect your Claude account**: one button, below. Pako then works with your own Claude plan.
5. **Connect your things** (optional, every step can be skipped): right after, a short step goes through what else Pako can use, one at a
   time, with the plain steps for each: **Telegram** first (the one chat that works with no server of your own: you talk to Pako from your
   phone while the Mac is on), then **Calendar**, **Mail**, **Slack** and **Zoom**. See *Connect your things* below.

That is all: Pako starts, signs in to its panel by itself and shows the dashboard. Closing the window keeps it in the menu bar.

## What it does

1. **Runs the Pako inside it**: `Contents/Resources/node/bin/node` (the official Node.js 22 LTS, for Intel and Apple silicon) on
   `Contents/Resources/pako/src/server.ts`. A release never runs code from anywhere else: no folder chosen before, no `~/pako`, no folder
   picker. (A developer build, see *Build the app*, runs a Pako folder with your own Node.js instead.)
2. **Finds the running Pako** by its lock in the Pako home (`~/.pako/.lock`, or the folder `PAKO_HOME` names: in the app's environment, in
   `~/.pako/.env`, as `npm run panel` looks). If none is running, it starts its own, without opening a browser. What it prints goes to
   `~/.pako/logs/app.log` (past 5 MB it is rotated: `app.log.1` to `.3` are kept, mode 600, as it may quote a message). It is given a `PATH` with the usual places of the `claude` command (`~/.local/bin`, `~/.claude/local`,
   `/opt/homebrew/bin`, `/usr/local/bin`); one found elsewhere is added (see *Connect Claude*).
3. **Signs in** the way `npm run panel` does: it reads the bridge token from `~/.pako/secrets.json`, asks the running Pako on `127.0.0.1` for a
   one-time link, and opens it in the window. The token is never shown or written anywhere, never in a command line, and it goes only to
   the port of the live lock, and only when the lock's own process is the one listening there: a lock left by a Pako that was killed (its
   process number now another program's) gets nothing. The panel's cookie is kept (30 days), so opening the app again goes straight in; when
   the panel asks to sign in again, the app gets a new link by itself.
4. **The window is the whole panel**: the dashboard with all its cards (the day's overview, agenda, mail, Slack, activity, reminders, lists
   and tasks, routines, people, memory, system, Telegram, connections, privacy) and the chat drawer, exactly as in a browser. The window
   opens at 1240 x 820 and remembers its size and place. The first time, the chat drawer is closed once it opens, so the dashboard shows first.
5. **The menu-bar item**: *Open Pako*; *Dashboard* (the panel's cards, the chat drawer closed, the page back at the top); *Pause everything
   (STOP)* / *Resume* (the panel's own STOP switch; shown once the panel is open); *Start with this Mac* (below); *Logs* (opens
   `~/.pako/logs` in the Finder); *Connect Your Things…* (below; shown once the panel is open); *Quit Pako*. When a newer version is out,
   *Update available: Pako x.y.z…* (below) is at the top of it and of the Pako menu.
6. **Closing the window** (Cmd+W) keeps Pako in the menu bar (and running); clicking the Dock icon brings it back. **Cmd+Q** (or *Quit Pako*)
   quits the app, and stops Pako **only if the app started it**: a Pako you started in a terminal keeps running. The first time, while
   *Start with this Mac* is off, it asks once: quitting means reminders and routines do not happen (*Keep Pako Running* closes the window
   instead; *Don't ask again*, or Settings > *Ask before quitting*, stops the question). Quit never waits more than about five seconds, so
   logout is not held up.
7. Only the panel's own pages (plain http on `127.0.0.1` and the running Pako's port) stay in the window: the app opens the panel at
   `127.0.0.1`, never at the name `localhost` (which macOS tries on `::1` first, where another program could listen). A link you click
   to another site, a mail address or a phone number opens in your default browser or app; anything else (another port, `file:`,
   `javascript:`, `data:`, a page or a frame moving on by itself, a window a script opens by itself) is refused. The Edit menu (copy, paste,
   undo) works in the chat. Cmd+R reloads the panel. The data export of the Privacy card is saved in your Downloads folder.
8. Its few words are in English, like the panel's.
9. **One at a time**: opening a second copy of Pako.app (say, one still on the disk image) brings the running one forward instead.
10. **While it starts** (or when something is wrong) the window shows its own page, in your Mac's light or dark appearance: Pako's orb, what
    is happening, and a button for what to do (*Try again*, *Restart Pako*, *Open logs*). Never a blank or white window.

## Keeping Pako running

- **A crash is restarted**: when the Pako the app started stops by itself (an error, out of memory, killed), the app writes it in `app.log`
  (its exit code or signal and how long it ran), the menu-bar orb turns hollow, the window says *Pako stopped. Starting it again in N s…*,
  and it starts it again after 1, 2, then 4 seconds. A fourth stop in a row (each run under five minutes) is not retried: the window says
  *Pako keeps stopping*, with *Try again* and *Open logs*. `app.log` also says when the app took its Pako as up (*Pako is up (process,
  port)*); one killed by a signal while it was starting, or just after it first answered, is started once more instead of shown as not started.
- **Its port**: the first time, 8787. When another program already listens there (Cloudflare's `wrangler` uses it too, and so does a Pako
  of another account on this Mac), the app picks a free port and keeps it from then on, so the panel's address (and its cookie) stay the
  same. If a start still finds the port taken, it tries once more on a new one. `PORT` in the app's environment wins.
- **A Pako left behind**: a lock whose process number now belongs to another program (after a crash or a power cut) is taken over by itself
  (the lock says when its process started). A Pako that holds your data but does not answer gets a *Restart Pako* button: the app stops it
  (only if it is `node` running Pako's `server.ts`) and starts a new one. Nobody is asked to delete a file.
- **Force Quit or a crash of the app**: the Pako it started stops by itself within two seconds (`PAKO_APP_PID`), so nothing keeps running
  that no window can stop. Claude runs under way stop with it (the bridge ends their whole process group).
- **After sleep** the app checks its Pako again: gone, it is found or started; there, the panel refreshes what it shows.
- **The page's web content** closed by macOS (memory pressure, a WebKit crash) is loaded again by itself (more than three times in a minute:
  the window says so instead).

## Notifications and the Dock badge

What Pako writes **by itself** (a reminder, a routine, a notice: not its answers to what you just wrote) becomes a notification while the
window is closed or behind other apps, in the panel's language; clicking it opens the window with the chat on it. The Dock icon shows how many
of those are unread, and the menu-bar orb gets a dot; opening the chat clears both. A one-time code is announced, never quoted.

macOS asks once whether Pako may notify you, and only after Claude is connected (before that Pako cannot write by itself): never at the
first launch. Settings > *Notifications* shows the answer and opens System Settings to change it.

How it works: every five seconds the app asks the Pako it shows `GET /panel/api/notices?after=<time>` with the bridge token (the route exists
in local mode only; a hosted server has none). It answers what Pako started after that time, newest 50 at most.

## Menus and Settings

- **Pako**: *About Pako* (version and build), *Check for Updates…*, *Settings…* (Cmd+,: the panel's Settings in a window of their own),
  *App Settings…* (Cmd+Option+,: the app's own, below), Services, Hide, Quit.
- **Edit**: undo, redo, cut, copy, paste, select all (for the chat).
- **View**: *Reload* (Cmd+R), *Actual Size* (Cmd+0), *Zoom In* (Cmd+=), *Zoom Out* (Cmd+-) (the zoom is kept), *Enter Full Screen* (Ctrl+Cmd+F).
- **Window**: *Minimize*, *Zoom*, *Close* (Cmd+W), *Bring All to Front*. The window is at least 480 x 400.
- **Help**: *Pako Help* (this page, in your browser) and *Report a Problem…* (opens the logs folder; it says `app.log` may quote a message).
- **The panel's Settings** (Cmd+,, the menu-bar item's *Settings…*, and the panel's gear inside the app) open `/panel/settings` in a window
  of their own, with the main window's sign-in; before the panel is open they show the app's own Settings instead.
- **App Settings** (Cmd+Option+,): *Start with this Mac*,
  *Ask before quitting*, Claude (its state and *Connect Claude…*), notifications, and updates (*Check for updates automatically*, *Check Now*).

Every word of the app's own is in English (`Texts.swift`), like the panel's. On the first run, *Connect your Claude account* opens after the
welcome's first step, not over its hello. VoiceOver reads the menu-bar item (with how many are unread, or that Pako is stopped), the
window's own page as it changes, and each step of *Connect Claude* (its code field and spinner are labelled).

## Start with this Mac

*Start with this Mac* in the menu-bar item makes the **app itself** a login item (`SMAppService.mainApp`, macOS 13+): at login it opens in the
menu bar, with no window, and starts its Pako. macOS lists it as **Pako** in System Settings > General > Login Items, it follows the app
when you move or update it, and it goes away when you delete the app. If macOS asks for your approval, the app opens that settings page.
It is refused while the app runs from the disk image or Downloads (that path is gone after an eject or a restart). The panel's *Start with
this computer* card is not shown in the app, and `--autostart` says to use the app's menu instead: a LaunchAgent written from inside the app
would name a node and a folder that move with it.

An older start-at-login, `~/Library/LaunchAgents/local.pako.plist` (from `npm run autostart` or an earlier developer build), is never removed
without asking: when you turn *Start with this Mac* on, the app asks to remove it (both would start a Pako at login); and once, at launch,
if it can only fail (its node or folder is gone, or it points inside an app). Removed means moved to the Trash; a Pako it already started
keeps running until you log out.

## Updates

When the release has a feed (`PakoUpdateFeed` in its Info.plist, set at build time), the app checks it at most once a day: an https GET with
a `User-Agent` of just `Pako`, no cookie and no cache, so nothing in it tells one person from another. When the feed names a newer release
(a newer version, or the same version with a higher build number), one quiet menu item appears, *Update available: Pako x.y.z…*, in the
menu bar's menu and the Pako menu. *Check for Updates…* (Pako menu) and Settings' *Check Now* ask at once; Settings can turn the daily
check off. With no feed (the default) the app never checks. The About item (Pako menu) shows the version and the build number.

**Only a signed feed counts.** The feed is signed with the owner's release key (Ed25519, `desktop/mac/feed-sign.ts`), and the app carries
the public half of that key (`PakoFeedPublicKey` in its Info.plist, from `desktop/mac/feed-key.pub`). A feed whose signature does not verify
against it (unsigned, signed by another key, or changed after it was signed) offers nothing at all: the app logs `update: the feed offers
Pako x.y.z, but its signature does not verify against this app's release key: ignored` and the check counts as failed. This matters because
the SHA-256 below comes from the same feed as the download: on its own it only proves the download matches the feed, not who made either. An
app built with no key (none committed yet) never offers an update.

**Installing it is your choice, never silent.** The item opens a sheet: what is new, the version you have, and **Update** / *Later* (and
*What's New*, the release's page). Only when you press **Update** does the app (`desktop/mac/Update.swift`):

1. **download** the dmg the feed names (https only; a redirect is followed only to another https address, as GitHub sends a release's
   asset on to its storage; at most 1.5 GB) into a temporary folder of its own, with a progress bar and *Cancel*;
2. **check its SHA-256** against the (signed) feed's: one byte off and nothing is installed;
3. **mount it read-only** (`hdiutil attach -readonly -nobrowse`), take `Pako.app` from it (a real folder, not a link) and **check that app**:
   the same identifier, exactly the version and build the feed promised, newer than yours, a macOS your Mac has (`LSMinimumSystemVersion`,
   and the feed's `minimumMacOS`, checked before downloading anything), and a **valid signature on every architecture** (as
   `codesign --verify --deep --strict`, the arm64 slice included on an Intel Mac); when the app you run is signed with a Developer ID, the
   new one must be **signed by the same team** (Apple-anchored, the same Team ID that `codesign -dv` shows), or it is refused;
4. **copy it next to the running app** (a hidden `.Pako-update-….app` in the same folder), check its signature again there, and **swap the two
   at once** (`renamex_np` with `RENAME_SWAP`: there is never a moment without a `Pako.app`); the old one goes to the **Trash**, named
   `Pako <old version>.app` (you can put it back by hand);
5. **quit** (stopping the Pako it started, as Quit does) and **open the new version** (Launch Services, as the Finder would). The new one
   says `Pako.app updated: now x.y.z (build n)` in `~/.pako/logs/app.log`.

**Any failure before the swap leaves the app you run exactly as it was** and says why in plain words, with *Try again* or *Open the
Download Page* (when trying again would fail the same way: no permission to write the app's folder, a download that is not the announced
version, a signature that does not match). Each step and failure is also a line in `app.log` (`update: …`, `update failed: <reason>`,
nothing personal). Quitting during the download or the checks stops the install where it is. A half-finished install's hidden copy is
removed at the next start. Your data (`~/.pako`) is never touched by an update.

The app must be able to write its own folder: in `/Applications` that is any administrator account (the usual case on a personal Mac). On
an account that cannot, the sheet says so and offers the download page; drag the new version in from the dmg as at install time. A copy
still running from the disk image or from Downloads (translocated) must be moved to Applications first (the app offers that at launch).

## Connect your things

Right after Claude is connected (the first time only), the app offers **Connect your things**: one sheet, one thing at a time, each
skippable (*Skip*), and *Finish Later* closes it (it comes back where you left it from **Connect Your Things…** in the menu bar's menu and the
Pako menu). The order:

1. **Telegram**, first, because it is the one chat that works with **no server of your own**: you talk to Pako from your phone while this Mac
   is on. The steps: in Telegram open @BotFather and send `/newbot`, copy the token, then *Connect in the Panel* opens the connections page
   (`/panel/settings`) on Telegram, where you paste the token and scan its QR code with your phone.
2. **Calendar** (a private ICS link), 3. **Mail** (Pako's own AgentMail inbox), 4. **Slack**, 5. **Zoom**: each shows the panel's own steps
   (the Connections card's words, in the panel's language), and *Connect in the Panel* opens the connections page on that connection,
   where you paste what it asks for. Saving restarts Pako; when the panel comes back, the sheet comes back too, on the same item, now saying
   *Connected*, with *Next*.

Each item says whether it is connected, half set or not connected (Telegram counts as connected once a phone is paired). The step is not
offered when everything is connected already, nor on a server's panel (which has no Connections card). It only opens the panel's own
cards: what you type goes where the panel always puts it (`~/.pako/secrets.json`), never through the app.

## Discovery: what this Mac already has

The panel's connections can start from what is already on this Mac, but **only after you say yes in the panel** ("May I look at what you have
on this Mac?"): nothing is looked at before. Then the panel asks the app (`window.webkit.messageHandlers.pako`, `{type: "discover", what}`)
and the app looks, for what was asked only:

- **Apps**: whether Zoom, Slack, Telegram, WhatsApp, Mail, Outlook and Teams are installed (by bundle identifier; no permission needed).
- **Calendars** (EventKit): macOS asks first (*Calendars*); then their names, accounts and colours. The calendars you choose
  (`calendarSelect`) send their events (two days back, fourteen ahead) to Pako every ten minutes and a few seconds after they change; Pako
  uses them like a calendar link. Choosing none stops it and Pako forgets them.
- **Mail addresses**, from every place this Mac keeps them. Only addresses are read: never a mailbox, a message or a password.
  - **Apple Mail**: macOS asks first (*Automation*, Pako to control Mail). Then each account's name, addresses and type. Mail is asked only
    while it is running, or when you press the button that opens it.
  - **Microsoft Outlook**: the same way (*Automation*, Pako to control Outlook), and only while it runs or on that button. The classic
    Outlook answers. The new Outlook has no AppleScript accounts, so you type your address instead.
  - **eM Client**: its account file under `~/Library/Application Support/eM Client`, opened read-only. Only text that is an address, in a
    column named for an address or a login, never one named for a password or a token.
  - **Thunderbird**: each profile's `prefs.js`, its `mail.identity.*.useremail` lines only.
  - **Your Apple Account**: `~/Library/Preferences/MobileMeAccounts.plist`, an ordinary preferences file with no prompt. It gives the Apple
    IDs signed in, and whether iCloud Mail is on (then the card offers **Connect iCloud Mail**).
  - **Your own contact card** (the Contacts "Me" card), only once Contacts already said yes.
  - Each address is listed once, with every app it was found in.
  - The card says exactly how Mail went:
    - "Mail isn't set up on this Mac"
    - "Allow Pako to read Mail's account list: System Settings › Privacy & Security › Automation › Pako › Mail"
    - "Mail is closed: open it, or press Find my accounts on this Mac"
    - "Found 2 addresses on this Mac"
- **Contacts**: macOS asks first (*Contacts*); then only how many there are. Names, emails, phones and companies are read and sent to Pako's
  people only when you confirm the import (`contactsImport`).
- **Zoom's recordings**: the folder names in `~/Documents/Zoom` with a transcript (`.vtt`) or a recording not converted yet (macOS may ask
  for *Documents*).

What is found goes only to this computer's Pako (`POST /panel/api/discovery`, with the panel's own sign-in), which keeps it in `~/.pako`,
shows it, and forgets it in one click; a later look replaces only what it looked at. The panel may also ask the app to open a link, only
https, Slack's, Telegram's and Zoom's apps, and System Settings' privacy panes (to change an answer given to macOS); any other message is
ignored. For this the app is signed with three entitlements (`desktop/mac/app.entitlements`: calendars, contacts, Apple events), which let
macOS ask; macOS's prompts say why (`InfoPlist.en.strings`). A check-only run (`PAKO_APP_REPORT`, `PAKO_APP_SELFTEST`)
never asks for or reads Calendars, Contacts or Mail; the tests check the rules with fake sources (`DiscoveryCore.swift`).

## Connect Claude: your own Claude plan

Pako's brain is the `claude` command (Claude Code), signed in to **your own Claude plan** (Pro, Max, Team or Enterprise): that is the way; an API key is the
advanced alternative. Claude Desktop alone is not enough: its sign-in belongs to it, and no other app may use it (the app never reads it, nor
any Keychain item, file or token of Claude's). The app sets up Claude Code instead, with the same Claude account, in two clicks, without a
terminal.

**The window *Connect your Claude account*** opens by itself the first times the panel opens while Claude is not ready (until it has once
been connected), when the running Pako says Claude is not signed in (or gone), from *Connect Claude…* in the menu bar, and from the
*Connect Claude…* button in the window's title bar (shown while Claude is not ready; the chat's banner says the same). One main button,
**Connect**:

1. **Not installed** (no `claude` in your login shell's `PATH`, `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin` or `/usr/local/bin`;
   or the `CLAUDE_BIN` you set is not there): one line says *Pako installs Claude Code (from Anthropic) in your user folder and opens
   Claude's sign-in page in your browser.* (about 100 MB). Connect downloads Anthropic's installer, `https://claude.ai/install.sh` (accepted only over https from `claude.ai` or
   `downloads.claude.ai`, where it moves to, and only a bash script of a sane size), into a private temporary folder, and runs it with
   `/bin/bash` as a program of its own: no shell command line, no Terminal, no `sudo` (the installer refuses it too). The installer puts
   Claude Code in `~/.local/bin/claude` and checks what it downloads (SHA-256). The window shows a spinner and the installer's last line; if
   it fails, its last lines and **Try again**. **Cancel** stops it. The temporary folder is deleted either way.
2. **Not signed in**: Connect runs `claude auth login --claudeai` (Claude's own sign-in, with the Claude subscription) as a program of its own,
   with no terminal and its stdin a pipe the app keeps open. Your browser opens Claude's page: sign in with your Claude account (Pro, Max, Team or Enterprise).
   The window says *Finish signing in in your browser* (with *Open the sign-in page again*, the address the sign-in printed, if the browser
   did not open) and asks `claude auth status` every 2 seconds, for up to 10 minutes, until it says signed in. Then **Connected**, and it closes.
   **Paste the code**: Claude Code 2.1.325's page does not hand the sign-in back by itself; it shows a code, and the sign-in prints
   *Paste code here if prompted >*. When it does, the window says *Sign in in your browser. If it shows a code, paste it here:* with a field
   and **Continue**: the code (spaces and line breaks dropped) is written to the sign-in's stdin with a newline, and the field is cleared. The
   code is never logged, shown elsewhere or saved. A code it refuses shows its error line under the field (*Invalid code. Please make sure
   the full code was copied.*: paste it again); a code that fails ends the sign-in (*Login failed: That code wasn't accepted…*), and
   **Try again** starts a new one. **Cancel** (or quitting the app) stops the sign-in. The password and the token never pass through the app.
3. **Connected**: the menu shows *Connected to your Claude plan* (with the account's email or plan when `claude auth status` gives one) with
   a tick.

**Pako picks it up by itself, with no restart.** Every answer runs a new `claude -p`, which reads the new login; a message that waited for the
sign-in is tried again every 20 seconds. Pako also asks `claude auth status` itself (every 15 seconds while not signed in, every 5 minutes
after), so the chat says *not signed in* before a message has to fail for it. The app asks it to look again at once when it connects
(`GET /panel/api/claude?fresh=1`, read only, behind the panel's session; at most once every 3 seconds).

**Found without a restart.** On each check the app reads your login shell's `PATH` again and looks in the installers' folders, so a `claude`
installed a moment ago is found. A Pako the app started is given that `PATH`; if `claude` turns up in a folder that Pako was not given, the
app starts that Pako again (never a Pako it did not start: one from a terminal, or the background one of autostart, looks in
`~/.local/bin` and `~/.claude/local` by itself anyway).

**An API key wins over the plan.** In `claude -p` an `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) in the environment is always used
when it is set. When one is set for Pako (in its Connections card, or in the shell, `~/.pako/.env` or the Pako folder's `.env`) or in the
app's own environment, the window says where, that it wins over your plan and is paid by use, with **Open Connections**. Only whether
it is set is looked at, never its value. *Use an API key instead (advanced)* opens the Connections card too.

The facts this relies on, from Anthropic's Claude Code docs (read on 2026-11-16):

- Install, the native installer `curl -fsSL https://claude.ai/install.sh | bash` for macOS (recommended; npm and Homebrew are alternatives),
  the launcher at `~/.local/bin/claude`, no `sudo`: <https://code.claude.com/docs/en/setup>
- Signing in with a Pro, Max, Team or Enterprise plan (`claude` or `claude auth login`, in the browser), credentials in the macOS Keychain, the
  authentication precedence (`ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_API_KEY`, always used in `-p` mode, before the subscription login),
  `claude setup-token` (a one-year token, not used here): <https://code.claude.com/docs/en/iam> (now *Authentication*,
  <https://code.claude.com/docs/en/authentication>)
- `claude auth login` (`--claudeai` the subscription, the default; `--console` for API billing), `claude auth status` (JSON; exit code 0
  signed in, 1 not; `authMethod` none, claude.ai, oauth_token, api_key, api_key_helper or third_party): <https://code.claude.com/docs/en/cli-reference>
- Checked on this Mac with Claude Code 2.1.325: `claude auth status` printed `{"loggedIn": false, "authMethod": "none", ...}` and exited 1;
  `claude auth login --claudeai` with no terminal and stdin a pipe printed the page's address (its `redirect_uri`
  `https://platform.claude.com/oauth/code/callback`, `code=true`) and `Paste code here if prompted > `, and read the code from the pipe:
  `invalid-test-code` got `Invalid code. Please make sure the full code was copied.` on stderr and it waited for another; `abc#def` got
  `Login failed: That code wasn't accepted. …` and it ended (exit 1). No terminal (`script`) is needed.

## Settings it reads

| Setting | What it does |
| --- | --- |
| `PAKO_HOME` | The Pako home, as for `npm start` (also read from `~/.pako/.env` and the Pako folder's `.env`). A Pako the app starts gets it too. |
| `HOME` | The home folder, as Pako's own Node reads it: `~/.pako`, `~/.local/bin/claude` and the installer's target are under it. |
| `CLAUDE_BIN` | The `claude` command to use, as for Pako (also read from `~/.pako/.env` and the Pako folder's `.env`): when set, that one or none. |
| `PAKO_REPO` | **Developers only**: a Pako folder to run instead of the server inside the app (with your own Node.js, 22.18 or newer). For trying a checkout with a release app. |
| `PAKO_APP_REPORT` | **Check-only**, for testing a build, not for everyday use, and **ignored by a Developer ID-signed app** (a release): a path. The app writes `<path>-loading.png` (its own starting page), then once the panel is open `<path>.json` (the overview's HTTP status, the cards shown, script errors, the menus, the port) and `<path>.png`, `<path>-dashboard.png`, `<path>-bottom.png` (the panel), `<path>-settings.png`, `<path>-about.png`, `<path>-connect.png` and `<path>-connect.json`, `<path>-discovery.json` (one discovery of apps and Zoom's recordings, with Calendars, Contacts and Mail never asked in such a run, and whether the panel's route took it), and `<path>-final.json` (notices seen, the Dock badge, the web-crash check), written again as it quits. The pictures show your own agenda, mail and chat: they are personal data. Unset or blank, it does nothing at all. |
| `PAKO_APP_APPEARANCE` | Check-only, with `PAKO_APP_REPORT`: `dark` or `light`, to see the app in that appearance. |
| `PAKO_APP_SELFTEST` | Check-only, same rule: `webcrash` (with `PAKO_APP_REPORT`) kills the page's web content once to see it come back; `headless` runs the app with no window, Dock icon or menu-bar item (`test/mac-app.test.ts` uses it to crash, quit and kill the app); `update` is headless too and, when the feed offers an installable release, installs it as if *Update* had been pressed, writing each step to `app.log` (`test/mac-app.test.ts` updates one build to another that way). |
| `PAKO_APP_FAKE_SOURCES` | Check-only, same rule: a JSON file of made-up calendars, events (times in minutes from now), contacts, Mail account lines and Zoom folders (`FileSources` in `Discovery.swift`), used in place of this Mac's own: nothing real is asked or read, and macOS shows no prompt. |
| `PAKO_APP_WALK` | Check-only, same rule, meant with `PAKO_APP_FAKE_SOURCES`: a path. Once the panel is open the app opens the connections page in its window and presses it through as a person would: *Yes, look*, a calendar chosen, the contacts imported; a picture of each step (`<path>-1-settings.png` … `<path>-5-contacts.png`), then the panel's agenda (`<path>-6-agenda.png`) and what Pako holds after it (`<path>-walk.json`). |
| `PAKO_APP_UPDATE_FEED` | Check-only, same rule (ignored by a Developer ID-signed app): a feed address to use instead of the build's `PakoUpdateFeed`. It may also be plain `http://127.0.0.1:<port>/…` (a local test server), for the feed and the dmg it names; any other address is ignored. With `PAKO_APP_REPORT`, the update sheet is drawn as `<path>-update.png` (and Connect your things as `<path>-things.png`). |

The app gives the Pako it starts `PAKO_NO_OPEN=1` (no browser tab), `PAKO_APP_PID` (that Pako stops when the app is gone, and prints no sign-in link), `PORT` (see "Its port" below) and, for the server inside it, `PAKO_APP_BUNDLE=1` ([configuration.md](configuration.md#settings-reference)).

An app opened from the Finder has none of your terminal's settings. To give it some (a test home, another port), start its binary from a
terminal: `PAKO_HOME=/tmp/pako-test PORT=8799 /Applications/Pako.app/Contents/MacOS/Pako`. Everything in its environment goes on to a Pako it
starts. (A run with its own `PAKO_HOME` is allowed next to the everyday one. It keeps its own settings, apart from the everyday app's, in
the `defaults` domain `io.github.anxovatomicaes.pako.home-<hash>`, keeps no cookie between runs and never asks for notifications.)

## Remove it

1. Turn off *Start with this Mac* (menu-bar item), then **Quit Pako** (Cmd+Q).
2. Drag **Pako** from Applications to the Trash. Its login item goes with it.
3. If you also want its data gone (your notes, reminders, chat, the panel's secrets): the panel's Privacy card has *Delete everything*, or
   remove the folder `~/.pako` (with the app quit). Pako's secrets are in your login keychain (service `Pako`): remove them in Keychain
   Access (search for Pako), or with `security delete-generic-password -s Pako` run until it finds none. And what the app kept for itself:

```sh
defaults delete io.github.anxovatomicaes.pako     # window position, first-run marks, the update check's date
rm -rf ~/Library/WebKit/io.github.anxovatomicaes.pako ~/Library/Caches/io.github.anxovatomicaes.pako \
  ~/Library/HTTPStorages/io.github.anxovatomicaes.pako*                                # the panel's cookie and cache
rm -f ~/Library/LaunchAgents/local.pako.plist     # only if an older version or npm run autostart made one
```

Claude Code is Anthropic's, not Pako's: `~/.local/bin/claude`, `~/.local/share/claude` and `~/.claude`, and its sign-in in your Keychain,
stay. Remove them as Anthropic's docs say if you no longer want them (`claude auth logout` first).

Builds before this one used the identifier `local.pako.app`: their leftovers are `defaults delete local.pako.app` and the same three
`~/Library` folders with that name.

## Build the app

For developers. You need macOS 13 or newer and the Command Line Tools (`xcode-select --install`; Xcode is not needed), and this repository
as a git checkout. In the Pako folder:

```sh
npm run mac-app        # dist/Pako.app, self-contained, signed ad hoc
```

1. **The app** (`build.sh`): `swiftc` compiles `desktop/mac/*.swift` for Intel and Apple silicon into one binary (an architecture that does
   not build is said and left out), draws the icon, writes the Info.plist: the version is `package.json`'s, the build number
   (`CFBundleVersion`) is `PAKO_BUILD` or else the number of commits, a whole number that only grows (the build stops when either is
   missing; it never ships a 0.0.0). The bundle identifier `io.github.anxovatomicaes.pako` is final: it keys the app's settings, its WebKit
   store (the panel's cookie), its login item and its notarization history, so it must not change after the first public release.
2. **Node.js and the server** (`package.sh`):
   - Node.js 22 LTS, the version pinned in `desktop/mac/node.sha256` with the SHA-256 of its two official tarballs (darwin-x64 and
     darwin-arm64). They are downloaded once from nodejs.org into `~/Library/Caches/pako-build` (outside the repo) and checked against the
     pinned hash and against that version's `SHASUMS256.txt` every time; a mismatch deletes the file and stops the build. The two `node`
     binaries become one universal binary (`lipo`), so there is one dmg for every Mac and the kernel picks the slice (about 115 MB more
     unpacked, much less in the dmg). Its licence goes next to it.
   - The server comes from **git, never from the folder as it lies**: `git archive` of `src`, `assistant/{bridge,prompt,run,voice}.ts`,
     `bin`, `package.json`, `package-lock.json`, `LICENSE` and `THIRD_PARTY_NOTICES.md` (with uncommitted changes to those tracked files,
     for trying things; `npm run mac-release` refuses them). An `.env`, `data/`, `.pako/`, private notes or anything untracked can never
     get in. Then `npm ci --omit=dev --ignore-scripts` with the npm of the same Node.js (no Node.js needed on the building Mac).
   - Pruned: the four packages the panel only serves files from (gsap, lucide, three, the Inter font) keep just those files (the vendor map
     in `src/dashboard.ts`); everywhere, source maps, `.ts` sources and type declarations, docs, tests and examples go. The production
     modules shrink from about 86 MB to about 26 MB. Every module the server imports is then loaded once with the bundled Node.js.
   - **It fails closed** on: a native addon (`.node`, `binding.gyp`, a `.dylib`: none exists today; one would need entitlements the app
     refuses), an `.env` anywhere, private notes or state (`HANDOFF.md`, `spec.md`, `private/`, `.claude/`, `.pako/`, `data/`, tests),
     a home-folder path or something shaped like a token in Pako's own code, and any program (Mach-O) other than the app and node.
3. **Signing** (`sign.sh`), inside out, never `--deep`: node with the hardened runtime and `desktop/mac/node.entitlements`, then the app with
   the hardened runtime and `desktop/mac/app.entitlements` (the three that let macOS ask for Calendars, Contacts and Mail: see Discovery).
   node's two entitlements are the only ones V8 needs to compile JavaScript (checked on this Mac:
   without them the bundled node aborts at its first compiled function; the file says which slice needs which); Node's own release
   entitlements are dropped (`get-task-allow`, which notarization refuses; `disable-library-validation` and the dyld ones, which would let
   other code be loaded into the process that holds your tokens). It then checks the signatures strictly, the runtime flag on both, the
   exact entitlements, and runs compiled JavaScript and WebAssembly with the bundled node on every slice the Mac can run. Ad hoc (`-`)
   unless `PAKO_SIGN_IDENTITY` is set.

`PAKO_DEV_BUILD=1 npm run mac-app` makes a **developer build** instead: no Node.js or server inside, and it runs the Pako folder it was built
from (written in its Info.plist as `PakoRepoPath`, never in a release), then a folder chosen before, then `~/pako`, then asks; with your own
Node.js 22.18 or newer (your login shell's, Homebrew's, `/usr/local/bin`, then the newest in `~/.nvm`).

`npm run mac-release-check [dmg]` checks a built dmg as a stranger gets it: it mounts it read-only, checks the Applications link, the
signatures and entitlements, then starts the server **from the mounted disk** with the bundled node, a fresh `HOME` and `PAKO_HOME`, a free
port and a `PATH` with no node in it; `/health`, `/panel`, a one-time sign-in link and the signed-in overview must answer, SIGTERM must stop it
with nothing left running, and every file in the app must hash the same before and after (nothing is written inside the app). With a
Developer ID it also asks Gatekeeper (`spctl`) and checks the stapled ticket. `npm test` runs the same on a fresh build (test/mac-app.test.ts).

## Make a release

For the owner. The result is `dist/release/Pako-<version>.dmg` and its `.sha256`, to publish (for example as a GitHub release's assets). The costs and the
one-time Apple steps, as a checklist: [notarization.md](notarization.md).

**Once: a Developer ID.** A Mac that downloads an app checks that Apple notarized it; an ad-hoc app is blocked ("Apple could not verify…",
and on macOS 15 only *Open Anyway* in System Settings > Privacy & Security gets past it). So a public release needs:

1. A paid Apple Developer Program membership.
2. A **Developer ID Application** certificate: on developer.apple.com > Certificates, make one from a certificate signing request (Keychain
   Access > Certificate Assistant > Request a Certificate From a Certificate Authority), download it and double-click it. Xcode is not
   needed. `security find-identity -v -p codesigning` then lists it as `Developer ID Application: <Name> (<TEAMID>)`.
3. A **notarytool keychain profile**, made once in a terminal; it asks for an app-specific password (appleid.apple.com > Sign-In and
   Security > App-Specific Passwords) and keeps it in your login keychain:

   ```sh
   xcrun notarytool store-credentials pako-notary --apple-id <your Apple ID> --team-id <TEAMID>
   ```

   `notarytool` and `stapler` come with the Command Line Tools (checked on macOS 15 with no Xcode).

**Each release:** commit, raise `version` in `package.json` if you want a new number (the build number grows by itself), then:

```sh
PAKO_SIGN_IDENTITY='Developer ID Application: <Name> (<TEAMID>)' PAKO_NOTARY_PROFILE=pako-notary \
  PAKO_UPDATE_FEED=https://<your site>/pako/releases.json npm run mac-release
```

It builds from the committed code (it refuses uncommitted changes to the server's files; `PAKO_ALLOW_DIRTY=1` overrides, for trying only),
signs with the Developer ID and a secure timestamp, notarizes the app and staples its ticket (so a copy works offline), makes the dmg, signs,
notarizes and staples the dmg, writes the `.sha256`, and runs `mac-release-check`, Gatekeeper included. On a rejection it prints Apple's
log. The scripts take no Apple ID, password or key: only the identity's name and the profile's name, from the environment. Without
`PAKO_NOTARY_PROFILE` it stops after signing and says the dmg is not notarized; without `PAKO_SIGN_IDENTITY` everything is ad hoc (fine on
the Mac that built it). Each step is also a script of its own: `desktop/mac/sign.sh`, `notarize.sh <app|dmg>`, `dmg.sh <app> [folder]`.

**Once: the feed signing key.** The app installs an update only from a `feed.json` signed with your release key, so a public release
needs one. On the Mac that makes releases:

```sh
node desktop/mac/feed-sign.ts keygen
git add desktop/mac/feed-key.pub && git commit -m "The feed's public key"
```

`keygen` makes an Ed25519 key pair: the **private key goes into your login keychain** (item `pako-feed-signing`, never written to a file,
never committed), the **public key into `desktop/mac/feed-key.pub`**, which `build.sh` bakes into every app (`PakoFeedPublicKey`). Back the
private key up somewhere safe (`security find-generic-password -s pako-feed-signing -w` prints it): lose it and apps already out there can
take no more updates from you; let it leak and anyone who can also change your feed can push an app to them. On another machine (CI), put it
in `PAKO_FEED_SIGNING_KEY` instead (the same one line; `PAKO_FEED_KEYCHAIN=off` keeps the keychain out of it).

**Then: a recovery key, kept off this Mac.** On 2026-11-20 the only copy of the release key was deleted, and every app carrying its public
half lost automatic updates. A second key prevents that:

```sh
node desktop/mac/feed-sign.ts keygen-recovery ~/Desktop/pako-recovery-key.txt
git add desktop/mac/feed-key.pub && git commit -m "A recovery key for the update feed"
```

Its public half is added as a second line of `feed-key.pub`, and every app built from then on accepts a feed signed by either key. Put the
private half from that file in a password manager or on paper, then delete the file. If the release key is ever lost, sign the next release
with `PAKO_FEED_SIGNING_KEY=<the recovery key>` and make a new recovery key. `release.sh` warns while there is none.

**At most one public release a day.** Every release costs users an update, and the ones that go wrong cost a manual one. `release.sh` stops
when the last public release is less than 20 hours old; `PAKO_HOTFIX=1` is for a fix that cannot wait.

`npm run mac-release` checks the key **first, before building anything**: no key, or a key that is not the one in `feed-key.pub`, stops it
with a message that says how to make one. `PAKO_LOCAL_RELEASE=1` builds without a key for this Mac only; its `feed.json` stays unsigned and
no app installs it, so never publish it. `node desktop/mac/feed-sign.ts verify dist/release/feed.json` checks a feed as the app will.

**The first signed release (one time).** Apps already out there (0.3.x) were built before the key: they still read the new feed (they
ignore its `signature`) and install the update with the SHA-256 check alone, as before. Every app from the first signed release on checks
the signature. So that release's notes should say it once, for example: "From this version on, Pako only installs updates whose
announcement is signed with Pako's release key. This update itself was checked the old way (its checksum); if you want to be sure, download
it from the release page instead of updating in the app."

**The update feed.** `npm run mac-release` ends with `desktop/mac/feed.sh`, which writes `dist/release/feed.json` for the dmg it just made.
It mounts the dmg read-only and reads the version, build and minimum macOS from the `Pako.app` on it, so the feed describes exactly that
file:

```json
{
  "version": "0.3.0",
  "build": 512,
  "url": "https://github.com/AnxovatomicaES/pako-personal-assistant/releases/download/v0.3.0/Pako-0.3.0.dmg",
  "sha256": "<the dmg's SHA-256>",
  "minimumMacOS": "13.0",
  "notes": "What changed, in one line.",
  "page": "https://github.com/AnxovatomicaES/pako-personal-assistant/releases/tag/v0.3.0"
}
```

By default `url` and `page` point at GitHub Releases of `AnxovatomicaES/pako-personal-assistant`, tag `v<version>`; `PAKO_RELEASE_REPO=owner/name` names another
repository, `PAKO_RELEASE_URL` / `PAKO_RELEASE_PAGE` other https addresses, `PAKO_RELEASE_NOTES` the one line the update sheet shows
(`sh desktop/mac/feed.sh <dmg> [feed.json]` runs it alone). Every field but `version` and `url` may be left out, but one that is there and
wrong (a checksum that is not 64 hex digits, a build that is not a whole number) makes the app ignore the whole feed. A feed with no
`sha256` (the first format: `version`, `url` of a page, `notes`) is still read, but only opens its page in the browser. Then release.sh
signs it (`node desktop/mac/feed-sign.ts sign`): it adds `"signature"`, an Ed25519 signature of the fields one per line in a fixed order
(`pako-feed-v1`, then `version=`, `build=`, `url=`, `sha256=`, `minimumMacOS=`, `notes=`, `page=`), so the JSON's spacing does not matter
but any change to a field does. `feed.sh` run alone writes an unsigned feed.

The address of the feed is baked into the build with `PAKO_UPDATE_FEED`. With GitHub Releases, use the address that always points at the
latest release's asset, so the feed never needs a home of its own:

```sh
PAKO_UPDATE_FEED=https://github.com/AnxovatomicaES/pako-personal-assistant/releases/latest/download/feed.json
```

Releases are signed with the same Developer ID from then on: an app signed with a Developer ID installs only updates signed by the same
team. (An ad-hoc build accepts any valid signature; the SHA-256 in the feed is its check.)

## Publish a release

For the owner, **when you decide**: nothing in the scripts uploads anything. After `npm run mac-release` (with the Developer ID, the
notary profile and `PAKO_UPDATE_FEED` above), `dist/release/` holds `Pako-<version>.dmg`, its `.sha256` and `feed.json`. With the GitHub
CLI (`gh auth login` once), in the public repository:

```sh
V=$(node -p "require('./package.json').version")
# 1. A draft first: nothing is visible, and releases/latest still points at the previous release while you look.
gh release create "v$V" --draft --title "Pako $V" --notes "What changed." \
  "dist/release/Pako-$V.dmg" "dist/release/Pako-$V.dmg.sha256" dist/release/feed.json
# 2. Check the draft's assets (the dmg's SHA-256 is the one in feed.json), download the dmg on another Mac and open it.
# 3. Publish: from now on every app with the feed above offers the update (within a day, or at once with Check for Updates).
gh release edit "v$V" --draft=false --latest
```

Without the CLI, the same on github.com: *Releases* > *Draft a new release*, tag `v<version>`, attach the three files, save as a draft,
check, then *Publish release* (with *Set as the latest release*). To withdraw a release that went wrong, mark the previous one as the latest
again (`gh release edit v<previous> --latest`): apps that have not updated yet stop being offered it. An app already updated keeps the new
version (it never goes back by itself); the old one is in its Trash.

**A newer Node.js:** read <https://nodejs.org/dist/index.json> (the newest `v22.x` with `lts`), put its version and the two `darwin-x64` and
`darwin-arm64` lines of its `SHASUMS256.txt` in `desktop/mac/node.sha256` (with gpg, check `SHASUMS256.txt.sig` against the Node.js release
keys first), and build: the diff of that file is the review.

## Limits

- **Not yet signed by a Developer ID**: until the owner has one, `npm run mac-release` makes an ad-hoc dmg, which runs on the Mac that built
  it but is blocked on any other Mac. Notarization (`notarize.sh`) has not been run for real: no Developer ID was available. The signing
  flags, entitlements and hardened runtime were checked with ad-hoc signatures (the same flags notarization checks).
- **Checked on an Intel Mac** (macOS 15). What an Intel Mac checks of Apple silicon, at every build and in `npm test`: the app and node are
  universal (`lipo`), node's arm64 slice is nodejs.org's binary byte for byte, and each arm64 slice (of the app and of node) has a strict
  signature, the hardened runtime, exactly the allowed entitlements (the three discovery ones for the app, the two JIT ones for node), is built for macOS 13 or
  older (`vtool`) and links only macOS's own libraries (`otool`); the update install checks signatures on every architecture. **What still
  needs a real Apple silicon Mac**, because an Intel Mac cannot run arm64 code:
  1. node's arm64 slice running JavaScript under the hardened runtime (V8 uses `MAP_JIT` there, which needs `allow-jit`): `sign.sh` runs it
     by itself on Apple silicon (*node runs compiled code under the hardened runtime: arm64 …*), so one build there settles it;
  2. the app's arm64 slice itself: launch, the window and the panel, the menu bar, Connect Claude (Anthropic's installer picks the arm64
     `claude`), notifications;
  3. `package.sh` on Apple silicon: it runs npm with the arm64 node (`HOSTARCH=arm64`), a path an Intel Mac never takes;
  4. the server's Pako run by the arm64 node from the dmg (`release-check.sh` on Apple silicon), and a whole update from one release to the
     next;
  5. *Open using Rosetta* (Finder > Get Info): the app's Intel slice would then start node's Intel slice too (translated, slower); it should
     work, it has not been seen.
- **Start with this Mac** registers the app with `SMAppService`; it was not turned on during testing (that would have changed the test Mac's
  real login items), so the login launch itself has not been watched.
- **Updates** were installed end to end on this Intel Mac, with two local builds, a feed and dmg served from `127.0.0.1` (the check-only
  `PAKO_APP_UPDATE_FEED`) and a fake `HOME` (`test/mac-app.test.ts`), and the install's every refusal against small real apps in real dmgs
  (`test/mac-update.test.ts`). Not yet: a real GitHub release (none is published), an update between two **Developer ID** builds (the
  same-team check was tested against Anthropic's signed `claude` and an ad-hoc app, not two Pako releases), the relaunch through Launch
  Services (the tests' own runs relaunch the program directly, to keep their test environment) and a non-administrator account.
- **Notifications** were checked up to the app posting them (a real notice reached the app, the Dock badge and the menu-bar label); the
  banner itself was not seen: the test runs never ask macOS for permission, so as not to touch the test Mac's real settings.
- **Connect Claude** needs the internet and Anthropic's installer as it is today; the app checks where it comes from, not its content (the
  installer checks what it downloads). It has not completed a real sign-in in testing (no account was used): the not-signed-in state was
  read from a real Claude Code 2.1.325, and `claude auth login` was started with invalid codes written to its stdin (above). Pasting a real
  code has not been tried from the app. A later Claude Code that asks for the code differently (not *Paste code*) gets no field: run
  `claude auth login` in a terminal then (the app sees the login either way). `claude auth` is used only with Claude Code 2.1.268 or newer (the first version the docs name for the JSON of `claude auth status`; an older one might take the words for a question to Claude): an older one is shown as *could not tell*, and the window asks to update it (`claude update`).
