# Slice 1 addendum: durable workers

Date: 2026-10-23. Spec: [01-feasibility-spike](../plan/specs/01-feasibility-spike.md).
The Slice 3 replacement executes the previously missing prerequisite probes.
No operator credentials, real model requests or GitHub writes are involved.
**Executed** means a command/test ran; **documented, not executed** is not proof.
See the [Slice 3 execution matrix](slice-3.md) for implementation coverage.

## Claims → results → go/no-go

| Item | Result and retained probe | Decision |
| --- | --- | --- |
| Orca viewer terminal | **Executed, partial (original addendum).** `spike/orca-viewer-terminal.sh`: full-screen probe accepted injected text, screen reads showed its output, closing the terminal left independent work running. Requested title was not reflected; resize was not exercised. | No-go for relying on automatic viewer behavior. Keep the command-string fallback. |
| 1. Worktree confinement | **Documented, not executed.** Host execution environments are not filesystem sandboxes. The Slice 3 steward has no shell/file tools; child worktree file-tool escape tests belong to the durable-worker implementation. | No-go as a security boundary. Does not block the narrow steward. |
| 2. Background cancellation | **Executed.** `test/contract/ownership.test.ts`: main abort preserves a background-owned child; node abort ends only its turn; explicit anchor-task abort crosses the boundary and writes a terminal receipt; `abort({background:true})` stops all owned work; a kill switch changed during generation blocks the tool. `recovery.test.ts` verifies resumable crash behavior. | Go for the native cancellation primitives and steward wiring. Worker-specific outcome/lifecycle tests remain required in 6c. |
| 3. Crash recovery and re-attach | **Executed.** `test/contract/recovery.test.ts` kills a process during an unsafe tool in an owned child, then sweeps containment before reopening. The resumed model observes `interrupted`; the same child completes, one loop remains, heartbeat/tokens/inbox survive, and the old tool PID is absent. | Go for interrupted-child recovery and ownership re-attachment. No live GitHub worker/PR was tested. |
| 4. Concurrency responsiveness | **Executed.** `node spike/steward-load.ts`: real loopback HTTP/SSE with 1, 2 and 4 concurrent faux-model child tools. Results below include a real 15-second ping for each run. | Go for the asynchronous-tool baseline: p95 <250 ms, p99 <1 s, ping lateness <2 s. Not a CPU-heavy worker benchmark. |
| 5. Transcript retention | **Executed export/read, not pruning.** SQLite and JSONL reopen tests retain committed entries; API transcript tests read native history. No pruning/deletion policy is implemented or tested. | Go for retention/read. No-go for pruning; non-blocking. |
| 6. Container/bubblewrap hardening | **Executed, candidate only (original addendum).** `spike/containment-probe.sh` exercised bubblewrap 0.12.0 with read-only root, writable temporary bind and a user scope. It did not run a worker/package workload or the escape matrix. | No-go as a deployed sandbox; hardening remains deferred. |
| 7. Skill prompt | **Documented, not executed.** No allowlisted skill body was given to a child model. | Keep the durable-worker skill allowlist empty. Non-blocking. |
| 8. Child model auth | **Executed, fabricated profile.** `test/contract/profile-child.test.ts` opens a temporary profile through `createModelsFor`/`ModelRuntime`, registers a faux provider, creates an owned scout and verifies provider/model provenance on its assistant entry. The profile remains byte-identical. Original spike evidence separately covers live provider reuse. | Go for inherited profile-runtime selection. This does not claim a new live OAuth refresh or Anthropic request. |
| 9. Tree enumeration | **Executed.** The real adapter uses `taskGraph`, paginated conversation scans and `scanConversations({ownerTaskId})`, including terminal task owners. Nested ownership, parent IDs, scout/chat kinds, opaque IDs and tree SSE deltas are tested in `ownership.test.ts` and `stream-service.test.ts`. | Go for the Slice 3 native tree. Dispatcher leaves remain Slice 6 work. |
| 10. Process containment | **Executed.** `containment.test.ts`: real transient user scopes; both sides of intent/spawn/registered/releasing/token-write/running/delete/kill SIGKILL boundaries; startup sweep; EOF/descriptor-error/empty/wrong/oversized/timeout gate refusal; recursive `populated` fixture; cleanup-failure fences/escalation; scope-creation refusal. A background sleep, nohup grandchild and setsid delayed writer are terminated; after 15 seconds the writer file is unchanged. `process-fallback.test.ts` executes marker cleanup and demonstrates an unmarked setsid escape remains unconfirmed. A reused-PID fixture is not signalled. | Go for cgroup-v2 Linux containment and fail-closed recovery. Explicit no-go for claiming exclusive ownership using the group/marker fallback. |

## Executed responsiveness baseline

Run with `node spike/steward-load.ts`. Child tools wait asynchronously; no model
network traffic or CPU-bound compiler workload is simulated.

| Busy children | HTTP samples | Tree API p95 | Tree API p99 | 15 s ping lateness |
| --- | --- | --- | --- | --- |
| 1 | 558 | 2.47 ms | 3.30 ms | 12.38 ms |
| 2 | 560 | 2.35 ms | 2.58 ms | 2.53 ms |
| 4 | 560 | 2.32 ms | 2.52 ms | 2.39 ms |

## Decision

**Go for spec 03's tree and Linux containment implementation.** The native
cancellation, child recovery, profile-runtime inheritance and asynchronous load
prerequisites have executed evidence. **This is not approval to enable durable
workers:** 6c still needs its real worker tool set, file escape/known-limit tests,
code-owned writes, worker lifecycle outcomes, retention policy and pilot. Keep
Pi-session workers as the planned default.

The real-user-service drill uses the production process entry with injected faux
model/identity dependencies. It validates curl reads, SSE ordering, read-token
403, SIGKILL restart, old-tool cleanup, pause and a pseudo-TTY CLI resume. It does
not replace the operator's real-profile deployment/fit checkpoint.
