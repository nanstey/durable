# Slice 6c: items 1–5

## Gap audit recorded before implementation

| Item | Foundation on entry | Missing implementation |
| --- | --- | --- |
| 1 | Capability class and selection helper | Register the native kind in production dispatch; exercise the kind contract. |
| 2 | Memory-only anchor | Native background ownership, transactional child configuration, persisted reattachment. |
| 3 | Standalone file/bash helpers | Actual fixed native tools, search, containment, before-tool checks, escape and known-limit tests. |
| 4 | Intent/reconcile helpers only | Injectable commit/push/draft-PR/report, durable operation storage, concurrent reconciliation, hardened git. |
| 5 | Pure limit predicate only | Tool reservations, usage accounting, supervisor cancellation, lifecycle and restart fences. |

## Implemented coverage

| Spec item | Implementation | Executed evidence |
| --- | --- | --- |
| 1 | `steward/harness.ts` installs `NativeDurableAnchor` and registers `DurableConversationKind` in the production kind registry. Existing `workers/select.ts` precedence and enablement remain unchanged. | All ten selection truth-table rows; native capability/tool snapshots; unsupported reviewer start returns `not_supported`/501. Pi-session remains the Linux default. |
| 2 | `workers/durable/anchor.ts` creates `run-worker`, its owned conversation, model/cwd/fixed tools, and the persistent attempt record in one native transaction. Reattachment validates `scanConversations({ownerTaskId})`. No memory anchor remains. | Main and loop abort preserve the worker; repeated start/reopen reuses its child; legacy loop-owned work items are rehomed before native dispatch. Native task graph verifies the owner chain. |
| 3 | `workers/durable/tools.ts`, `confine.ts`, `operation.ts`: read/search/edit/write/bash, credential screening, realpath and `.git` rejection; bash uses `durable-shell` and the attempt's `ProcessManager.launch` containment. Shared command guard runs before tool execution. | Absolute/traversal/symlink/`.git` escapes refused; guarded commands refused; real shell `env` omits hostile parent credentials and profile secrets; known-limit tests demonstrate interpreter, script and credential-file access outside the worktree, including a direct local-remote push. |
| 4 | `workers/durable/gitops.ts`: manifest identity/trailer commits, fixed-SHA fast-forward push, draft PR lookup/create and report. Intents are native documents committed before writes. In-flight locks return the same intent; persisted ambiguous operations reconcile on a fresh instance. | Fake GitHub plus real local bare remote: lost push/PR responses, intervening branch conflicts, concurrent retries, wrong-SHA/non-draft PR refusal, hostile hooks/helpers/config/filters, retry ancestry from the pushed SHA. |
| 5 | `workers/durable/limits.ts` and native hooks/supervisor: atomic tool reservations, turn and conversation-token budgets, agent usage charging, wall-clock/hold/kill checks. `WorkRuntime` persists terminal reasons and cancellation ownership; hard/hold/pause/stop cross the background boundary and terminate containment. | Abort/soft interrupt wait for follow-up; hard/hold/pause/disabled/stop/time/tool/turn/token stops survive reopen; no route or steer restarts them before retry/release/TTY-resume. Parallel tools cannot exceed the call budget. Close during bash returns interrupted on reopen without a terminal attempt outcome; SIGKILL while idle preserves the same child and owner. |

## Native API mapping

Pi-durable 1.4.0 rejects `background: true` on task-owned children with
`A child task cannot be background`. The conversation-owned `WorkItemTask` is
therefore the native background boundary; `run-worker` is its owned child, and
transactionally owns/configures the worker conversation. The loop maintains the
item-owner index, not that native owner edge. Main/chat/loop aborts preserve work;
explicit cancellation still targets `run-worker`. Existing loop-owned work items
are rehomed; stale supervisors retire without redispatching.

Code-owned commits use attempt-isolated steward-owned Git directories, staging
from the workspace without loading its Git configuration. The workspace's original
Git index is not used or rewritten. The committed SHA, not its index or HEAD, is
the authoritative push/PR input. A new attempt observes the remote durable branch
and seeds its commit ancestry from that SHA. The definition's base is used for PRs.
No worktree hook, credential helper, URL rewrite, fsmonitor or filter executes.

Execution-only async context carries cancellation and attempt identity into every
code-owned Git/GitHub subprocess, including read/reconcile calls. It contains no
ownership authority; the native transaction/index remains authoritative. A turn
abort kills in-flight subprocesses and rejects follow-on launches. Per-provider
session model dispatch enforces budgets because upstream `beforeRequest` hooks
are advisory, not a cancellation API.

## Executed local checks

- `pnpm install --frozen-lockfile`
- `pnpm check`, `pnpm hygiene`, and `git diff --check`: passed.
- `node --test --test-timeout=30000 test/unit/durable-worker.test.ts test/unit/durable-config.test.ts test/contract/durable-gitops.test.ts test/contract/durable-known-limits.test.ts test/contract/durable-worker.test.ts`: **28 passed**.
- Focused regression files: `worker-kinds`, `worker-guard`, `work-item-dispatch`, `work-safety`, `work-replay`, `claims-pipeline`, `scout`, `work-flow`, `ownership`, `model-config`, `pause-race`, `loop`: **77 passed**, including all ten selection rows.
- **105 focused tests total**, no skipped tests. The exhaustive suite is left to CI, per contributor rules.
- Complexity measurement: `confinedPath` reduced from CCN 16 to below the review threshold; `WorkRuntime.progress` reduced from CCN 16 to 14 after integrating the latest dispatch safety fixes; cancellation reduced from CCN 16 to 12. Remaining flagged functions are in the review band, not the refactor band.

## Validation boundaries

The new contracts use a faux model, fake workspace dispatcher and fake GitHub with
real local Git commits and bare-remote pushes. Their process fixture records
cancellation and runs real subprocesses; it is **not** a Linux cgroup probe.
Existing slice 3 containment/recovery contracts remain the evidence for the gated
launch, startup sweep and platform-specific cleanup. The SIGKILL lifecycle test
kills an idle worker with no subprocess; the full mid-bash/setsid recovery matrix
belongs to item 6.

The shell runs as the operator's OS user: guardrails are **not a sandbox**. The
fixed file tools check their paths; interpreters and scripts can access files the
OS user can access, including credential files. Shell credentials are omitted,
not made inaccessible. Code-owned GitHub tools are the supported path, not an
enforced one. Sandbox hardening remains deferred.

Items 6–12 are not completed or enabled by this PR: recovery playbook/full crash
matrix, skills runtime, concurrency/storage policy and load benchmark, model-auth
policy, viewer integration, reviewer verdicts, operator docs and live pilot.
Reviewer launch explicitly refuses rather than exposing write tools. No live
GitHub writes, provider requests or operator credentials were used. Independent
source review requires a coordinator; this worker does not claim one.
