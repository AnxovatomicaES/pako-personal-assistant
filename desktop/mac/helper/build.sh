#!/bin/sh
# npm run mac-helper: builds Pako Helper.app (desktop/mac/helper/main.swift with the Mac app's own Asks, Discovery and Reminders code) into
# ~/.pako/helper and starts it at login (LaunchAgent local.pako.helper), so a Pako run from the Terminal gets this Mac's calendars, contacts,
# Mail accounts and Reminders as the Mac app would give them. `--remove` stops it and removes both. Needs swiftc (xcode-select --install).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
MAC=$(dirname "$HERE")
HOME_DIR=${PAKO_HOME:-$HOME/.pako}
APP="$HOME_DIR/helper/Pako Helper.app"
LABEL=local.pako.helper
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
say() { printf '%s\n' "$*"; }

stop() { launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; }
if [ "${1:-}" = "--remove" ]; then
  stop
  rm -f "$AGENT"
  rm -rf "$HOME_DIR/helper"
  say "Pako's Mac helper is stopped and removed."
  exit 0
fi
if [ "$(uname)" != "Darwin" ] || ! command -v swiftc >/dev/null 2>&1; then
  say "The Mac helper needs macOS and swiftc: install the Command Line Tools (xcode-select --install) and run this again."
  exit 1
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/pako-helper.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
swiftc -O -swift-version 5 -module-name PakoHelper -framework AppKit -framework EventKit -framework Contacts \
  "$MAC/Core.swift" "$MAC/DiscoveryCore.swift" "$MAC/Pako.swift" "$MAC/Discovery.swift" "$MAC/RemindersCore.swift" "$MAC/Reminders.swift" \
  "$MAC/Asks.swift" "$HERE/main.swift" -o "$WORK/pako-helper" 2>"$WORK/build.log" || { grep -A 3 'error:' "$WORK/build.log" | head -30; exit 1; }

# Stopped only now: a build that fails leaves the running helper as it was.
stop
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$HOME_DIR/logs"
cp "$WORK/pako-helper" "$APP/Contents/MacOS/pako-helper"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
# Signed here, ad hoc: macOS keeps the person's answers (calendars, contacts) for this signature; a new build asks once more.
codesign --force --sign - --identifier io.github.anxovatomicaes.pako.helper "$APP" >/dev/null 2>&1 || say "(not signed: macOS may ask again)"

mkdir -p "$(dirname "$AGENT")"
cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$APP/Contents/MacOS/pako-helper</string></array>
  <key>EnvironmentVariables</key><dict><key>PAKO_HOME</key><string>$HOME_DIR</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/logs/helper.log</string>
</dict>
</plist>
PLIST
# Right after a bootout, launchd may still be letting the old one go ("Input/output error"): once more after a moment.
launchctl bootstrap "gui/$(id -u)" "$AGENT" 2>/dev/null || { sleep 2; launchctl bootstrap "gui/$(id -u)" "$AGENT"; }
say "Pako's Mac helper is running. In the panel's Connections, Calendar and Contacts now offer this Mac's own; macOS asks you first."
