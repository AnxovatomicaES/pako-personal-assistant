#!/bin/sh
# Pako for Mac, installed from Terminal in one line. Read it before you run it: it is short, and it says each step as it takes it.
#
#   curl -fsSL https://raw.githubusercontent.com/AnxovatomicaES/pako-personal-assistant/main/install-mac.sh | sh
#
# Why from Terminal: Pako for Mac is not notarized by Apple. A dmg downloaded in a browser is marked "quarantined", and macOS then refuses to
# open the app until you press Open Anyway in System Settings. Files that curl downloads carry no such mark, so the app opens straight away.
# What replaces Apple's check here is Pako's own: the same signed update feed (feed.json) the app itself trusts for its updates.
#
# What it does, in order:
#   1. Checks this is a Mac, new enough, and that it is not run as root. It never uses sudo.
#   2. Downloads the latest release's feed.json, and checks its Ed25519 signature against Pako's public keys (the same ones the app carries,
#      desktop/mac/feed-key.pub) when this Mac has an OpenSSL that can (OpenSSL 3, from Homebrew for one). macOS's own LibreSSL cannot:
#      then it says the signature was not checked, and the download is checked against the feed's SHA-256 only.
#   3. Downloads the dmg the feed names and checks its SHA-256 against the feed. A mismatch stops here, before anything is installed.
#   4. Opens the dmg read-only, checks the app's version and code signature, and copies Pako.app into /Applications (or ~/Applications when
#      /Applications is not writable). An older Pako there is replaced: it goes to the Trash. Pako must not be running.
#   5. Opens Pako. Your data (~/.pako) is never touched.
#
# Settings (all optional):
#   PAKO_APP_DIR=/some/folder     where Pako.app goes (default /Applications, else ~/Applications)
#   PAKO_FEED_URL=<https url>     another feed (default: the latest release of Pako's public repository)
#   PAKO_FEED_PUBLIC_KEY=<base64> the key(s) the feed must be signed by, instead of Pako's (space separated)
#   PAKO_NO_OPEN=1                install, but do not open Pako
#   PAKO_DRY_RUN=1                check the feed and say what it would do; downloads no dmg and changes nothing
# Works with sh, dash, bash and zsh. Running it again installs the newest release over the old one.

set -eu

FEED="${PAKO_FEED_URL:-https://github.com/AnxovatomicaES/pako-personal-assistant/releases/latest/download/feed.json}"
# desktop/mac/feed-key.pub: the release key, then the recovery key (a test checks they agree).
KEYS="${PAKO_FEED_PUBLIC_KEY:-RieIRE5udjogfJ8id/VVAuQxeTmwe4vPejNj9AFyg0Y= gyyvVAd5w5NqHL4CvzvypkBu0RFsN05JNlLcB5dKdbE=}"
BUNDLE_ID="io.github.anxovatomicaes.pako"
DRY="${PAKO_DRY_RUN:-0}"

msg() { printf '%s\n' "$1"; }
step() { printf '\n'; msg "==> $1"; }
die() { printf '\n' >&2; msg "$1" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "This installs Pako for Mac. On Linux, use install.sh instead (docs/install.md)."
[ "$(id -u)" != 0 ] || die "Run this as yourself, not as root or with sudo: Pako lives in your own account."

# A feed or dmg address: https, or a local file:// (for a copy you already have, and for the tests).
case "$FEED" in https://*|file://*) ;; *) die "PAKO_FEED_URL must be an https:// address." ;; esac

WORK=$(mktemp -d "${TMPDIR:-/tmp}/pako-install.XXXXXX")
MNT="$WORK/mnt"
MOUNTED=0
TARGET=""
STAGE=""
ASIDE=""
GONE=""
cleanup() {
  if [ "$MOUNTED" = 1 ]; then hdiutil detach -quiet "$MNT" 2>/dev/null || hdiutil detach -quiet -force "$MNT" 2>/dev/null || true; fi
  # Stopped half way (Ctrl+C, a failed step): no hidden copy is left in the applications folder, and an old Pako set aside goes back to its
  # place, or to the Trash when the new one is already there.
  if [ -n "$STAGE" ]; then rm -rf "$STAGE"; fi
  if [ -n "$ASIDE" ] && [ -e "$ASIDE" ]; then
    if [ ! -e "$TARGET" ]; then mv "$ASIDE" "$TARGET" 2>/dev/null || true
    else mv "$ASIDE" "$GONE" 2>/dev/null || true
    fi
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

fetch() { # fetch <url> <file>
  case "$1" in
    file://*) cp "${1#file://}" "$2" ;;
    *) curl -fL --progress-bar --proto '=https' --tlsv1.2 --retry 2 -o "$2" "$1" ;;
  esac
}
field() { plutil -extract "$1" raw -o - "$WORK/feed.json" 2>/dev/null || true; }

step "Reading the latest release"
fetch "$FEED" "$WORK/feed.json" 2>/dev/null || die "Could not download $FEED. Check your connection and try again."
plutil -convert xml1 -o /dev/null "$WORK/feed.json" >/dev/null 2>&1 || die "The feed at $FEED is not valid JSON."
VERSION=$(field version)
BUILD=$(field build)
URL=$(field url)
SHA=$(field sha256 | tr 'A-F' 'a-f')
MINOS=$(field minimumMacOS)
NOTES=$(field notes)
PAGE=$(field page)
SIG=$(field signature)
case "$VERSION" in ''|*[!0-9.]*) die "The feed has no valid version." ;; esac
case "$SHA" in *[!0-9a-f]*|'') die "The feed has no valid SHA-256." ;; esac
[ "${#SHA}" = 64 ] || die "The feed has no valid SHA-256."
case "$URL" in
  https://*.dmg) ;;
  file://*.dmg) case "$FEED" in file://*) ;; *) die "The feed names a local file, not an https:// address." ;; esac ;;
  *) die "The feed names no https:// dmg." ;;
