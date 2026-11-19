#!/bin/sh
# npm run mac-release-check [Pako-x.y.z.dmg]: checks a built dmg as a stranger would get it, from a read-only disk, with no Node.js of their
# own. The CI here cannot run (no macOS runner), so this is the release gate, run by release.sh and by hand.
#   - the disk holds Pako.app and the Applications link
#   - strict signatures, the hardened runtime on both programs, the entitlement allowlist (the three discovery ones for the app, the two JIT
#     ones for node)
#   - node has both architectures, and the server runs FROM THE MOUNTED DISK with the bundled node: a fresh HOME and PAKO_HOME, a free port,
#     a PATH with no node in it. /health answers, the panel answers, a one-time sign-in link (the bridge token, as the app asks) gives a
#     session the overview accepts; SIGTERM stops it and nothing of it is left running
#   - nothing was written inside the app (every file's SHA-256 before and after)
#   - with a Developer ID: Gatekeeper accepts the app and the dmg, and the dmg's ticket is stapled
#
# Usage: sh desktop/mac/release-check.sh [Pako-x.y.z.dmg]   (default: the newest dist/release/Pako-*.dmg)
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
say() { printf '  %s\n' "$*"; }
fail() { say "release-check FAILED: $*"; exit 1; }

DMG=${1:-$(ls -t "$REPO"/dist/release/Pako-*.dmg 2>/dev/null | head -n 1)}
[ -n "$DMG" ] && [ -f "$DMG" ] || fail "no dmg (build one: npm run mac-release)"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/pako-check.XXXXXX")
MNT="$WORK/mnt"
SERVER=""
cleanup() {
  [ -n "$SERVER" ] && kill -9 "$SERVER" 2>/dev/null || true
  hdiutil detach -quiet "$MNT" 2>/dev/null || hdiutil detach -quiet -force "$MNT" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$MNT"
hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$MNT" "$DMG" || fail "could not mount $DMG"
APP="$MNT/Pako.app"
[ -d "$APP" ] || fail "no Pako.app on the disk"
[ "$(readlink "$MNT/Applications")" = /Applications ] || fail "no Applications link on the disk"
say "disk: $(cd "$MNT" && ls | tr '\n' ' ')"

# ---- signatures ----
codesign --verify --deep --strict --verbose=2 "$APP" 2>"$WORK/cs.txt" || { cat "$WORK/cs.txt"; fail "the app's signature does not verify"; }
NODE="$APP/Contents/Resources/node/bin/node"
[ -x "$NODE" ] || fail "no bundled node"
for f in "$APP" "$NODE"; do
  codesign -dv "$f" 2>&1 | grep -q '^CodeDirectory.*flags=.*runtime' || fail "$f lacks the hardened runtime"
done
ents() { codesign -d --entitlements - --xml "$1" 2>/dev/null | plutil -convert json -o - - 2>/dev/null | tr ',{}' '\n\n\n' | sed -n 's/^ *"\([^"]*\)":.*/\1/p' | sort | tr '\n' ' '; }
APP_ENTS="com.apple.security.automation.apple-events com.apple.security.personal-information.addressbook com.apple.security.personal-information.calendars "
[ "$(ents "$APP")" = "$APP_ENTS" ] || fail "the app's entitlements: $(ents "$APP")"
[ "$(ents "$NODE")" = "com.apple.security.cs.allow-jit com.apple.security.cs.allow-unsigned-executable-memory " ] || fail "node's entitlements: $(ents "$NODE")"
archs=$(lipo -archs "$NODE")
case "$archs" in *x86_64*arm64* | *arm64*x86_64*) ;; *) fail "node is not universal: $archs" ;; esac
appArchs=$(lipo -archs "$APP/Contents/MacOS/Pako")
case "$appArchs" in *x86_64*arm64* | *arm64*x86_64*) ;; *) fail "Pako.app is not universal: $appArchs" ;; esac
say "signatures: strict, hardened runtime on the app and node, entitlements as allowed; node: $archs; app: $appArchs"
# ---- each architecture on its own: an Intel Mac cannot run the arm64 slices, but it checks them here ----
MINOS=$(plutil -extract LSMinimumSystemVersion raw -o - "$APP/Contents/Info.plist")
archEnts() { codesign -d --arch "$1" --entitlements - --xml "$2" 2>/dev/null | plutil -convert json -o - - 2>/dev/null | tr ',{}' '\n\n\n' \
  | sed -n 's/^ *"\([^"]*\)":.*/\1/p' | sort | tr '\n' ' '; }
minos() { vtool -arch "$1" -show-build "$2" 2>/dev/null | awk '$1 == "minos" { print $2; exit }'; }
older() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1)" = "$1" ]; }
for a in x86_64 arm64; do
  for f in "$APP" "$NODE"; do
    codesign --verify --strict --arch "$a" "$f" 2>/dev/null || fail "$a slice of $f: the signature does not verify"
    codesign -dv --arch "$a" "$f" 2>&1 | grep -q '^CodeDirectory.*flags=.*runtime' || fail "$a slice of $f lacks the hardened runtime"
  done
  [ "$(archEnts "$a" "$APP")" = "$APP_ENTS" ] || fail "the app's $a slice: entitlements $(archEnts "$a" "$APP")"
  [ "$(archEnts "$a" "$NODE")" = "com.apple.security.cs.allow-jit com.apple.security.cs.allow-unsigned-executable-memory " ] \
    || fail "node's $a slice: entitlements $(archEnts "$a" "$NODE")"
  [ "$(minos "$a" "$APP/Contents/MacOS/Pako")" = "$MINOS" ] || fail "the app's $a slice is built for macOS $(minos "$a" "$APP/Contents/MacOS/Pako"), not $MINOS"
  m=$(minos "$a" "$NODE")
  [ -n "$m" ] && older "$m" "$MINOS" || fail "node's $a slice needs macOS ${m:-?}, newer than the app's $MINOS"
  libs=$(otool -L -arch "$a" "$APP/Contents/MacOS/Pako" | tail -n +2 | awk '{ print $1 }' | grep -v -e '^/System/Library/' -e '^/usr/lib/' || true)
  [ -z "$libs" ] || fail "the app's $a slice links something outside macOS: $libs"
