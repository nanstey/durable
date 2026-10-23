# Slice 3 coordinator handoff

## State

Implementation is complete enough for coordinator review, not merge-ready.
The user requested an early wrap-up and a local commit, without more exhaustive
validation. No push, PR creation or merge has been performed by this worker.

- Branch: `slice-3r-steward`; base: `5804f22` (latest fetched main).
- Source: 4,427 TypeScript lines under `src/`.
- Final suite: 339 tests passed, zero skipped locally; includes 19 live-systemd
  cases and real SIGKILL/descendant-cleanup tests.
- Final TypeScript, Biome formatting, hygiene and diff-whitespace checks passed.
- Full `pnpm check` passed before the final launch-cancellation / identity-probe
  deadline fixes. It has **not** been rerun after those fixes.

## Implemented

Native pi-durable 1.4.0 adapter with SQLite/JSONL, persistent main conversation and
loop, profile model runtime, budget/inbox/chat documents, idempotent submissions,
Hono API/SSE, hashed scoped tokens, credential screening using the spike corpus,
conversation tree from ownership index/task graph, pause/resume boundaries,
ServiceManager/user units, and citty CLI commands.

Containment has a token-gated handshake, fsynced pre-open journal, stale sweep,
recursive cgroup population checks, recovery fences, and process-group/marker
fallback with explicit unconfirmed status. Late review found and fixed a race:
cleanup could remove an intent while its active launch continued toward release.
Active launches are now cancelled before cleanup and rechecked before spawn and
release; six boundary-specific regression tests pass. Read-only identity probes
also have a contained deadline, with a dedicated regression test.

## Evidence

- [Every numbered spec item](docs/evidence/slice-3.md), including partial item 15.
- [Executed addendum prerequisites and go/no-go limits](docs/evidence/spike-durable-workers.md).
- The real transient user-service faux-identity drill passed curl device/SSE/
  transcript/inbox, read-token 403, SIGKILL restart, old-tool removal, pause and
  pseudo-TTY CLI resume. It preceded the last cancellation/deadline fixes; the
  final native containment/recovery suite passed after them.
- 1/2/4 busy asynchronous child probe: p95 2.47/2.35/2.32 ms, p99
  3.30/2.58/2.52 ms, 15-second heartbeat lateness 12.38/2.53/2.39 ms.
- No operator credentials or GitHub writes were used in runtime probes.

## Coordinator next steps

1. Run final `pnpm check`; assess the latest cancellation/deadline changes and
   decide whether the existing focused/full-suite evidence needs another drill.
2. Dispatch independent source/security/outcome review. This leaf worker cannot
   run the coordinated review workflow; it does not claim an independent packet.
3. Inspect identity startup, cancellation/record-deletion interleavings, gate fd
   handling, fallback limits, token scopes/revocation, and schema/API compatibility.
4. Real-profile enablement and the operator's API-fit judgment remain unexecuted
   (spec 03 item 15). The faux service drill does not satisfy that checkpoint.
5. Push, create the PR, wait for CI, then squash-merge only after required gates.
   User authorization to ship exists; no remote shipping mutation has occurred.

## Scope limits

Worker kinds/dispatch and hold/release APIs belong to Slice 6; `stop --workers`
explicitly refuses rather than silently stopping the daemon. Chat/scout creation
is currently an in-process adapter operation; external creation belongs to Slice
4. Failure notification remains the spec's inert unit hook. No transcript pruning,
OS sandbox, Android hardware validation, approval bearer scope or tailnet listener
is claimed. Existing `doctor` complexity remains a follow-up; new callbacks are
within the measured review band. Group/marker cleanup cannot prove exclusive
ownership, and separate invocation scopes may survive until startup sweep after
a crash.
