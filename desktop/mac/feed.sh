#!/bin/sh
# feed.json: the update feed for a built dmg (release.sh runs it; the app reads it, desktop/mac/Update.swift). It describes exactly that dmg:
# the disk is mounted read-only and the version, build and minimum macOS are read from the Pako.app on it, and the SHA-256 is the dmg's own.
#
#   { "version": "0.3.0", "build": 512, "url": "https://github.com/<owner>/<repo>/releases/download/v0.3.0/Pako-0.3.0.dmg",
#     "sha256": "<64 hex>", "minimumMacOS": "13.0", "notes": "<one line>", "page": "https://github.com/<owner>/<repo>/releases/tag/v0.3.0" }
#
# Usage: sh desktop/mac/feed.sh <Pako-x.y.z.dmg> [output file]   (default: feed.json next to the dmg)
#   PAKO_RELEASE_REPO     the GitHub repository the release is published in (default AnxovatomicaES/pako-personal-assistant)
#   PAKO_RELEASE_URL      where the dmg will be downloaded from, instead of that repository's release v<version> (https only)
#   PAKO_RELEASE_PAGE     the release's page, instead of that repository's (https only)
#   PAKO_RELEASE_NOTES    one line for the update window (default: "Pako <version>")
# Nothing is uploaded: publishing is the owner's step (docs/desktop-mac.md, "Publish a release").
set -eu

say() { printf '  %s\n' "$*"; }
fail() { say "feed: $*"; exit 1; }

[ "$#" -ge 1 ] || fail "usage: sh desktop/mac/feed.sh <Pako-x.y.z.dmg> [output file]"
DMG=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
[ -f "$DMG" ] || fail "no such dmg: $1"
OUT=${2:-"$(dirname "$DMG")/feed.json"}
REPO=${PAKO_RELEASE_REPO:-AnxovatomicaES/pako-personal-assistant}
case "$REPO" in
  */*) ;;
  *) fail "PAKO_RELEASE_REPO must be owner/name" ;;
esac

WORK=$(mktemp -d "${TMPDIR:-/tmp}/pako-feed.XXXXXX")
MNT="$WORK/mnt"
cleanup() {
  hdiutil detach -quiet "$MNT" 2>/dev/null || hdiutil detach -quiet -force "$MNT" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT
mkdir -p "$MNT"
# macOS's disk-image service can be busy for a moment (another image being attached or checked: it was seen while the whole test suite
# ran): tried three times, and when it still fails its own reason is said, not hidden.
MOUNTED=0
MOUNT_ERR=""
for try in 1 2 3; do
  if MOUNT_ERR=$(hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$MNT" "$DMG" 2>&1 >/dev/null); then MOUNTED=1; break; fi
  sleep "$try"
done
[ "$MOUNTED" = 1 ] || fail "could not mount $DMG: $(printf '%s' "$MOUNT_ERR" | tr '\n' ' ' | cut -c1-200)"
PLIST="$MNT/Pako.app/Contents/Info.plist"
[ -f "$PLIST" ] || fail "no Pako.app on the disk"
get() { plutil -extract "$1" raw -o - "$PLIST" 2>/dev/null || true; }
VERSION=$(get CFBundleShortVersionString)
BUILD=$(get CFBundleVersion)
MINOS=$(get LSMinimumSystemVersion)
case "$VERSION" in [0-9]*.[0-9]*.[0-9]*) ;; *) fail "the app's version is not x.y.z: $VERSION" ;; esac
case "$BUILD" in '' | *[!0-9]*) fail "the app's build number is not a whole number: $BUILD" ;; esac
case "$MINOS" in [0-9]*.[0-9]*) ;; *) fail "the app has no LSMinimumSystemVersion" ;; esac
[ "$(basename "$DMG")" = "Pako-$VERSION.dmg" ] || fail "the dmg is named $(basename "$DMG"), but the app on it is $VERSION"

URL=${PAKO_RELEASE_URL:-"https://github.com/$REPO/releases/download/v$VERSION/Pako-$VERSION.dmg"}
PAGE=${PAKO_RELEASE_PAGE:-"https://github.com/$REPO/releases/tag/v$VERSION"}
NOTES=${PAKO_RELEASE_NOTES:-"Pako $VERSION"}
for u in "$URL" "$PAGE"; do
  case "$u" in https://*) ;; *) fail "not an https address: $u" ;; esac
done
SHA=$(shasum -a 256 "$DMG" | cut -d ' ' -f 1)

# plutil writes the JSON (every string escaped as JSON needs), from a plist built key by key.
P="$WORK/feed.plist"
plutil -create xml1 "$P"
plutil -insert version -string "$VERSION" "$P"
plutil -insert build -integer "$BUILD" "$P"
plutil -insert url -string "$URL" "$P"
plutil -insert sha256 -string "$SHA" "$P"
plutil -insert minimumMacOS -string "$MINOS" "$P"
plutil -insert notes -string "$(printf '%s' "$NOTES" | tr '\r\n' '  ' | cut -c 1-300)" "$P"
plutil -insert page -string "$PAGE" "$P"
plutil -convert json -r -o "$OUT.part" "$P"
mv "$OUT.part" "$OUT"
say "feed: $OUT (Pako $VERSION, build $BUILD, macOS $MINOS or later, sha256 $SHA)"
say "      the dmg must be downloadable at $URL"
