#!/bin/sh
# The nightly gate: checks out the default branch as it is on GitHub into a throwaway worktree, runs bin/gate.sh there, keeps the log in
# ~/Library/Logs/pako-nightly/ (the last 14) and shows a macOS notification only when it fails. Installed by bin/nightly-install.sh.
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH="${PAKO_NIGHTLY_BRANCH:-main}"
LOGS="$HOME/Library/Logs/pako-nightly"
mkdir -p "$LOGS"
LOG="$LOGS/$(date +%Y-%m-%d).log"
TMP="$(mktemp -d)"
WT="$TMP/nightly"
# A fetch that fails (offline when it runs) is a failed night too: told like failing tests, not an exit with nothing said.
{
  date
  if git -C "$REPO" fetch -q origin "$BRANCH" && git -C "$REPO" worktree add -q --detach "$WT" "origin/$BRANCH"; then
    ln -s "$REPO/node_modules" "$WT/node_modules"
    ln -s "$REPO/voice-worker/node_modules" "$WT/voice-worker/node_modules"
    git -C "$WT" log -1 --oneline
    sh "$WT/bin/gate.sh"
  else
    echo "not ok: could not fetch $BRANCH"
    false
  fi
} > "$LOG" 2>&1
STATUS=$?
git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1
rm -rf "$TMP"
ls -1t "$LOGS"/*.log 2>/dev/null | tail -n +15 | xargs rm -f 2>/dev/null
if [ "$STATUS" -ne 0 ]; then
  FAILS="$(grep -cE '^not ok|error TS' "$LOG")"
  osascript -e "display notification \"$FAILS failing. Log: $LOG\" with title \"Pako nightly tests failed\"" >/dev/null 2>&1
fi
exit "$STATUS"
