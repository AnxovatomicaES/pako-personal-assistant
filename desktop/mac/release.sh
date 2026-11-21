#!/bin/sh
# npm run mac-release: the downloadable Pako-<version>.dmg, from the committed code, and the update feed that describes it.
#   build.sh (the app, Node.js and the server inside it) -> sign.sh (PAKO_SIGN_IDENTITY, else ad hoc) -> notarize.sh on the app when
#   PAKO_NOTARY_PROFILE is set -> dmg.sh -> notarize.sh on the dmg -> release-check.sh (mounts it and runs the server from it) -> feed.sh
#   (feed.json next to the dmg: its version, build, SHA-256 and where it will be downloaded from; PAKO_RELEASE_* say where, see feed.sh)
#   -> feed-sign.ts (signs feed.json with the release key: the app installs nothing from a feed that is not signed by it).
# Nothing is published: docs/desktop-mac.md, "Publish a release", says how, when the owner decides.
# The order matters: the app is stapled before it goes into the dmg (a copy dragged out of the dmg then carries its own ticket, for a first
# launch with no internet), then the dmg gets its own ticket.
#
# Usage: sh desktop/mac/release.sh [output folder]   (default: dist/release in the Pako folder)
#   PAKO_HOTFIX=1  release although the last public one is less than a day old (a fix that cannot wait)
#   PAKO_ALLOW_DIRTY=1  build even with uncommitted changes to the server's files (never for a release that ships)
#   PAKO_LOCAL_RELEASE=1  a build only for this Mac, never published: no feed signing key needed, its feed.json stays unsigned (no app
#                         installs it). Without it, no signing key (PAKO_FEED_SIGNING_KEY or the keychain's pako-feed-signing) stops here.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
OUT=${1:-"$REPO/dist/release"}
say() { printf '  %s\n' "$*"; }

ID=${PAKO_SIGN_IDENTITY:--}
if [ -n "${PAKO_NOTARY_PROFILE:-}" ] && [ "$ID" = "-" ]; then
  say "PAKO_NOTARY_PROFILE is set but PAKO_SIGN_IDENTITY is not: an ad-hoc app cannot be notarized."
  exit 1
fi
if [ "${PAKO_ALLOW_DIRTY:-}" != 1 ]; then export PAKO_REQUIRE_CLEAN=1; fi
# The feed signing key, before anything is built: a public release whose feed no app would install must not get made.
signer() { node --disable-warning=ExperimentalWarning "$HERE/feed-sign.ts" "$@"; }
if [ "${PAKO_LOCAL_RELEASE:-}" != 1 ]; then
  if ! signer check; then
    say "release: stopped (no usable feed signing key; see above, and docs/desktop-mac.md, 'Make a release')."
    exit 1
  fi
  # A public release with no recovery key: one lost key strands every installed app (2026-11-20). Said, not stopped.
  if ! signer check | grep -q "recovery key(s) also trusted"; then
    say "warning: feed-key.pub has no recovery key: node desktop/mac/feed-sign.ts keygen-recovery <file>, then keep that file offline."
  fi
  # At most one public release a day: users update by hand when anything goes wrong, so each one must be worth it. PAKO_HOTFIX=1 for a fix.
  if [ "${PAKO_HOTFIX:-}" != 1 ] && command -v gh >/dev/null 2>&1; then
    LAST=$(gh release view --repo "${PAKO_RELEASE_REPO:-AnxovatomicaES/pako-personal-assistant}" --json publishedAt -q .publishedAt 2>/dev/null || true)
    if [ -n "$LAST" ]; then
      AGE=$(( $(date -u +%s) - $(date -ju -f '%Y-%m-%dT%H:%M:%SZ' "$LAST" +%s 2>/dev/null || date -u +%s) ))
      if [ "$AGE" -lt 72000 ]; then
        say "release: stopped (the last release is $((AGE / 3600)) h old; at most one a day, PAKO_HOTFIX=1 for a fix that cannot wait)."
        exit 1
      fi
    fi
  fi
fi

mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
rm -rf "$OUT/Pako.app"
sh "$HERE/build.sh" "$OUT"
APP="$OUT/Pako.app"
VERSION=$(plutil -extract CFBundleShortVersionString raw -o - "$APP/Contents/Info.plist")
DMG="$OUT/Pako-$VERSION.dmg"

if [ -n "${PAKO_NOTARY_PROFILE:-}" ]; then sh "$HERE/notarize.sh" "$APP"; fi
sh "$HERE/dmg.sh" "$APP" "$OUT"
if [ -n "${PAKO_NOTARY_PROFILE:-}" ]; then
  sh "$HERE/notarize.sh" "$DMG"
  # Stapling wrote the ticket into the dmg: its checksum changed.
  (cd "$OUT" && shasum -a 256 "$(basename "$DMG")" >"$(basename "$DMG").sha256")
fi
sh "$HERE/release-check.sh" "$DMG"
# Last: the feed's SHA-256 is that of the dmg as it ships (stapling above changed it).
sh "$HERE/feed.sh" "$DMG" "$OUT/feed.json"
if [ "${PAKO_LOCAL_RELEASE:-}" = 1 ]; then
  say "feed.json is NOT signed (PAKO_LOCAL_RELEASE=1): never publish it, no Pako.app would install it."
else
  signer sign "$OUT/feed.json"
  signer verify "$OUT/feed.json"
fi

if [ "$ID" = "-" ]; then
  say "ad hoc: fine on this Mac; a downloaded copy is blocked by Gatekeeper. For a public release: docs/desktop-mac.md, 'Make a release'."
elif [ -z "${PAKO_NOTARY_PROFILE:-}" ]; then
  say "signed but NOT notarized (no PAKO_NOTARY_PROFILE): macOS blocks a downloaded copy until it is notarized."
fi
say "release: $DMG ($(du -sh "$DMG" | cut -f1)), $DMG.sha256 and $OUT/feed.json"
