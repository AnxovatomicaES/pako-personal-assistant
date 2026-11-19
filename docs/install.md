# Installing Pako on macOS or Linux

One script, `install.sh` at the root of the repository, gets Pako onto your computer, keeps it up to date, and can make it start by itself
when you log in. It is plain `sh` (it also runs under dash, bash and zsh), a little over 200 lines, and it prints every command before running it.

## What you need

- **A computer that stays on** while you want Pako to answer and to remind you (macOS or Linux; Windows 10 or 11 too, with
  [its own line](install-windows.md)).
- **[Node.js](https://nodejs.org) 22.18 or newer**, and git.
- **Claude**, one of two ways:
  - [Claude Code](https://claude.com/claude-code) installed and signed in to your own Claude plan (run `claude` once). This is the default.
    On a Mac, [Pako for Mac](desktop-mac.md) does both for you in two clicks, with the same Claude account as Claude Desktop or claude.ai.
  - Or Claude Code installed, and your own Anthropic API key (see [below](#with-an-api-key-instead-of-a-plan)).

No other account and no other key are needed to start.

## The one line

Download it, read it, then run it:

```sh
curl -fsSLO https://raw.githubusercontent.com/AnxovatomicaES/pako-personal-assistant/main/install.sh
less install.sh
sh install.sh
```

Piping it straight into `sh` (`curl -fsSL .../install.sh | sh`) works too, but reading it first is the point: it is short on purpose.

On Windows, use the PowerShell line in [install-windows.md](install-windows.md) instead.

**Try the demo first.** When the panel opens, press **Try with a demo week**: Pako runs on an invented week (people, mail, Slack, a calendar,
follow-ups) in its own folder, `~/.pako/demo`, with every connection off and nothing sent. The banner's **Leave demo** deletes that folder
and brings back your own setup. `PAKO_DEMO=1 npm start` (or `npm start -- --demo`) starts it from the terminal.

The address is `https://raw.githubusercontent.com/OWNER/REPO/BRANCH/install.sh`, with OWNER/REPO from the `repository` field of
`package.json` (the same one both installers clone) and BRANCH the published repository's default branch. A fork or a move of the
repository changes OWNER, REPO and BRANCH here, in `docs/install-windows.md`, in `README.md` and in both scripts
(`test/autostart.test.ts` checks that they all agree with `package.json`).

Run it as your normal user. It refuses to run as root, and it never calls `sudo` itself.

## What it does

1. **Checks this computer.** macOS or Linux, not root, Node.js 22.18 or newer (or 23.6+ on the 23 line), npm and git. When something
   is missing it says how to get it for your system (nodejs.org, Homebrew, nvm, `xcode-select --install`, your package manager) and stops.
   It never installs Node.js or git for you.
2. **Gets Pako.** The first time, `git clone` into `~/pako`. If `~/pako` is already a git copy of Pako, `git pull --ff-only` (so running the
   script again is how you update). A folder that exists and is something else is left alone, and the script stops: a git copy counts as
   Pako only with Pako's own files (`src/server.ts`, `src/autostart.ts`, `bin/panel.cjs` and a `package.json` named `pako`), so a clone of
   the npm library that is also called `pako` is never pulled or installed into.
3. **Installs what Pako needs to run**: `npm ci --omit=dev --ignore-scripts` (falling back to `npm install` with the same flags). No
   development tools, and no package gets to run code of its own while installing.
4. **Looks for Claude.** Pako thinks with the `claude` command (Claude Code), signed in with your own Claude plan. The script looks for it
   on the `PATH`, then in `~/.local/bin` and `~/.claude/local`, and checks whether it looks signed in. If not, it tells you to install it
   and run `claude` once to sign in. It never asks for a key.
5. **Offers to start Pako by itself** when you log in (see below). Already on: it restarts the background Pako, so it runs the new code.
   If a Pako you started by hand (`npm start`) is running in another terminal, it says so, prints a link to its panel and stops there: stop
   that one with Ctrl+C and run the script again to use the new code.
6. **Starts Pako** and prints the panel's address (`http://127.0.0.1:8787/panel`). Without autostart, Pako runs in that terminal
   (`npm start`: it opens the browser and prints a one-time sign-in link; Ctrl+C stops it). With autostart, it runs in the background and
   the script prints a sign-in link from `npm run panel`. If autostart was turned on but the background Pako could not be started now
   (`--autostart on` ends with exit code 3), Pako runs in that terminal instead, and starts by itself from the next login.

The whole script is one function called on its last line, so a download cut halfway (`curl ... | sh`) runs nothing.

The only network traffic is git's and npm's.

### Settings

All optional, given in front of the command (`PAKO_DIR=~/apps/pako sh install.sh`):

| Variable | Default | What |
|---|---|---|
| `PAKO_DIR` | `~/pako` | The folder Pako goes into. |
| `PAKO_REPO` | the `repository` in `package.json` | Where `git clone` gets it from (a fork, a mirror). |
| `PAKO_AUTOSTART` | ask | `1` or `0` answers the autostart question beforehand. With no terminal to ask in, the answer is no. An autostart that is already on stays on (turn it off with the command below). |
| `PAKO_DRY_RUN` | empty | `1` prints what it would do and changes nothing (no clone, no install, no autostart, no start). |
| `PORT` | `8787` | Only used to print the panel's address; set it in `~/.pako/.env` for Pako itself. |

## Install by hand

By hand, instead of the installer:

```bash
git clone https://github.com/AnxovatomicaES/pako-personal-assistant.git
cd pako
npm install
npm start
```

`npm start` prints a sign-in link and opens it in your browser. That is the **control panel**, with the chat inside it.

**The first five minutes** happen in the panel, in a welcome you can skip:

1. **Name.** What Pako should call you.
2. **Try it.** Three suggestions that send real messages to the chat: a reminder in two minutes, a note to remember, a question for the web.
   The first answer takes a few seconds.
3. **Your phone.** Connect Telegram: create a bot, paste its token, scan a QR code (see [Telegram](channels.md#telegram-next-to-your-chat)). You can do it later.

The welcome is shown once. **Your name**, at the foot of the panel, changes the name later. Pako's own words are in English; write to it in
any language and Claude answers in that language. In the chat, write `HELP` to see what your Pako can do.

Your notes, reminders and chat are kept in `~/.pako`, readable only by you. What you write, and what Pako reads to answer it, goes to
Anthropic through the `claude` command on your own computer, and nowhere else unless you connect something.

Stop Pako with `Ctrl+C`. Start it again with `npm start`: it picks up where it was.

## With an API key instead of a plan

Put your key in `~/.pako/.env` (make the folder and the file if they are not there):

```
ANTHROPIC_API_KEY=your-key
```

Then `npm start`. Claude Code must still be installed, but it does not need to be signed in. Every message is then billed to that API account.
Pako passes the key to the `claude` command only.

Two things to know. If `ANTHROPIC_API_KEY` is already set in the shell where you run `npm start`, Claude Code uses it instead of your plan:
run `unset ANTHROPIC_API_KEY` first if you want the plan. And if the key is refused, the chat says Claude is not signed in; if the account
is out of credit, it says Claude reached its limit, and your message waits.

## Starting by itself

```sh
cd ~/pako
npm run autostart -- on       # or: node src/server.ts --autostart on
npm run autostart -- status
npm run autostart -- off
```

The panel has the same switch in its "Start with this computer" card (on a computer only; a server's panel does not show it).

- **macOS**: a LaunchAgent, `~/Library/LaunchAgents/local.pako.plist`. It starts Pako at login and starts it again only if it crashes: a
  Pako you stop on purpose stays stopped. What it writes goes to `~/.pako/logs/pako.log` and `pako.err.log`.
- **Linux**: a systemd unit for your user, `~/.config/systemd/user/pako.service` (`Restart=on-failure`), writing to the same logs. It
  starts when you log in. To start it when the computer starts, before anyone logs in, turn on lingering once:
  `loginctl enable-linger $USER` (some systems ask for `sudo` there; the command says so when lingering is off). Without a systemd for your
  user (some containers, WSL without systemd) it says so and changes nothing.
- **Windows**: a Task Scheduler task, made by the Windows installer: see [install-windows.md](install-windows.md). The same
  `npm run autostart -- on|off|status` and the same panel card work there too.

Both run the Node.js that turned it on (its full path, since a login session may not have yours on its `PATH`; for Homebrew's Node.js,
Homebrew's stable link `$(brew --prefix)/opt/node/bin/node` rather than the versioned Cellar folder an upgrade removes) on this folder's
`src/server.ts`, as you, never as root. They carry the `PATH` of the terminal that turned it on (so `claude` is found as it is there), and
`PAKO_HOME`, `PORT`, `PAKO_HOST` and `CLAUDE_BIN` when that terminal had them; nothing else. Other settings belong in `~/.pako/.env`, which
Pako reads at every start. The background Pako does not open a browser: `npm run panel` gives you a sign-in link whenever you want one.

From the command line, `on` also starts it now (or restarts it, after an update) and `off` also stops the background one. `on` ends with
exit code 0 when it is on and started, 3 when it is on but could not be started now (it starts at the next login; when a Pako started by hand
is running, it is not started and the message says to stop that one first), and 1 when it could not be turned on. From the panel,
the switch only changes what happens at the next login: the Pako answering the panel may be the background one itself.

If you move the folder, or upgrade or remove the Node.js it runs (`nvm uninstall`, a reinstall elsewhere), `status` says the autostart is
for another folder or another Node.js: run `npm run autostart -- on` again.

One autostart per user: a second Pako with another `PAKO_HOME` is started by hand.

If a Pako is already running in a terminal when the background one starts (at login), the background one finds the first one's lock and
stops for good: launchd and systemd do not start it again (it exits with 0 under launchd, and with 78, `RestartPreventExitStatus`, under
systemd), so a Pako you stop stays stopped. The same goes for a port another program holds, or a wrong setting in `~/.pako/.env`. Any other
failure is retried every 30 seconds; systemd gives up after five tries in ten minutes (`systemctl --user status pako` says why).

## Uninstalling

```sh
cd ~/pako && npm run autostart -- off
rm -rf ~/pako        # the code
rm -rf ~/.pako       # your notes, reminders, chat and settings: only if you want them gone
```
