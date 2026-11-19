#!/bin/sh
# Sends Pako.app or Pako-<version>.dmg to Apple's notary service, waits for the answer, staples the ticket to it, and asks Gatekeeper.
#
# Needs, from the environment, and refuses to run without them:
#   PAKO_SIGN_IDENTITY   the Developer ID Application identity the file was signed with (an ad-hoc signature cannot be notarized)
#   PAKO_NOTARY_PROFILE  the name of a notarytool keychain profile. Made once, by the owner, in a terminal:
#                          xcrun notarytool store-credentials pako-notary --apple-id <your Apple ID> --team-id <TEAMID>
#                        It asks for an app-specific password (appleid.apple.com > Sign-In and Security > App-Specific Passwords) and keeps
#                        it in the login keychain. This script never takes an Apple ID, a password or a key, and never prints one.
# notarytool and stapler come with the Command Line Tools (checked on macOS 15: /Library/Developer/CommandLineTools/usr/bin); Xcode is
# not needed.
#
# Usage: sh desktop/mac/notarize.sh <Pako.app | Pako-x.y.z.dmg>
set -eu

say() { printf '  %s\n' "$*"; }
fail() { say "notarize: $*"; exit 1; }

[ "$#" -eq 1 ] || fail "usage: sh desktop/mac/notarize.sh <Pako.app | Pako-x.y.z.dmg>"
FILE=$1
[ -e "$FILE" ] || fail "$FILE not found"
if [ -z "${PAKO_NOTARY_PROFILE:-}" ] || [ -z "${PAKO_SIGN_IDENTITY:-}" ] || [ "${PAKO_SIGN_IDENTITY:-}" = "-" ]; then
  say "notarize: needs PAKO_SIGN_IDENTITY (a Developer ID Application identity) and PAKO_NOTARY_PROFILE (a notarytool keychain profile)."
  say "Make the profile once:  xcrun notarytool store-credentials pako-notary --apple-id <Apple ID> --team-id <TEAMID>"
  say "then:  PAKO_SIGN_IDENTITY='Developer ID Application: <Name> (<TEAMID>)' PAKO_NOTARY_PROFILE=pako-notary npm run mac-release"
  exit 2
fi
for tool in notarytool stapler; do
  xcrun --find "$tool" >/dev/null 2>&1 || fail "xcrun $tool not found: install the Command Line Tools (xcode-select --install)"
done
codesign --verify --strict "$FILE" || fail "$FILE is not properly signed"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/pako-notarize.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
case "$FILE" in
  *.app | *.app/) SUBMIT="$WORK/Pako.zip"; ditto -c -k --keepParent "$FILE" "$SUBMIT" ;;
  *.dmg) SUBMIT=$FILE ;;
  *) fail "only a .app or a .dmg" ;;
esac

say "sending $(basename "$FILE") to Apple's notary service (it takes a few minutes)"
xcrun notarytool submit "$SUBMIT" --keychain-profile "$PAKO_NOTARY_PROFILE" --wait --output-format json >"$WORK/result.json" 2>"$WORK/err.txt" || true
STATUS=$(plutil -extract status raw -o - "$WORK/result.json" 2>/dev/null || true)
SUBMISSION=$(plutil -extract id raw -o - "$WORK/result.json" 2>/dev/null || true)
if [ "$STATUS" != "Accepted" ]; then
  cat "$WORK/err.txt" >&2
  if [ -n "$SUBMISSION" ]; then
    say "status: ${STATUS:-unknown}. Apple's log for submission $SUBMISSION:"
    xcrun notarytool log "$SUBMISSION" --keychain-profile "$PAKO_NOTARY_PROFILE" || true
  fi
  fail "not notarized"
fi
say "accepted (submission $SUBMISSION)"
xcrun stapler staple "$FILE"
xcrun stapler validate "$FILE"
case "$FILE" in
  *.dmg) spctl -a -vv -t open --context context:primary-signature "$FILE" ;;
  *) spctl -a -vv -t exec "$FILE" ;;
esac
say "notarized and stapled: $FILE"
