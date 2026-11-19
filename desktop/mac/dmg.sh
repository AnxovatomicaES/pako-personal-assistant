#!/bin/sh
# Pako-<version>.dmg: the download. A compressed (UDZO) disk image named "Pako" holding Pako.app and a link to /Applications, so installing
# is one drag. Signed with PAKO_SIGN_IDENTITY when one is set (then notarize.sh notarizes and staples it); a .sha256 file goes next to it.
#
# Usage: sh desktop/mac/dmg.sh <Pako.app> [output folder]   (default: the app's folder)
set -eu

say() { printf '  %s\n' "$*"; }
fail() { say "dmg: $*"; exit 1; }

[ "$#" -ge 1 ] || fail "usage: sh desktop/mac/dmg.sh <Pako.app> [output folder]"
APP=$(cd "$1" && pwd)
OUT=${2:-$(dirname "$APP")}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
VERSION=$(plutil -extract CFBundleShortVersionString raw -o - "$APP/Contents/Info.plist")
DMG="$OUT/Pako-$VERSION.dmg"
ID=${PAKO_SIGN_IDENTITY:--}

codesign --verify --deep --strict "$APP" || fail "$APP is not properly signed (run sign.sh first)"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/pako-dmg.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
# ditto keeps the signature, the symlinks and the permissions exactly.
ditto "$APP" "$WORK/Pako/Pako.app"
ln -s /Applications "$WORK/Pako/Applications"
rm -f "$DMG" "$DMG.sha256"
# hdiutil sometimes fails for a moment on a busy Mac (a disk arbitration timeout): tried up to three times.
n=0
until hdiutil create -quiet -volname Pako -srcfolder "$WORK/Pako" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$DMG"; do
  n=$((n + 1))
  [ "$n" -lt 3 ] || fail "hdiutil create failed"
  rm -f "$DMG"
  sleep 2
done
if [ "$ID" != "-" ]; then
  codesign --force --timestamp -s "$ID" "$DMG"
  codesign --verify --strict "$DMG" || fail "the disk image's signature does not verify"
fi
(cd "$OUT" && shasum -a 256 "$(basename "$DMG")" >"$(basename "$DMG").sha256")
say "made $DMG ($(du -sh "$DMG" | cut -f1); the app inside is $(du -sh "$APP" | cut -f1) unpacked)"
