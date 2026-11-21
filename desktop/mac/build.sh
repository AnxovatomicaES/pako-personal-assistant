#!/bin/sh
# npm run mac-app: builds Pako.app (desktop/mac/*.swift) with swiftc, no Xcode needed: a universal binary (Intel and Apple silicon; an
# architecture that does not build is said and left out), its Info.plist, an icon drawn at build time. Then, so that a stranger needs nothing
# else, package.sh puts Node.js and Pako's server inside it, and sign.sh signs it (ad hoc unless PAKO_SIGN_IDENTITY names a Developer ID).
# Usage: sh desktop/mac/build.sh [output folder]   (default: dist/ in the Pako folder; the app is <folder>/Pako.app)
#   PAKO_DEV_BUILD=1   a developer build: no Node.js or server inside; it runs the Pako folder it was built from (PakoRepoPath) with your node.
#   PAKO_BUILD=<n>     the build number (CFBundleVersion); default: the number of commits (git rev-list --count HEAD). It only ever grows.
#   PAKO_UPDATE_FEED   an https URL of the release feed the app checks once a day (empty: no check). See docs/desktop-mac.md.
#   PAKO_HELP_URL      an https URL Help > Pako Help opens (default: docs/desktop-mac.md in the public repository).
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
OUT=${1:-"$REPO/dist"}
say() { printf '  %s\n' "$*"; }
# iCloud Drive (Desktop and Documents too, when they sync) and other File Provider folders put Finder information back on a bundle a few
# seconds after it is cleaned, and codesign then refuses it ("resource fork, Finder information, or similar detritus not allowed"): such an
# output folder is refused here, before anything is built.
. "$HERE/synced.sh"
if syncedFolder "$OUT"; then
  say "$OUT is in a folder iCloud (or another File Provider) syncs: codesign cannot sign an app there. Build into another folder:"
  say "  npm run mac-app -- ~/pako-build   (or: npm run mac-release -- ~/pako-build)"
  exit 1
fi
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
APP="$OUT/Pako.app"

if ! command -v swiftc >/dev/null 2>&1; then
  say "swiftc not found: install the Command Line Tools (xcode-select --install) and run this again."
  exit 1
fi

# The version people see is package.json's; the build number is a plain integer that only grows, which is what Launch Services and the update
# check compare (two builds of one version must still be told apart). Either missing stops the build: a 0.0.0 app must never ship.
VERSION=$(plutil -extract version raw -o - "$REPO/package.json" 2>/dev/null || true)
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) say "could not read the version from $REPO/package.json: nothing made."; exit 1 ;;
esac
BUILD=${PAKO_BUILD:-$(git -C "$REPO" rev-list --count HEAD 2>/dev/null || true)}
case "$BUILD" in
  '' | *[!0-9]*) say "no build number: set PAKO_BUILD to a whole number (or build from a git checkout)."; exit 1 ;;
esac
FEED=${PAKO_UPDATE_FEED:-}
case "$FEED" in
  '' | https://*) ;;
  *) say "PAKO_UPDATE_FEED must be an https:// address."; exit 1 ;;
esac
# The public half of the release key (desktop/mac/feed-key.pub, or PAKO_FEED_PUBLIC_KEY): the app installs an update only from a feed signed
# by it (desktop/mac/feed-sign.ts, docs/desktop-mac.md "Make a release"). None yet: the app is built without one and offers no update.
FEEDKEY=${PAKO_FEED_PUBLIC_KEY:-$(cat "$HERE/feed-key.pub" 2>/dev/null || true)}
# One key per line (or comma separated): the release key, then any recovery keys. The app gets them comma separated.
KEYS=""
for K in $(printf '%s' "$FEEDKEY" | tr ',\r' '  '); do
  if [ "${#K}" != 44 ] || [ "$(printf '%s' "$K" | base64 --decode 2>/dev/null | wc -c | tr -d ' ')" != 32 ]; then
    say "a feed public key (desktop/mac/feed-key.pub or PAKO_FEED_PUBLIC_KEY) is not 32 bytes of base64."; exit 1
  fi
  KEYS=${KEYS:+$KEYS,}$K
done
FEEDKEY=$KEYS
HELP=${PAKO_HELP_URL:-https://github.com/AnxovatomicaES/pako-personal-assistant/blob/main/docs/desktop-mac.md}
case "$HELP" in
  https://*) ;;
  *) say "PAKO_HELP_URL must be an https:// address."; exit 1 ;;
