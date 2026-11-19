#!/bin/sh
# The local gate (GitHub Actions do not run for this repo): both type checks and every test. Used by .githooks/pre-push and bin/nightly-gate.sh.
set -e
# No GIT_* setting from a hook reaches the tests (they run git in throwaway repositories of their own).
for v in $(env | sed -n 's/^\(GIT_[A-Z_]*\)=.*/\1/p'); do unset "$v"; done
cd "$(dirname "$0")/.."
npx tsc --noEmit -p .
npx tsc --noEmit -p voice-worker
npm test
