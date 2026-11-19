#!/bin/sh
# Installs (or with --remove, removes) the nightly gate as a launchd job of this user: every day at 03:30, bin/nightly-gate.sh.
LABEL="io.github.anxovatomicaes.pako.nightly"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
if [ "$1" = "--remove" ]; then rm -f "$PLIST"; echo "removed"; exit 0; fi
SCRIPT="$(cd "$(dirname "$0")" && pwd)/nightly-gate.sh"
NODE_DIR="$(dirname "$(command -v node)")"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$SCRIPT</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>
  <key>LowPriorityIO</key><true/><key>Nice</key><integer>10</integer>
</dict></plist>
PL
launchctl bootstrap "gui/$(id -u)" "$PLIST" && echo "installed: every day at 03:30 ($PLIST)"