esac
msg "    Pako $VERSION (build ${BUILD:-?})"

# Is this macOS new enough? Major.minor, compared as numbers.
OS=$(sw_vers -productVersion)
if [ -n "$MINOS" ] && ! printf '%s %s\n' "$OS" "$MINOS" | awk '{ split($1, a, "."); split($2, b, "."); exit !((a[1] + 0 > b[1] + 0) || (a[1] + 0 == b[1] + 0 && a[2] + 0 >= b[2] + 0)) }'; then
  die "Pako $VERSION needs macOS $MINOS or newer; this Mac has $OS."
fi

# The signature: an OpenSSL that knows Ed25519, if this Mac has one (macOS's own /usr/bin/openssl is LibreSSL, which does not).
OPENSSL=""
for o in openssl /opt/homebrew/bin/openssl /usr/local/bin/openssl /opt/homebrew/opt/openssl@3/bin/openssl /usr/local/opt/openssl@3/bin/openssl; do
  if command -v "$o" >/dev/null 2>&1 && "$o" list -public-key-algorithms 2>/dev/null | grep -qi ed25519; then OPENSSL=$o; break; fi
done
if [ -z "$SIG" ]; then
  die "The feed is not signed: nothing installed."
elif [ -n "$OPENSSL" ]; then
  # The signed text, field by field, exactly as desktop/mac/feed-sign.ts builds it (feedMessage).
  printf 'pako-feed-v1\nversion=%s\nbuild=%s\nurl=%s\nsha256=%s\nminimumMacOS=%s\nnotes=%s\npage=%s\n' \
    "$(field version)" "$BUILD" "$URL" "$(field sha256)" "$MINOS" "$NOTES" "$PAGE" >"$WORK/msg"
  printf '%s' "$SIG" | "$OPENSSL" base64 -d -A >"$WORK/sig" 2>/dev/null || die "The feed's signature is not valid base64: nothing installed."
  GOOD=0
  for k in $KEYS; do
    # An Ed25519 public key as DER: the 12-byte SubjectPublicKeyInfo prefix (30 2a 30 05 06 03 2b 65 70 03 21 00), then its 32 bytes.
    { printf '\060\052\060\005\006\003\053\145\160\003\041\000'; printf '%s' "$k" | "$OPENSSL" base64 -d -A; } >"$WORK/key.der" 2>/dev/null || continue
    if "$OPENSSL" pkeyutl -verify -pubin -inkey "$WORK/key.der" -keyform DER -rawin -in "$WORK/msg" -sigfile "$WORK/sig" >/dev/null 2>&1; then GOOD=1; break; fi
  done
  [ "$GOOD" = 1 ] || die "The feed's signature does NOT verify against Pako's keys: nothing installed. Please report this (SECURITY.md)."
  msg "    Signature: verified (Pako's release key)"
else
  msg "    Signature: not checked (this Mac has no OpenSSL 3; macOS's own cannot check Ed25519). The download is still checked against"
  msg "    the feed's SHA-256, and Pako checks the signature of every update itself once installed."
fi