done
say "each slice (x86_64, arm64) of the app and node: signed, hardened, entitled as allowed, built for macOS $MINOS or older, system libraries only"
grep -q PakoRepoPath "$APP/Contents/Info.plist" && fail "the release's Info.plist names a build folder (PakoRepoPath)"

# ---- the server, from the read-only disk ----
hashes() { (cd "$APP" && find . -type f -print0 | xargs -0 shasum -a 256 | sort -k 2); }
hashes >"$WORK/before.txt"
HOMEDIR="$WORK/home"
mkdir -p "$HOMEDIR"
PORT=$("$NODE" -e "const s = require('net').createServer().listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); })")
CLEANPATH=/usr/bin:/bin:/usr/sbin:/sbin
if PATH=$CLEANPATH command -v node >/dev/null 2>&1; then fail "the test PATH has a node in it"; fi
# PAKO_SECRET_STORE=file: this throwaway home never writes the keychain of the Mac it is checked on, and its token is read from the file below.
(cd "$APP/Contents/Resources/pako" && exec env -i HOME="$HOMEDIR" PAKO_HOME="$HOMEDIR/.pako" PORT="$PORT" PATH="$CLEANPATH" PAKO_NO_OPEN=1 PAKO_SECRET_STORE=file \
  PAKO_APP_BUNDLE=1 LANG=en_US.UTF-8 "$NODE" --disable-warning=ExperimentalWarning src/server.ts) >"$WORK/server.log" 2>&1 &
SERVER=$!
up=""
i=0
while [ $i -lt 120 ]; do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null; then up=1; break; fi
  kill -0 "$SERVER" 2>/dev/null || break
  sleep 0.5
  i=$((i + 1))
done
[ -n "$up" ] || { sed 's/^/    /' "$WORK/server.log" | tail -30; fail "the bundled server did not answer /health"; }
say "the bundled server answers on 127.0.0.1:$PORT (started from the read-only disk, no node on PATH)"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/panel")
[ "$code" = 200 ] || fail "/panel answered $code"
# Signed in as the app does it: the bridge token (secrets.json) for a one-time link, the link for the session cookie, the cookie for data.
TOKEN=$("$NODE" -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).bridgeToken)" "$HOMEDIR/.pako/secrets.json")
LINK=$(curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Length: 0' "http://127.0.0.1:$PORT/panel/api/link" \
  | "$NODE" -e "let s = ''; process.stdin.on('data', d => s += d).on('end', () => process.stdout.write(JSON.parse(s).link))")
case "$LINK" in http://*/panel/login/*) ;; *) fail "no sign-in link" ;; esac
LINK="http://127.0.0.1:$PORT${LINK#http://*:"$PORT"}"
curl -fsS -o /dev/null -c "$WORK/jar" "$LINK" || fail "the sign-in link was refused"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$WORK/jar" "http://127.0.0.1:$PORT/panel/api/overview")
[ "$code" = 200 ] || fail "the signed-in overview answered $code"
say "panel: /panel 200, sign-in link accepted, signed-in /panel/api/overview 200"
kill -TERM "$SERVER"
i=0
while kill -0 "$SERVER" 2>/dev/null && [ $i -lt 40 ]; do sleep 0.5; i=$((i + 1)); done
kill -0 "$SERVER" 2>/dev/null && fail "the server did not stop on SIGTERM"
SERVER=""
sleep 1
left=$(pgrep -fl "$MNT" || true)
[ -z "$left" ] || fail "still running from the disk after SIGTERM: $left"
say "stopped on SIGTERM; nothing left running from the disk"
hashes >"$WORK/after.txt"
cmp -s "$WORK/before.txt" "$WORK/after.txt" || { diff "$WORK/before.txt" "$WORK/after.txt" | head; fail "files inside the app changed"; }
say "nothing inside the app changed ($(wc -l <"$WORK/before.txt" | tr -d ' ') files hashed before and after)"

# ---- Gatekeeper, for a Developer ID build ----
if codesign -dv "$APP" 2>&1 | grep -q '^Authority=Developer ID Application'; then
  spctl -a -vv -t exec "$APP" || fail "Gatekeeper refuses the app"
  xcrun stapler validate "$DMG" || fail "the dmg has no stapled ticket"
  spctl -a -vv -t open --context context:primary-signature "$DMG" || fail "Gatekeeper refuses the dmg"
  say "Gatekeeper accepts the app and the dmg; the ticket is stapled"
else
  say "ad hoc: Gatekeeper is not asked (it refuses any download that is not notarized)"
fi
say "release-check passed: $(basename "$DMG") $(du -sh "$DMG" | cut -f1), app $(du -sh "$APP" | cut -f1) unpacked"
