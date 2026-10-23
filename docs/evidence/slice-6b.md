# Slice 6b integration evidence

## Initial audit

The merged foundations are helpers, not an end-to-end dispatcher. This table records the gaps before integration.

| Spec | Existing building block | Integration gap |
| --- | --- | --- |
| 5 | `steward/claims.ts` | No runtime GitHub adapter; replay duplicates comments; expired leases participate. |
| 5b | `steward/workItems.ts`, `pipeline/select.ts` | Loop never migrates queue or reconciles PRs; selected stages are not enforced at dispatch. |
| 6 | `steward/workItemTask.ts` | Never called by harness; no durable task state, restart handles, or await-PR progression. |
| 7 | `scout/brief.ts`, template | Unused; brief phase does not scout or persist output. |
| 8 | `dispatch/launcher.ts`, `workers/piSession.ts` | No containment handshake for hosted jobs; resume omits continue; generated settings omit guard. |
| 9 | guard extension and shared patterns | Extension uses the wrong Pi event; no hold check; drift test does not prove registration. |
| 10 | `dispatch/monitor.ts` | Unused; resumes are neither counted nor registered; secondary PR can complete item. |
| 11 | `steward/limits.ts` | Worker caps, wall time, pause/kill and worker-only stop are not wired. |
| 12 | identity environment and brief footer | No audited runtime GitHub writer or worker-tool attribution. |
| 12b | `dispatch/hold.ts`, process journal | No routes, nonce, CLI, durable hold sequence or release integration. |
| 12c | dispatcher `openViewer` | No CLI/API entry point. |
| 13 | worker/operator docs | Integration instructions and fake end-to-end evidence missing; live pilots pending operator. |

## Validation

All automated GitHub tests use fakes; no live issue or PR writes are part of the test path. Live Orca/git-process issue-to-draft-PR pilots, TUI terminal input, viewer rendering, machine load and steward crash drills: **pending operator**.

## Completed integration

| Spec | Implementation | Executed evidence |
| --- | --- | --- |
| 5 | `steward/github.ts`, `claims.ts`: injectable audited GitHub, lease expiry/renewal, read-after-write election, loser cleanup, replay-safe claim ownership | `claims-pipeline.test.ts`, `work-replay.test.ts`, `work-safety.test.ts` |
| 5b | `harness.ts`, `workItems.ts`, `pipeline/select.ts`: eligible-only migration, derived queue, stable identity, primary-PR reconciliation, mandatory stage/gate refusal | Queue, pipeline, replay and end-to-end tests |
| 6 | Native loop-owned `steward.work-item` task in `harness.ts`; committed phase/attempt intents in `workItemTask.ts`, `workRuntime.ts`; production wiring in `workerSetup.ts` | Phase effect-before-commit replay, fresh-registry restart, no duplicate workspace/claim/job |
| 7 | Trusted-author read-only child conversation, bounded scout wait, local/GitHub intake reads, assembled autopilot brief | Real faux-model child conversation, brief snapshot, local symlink refusal |
| 8 | `piSession.ts`, `launcher.ts`, `procs.ts`, `durable-host-gate`: private derived Pi directory, separate provider/model flags, continue, stdin and file-backed gate inside containment | Dispatcher contracts; hosted-gate fault injection; real Linux delayed/background/nohup/setsid writers absent 15 seconds after held |
| 9 | Actual Pi `tool_call` handler, persisted-fence check, shared command table, generated settings | Policy drift/holding/held tests and real offline Pi extension loader |
| 10 | Native task calls `monitor.ts`; rehydrates handles, counts and registers continuation attempts; cancellation never auto-retries; one escalation/comment | End-to-end PR discovery, bounded continuation, soft stop and restart tests |
| 11 | Concurrent/daily launch caps, item wall clock, quiet-hours dispatch refusal, running-worker pause/kill, guarded TTY resume, worker-only stop | Cap+1, daily rollover, limit, disabled-file, quiet-hours, resume, worker-stop and lifecycle tests |
| 12 | Profile git author/committer env; supported git/gh shims enforce trailer, own branch, draft, label, marker/footer; fenced/audited daemon GitHub writes | Fake CLI argv/identity/audit assertions; fake GitHub end-to-end draft PR |
| 12b | Synchronous pre-effect process-journal fence, drain/containment confirmation, restart handling, item routes, CLI and console Hold; nonce-only release; foreign-terminal advisory in workers/doctor | Scope matrix; single-use, expiry, agent/action/item/epoch binding; Linux failure and Android advisory fixtures; held restart; live Linux containment test |
| 12c | `durable open`, read-scoped conversation-open API, `openViewer` and command fallback | Stub-Orca list/create ordering and fallback API tests |
| 13 | `workers.md`, `operator.md`, `api.md`, this evidence | Automated evidence complete; live issue-to-PR pilots **pending operator** |

### Implementation decisions

- Fences remain in the existing fsync-backed process journal (`procs.json`'s `holds` record), loaded before `Harness.open`, rather than adding a second competing fence writer. Work-item lifecycle and phase documents live in native storage.
- Pi-durable refuses background child tasks. Work-item tasks are children of the already-background steward loop and inherit its lifecycle boundary. Scout conversations are transactionally owned by the work-item task.
- Claim markers optionally include an opaque persisted steward UID. This distinguishes two installations of the same agent while retaining restart idempotency and accepting older markers for arbitration.
- Orca cannot pass extra pipe descriptors to hosted terminals. Its launcher uses a private file-backed gate with atomic identity/release publication and the same intent/registered/releasing/running journal states as directly spawned invocations.
- Pi-session guardrails and supported CLI shims are not an OS sandbox. A same-user worker that deliberately bypasses them can bypass their audit/attribution; repository rules and token permissions remain the boundary.

### Checks

- Frozen dependency installation succeeded.
- 284 focused tests across 22 affected unit/contract files passed; four hosted-gate tests also passed (288 unique local tests). Focused reruns are not counted twice. The exhaustive suite is left to CI.
- The real Linux hosted containment check passed, including descendants that leave their process group; no GitHub access was involved.
- `pnpm pack` includes the worker template, repository guard, hosted gate and worker CLI shims.
- `pnpm check` and `pnpm hygiene` passed. Biome reports advisory warnings, not errors; Fallow reports no unused code or duplication.
- Complexity measurement drove extraction of phase, monitor, dependency and production-wiring helpers. No changed function remains in the refactor band; longer wiring functions remain review notes.
- Independent cross-family source review is not claimed: this implementation session is a leaf worker and cannot dispatch reviewers.