# Where it goes.
if [ -n "${PAKO_APP_DIR:-}" ]; then APPS=$PAKO_APP_DIR
elif [ -w /Applications ]; then APPS=/Applications
else APPS="$HOME/Applications"
fi
TARGET="$APPS/Pako.app"

if [ "$DRY" = 1 ]; then
  step "Dry run: nothing downloaded or changed"
  msg "    Would download $URL"
  msg "    Would check its SHA-256 is $SHA"
  msg "    Would install Pako $VERSION as $TARGET"
  exit 0
fi

step "Downloading Pako $VERSION"
fetch "$URL" "$WORK/Pako.dmg" || die "Could not download $URL. Try again in a moment."
GOT=$(shasum -a 256 "$WORK/Pako.dmg" | awk '{print $1}')
[ "$GOT" = "$SHA" ] || die "The download's SHA-256 ($GOT) is not the release's ($SHA): nothing installed. Try again; if it repeats, report it."
msg "    SHA-256: matches the release"

step "Checking the app"
mkdir -p "$MNT"
hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$MNT" "$WORK/Pako.dmg" || die "macOS could not open the downloaded dmg."
MOUNTED=1
NEW="$MNT/Pako.app"
[ -d "$NEW" ] || die "The dmg holds no Pako.app."
[ "$(plutil -extract CFBundleIdentifier raw -o - "$NEW/Contents/Info.plist" 2>/dev/null)" = "$BUNDLE_ID" ] || die "The app in the dmg is not Pako."
[ "$(plutil -extract CFBundleShortVersionString raw -o - "$NEW/Contents/Info.plist" 2>/dev/null)" = "$VERSION" ] ||
  die "The app in the dmg is not version $VERSION."
codesign --verify --deep --strict "$NEW" 2>/dev/null || die "The app's code signature does not verify: nothing installed."
msg "    Pako $VERSION, code signature intact"

# Is a Pako running from there? Each process called Pako is compared by its program's file (-ef: the same file), not by a pattern on the
# path: a folder spelled with a trailing slash, brackets or a plus (all special in a pattern) must not hide the running app.
running() {
  for p in $(pgrep -x Pako 2>/dev/null); do
    [ "$(ps -o comm= -p "$p" 2>/dev/null)" -ef "$TARGET/Contents/MacOS/Pako" ] && return 0
  done
  return 1
}
if running; then
  die "Pako is running. Quit it first (the Pako menu in the menu bar, then Quit Pako), then run this again."
fi

step "Installing into $APPS"
mkdir -p "$APPS"
if [ -e "$TARGET" ] && [ "$(plutil -extract CFBundleIdentifier raw -o - "$TARGET/Contents/Info.plist" 2>/dev/null)" != "$BUNDLE_ID" ]; then
  die "$TARGET is there and is not Pako: left as it is, nothing installed. Move it away, or set PAKO_APP_DIR."
fi
# Copied next to its place first, then swapped in, so a failed copy never leaves half an app. The swap is two renames in the same folder,
# one right after the other (the old app set aside, the new one in its place): the Trash, perhaps on another disk, comes after.
STAGE="$APPS/.Pako-installing.app"
rm -rf "$STAGE"
ditto "$NEW" "$STAGE" || die "Could not copy Pako into $APPS."
xattr -dr com.apple.quarantine "$STAGE" 2>/dev/null || true
OLD=""
if [ -e "$TARGET" ]; then
  OLD=$(plutil -extract CFBundleShortVersionString raw -o - "$TARGET/Contents/Info.plist" 2>/dev/null || echo old)
  GONE="$HOME/.Trash/Pako $OLD $(date +%Y%m%d-%H%M%S).app"
  rm -rf "$APPS/.Pako-replaced.app"
  ASIDE="$APPS/.Pako-replaced.app"
  mv "$TARGET" "$ASIDE"
fi
mv "$STAGE" "$TARGET"
STAGE=""
if [ -n "$ASIDE" ]; then
  if mv "$ASIDE" "$GONE" 2>/dev/null; then msg "    Pako $OLD moved to the Trash"
  else rm -rf "$ASIDE"; msg "    Pako $OLD removed"
  fi
  ASIDE=""
fi
msg "    Installed: $TARGET"

if [ "${PAKO_NO_OPEN:-0}" != 1 ]; then
  step "Opening Pako"
  open "$TARGET" || msg "    Open Pako from $APPS yourself."
fi
printf '\n'
msg "Done. Pako lives in your menu bar. Updates come by themselves from now on (Pako checks their signature)."
