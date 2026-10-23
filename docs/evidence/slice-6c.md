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

## Independent review fixes

An independent Anthropic-family review of `b7d9e93` returned three findings. The
coordinator requested these fixes and authorized publication and merge after CI.

| Finding | Fix | Regression test |
| --- | --- | --- |
| F1 high: dangling-symlink write escape | `confine.ts` treats only `lstat` ENOENT as an absent file. Failed symlink target resolution now rejects the path. | Relative, absolute and chained dangling links cannot create an outside file through write/edit; ordinary new files still work. |
| F2 medium: forged commit trailer | `gitops.ts` rejects model-supplied `Durable-Agent` lines at the start or after LF/CR/CRLF, case-insensitively. | All variants, including whitespace around the key, reject before any Git invocation. |
| F3 low: unbounded search reads | `tools.ts` caps each search read at 1 MiB, including files that grow after `stat`, and skips NUL-containing or invalid UTF-8 files. | Oversized and binary matches are omitted while ordinary UTF-8 text remains searchable. |

## Executed local checks

- `pnpm install --frozen-lockfile`
- `pnpm check`, `pnpm hygiene`, and `git diff --check`: passed.
- `node --test --test-timeout=30000 test/unit/durable-worker.test.ts test/unit/durable-config.test.ts test/contract/durable-gitops.test.ts test/contract/durable-known-limits.test.ts test/contract/durable-worker.test.ts`: **31 passed** after the review fixes.
- Focused regression files: `worker-kinds`, `worker-guard`, `work-item-dispatch`, `work-safety`, `work-replay`, `claims-pipeline`, `scout`, `work-flow`, `ownership`, `model-config`, `pause-race`, `loop`: **77 passed**, including all ten selection rows.
- **108 focused tests total**, no skipped tests. The exhaustive suite is left to CI, per contributor rules.
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

## Items 6–9 recovery and policy

| Spec item | Implementation | Executed evidence |
| --- | --- | --- |
| 6 | `workers/durable/playbook.ts` is appended to every durable worker instruction. It requires inspection of git status, files, branch and PR state before retrying an `interrupted` non-replay-safe call. The existing ownership index reattaches the same child after the steward reopens. | Faux-model `close during native bash` restarts with one child and records the native `interrupted` tool result; the instruction snapshot includes the recovery playbook. |
| 7 | `workers/durable/skills.ts` reads only named `skills/<name>/SKILL.md` files under the generated Pi directory, caps each at 32 KiB, and rejects subagent, codemode and helper-script workflows. The durable child still configures only its code-owned extension/tool list. | Allowlisted body inlining, empty default, traversal rejection and runtime-workflow denial tests pass. |
| 8 | `NativeDurableAnchor` counts unreported, non-terminal durable children inside its storage transaction and refuses starts past `maxConcurrent`. `steward/harness.ts` supplies definition value or Linux default 2 / Android default 1. | Faux-model cap test starts two children and rejects the third with `capacity_exceeded`. |
| 9 | The steward opens the harness model runtime through `createModelsFor(resolveProfile(def.profile), providersOf(def))`; child configuration selects its declared provider/model from that profile-scoped runtime. The plain model-auth implementation rejects Anthropic OAuth shaping; doctor reports it unsupported until the explicit `modelAuth` implementation option exists. | Existing model-auth and doctor contracts cover profile provider selection and OAuth refusal; durable child capability reports `anthropicOAuth: modelAuth-option`. |

## Items 10–12 tree, reviewer, and operator documentation

| Spec item | Implementation | Executed evidence |
| --- | --- | --- |
| 10 | Native child metadata records `worker-durable` or `reviewer-durable`; both appear below the steward in the shared tree. The typed `/open` path uses `durable attach <agent>/<conversation>`. `workers.durable.viewer: on-start` asks the dispatcher to open the viewer and retains the command fallback. | Focused faux-model tree contract verifies a reviewer leaf below the steward; dispatcher contracts cover Orca terminal creation and command fallback. |
| 11 | Durable reviewers expose only read, search, `pr_diff`, and `report_verdict`. The final verdict validates its shape, reviewed SHA, single-call rule, and opposite model family; it stores kind-neutral `ReviewResult` plus durable-entry `ModelProvenance`. | Faux model plus fake GitHub diff records a `changes` verdict with provenance. The exposed-tool snapshot has no shell or write tool; malformed/wrong-SHA/same-family calls are refused by the code-owned tool. |
| 12 | `docs/workers.md` now documents kinds, roles, capabilities, viewer behavior, lifecycle, limits, Pi-session-only workflows, and the advisory guardrail boundary with known limits. | Documentation reviewed alongside the focused contracts. |

## Pending operator validation

The live pilot remains **pending operator**: run one low-risk issue with each
kind on the same repository, kill the steward mid-run, hold and release, and
compare results. No live GitHub writes, provider requests, or operator
credentials were used here.

The full five-minute responsiveness benchmark also remains **pending operator**.
The Linux cgroup/`setsid` SIGKILL matrix is retained as a validation boundary:
existing containment contracts cover the gated launch and cleanup path, but the
faux process fixture is not a Linux cgroup probe.
