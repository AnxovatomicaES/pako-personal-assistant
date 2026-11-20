#!/bin/sh
# Runs a command with a temporary folder of its own (TMPDIR), removed afterwards whatever the result. The tests make throwaway folders with
# mkdtemp and many leave them: on 2026-11-20 about 127,000 of them had filled the disk. Usage: sh bin/with-tmp.sh <command> [args…]
root=$(mktemp -d "${TMPDIR:-/tmp}/pako-run.XXXXXX") || exit 1
trap 'rm -rf "$root"' EXIT INT TERM
TMPDIR="$root/" "$@"
