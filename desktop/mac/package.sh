#!/bin/sh
# Makes Pako.app self-contained (called by build.sh): the official Node.js runtime and Pako's server go inside it, so a person who drags the
# app to Applications needs nothing else installed.
#
#   Contents/Resources/node/bin/node   Node.js (node.sha256 pins the version), one universal binary: lipo of the official x64 and arm64 ones
#   Contents/Resources/node/LICENSE    Node.js's licence, which must travel with it
#   Contents/Resources/pako/           src, assistant's four .ts files, bin, package.json, package-lock.json, LICENSE, THIRD_PARTY_NOTICES.md
#                                      and production node_modules (npm ci --omit=dev --ignore-scripts), pruned
#
# Universal, not one download per architecture: one Pako.dmg for every Mac (owner decision 1: a stranger never has to know which chip they
# have), and the kernel picks the slice. It costs about 115 MB of the second slice unpacked, much less in the compressed dmg.
#
# Never copied from the working tree: the server comes from `git archive` of the committed files (with uncommitted changes to tracked files
# when there are some; never an untracked or ignored one: no .env, data/, .pako/, private notes). The build then fails closed on anything that
# should not ship (secrets, private notes, a Mach-O other than node and the app, a native addon).
#
# Usage: sh desktop/mac/package.sh <Pako.app>
#   PAKO_BUILD_CACHE    where downloads are kept (default ~/Library/Caches/pako-build), outside the repo
#   PAKO_REQUIRE_CLEAN  1: refuse when the server's files have uncommitted changes (release.sh sets it)
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
say() { printf '  %s\n' "$*"; }
fail() { say "package: $*"; exit 1; }

[ "$#" -eq 1 ] || fail "usage: sh desktop/mac/package.sh <Pako.app>"
APP=$(cd "$1" && pwd)
[ -f "$APP/Contents/Info.plist" ] || fail "$APP is not an app bundle"
RES="$APP/Contents/Resources"
CACHE=${PAKO_BUILD_CACHE:-"$HOME/Library/Caches/pako-build"}
PINS="$HERE/node.sha256"
V=$(sed -n 's/^version \(v22\.[0-9]*\.[0-9]*\)$/\1/p' "$PINS")
[ -n "$V" ] || fail "no Node.js 22 version in $PINS"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/pako-package.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

sha() { shasum -a 256 "$1" | cut -d ' ' -f 1; }

# ---- Node.js: downloaded once into the cache, checked against the pinned hash and nodejs.org's SHASUMS256.txt, every time it is used ----
fetch() {
  name="node-$V-darwin-$1.tar.gz"
  want=$(awk -v n="$name" '$2 == n { print $1 }' "$PINS")
  [ -n "$want" ] || fail "no pinned SHA-256 for $name in $PINS"
  dir="$CACHE/node/$V"
  mkdir -p "$dir"
  if [ ! -f "$dir/$name" ] || [ "$(sha "$dir/$name")" != "$want" ]; then
    say "downloading $name from nodejs.org"
    rm -f "$dir/$name.part"
    curl -fsSL --proto '=https' --tlsv1.2 --retry 2 --max-time 600 -o "$dir/$name.part" "https://nodejs.org/dist/$V/$name" \
      || fail "could not download $name (no internet?)"
    mv "$dir/$name.part" "$dir/$name"
  fi
  if [ ! -f "$dir/SHASUMS256.txt" ]; then
    curl -fsSL --proto '=https' --tlsv1.2 --retry 2 --max-time 60 -o "$dir/SHASUMS256.txt.part" "https://nodejs.org/dist/$V/SHASUMS256.txt" \
      || fail "could not download SHASUMS256.txt for $V"
    mv "$dir/SHASUMS256.txt.part" "$dir/SHASUMS256.txt"
  fi
  listed=$(awk -v n="$name" '$2 == n { print $1 }' "$dir/SHASUMS256.txt")
  got=$(sha "$dir/$name")
  if [ "$got" != "$want" ] || [ "$listed" != "$want" ]; then
    rm -f "$dir/$name"
    fail "$name: SHA-256 $got does not match the pinned $want (SHASUMS256.txt says ${listed:-nothing}): deleted, nothing made"
  fi
  # Each archive in an empty folder of its own (downloaded data), only the files used.
  mkdir -p "$WORK/node-$1"
  members="node-$V-darwin-$1/bin/node node-$V-darwin-$1/LICENSE"
  [ "$1" = "$HOSTARCH" ] && members="$members node-$V-darwin-$1/lib/node_modules/npm"
  # shellcheck disable=SC2086 # the member names have no spaces
  tar -xzf "$dir/$name" -C "$WORK/node-$1" --strip-components 1 $members
}

case "$(uname -m)" in
  arm64) HOSTARCH=arm64 ;;
  *) HOSTARCH=x64 ;;
esac
fetch x64
fetch arm64
say "Node.js $V checked (pinned SHA-256 and SHASUMS256.txt)"

