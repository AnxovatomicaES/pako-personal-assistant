#!/usr/bin/env bash
# One-command setup of the owner's WhatsApp assistant on a Mac (see assistant/README.md):
#   cd /path/to/pako && git pull && bash assistant/install.sh
# It checks Node and Claude Code, asks for the bridge token (not shown as you type; or give it as ASSISTANT_BRIDGE_TOKEN), writes
# assistant/.env readable by you only, and installs a LaunchAgent that keeps the assistant running (and the Mac from idling to sleep).
#   bash assistant/install.sh --uninstall     stops it and removes the LaunchAgent (keeps assistant/.env and ~/.pako-assistant)
# ASSISTANT_INSTALL_DRY_RUN=1 writes the files but starts nothing and asks the server nothing (used by the tests).

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ASSISTANT_ENV_FILE:-$REPO/assistant/.env}"
LABEL="local.pako.assistant"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# Before Pako was called Pako the LaunchAgent was com.aibuyer.assistant and the folder ~/.ai-buyer-assistant. That LaunchAgent is replaced
# by the one above (two would run two assistants); a Mac that has only the older folder keeps using it, as assistant/bridge.ts does, so its
# conversation, its voice model (ASSISTANT_WHISPER_MODEL names a file in it) and its log stay where they are.
OLD_PLIST="$HOME/Library/LaunchAgents/com.aibuyer.assistant.plist"
STATE="$HOME/.pako-assistant"
if [ ! -e "$STATE" ] && [ -d "$HOME/.ai-buyer-assistant" ]; then STATE="$HOME/.ai-buyer-assistant"; fi
# The server's address is YOURS: it is never guessed. From the environment, or kept from the settings file, or asked (below).
SERVER="${ASSISTANT_SERVER_URL:-}"
DRY="${ASSISTANT_INSTALL_DRY_RUN:-}"
UID_NUM="$(id -u)"

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

stop_agent() {
  [ -n "$DRY" ] && return 0
  launchctl bootout "gui/$UID_NUM" "${1:-$PLIST}" >/dev/null 2>&1 || launchctl unload "${1:-$PLIST}" >/dev/null 2>&1 || true
}

if [ "${1:-}" = "--uninstall" ]; then
  stop_agent
  rm -f "$PLIST"
  if [ -f "$OLD_PLIST" ]; then stop_agent "$OLD_PLIST"; rm -f "$OLD_PLIST"; fi
  say "Stopped and removed the LaunchAgent. assistant/.env and $STATE are still there; delete them if you want them gone."
  exit 0
fi

[ -z "${1:-}" ] || die "Unknown option: $1 (the only one is --uninstall)."
[ "$(uname)" = "Darwin" ] || [ -n "$DRY" ] || die "This installer is for macOS. Elsewhere run: node --env-file=assistant/.env assistant/run.ts"

command -v node >/dev/null 2>&1 || die "Node.js is not installed (22.18 or newer): https://nodejs.org"
# 22.18, or 23.6 on the short-lived 23 line: the first that run Pako's TypeScript as it is (bin/preflight.cjs says the same).
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 23 || (a === 23 && b >= 6) || (a === 22 && b >= 18) ? 0 : 1)' \
  || die "Node $(node -v) is too old: 22.18 or newer is needed."
command -v claude >/dev/null 2>&1 || die "Claude Code is not installed or not on the PATH ('claude'). Install it, run 'claude' once to log in, then run this again."
NODE_BIN="$(command -v node)"
CLAUDE_BIN="$(command -v claude)"
for p in "$REPO" "$NODE_BIN" "$CLAUDE_BIN" "$HOME"; do
  case "$p" in *[\&\<\>\"\']*) die "A path with a special character is not supported: $p" ;; esac
done

# A value in the settings file may be quoted or end in a carriage return (Node reads both): take those off.
file_value() { sed -n "s/^$1=//p" "$ENV_FILE" | head -1 | tr -d "\"'\r "; }
if [ -z "$SERVER" ] && [ -f "$ENV_FILE" ]; then SERVER="$(file_value ASSISTANT_SERVER_URL)"; fi
if [ -z "$SERVER" ]; then
  say "Paste your server's address (the https address where Pako runs, for example https://my-pako.onrender.com)."
  read -r -p "Server: " SERVER || true
fi
SERVER="${SERVER%/}"
# Exactly what the bridge takes (assistant/bridge/config.ts): https:// and the host alone, or this computer over http. A panel address with a
# path would be written, then refused by the bridge at every start; and http://localhost.<anything> is another computer, which must not get
# the token over plain http in the check below.
HTTPS_RE='^https://[^/[:space:]]+$'
LOCAL_RE='^http://(localhost|127\.0\.0\.1)(:[0-9]+)?$'
[[ $SERVER =~ $HTTPS_RE || $SERVER =~ $LOCAL_RE ]] ||
  die "The server address must be https:// and the server's name only, nothing after it, like https://my-pako.onrender.com (got: ${SERVER:-nothing})."

TOKEN="${ASSISTANT_BRIDGE_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$ENV_FILE" ]; then
  TOKEN="$(file_value ASSISTANT_BRIDGE_TOKEN)"
