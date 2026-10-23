#!/usr/bin/env bash
# Spike (throwaway): exact driver for the AuthStorage symlink test (evidence row 4). FABRICATED credentials only.
# Run inside a temp dir that has pi-coding-agent 1.4.0 installed and a copy of spike/auth-symlink.ts:
#   bash auth-symlink-concurrency.sh [N]      (default N=200)
# Expected counters: 5 sequential bumps + N via the canonical path + N via the symlinked path = 2N+5 per file.
set -euo pipefail
N="${1:-200}"
R="$(mktemp -d)/sym"
node auth-symlink.ts setup "$R"
echo "== sequential: 5 bumps through each symlink"
node auth-symlink.ts bump "$R/derived/auth-profiles/work.json" 5   # directory symlink
node auth-symlink.ts bump "$R/derived/auth.json" 5                 # file symlink
node auth-symlink.ts report "$R"
echo "== concurrent: $N bumps via canonical path + $N via symlinked path, for each file (4 processes)"
node auth-symlink.ts bump "$R/canonical/auth-profiles/work.json" "$N" &
node auth-symlink.ts bump "$R/derived/auth-profiles/work.json" "$N" &
node auth-symlink.ts bump "$R/canonical/auth.json" "$N" &
node auth-symlink.ts bump "$R/derived/auth.json" "$N" &
wait
echo "expected counter per file: $((2 * N + 5))"
node auth-symlink.ts report "$R"
rm -rf "$(dirname "$R")"
