#!/bin/sh
# Signs Pako.app inside out, with the hardened runtime (which notarization requires), then checks the result.
#
#   1. Contents/Resources/node/bin/node: --options runtime and node.entitlements (only the two JIT entitlements V8 needs; that file says why).
#      Its official signature (Node's own team, with get-task-allow, which notarization refuses) is replaced.
#   2. Pako.app itself (its binary, Info.plist and every resource sealed): --options runtime and app.entitlements: only the three that let
#      macOS ask the person for Calendars, Contacts and Automation (Mail), which discovery needs (that file says why). It is not sandboxed,
#      WKWebView's JIT runs in Apple's own WebContent process, and starting node needs nothing.
#
# No --deep: it would give node the app's entitlements (none: node would crash) and is deprecated for signing.
# The identity is PAKO_SIGN_IDENTITY ("Developer ID Application: Name (TEAMID)", as `security find-identity -v -p codesigning` lists it),
# else "-" (ad hoc: runs on the Mac that built it; a download of it is blocked by Gatekeeper). Nothing secret is read or written here: the
# private key stays in the keychain, and codesign asks the keychain for it.
#
# Usage: sh desktop/mac/sign.sh <Pako.app>
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
say() { printf '  %s\n' "$*"; }
fail() { say "sign: $*"; exit 1; }

[ "$#" -eq 1 ] || fail "usage: sh desktop/mac/sign.sh <Pako.app>"
APP=$(cd "$1" && pwd)
ID=${PAKO_SIGN_IDENTITY:--}
# A secure timestamp needs a real identity (Apple's timestamp server refuses ad-hoc code); notarization needs it.
if [ "$ID" = "-" ]; then TS="--timestamp=none"; else TS="--timestamp"; fi
NODE="$APP/Contents/Resources/node/bin/node"

if [ -f "$NODE" ]; then
  # Named after the app (a bare binary would otherwise be "node" plus a hash), so a crash report or a privacy prompt says whose it is.
  BUNDLE_ID=$(plutil -extract CFBundleIdentifier raw -o - "$APP/Contents/Info.plist")
  codesign --force --options runtime "$TS" --entitlements "$HERE/node.entitlements" -i "$BUNDLE_ID.node" -s "$ID" "$NODE"
fi
codesign --force --options runtime "$TS" --entitlements "$HERE/app.entitlements" -s "$ID" "$APP"

# ---- Checks: a strict signature, the hardened runtime on both programs, and exactly the allowed entitlements ----
codesign --verify --deep --strict --verbose=2 "$APP" 2>"${TMPDIR:-/tmp}/pako-sign.$$" || { cat "${TMPDIR:-/tmp}/pako-sign.$$"; fail "the signature does not verify"; }
rm -f "${TMPDIR:-/tmp}/pako-sign.$$"
runtime() { codesign -dv "$1" 2>&1 | grep -q '^CodeDirectory.*flags=.*runtime' || fail "$1 lacks the hardened runtime"; }
# The entitlement keys, one per line, sorted ("" when there are none).
ents() { codesign -d --entitlements - --xml "$1" 2>/dev/null | plutil -convert json -o - - 2>/dev/null | tr ',{}' '\n\n\n' | sed -n 's/^ *"\([^"]*\)":.*/\1/p' | sort | tr '\n' ' '; }
runtime "$APP"
APP_ENTS="com.apple.security.automation.apple-events com.apple.security.personal-information.addressbook com.apple.security.personal-information.calendars "
[ "$(ents "$APP")" = "$APP_ENTS" ] || fail "Pako.app's entitlements are not exactly the three discovery ones: $(ents "$APP")"
for a in $(lipo -archs "$APP/Contents/MacOS/Pako"); do
  codesign --verify --strict --arch "$a" "$APP" || fail "Pako.app's $a slice: the signature does not verify"
  codesign -dv --arch "$a" "$APP" 2>&1 | grep -q '^CodeDirectory.*flags=.*runtime' || fail "Pako.app's $a slice lacks the hardened runtime"
done
if [ -f "$NODE" ]; then
  codesign --verify --strict "$NODE" || fail "node's signature does not verify"
  runtime "$NODE"
  got=$(ents "$NODE")
  [ "$got" = "com.apple.security.cs.allow-jit com.apple.security.cs.allow-unsigned-executable-memory " ] \
    || fail "node's entitlements are not exactly the two JIT ones: $got"
  # Each slice on its own (codesign signs them one by one): the arm64 one is checked here even on an Intel Mac, which cannot run it.
  for a in $(lipo -archs "$NODE"); do
    codesign --verify --strict --arch "$a" "$NODE" || fail "node's $a slice: the signature does not verify"
    codesign -dv --arch "$a" "$NODE" 2>&1 | grep -q '^CodeDirectory.*flags=.*runtime' || fail "node's $a slice lacks the hardened runtime"
    got=$(codesign -d --arch "$a" --entitlements - --xml "$NODE" 2>/dev/null | plutil -convert json -o - - 2>/dev/null | tr ',{}' '\n\n\n' \
      | sed -n 's/^ *"\([^"]*\)":.*/\1/p' | sort | tr '\n' ' ')
    [ "$got" = "com.apple.security.cs.allow-jit com.apple.security.cs.allow-unsigned-executable-memory " ] \
      || fail "node's $a slice: entitlements are not exactly the two JIT ones: $got"
  done
  say "node: each slice ($(lipo -archs "$NODE")) signed, hardened, with only the two JIT entitlements"
  # V8 compiles hot code at run time: a loop long enough to be compiled, and a WebAssembly module, under the hardened runtime, on every slice
  # this Mac can run (an Intel Mac cannot run the arm64 one: Apple silicon runs both).
  js='let s = 0; for (let i = 0; i < 3e7; i++) s += i % 7; new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))); console.log(process.arch, process.version)'
  for a in x86_64 arm64; do
    if arch "-$a" /usr/bin/true 2>/dev/null; then
      out=$(arch "-$a" "$NODE" -e "$js" 2>&1) || fail "the bundled node ($a) crashed under the hardened runtime: $out"
      say "node runs compiled code under the hardened runtime: $out"
    else
      say "node ($a): this Mac cannot run that slice; not run here"
    fi
  done
fi
if [ "$ID" = "-" ]; then
  say "signed ad hoc (set PAKO_SIGN_IDENTITY to sign with a Developer ID)"
else
  say "signed by $(codesign -dv "$APP" 2>&1 | sed -n 's/^Authority=//p' | head -n 1), team $(codesign -dv "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
fi
