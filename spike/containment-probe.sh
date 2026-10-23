#!/usr/bin/env bash
# Throwaway containment capability probe; uses only a temporary directory.
set -euo pipefail
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
printf 'bwrap='; bwrap --version
bwrap --ro-bind / / --bind "$work" /tmp --tmpfs /home --unshare-pid --die-with-parent \
  -- bash --noprofile --norc -c 'test -w /tmp && test -d /home && test -z "$(ls -A /home)" && echo bwrap-worktree-rw-home-tmpfs'
unit="durable-spike-$RANDOM.scope"
systemd-run --user --scope --unit="$unit" --slice=durable-spike.slice --quiet \
  bash -lc 'sleep 30 & wait' &
launcher=$!
sleep 1
systemctl --user kill --kill-who=all "$unit"
wait "$launcher" || true
systemctl --user show --property=ControlGroup --value "$unit" 2>/dev/null || true
printf 'scope-kill-issued=true\n'
