#!/usr/bin/env bash
# Spike (throwaway): Orca terminal create -> send -> read -> close round trip.
# Usage: spike/orca-steer.sh <worktree-selector>   (e.g. path:<checkout>)
# Creates ONE throwaway terminal running `cat`, injects a line, reads it back, closes the terminal.
set -euo pipefail
ORCA="${ORCA_CLI_COMMAND:-orca-ide}"
WT="${1:?worktree selector, e.g. path:<checkout>}"
created=$("$ORCA" terminal create --worktree "$WT" --title "durable-spike-steer" --command "cat" --json)
handle=$(printf '%s' "$created" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.result.terminal.handle)})')
echo "created handle: ${handle:0:9}…"
trap '"$ORCA" terminal close --terminal "$handle" --tab --json >/dev/null && echo "closed"' EXIT
sleep 2
before=$("$ORCA" terminal read --terminal "$handle" --json)
cursor=$(printf '%s' "$before" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.result.terminal.nextCursor??0)})')
"$ORCA" terminal send --terminal "$handle" --text "steer-probe-42" --enter --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("send ok:",j.ok,"keys:",Object.keys(j.result??{}).join(","))})'
sleep 1
"$ORCA" terminal read --terminal "$handle" --cursor "$cursor" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.result.terminal;console.log("read ok:",j.ok,"source:",r.source,"tail:",JSON.stringify(r.tail).slice(0,200))})'
"$ORCA" terminal send --terminal "$handle" --interrupt --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("interrupt ok:",j.ok)})'
