# Steward daemon

The steward owns one pi-durable store and one loopback API per assigned agent.
It does not dispatch workers or write to GitHub. Start with
[profiles and doctor](operator.md), then run:

```sh
durable doctor <agent>
durable enable <agent> --dry-run
durable enable <agent>
durable status <agent>
durable logs <agent>
```

`enable` installs the user units and enables the agent immediately. It refuses
unassigned agents and failed identity checks. `disable` disables and stops the
service; `stop` stops it without disabling it. `start` starts an installed unit.
`durable run <agent>` and `durable steward run <agent>` run in the foreground.
Service commands accept `--dry-run` without installing anything.

For operation after logout, run `loginctl enable-linger` on the machine. The CLI
must be linked at `~/.local/bin/durable`; the unit uses that stable symlink rather
than an installation-specific checkout path. It explicitly sets
`KillMode=control-group`, `Restart=on-failure`, `RestartSec=12`,
`TimeoutStopSec=30`, and `NoNewPrivileges=yes`. Only a non-default `DURABLE_HOME`
is rendered into the unit. The failure unit is an inert `/usr/bin/true` hook;
notification delivery belongs to the notifier slice.

## State and recovery

State lives in `$DURABLE_HOME/agents/<agent>/`. Native SQLite storage is selected
when `node:sqlite` is available (`state.sqlite`); otherwise pi-durable's JSONL
storage uses `state.jsonl/`. There is no native addon. One renewable lock excludes
other stewards. A crashed owner's lock expires after ten seconds; the unit's
restart delay exceeds that interval.

The main conversation, opaque conversation IDs, loop task, heartbeat, budgets,
chat counters, inbox and submission receipts survive reopen. Shutdown closes the
harness without writing cancellation outcomes. Crash recovery gives an
interrupted non-replay-safe tool an error result rather than silently replaying
its side effects. Completed transcript entries are retained, not pruned.

Every code-owned invocation has an fsynced intent in `procs.json`. A Node gate
waits on fd 3 for its exact random release token. The steward registers its PID,
start time and containment identity, commits `releasing`, then releases it.
EOF, invalid input, descriptor errors and timeout exit 97 without running the
target. Tokens and command environments are not stored in this journal.

On cgroup-v2 Linux, a transient user scope runs inside a per-attempt slice.
Termination sends TERM, waits five seconds, sends KILL, then checks the slice's
recursive `cgroup.events` population. An empty slice `cgroup.procs` is not proof:
its descendants live in child scopes. Scope creation failure refuses the command.
On every start, all journal states, including `intent`, are swept **before** the
harness opens. Failed cleanup retains records, installs a recovery fence and
queues an escalation; startup refuses to resume anything. Existing hold fences
are loaded before scheduling. Hold/release APIs and worker outcomes belong to
the dispatcher slice.

Without cgroup v2, process groups and per-invocation environment markers provide
best-effort cleanup. Marker removal can escape it. Records are retained and
exclusive ownership is never confirmed; stop the affected runtime or reboot
before editing. This is not a sandbox, on either platform.

## Pause and budgets

`durable pause <agent>` calls the scoped API. The per-agent `disabled` file,
`$DURABLE_HOME/disabled`, and `DURABLE_DISABLED=1` also disable action. Quiet hours
use `HH:MM-HH:MM [UTC|local]` (local time by default; overnight windows supported).
Paused ticks leave the heartbeat unchanged. The provider boundary and every tool
call also check safety, including pending work recovered after a crash.

`durable resume <agent>` requires a local TTY and removes only the agent's file.
Global/environment switches and quiet hours still apply. No bearer token can
resume an agent. Resume is audited. Nonces and passkeys are not implemented here.

Daily model budgets default to `limits.dailyDollars: 10` and
`limits.dailyTokens: 1000000`; either can be lowered to zero. Usage is committed
after model responses and rolls over at UTC midnight on a tick. An in-flight
response can overshoot a cap; the next request/tool is blocked. The inbox records
pause and budget-stop transitions. Identity failures occurring before a harness
can open are durably queued and transferred, with ID de-duplication, on the next
healthy start.

See [API v1](api.md) and [executed evidence](evidence/slice-3.md).