rm -rf "$RES/node" "$RES/pako"
mkdir -p "$RES/node/bin"
lipo -create "$WORK/node-x64/bin/node" "$WORK/node-arm64/bin/node" -output "$RES/node/bin/node"
chmod 755 "$RES/node/bin/node"
# Each slice of the universal node is the official binary, byte for byte (lipo only puts them side by side): the arm64 one, which an Intel Mac
# cannot run, is at least exactly what nodejs.org built and the pinned SHA-256 vouched for.
for pair in x86_64:x64 arm64:arm64; do
  lipo -thin "${pair%%:*}" "$RES/node/bin/node" -output "$WORK/node-thin" || fail "no ${pair%%:*} slice in the universal node"
  cmp -s "$WORK/node-thin" "$WORK/node-${pair##*:}/bin/node" || fail "the ${pair%%:*} slice of the universal node is not the official binary"
done
say "node's two slices are the official binaries, byte for byte"
# The app itself must have both slices too: build.sh leaves out one that does not compile, which a developer build may live with, a release not.
case "$(lipo -archs "$APP/Contents/MacOS/Pako")" in
  *x86_64*arm64* | *arm64*x86_64*) ;;
  *) fail "Pako.app is not universal ($(lipo -archs "$APP/Contents/MacOS/Pako")): a release runs on Intel and Apple silicon" ;;
esac
cp "$WORK/node-x64/LICENSE" "$RES/node/LICENSE"
# The npm of the same Node.js, run by this Mac's own slice: the build needs no Node.js of its own.
NODE_HOST="$WORK/node-$HOSTARCH/bin/node"
NPM="$WORK/node-$HOSTARCH/lib/node_modules/npm/bin/npm-cli.js"

# ---- Pako's server, from git ----
command -v git >/dev/null 2>&1 && git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || fail "$REPO is not a git checkout: the server is taken from git"
# Every TypeScript file of the bridge (assistant/*.ts), as git has them: a file added there later is taken without changing this list.
ASSISTANT_TS=$(git -C "$REPO" ls-files 'assistant/*.ts' | tr '\n' ' ')
[ -n "$ASSISTANT_TS" ] || fail "no assistant/*.ts in git"
SERVER_FILES="src $ASSISTANT_TS bin package.json package-lock.json LICENSE THIRD_PARTY_NOTICES.md"
if [ "${PAKO_REQUIRE_CLEAN:-}" = 1 ]; then
  # shellcheck disable=SC2086
  dirty=$(git -C "$REPO" status --porcelain -- $SERVER_FILES)
  [ -z "$dirty" ] || fail "uncommitted changes in the server's files (commit them first):
$dirty"
fi
# `git stash create` makes a commit of the tracked files as they are now without touching the work tree, the index or the stash list; empty
# when nothing changed. Untracked and ignored files are never in it.
REF=$(git -C "$REPO" stash create 2>/dev/null || true)
REF=${REF:-HEAD}
STAGE="$WORK/pako"
mkdir -p "$STAGE"
# shellcheck disable=SC2086
git -C "$REPO" archive --format=tar "$REF" -- $SERVER_FILES | tar -xf - -C "$STAGE"
[ -f "$STAGE/src/server.ts" ] && [ -f "$STAGE/package-lock.json" ] || fail "the server's files are not all in git"

say "installing the server's production modules (npm ci --omit=dev --ignore-scripts)"
(cd "$STAGE" && "$NODE_HOST" "$NPM" ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error) >"$WORK/npm.log" 2>&1 \
  || { sed 's/^/    /' "$WORK/npm.log" | tail -20; fail "npm ci failed"; }

# No native addon: none is expected (checked: no dependency has one), and one would need disable-library-validation, which the app refuses.
addons=$(find "$STAGE/node_modules" \( -name '*.node' -o -name binding.gyp -o -name '*.dylib' \) -print)
[ -z "$addons" ] || fail "native addons in the production modules (not supported):
$addons"

