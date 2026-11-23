#!/bin/sh
# Pako's installer for macOS and Linux. Read it before you run it: it is short, and it says each step as it takes it.
#
#   Its address: https://raw.githubusercontent.com/AnxovatomicaES/pako-personal-assistant/main/install.sh (docs/install.md: download, read, run)
#
# (The address is OWNER/REPO from package.json's "repository", on its default branch: the same rule as install.ps1, checked by a test.)
#
# What it does, in order:
#   1. Checks that it is not run as root, and that Node.js 22.18 or newer and git are here. It never installs them and never uses sudo:
#      when one is missing it says how to get it on this system, and stops.
#   2. Gets Pako into ~/pako (PAKO_DIR to choose another folder): git clone the first time, git pull --ff-only after that (see catch_up_git). Running this
#      script again is how Pako is updated.
#   3. Installs what Pako needs to run: npm ci --omit=dev --ignore-scripts (no development tools, and no package runs code of its own).
#   4. Looks for the claude command and whether it seems signed in. It never asks for a key: Pako uses your own Claude, signed in with claude.
#   5. Offers to make Pako start by itself when you log in (node src/server.ts --autostart on), then starts Pako and prints the panel's address.
#
# It reaches the network through git and npm only. Settings (all optional):
#   PAKO_DIR=/some/folder   where Pako goes (default ~/pako)
#   PAKO_REPO=<git url>     where it comes from (default: Pako's repository, the one in its package.json)
#   PAKO_AUTOSTART=1 or 0   answers the autostart question beforehand (with no terminal to ask in, the answer is no)
#   PAKO_DRY_RUN=1          says what it would do and changes nothing
# Works with sh, dash, bash and zsh. A copy of Pako is updated only when it has Pako's own files (is_pako): any other folder is left alone.

set -eu

# The same address as package.json's "repository" (a test checks they agree).
DEFAULT_REPO="https://github.com/AnxovatomicaES/pako-personal-assistant.git"

DRY="${PAKO_DRY_RUN:-0}"
DIR="${PAKO_DIR:-$HOME/pako}"
REPO="${PAKO_REPO:-$DEFAULT_REPO}"

# msg "text": one line. Pako's own words are English, whatever this computer's language.
msg() {
  printf '%s\n' "$1"
}
step() {
  printf '\n'
  msg "==> $1"
}
die() {
  printf '\n' >&2
  msg "$1" >&2
  exit 1
}
# run cmd args...: prints the command, then runs it (or, in a dry run, only prints it).
run() {
  printf '    $'
  for a in "$@"; do
    case "$a" in
      *[!A-Za-z0-9_./:=@+-]*|'') printf " '%s'" "$a" ;;
      *) printf ' %s' "$a" ;;
    esac
  done
  printf '\n'
  if [ "$DRY" = 1 ]; then return 0; fi
  "$@"
}
node_hint() {
  if [ "$OS" = Darwin ]; then
    msg "  Install it from https://nodejs.org (the LTS), or with Homebrew: brew install node"
  else
    msg "  Install it with nvm (https://github.com/nvm-sh/nvm, then: nvm install --lts) or from https://nodejs.org."
    msg "  Your distribution's nodejs package may be too old: check its version first."
  fi
  msg "  Then run this installer again."
}

# Pako's own files, not only its name: the npm compression library is called "pako" too, and a clone of it may well be in ~/pako.
is_pako() {
  [ -f "$1/src/server.ts" ] && [ -f "$1/src/autostart.ts" ] && [ -f "$1/bin/panel.cjs" ] && grep -q '"name": "pako"' "$1/package.json" 2>/dev/null
}

