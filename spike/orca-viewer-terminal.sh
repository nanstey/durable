#!/usr/bin/env bash
# Throwaway Orca viewer-terminal probe. Run from a registered worktree.
# It records no paths, credentials, host names, or terminal handles.
set -euo pipefail
orca-ide status --json >/dev/null
unrelated_pid=""
cleanup() {
  [ -n "$unrelated_pid" ] && kill "$unrelated_pid" 2>/dev/null || true
}
trap cleanup EXIT
sleep 60 & unrelated_pid=$!
created=$(orca-ide terminal create --worktree "path:$PWD" --title durable-spike-viewer \
  --command "bash -lc 'tput smcup; clear; printf \"DURABLE VIEWER READY\\ninput> \"; read line; printf \"received:%s\\n\" \"\$line\"; sleep 20'" --json)
handle=$(printf '%s' "$created" | jq -r '.result.terminal.handle')
sleep 2
orca-ide terminal list --worktree "path:$PWD" --json
orca-ide terminal read --terminal "$handle" --screen --json
orca-ide terminal send --terminal "$handle" --text viewer-input --enter --json
sleep 1
orca-ide terminal read --terminal "$handle" --screen --json
orca-ide terminal close --terminal "$handle" --json
kill -0 "$unrelated_pid"
printf 'unrelated_background_alive=true\n'