# ---- Pruning: what the server never reads ----
# The four packages the panel only serves files from (src/dashboard.ts, its vendor map): only those files, their package.json and licence.
VENDOR=$(sed -n 's/.*{ file: "\([^"]*\)", type:.*/\1/p' "$STAGE/src/dashboard.ts")
[ -n "$VENDOR" ] || fail "no vendor files found in src/dashboard.ts"
for pkg in gsap lucide three @fontsource-variable/inter; do
  d="$STAGE/node_modules/$pkg"
  [ -d "$d" ] || fail "$pkg is missing from node_modules"
  keep="$WORK/keep/$pkg"
  mkdir -p "$keep"
  for f in package.json LICENSE LICENSE.md LICENSE.txt license; do [ -f "$d/$f" ] && cp "$d/$f" "$keep/"; done
  for f in $VENDOR; do
    case "$f" in
      "$pkg"/*) rel=${f#"$pkg"/}; mkdir -p "$keep/$(dirname "$rel")"; cp "$d/$rel" "$keep/$rel" ;;
    esac
  done
  rm -rf "$d"
  mv "$keep" "$d"
done
for f in $VENDOR; do [ -f "$STAGE/node_modules/$f" ] || fail "vendor file $f is missing after pruning"; done
# Everywhere: source maps, type declarations, TypeScript sources (Node.js never strips types under node_modules, so none can be run from
# there), docs and tests (a licence file is always kept).
find "$STAGE/node_modules" -type d \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name example -o -name examples \
  -o -name .github \) -prune -exec rm -rf {} +
find "$STAGE/node_modules" -type f \( -name '*.map' -o -name '*.ts' -o -name '*.mts' -o -name '*.cts' -o -name '*.md' -o -name '*.markdown' \
  -o -name '*.test.js' -o -name '*.spec.js' \) \
  ! -iname 'license*' ! -iname 'licence*' -delete
# Type-only packages (a production dependency may list one; nothing imports them at run time), then the folders pruning left empty.
rm -rf "$STAGE/node_modules/@types"
find "$STAGE/node_modules" -type d -empty -delete

# Every module the server and the bridge import (and the one they import lazily) still loads, with the bundled Node.js.
mods=$(cat "$STAGE"/src/*.ts "$STAGE"/src/door/*.ts "$STAGE"/src/followups/*.ts "$STAGE"/assistant/*.ts | sed -n -e 's/.* from "\([^".][^"]*\)";$/\1/p' -e 's/.*await import("\([^".][^"]*\)").*/\1/p' \
  | grep -v '^node:' | sort -u)
[ -n "$mods" ] || fail "no imports found in the server"
for m in $mods; do
  (cd "$STAGE/src" && "$NODE_HOST" --input-type=module -e "await import('$m')") >"$WORK/import.log" 2>&1 \
    || { sed 's/^/    /' "$WORK/import.log" | tail -8; fail "the server's import of $m fails after pruning"; }
done
say "the server's modules all load: $(printf '%s' "$mods" | tr '\n' ' ')"

# Every file the server and the bridge import from one another (./x.ts, ../src/x.ts) is in the app: a missing one stops the bridge at start.
for f in "$STAGE"/src/*.ts "$STAGE"/src/door/*.ts "$STAGE"/src/followups/*.ts "$STAGE"/assistant/*.ts; do
  for rel in $(sed -n -e 's/.* from "\(\.[^"]*\.ts\)";$/\1/p' -e 's/.*import("\(\.[^"]*\.ts\)").*/\1/p' "$f" | sort -u); do
    [ -f "$(dirname "$f")/$rel" ] || fail "$(basename "$(dirname "$f")")/$(basename "$f") imports $rel, which is not in the app"
  done
done
say "every file the server and the bridge import is in the app"

# ---- Fail closed: nothing private, no secret, no foreign code ----
# A .env anywhere (src/local.ts reads one in the working folder, which is this one); the owner's private notes and state outside node_modules
# (where a package's own folder may be called "private").
bad=$(cd "$STAGE" && {
  find . \( -name '.env' -o -name '.env.*' -o -name '*.env.calls' -o -name .DS_Store \) ! -name .env.example -print
  find . -path ./node_modules -prune -o \( -name HANDOFF.md -o -name spec.md -o -name .pako -o -name .claude -o -name private -o -name data \
    -o -name fixtures -o -name '*.test.ts' \) -print
})
[ -z "$bad" ] || fail "files that must never ship are in the server:
$bad"
# Our own code (not node_modules) names no one's folder and holds nothing shaped like a token.
leak=$(grep -rlE '/Users/[A-Za-z]|sk-ant-[A-Za-z0-9_-]{20}|xox[abp]-[0-9]{6}|ghp_[A-Za-z0-9]{30}|AKIA[0-9A-Z]{16}' \
  "$STAGE/src" "$STAGE/assistant" "$STAGE/bin" "$STAGE/package.json" || true)
[ -z "$leak" ] || fail "a home folder path or something shaped like a token is in:
$leak"

mv "$STAGE" "$RES/pako"
# A release build carries no folder of the builder's (build.sh adds this key only to developer builds).
plutil -remove PakoRepoPath "$APP/Contents/Info.plist" >/dev/null 2>&1 || true

# Only two programs in the whole app: the app itself and node. Anything else would ship unsigned and fail notarization.
machos=$(cd "$APP/Contents" && find . -type f -print0 | xargs -0 file -h | grep 'Mach-O' | cut -d: -f1 | sed 's/ (for architecture .*//' | sort -u | tr '\n' ' ')
[ "$machos" = "./MacOS/Pako ./Resources/node/bin/node " ] || fail "unexpected programs in the app: $machos"

say "bundled Node.js $V ($(lipo -archs "$RES/node/bin/node")) and the server: node $(du -sh "$RES/node" | cut -f1), server $(du -sh "$RES/pako" | cut -f1)"