# catch_up_git DIR: brings a Pako checkout up to date. A fast-forward when it can be one; failing that, a copy with no changes of its own whose
# files are exactly one version from origin's history goes to origin's newest (the public history was rewritten once, on 21 November 2026,
# so every older clone stopped being a fast-forward). Anything else (changed files, commits of its own) is left as it is: it returns 1.
# A pull that failed because GitHub could not be reached is not a rewrite: origin's history as last fetched holds this copy too, so it would
# "move" to the version it already has and go on as if updated. Origin is fetched again first, and when that fails too it returns 1.
# >>> catch_up_git
catch_up_git() {
  if run git -C "$1" pull --ff-only; then return 0; fi
  [ "$DRY" = 1 ] && return 0
  if ! run git -C "$1" fetch; then
    msg "  Couldn't reach Pako on GitHub to update it. Check the connection, then run this again."
    return 2
  fi
  [ -z "$(git -C "$1" status --porcelain --untracked-files=no 2>/dev/null)" ] || return 1
  up=$(git -C "$1" rev-parse --verify --quiet '@{upstream}') || return 1
  tree=$(git -C "$1" rev-parse --verify --quiet 'HEAD^{tree}') || return 1
  git -C "$1" log --format=%T "$up" | grep -qx "$tree" || return 1
  msg "  Pako's public history was rewritten on 21 November 2026; your copy had no changes of its own, so it moves to the new one."
  run git -C "$1" reset --keep "$up"
}
# <<< catch_up_git