fi
if [ -z "$TOKEN" ]; then
  say "Paste the bridge token: your server's settings, ASSISTANT_BRIDGE_TOKEN. It is not shown as you type."
  read -r -s -p "Token: " TOKEN
  echo
fi
case "$TOKEN" in
  "" | *[!A-Za-z0-9_-]*) die "The token may only hold letters, digits, - and _." ;;
esac
[ "${#TOKEN}" -ge 32 ] || die "The token is too short (32 characters or more)."

umask 077
mkdir -p "$STATE" "$HOME/Library/LaunchAgents"
chmod 700 "$STATE"
# Keep any other settings already in the file; replace the two this script owns.
TMP="$ENV_FILE.tmp"
{
  [ -f "$ENV_FILE" ] && { grep -v -E '^(ASSISTANT_SERVER_URL|ASSISTANT_BRIDGE_TOKEN)=' "$ENV_FILE" || true; }
  printf 'ASSISTANT_SERVER_URL=%s\n' "$SERVER"
  printf 'ASSISTANT_BRIDGE_TOKEN=%s\n' "$TOKEN"
} > "$TMP"
chmod 600 "$TMP"
mv "$TMP" "$ENV_FILE"
say "Wrote $ENV_FILE (readable by you only)."

# The older LaunchAgent, if this Mac has one: stopped and removed, as the one written next takes its place.
if [ -f "$OLD_PLIST" ]; then
  stop_agent "$OLD_PLIST"
  rm -f "$OLD_PLIST"
  say "Removed the older LaunchAgent ($OLD_PLIST): the one below replaces it."
fi

# The LaunchAgent: the paths of this Mac, and a PATH that reaches both node and claude. The token stays in the .env file, not here.
AGENT_PATH="$(dirname "$NODE_BIN"):$(dirname "$CLAUDE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-i</string>
    <string>$NODE_BIN</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>--env-file=$ENV_FILE</string>
    <string>$REPO/assistant/run.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$AGENT_PATH</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$STATE/assistant.log</string>
  <key>StandardErrorPath</key>
  <string>$STATE/assistant.log</string>
</dict>
</plist>
PLIST
say "Wrote $PLIST."

if [ -n "$DRY" ]; then
  say "Dry run: nothing started, the server not asked."
  exit 0
fi

# Does the server know this token? (404 just means its WhatsApp side is not turned on yet: it connects by itself once it is.)
# The token goes in on standard input, not on the command line (where any process could read it with ps).
CODE="$(printf 'Authorization: Bearer %s' "$TOKEN" | curl -sS -o /dev/null -m 20 -w '%{http_code}' -H @- "$SERVER/assistant/context" 2>/dev/null)" || true
[ -n "$CODE" ] || CODE=000
case "$CODE" in
  200) say "The server accepted the token." ;;
  401) say "WARNING: the server refused the token. Check it matches ASSISTANT_BRIDGE_TOKEN on the server, then run this again." ;;
  404) say "The server's chat side is not turned on yet (WhatsApp needs its settings on the server). Installed anyway: it connects by itself once it is." ;;
  000) say "Could not reach $SERVER. Installed anyway: it keeps trying." ;;
  *) say "The server answered $CODE. Installed anyway; see the log below." ;;
esac

stop_agent
if ! launchctl bootstrap "gui/$UID_NUM" "$PLIST" >/dev/null 2>&1; then
  launchctl load -w "$PLIST" || die "launchctl could not start it. Run it by hand instead: node --env-file=assistant/.env assistant/run.ts"
fi
say "Running. Log:      tail -f $STATE/assistant.log"
say "Stop and remove:   bash assistant/install.sh --uninstall"
say "Reminder: Claude Code on this Mac must be logged in (run 'claude' once), or the assistant will tell you it cannot think."