esac
WORK=$(mktemp -d "${TMPDIR:-/tmp}/pako-app.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# The app's sources only: icon/ is its own small program. Kept as the arguments ("$@"), each one whole: the Pako folder's path may have
# spaces in it (a list in one variable would be cut there).
set -- "$HERE/Core.swift" "$HERE/DiscoveryCore.swift" "$HERE/Pako.swift" "$HERE/Claude.swift" "$HERE/Connect.swift" "$HERE/Status.swift" \
  "$HERE/Texts.swift" "$HERE/Update.swift" "$HERE/Discovery.swift" "$HERE/RemindersCore.swift" "$HERE/Reminders.swift" \
  "$HERE/App.swift" "$HERE/main.swift"
for ARCH in x86_64 arm64; do
  if swiftc -O -swift-version 5 -target "$ARCH-apple-macos13" -module-name Pako -framework AppKit -framework WebKit -framework EventKit -framework Contacts \
      "$@" -o "$WORK/Pako-$ARCH" 2>"$WORK/$ARCH.log"; then
    say "built for $ARCH"
  else
    rm -f "$WORK/Pako-$ARCH"
    say "could not build for $ARCH (left out):"
    # The errors, not the warnings before them.
    grep -A 3 'error:' "$WORK/$ARCH.log" | sed 's/^/    /' | head -30 || true
  fi
done
# Now the binaries that were made, again each one whole.
set --
for ARCH in x86_64 arm64; do
  if [ -f "$WORK/Pako-$ARCH" ]; then set -- "$@" "$WORK/Pako-$ARCH"; fi
done
if [ "$#" -eq 0 ]; then
  say "no architecture built: nothing made."
  exit 1
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
lipo -create "$@" -output "$APP/Contents/MacOS/Pako"

PLIST="$APP/Contents/Info.plist"
cp "$HERE/Info.plist" "$PLIST"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$PLIST"
plutil -replace CFBundleVersion -string "$BUILD" "$PLIST"
plutil -replace PakoUpdateFeed -string "$FEED" "$PLIST"
plutil -replace PakoFeedPublicKey -string "$FEEDKEY" "$PLIST"
plutil -replace PakoHelpURL -string "$HELP" "$PLIST"
if [ "${PAKO_DEV_BUILD:-}" = 1 ]; then
  # A developer build only: the Pako folder it was built from is where it looks first. Never in a release, which would hand every downloader
  # the builder's folder path (their user name) and let a folder there win over the server inside the app.
  plutil -insert PakoRepoPath -string "$REPO" "$PLIST"
fi
printf 'APPL????' >"$APP/Contents/PkgInfo"
# Why macOS asks for Calendars, Contacts, Mail and Documents, in English, the one language the app speaks (Info.plist has the same words).
mkdir -p "$APP/Contents/Resources/en.lproj"
cp "$HERE/InfoPlist.en.strings" "$APP/Contents/Resources/en.lproj/InfoPlist.strings"

# The icon: Pako's own face (icon/pako-icon-1024.png, the figure from the site in the macOS tile shape), cut to every size iconutil wants.
# Without that file, icon/main.swift draws a plain one for this Mac's own architecture. Without either the app still works.
if [ -f "$HERE/icon/pako-icon-1024.png" ] && cp "$HERE/icon/pako-icon-1024.png" "$WORK/icon.png" \
  || { swiftc -O -swift-version 5 -framework AppKit "$HERE/icon/main.swift" -o "$WORK/icon" 2>"$WORK/icon.log" && "$WORK/icon" "$WORK/icon.png"; }; then
  SET="$WORK/AppIcon.iconset"
  mkdir -p "$SET"
  ICON_OK=1
  for S in 16 32 128 256 512; do
    D=$((S * 2))
    sips -z "$S" "$S" "$WORK/icon.png" --out "$SET/icon_${S}x${S}.png" >/dev/null || ICON_OK=0
    sips -z "$D" "$D" "$WORK/icon.png" --out "$SET/icon_${S}x${S}@2x.png" >/dev/null || ICON_OK=0
  done
  # Optional, like the rest of the icon: a failure here leaves the default one, it does not stop the build.
  if [ "$ICON_OK" = 1 ] && iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns"; then :; else
    say "the icon could not be made (the app keeps the default one)"
  fi
else
  say "the icon could not be drawn (the app keeps the default one)"
fi

if [ "${PAKO_DEV_BUILD:-}" != 1 ]; then
  sh "$HERE/package.sh" "$APP"
fi
# Inside out, hardened runtime, no --deep (sign.sh says why); ad hoc unless PAKO_SIGN_IDENTITY is set.
sh "$HERE/sign.sh" "$APP"
say "made $APP (version $VERSION, build $BUILD$( [ "${PAKO_DEV_BUILD:-}" = 1 ] && printf ', developer build'), $(du -sh "$APP" | cut -f1))"