# Everything runs from main, called on the last line: piped straight into sh, a download cut halfway runs nothing at all.
main() {
  if [ "$DRY" = 1 ]; then
    msg "(Dry run: PAKO_DRY_RUN=1. Saying what it would do, changing nothing.)"
  fi

  OS=$(uname -s)
  step "Checking this computer"
  case "$OS" in
    Darwin|Linux) ;;
    *) die "This installer is for macOS and Linux. On Windows, see docs/install.md." ;;
  esac
  if [ "$(id -u)" = 0 ]; then
    die "Don't run this as root or with sudo: Pako is yours and lives in your folder. Run it as your usual user."
  fi


  if ! command -v node >/dev/null 2>&1; then
    msg "Pako needs Node.js 22.18 or newer, and there is no Node.js here." >&2
    node_hint >&2
    exit 1
  fi
  NODE_VERSION=$(node -p 'process.versions.node' 2>/dev/null || echo 0)
  NODE_MAJOR=$(printf '%s' "$NODE_VERSION" | cut -d. -f1)
  NODE_MINOR=$(printf '%s' "$NODE_VERSION" | cut -d. -f2)
  case "$NODE_MAJOR$NODE_MINOR" in *[!0-9]*|'') NODE_MAJOR=0; NODE_MINOR=0 ;; esac
  # 22.18, or 23.6 on the short-lived 23 line: the first that run Pako's TypeScript as it is (bin/preflight.cjs says the same).
  NODE_OK=0
  if [ "$NODE_MAJOR" -gt 23 ]; then NODE_OK=1
  elif [ "$NODE_MAJOR" -eq 23 ] && [ "$NODE_MINOR" -ge 6 ]; then NODE_OK=1
  elif [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 18 ]; then NODE_OK=1
  fi
  if [ "$NODE_OK" != 1 ]; then
    msg "Pako needs Node.js 22.18 or newer, and this is Node.js $NODE_VERSION." >&2
    node_hint >&2
    exit 1
  fi
  if ! command -v npm >/dev/null 2>&1; then
    msg "Node.js $NODE_VERSION is here but npm, which usually comes with it, is not." >&2
    node_hint >&2
    exit 1
  fi
  msg "  Node.js $NODE_VERSION: good."

  if ! command -v git >/dev/null 2>&1; then
    if [ "$OS" = Darwin ]; then
      die "git is missing. Install it with: xcode-select --install (or brew install git), then run this installer again."
    fi
    die "git is missing. Install it with your system's package manager (for example: sudo apt install git), then run this installer again."
  fi
  msg "  git: good."

  step "Getting Pako into $DIR"
  if [ -d "$DIR/.git" ]; then
    # Before anything is done to it: a git folder that is not Pako (the npm library of the same name, another project) is left alone.
    if ! is_pako "$DIR"; then
      die "$DIR already exists and isn't a copy of Pako: leaving it alone. Pick another folder: PAKO_DIR=/another/folder sh install.sh"
    fi
    msg "  Already there: updating it."
    # 2 = GitHub out of reach (catch_up_git has said so); anything else is a copy it can't move.
    up_rc=0; catch_up_git "$DIR" || up_rc=$?
    if [ "$up_rc" = 2 ]; then
      exit 1
    elif [ "$up_rc" != 0 ]; then
      die "I couldn't update $DIR (changes of yours in that folder?). Look with: git -C \"$DIR\" status"
    fi
  elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    die "$DIR already exists and isn't a copy of Pako. Pick another folder: PAKO_DIR=/another/folder sh install.sh"
  else
    run git clone "$REPO" "$DIR"
  fi
  if [ "$DRY" != 1 ]; then DIR=$(CDPATH= cd -- "$DIR" && pwd); fi
  if [ "$DRY" != 1 ] && ! is_pako "$DIR"; then
    die "$DIR doesn't look like Pako (its package.json isn't Pako's)."
  fi

  step "Installing what Pako needs"
  if [ "$DRY" = 1 ] || [ -f "$DIR/package-lock.json" ]; then
    if ! run npm ci --omit=dev --ignore-scripts --prefix "$DIR"; then
      msg "  npm ci didn't work: trying npm install."
      run npm install --omit=dev --ignore-scripts --prefix "$DIR"
    fi
  else
    run npm install --omit=dev --ignore-scripts --prefix "$DIR"
  fi

  step "Looking for Claude"
  CLAUDE=""
  if command -v claude >/dev/null 2>&1; then CLAUDE=$(command -v claude)
  elif [ -x "$HOME/.local/bin/claude" ]; then CLAUDE="$HOME/.local/bin/claude"
  elif [ -x "$HOME/.claude/local/claude" ]; then CLAUDE="$HOME/.claude/local/claude"
  fi
  if [ -z "$CLAUDE" ]; then
    msg "  I can't find the claude command. Pako thinks with it, on your own Claude plan. Install Claude Code"
    msg "  (https://claude.com/claude-code) and run claude once to sign in: Pako picks it up by itself, with no restart."
  elif grep -q '"oauthAccount"' "$HOME/.claude.json" 2>/dev/null || [ -f "$HOME/.claude/.credentials.json" ]; then
    msg "  claude ($CLAUDE): installed and signed in."
  else
    msg "  claude ($CLAUDE) is installed, but I can't tell whether it's signed in. If not, run claude in a terminal and follow its steps."
  fi

  # Pako already running in another terminal (started by hand): it keeps the old code, and holds the folder. A background Pako (autostart, marked
  # "service" in the lock) is not this case: turning autostart on again restarts it with what's new.
  HOLDER=$(node -e '
  const fs = require("fs"), os = require("os");
  try {
    const [p, , up, mark, started] = fs.readFileSync(process.argv[1], "utf8").split("\n");
    const pid = Number(p);
    if (!(pid > 0) || mark === "service" || (/^\d+$/.test(up || "") && os.uptime() < Number(up))) process.exit(0);
    try { process.kill(pid, 0); } catch (e) { if (e.code !== "EPERM") process.exit(0); }
    // That number may be another program now (Pako was killed): the one the lock means started when its fifth line says (src/local.ts).
    if (/^\d+$/.test(started || "")) {
      const env = Object.assign({}, process.env, { LC_ALL: "C", TZ: "UTC" });
      const r = require("child_process").spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 3000, env });
      const t = r.status === 0 ? Date.parse(String(r.stdout).trim().replace(/\s+/g, " ") + " UTC") : NaN;
      if (Number.isFinite(t) && Math.abs(Math.floor(t / 1000) - Number(started)) > 2) process.exit(0);
    }
    console.log(pid);
  } catch {}' "${PAKO_HOME:-$HOME/.pako}/.lock" 2>/dev/null || true)
  case "$HOLDER" in ''|*[!0-9]*) HOLDER="" ;; esac
  if [ -n "$HOLDER" ]; then
    step "Pako is already running"
    msg "  Pako is running in another terminal (process $HOLDER), with the version from before. To use the new one, stop it there with Ctrl+C"
    msg "  and run this installer again (or npm start in $DIR). Meanwhile, here is its panel:"
    if [ "$DRY" = 1 ]; then run node "$DIR/bin/panel.cjs"; else (cd "$DIR" && node bin/panel.cjs) || true; fi
    exit 0
  fi

  step "Starting by itself"
  ENABLED=0
  if [ "$DRY" != 1 ] && (cd "$DIR" && node --disable-warning=ExperimentalWarning src/server.ts --autostart status >/dev/null 2>&1); then ENABLED=1; fi
  WANT="${PAKO_AUTOSTART:-}"
  if [ "$ENABLED" = 1 ]; then
    msg "  It already starts by itself: restarting it with what's new."
    WANT=1
  elif [ -z "$WANT" ]; then
    if (: </dev/tty) 2>/dev/null; then
      msg "  Should Pako start by itself every time you log in? [Y/n]"
      ANSWER=""
      read -r ANSWER </dev/tty || ANSWER=""
      case "$ANSWER" in [nN]*) WANT=0 ;; *) WANT=1 ;; esac
    else
      msg "  No terminal to ask in: leaving it off (PAKO_AUTOSTART=1 would turn it on)."
      WANT=0
    fi
  fi

  if [ "$WANT" != 1 ]; then
    msg "  No: Pako starts when you run npm start in $DIR. You can turn it on later in the panel."
  fi

  PORT_SHOWN="${PORT:-8787}"
  if [ "$WANT" = 1 ]; then
    # The path is the folder's own: the background Pako runs this copy, with this Node.js, whatever folder this script was run from.
    # Its exit code: 0 on and started, 3 on but not started now (it starts at the next login), anything else not on.
    AUTO=0
    run node --disable-warning=ExperimentalWarning "$DIR/src/server.ts" --autostart on || AUTO=$?
    if [ "$AUTO" = 0 ]; then
      step "Opening the panel"
      if [ "$DRY" = 1 ]; then
        run node "$DIR/bin/panel.cjs"
      else
        # The background Pako takes a few seconds to answer: npm run panel (bin/panel.cjs) asks it for a sign-in link once it does.
        tries=0
        until (cd "$DIR" && node bin/panel.cjs) 2>/dev/null; do
          tries=$((tries + 1))
          if [ "$tries" -ge 20 ]; then
            msg "  Pako isn't answering yet. Look at what it writes in ~/.pako/logs, and open the panel with: cd \"$DIR\" && npm run panel"
            break
          fi
          sleep 1
        done
      fi
      msg ""
      msg "  Pako is at http://127.0.0.1:$PORT_SHOWN/panel (to sign in, a fresh link: cd \"$DIR\" && npm run panel)."
      exit 0
    fi
    if [ "$AUTO" = 3 ]; then
      msg "  It will start by itself when you log in, but it couldn't start in the background now (the line above says why): starting it here."
    else
      msg "  It couldn't be set to start by itself (the line above says why): starting it here."
    fi
  fi

  step "Starting Pako"
  msg "  The panel will be at http://127.0.0.1:$PORT_SHOWN/panel: Pako prints a sign-in link below. Ctrl+C stops it."
  run cd "$DIR"
  if [ "$DRY" = 1 ]; then
    run npm start
    exit 0
  fi
  printf '    $ npm start\n'
  exec npm start
}

main "$@"
