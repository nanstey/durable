# Independent review: slices 3, 4b, 5, 6a, 6b

Scope: steward/API/containment (3), notifier (4b), scout/eligibility (5), dispatch adapters (6a), claims, work items, hold, attribution, guard and limits (6b), at `main` b4f6858. Reviewed against `docs/plan/specs/03`, `05`, `06` and their risk controls. Read-only review; no source was edited. The reviewer read the code directly (no helper agents; this reviewer is a leaf agent).

Verification performed: focused tests passed (`claims-pipeline`, `eligibility`, `scout`, `worker-guard`, `notifier`, `dispatch`, `work-safety`, `process-fallback`, `dispatcher`: 0 failures). Findings marked **[repro]** were reproduced with a throwaway script that was deleted afterwards. Passing tests do not cover any of the defects below.

Totals: **High 3 · Medium 5 · Low 9 · Spec gaps 5**.

## What is sound

- Hold fence is journalled synchronously (`procs.ts:71-87`) before the queued work (`workRuntime.ts:467-502`); `fencedDispatcher` (`dispatch/hold.ts`) and `ProcessManager.launch/host` re-check the fence at three points. Restart finishes `holding` fences before resume (`harness.ts:829-840`).
- Release is nonce-only: bearer credentials get 403 (`api/auth.ts`), nonces are item/epoch/action bound, hashed, single use and expire (`approval/nonce.ts`). `approvalNonce` bypasses persistence and non-nonce-safe channels.
- Tokens are hashed, compared in constant time, expire, and are scope-checked per route. Unmapped POSTs fail closed (403). Bearer auth means cross-site POSTs need a preflight.
- Local-file intake rejects symlink/`..` escape through `realpath`. `gh` writes go through the fenced, audited launcher with `-f` (not `-F`, so no `@file` reads).
- Claim arbitration is GitHub read-after-write with lowest-id wins, and the loser deletes its own comment.

## Findings

### High

**H1. Worker environment (GH_TOKEN and every profile secret) is put on the Orca command line. [repro]**
`src/dispatch/orca.ts:107-123` (`hostProcess`) builds `terminal create --command "env -i KEY=VALUE … pi"` from `spec.env`. `spec.env` is the full worker env from `buildAgentEnv` (`identity/env.ts:93-112`: GH_TOKEN, GITHUB_TOKEN, and `...secrets`, i.e. all keys in the profile secrets file). Stub-`orca` run printed `terminal create … --command 'env' '-i' 'GH_TOKEN=ghp_SECRET123' 'pi'`. Impact: the token is visible to any local user via `ps`/`/proc/<pid>/cmdline`, and is typed into the Orca terminal, so it lands in scrollback/history and `orca terminal read`. It contradicts the design in `dispatch/launcher.ts` and spec 06 ("Brief and launcher files contain no secrets (env supplies them)"; W1). The git-process adapter passes env through `execa env`, so only Orca is affected.
Fix: never serialise values into argv. Write the env to a `0600` file in the launcher dir, or have the gate read it from an inherited fd, or run `orca terminal create` with the env set on the `orca` process and a launcher that inherits it. Add a contract test that no `spec.env` value appears in any adapter argv.

**H2. Non-cgroup containment never removes finished invocation records, so the steward cannot restart and merged items get recovery fences. [repro]**
`procs.ts:384-389` deletes a finished record only when `this.backend.confirmed`. `ProcessContainment.confirmed` is `false` (all non-systemd platforms: Android/Termux, macOS, cgroup-v1 Linux). Probe: after one successful `launch(["true"])` the journal holds 1 record, and a fresh `ProcessManager.sweep()` returns `false` (`ProcessContainment.kill` always returns `false`, `processContainment.ts`). `steward/main.ts:170-184` then throws "recovery containment unconfirmed" for any retained record without an item (every steward-level `gh api` probe), so the daemon refuses to start after its first run. Separately, `finish()` → `processes.terminate({item})` (`workRuntime.ts:309`) hits `cleanup` → `false` → writes a `recovery` fence on the just-merged item (`procs.ts:172-176`).
Fix: delete a record when the child's `done` has resolved and the marker scan is empty, regardless of `confirmed`; use `confirmed` only to decide whether a hold may be acknowledged as `held`. Add a restart test with `ProcessContainment` (the existing `process-fallback` test does not restart after a completed launch).

**H3. The steward LLM sees untrusted issue titles, and its `request_work` tool re-runs human-cancelled work.**
(a) `harness.ts:241-248` `list_queue` returns the whole projected queue as JSON. `updateQueue` stores every candidate, including `skipped` untrusted-author issues, with `title`, `author` and `labels`. Spec 05 risk control and acceptance: "never placed in a prompt unless the author is trusted… an untrusted-author issue never reaches an LLM prompt". The steward has `pause` and `request_work`, so an injected title can steer them.
(b) `request_work` (`harness.ts:318-337`) calls `WorkRuntime.requestWork` (`workRuntime.ts:414-440`), which only refuses `held`, `paused`, `merged`, `cancelled`, `parked`. A `needs-human`/`limit` item whose attempt has `cancelledBy` (hard interrupt, `stop --workers`, claim lost) is reset to `dispatch`. Spec 06 item 3b and the lifecycle risk control: hard interrupt "is never retried automatically"; "intentional cancellation … never silently restarts work". The same function backs the human `POST /v1/items/:id/retry`, which is fine; the model-callable path is the issue.
Fix: return only `{ref, state, reasons, workItem}` (and titles only for eligible, trusted items) from `list_queue`; give the tool a separate path that refuses items with `cancelledBy` or outcome `needs-human`/`limit`. Add the spec's injection test against the tool output.

### Medium

**M1. Eligibility and trust are not re-checked after migration; trust is hard-coded.**
`harness.ts:503-535` creates a `steward.work-item` task for every non-terminal work item, whether or not the queue still marks it `eligible`. `WorkRuntime.progress` (`workRuntime.ts:97-130`) and `advanceWorkItem` never consult the queue. Trigger: an item is migrated, capacity (`maxConcurrentWorkers`) or quiet hours delay dispatch, the maintainer then adds an excluded label (e.g. `wontfix`), closes the issue or removes the required label; the item is still claimed and dispatched. `brief()` also calls `createScoutBrief(candidate, true, …)` (`workRuntime.ts:234`), so `trusted` is a constant rather than a re-evaluated property of the author, and the issue body is re-fetched at brief time (`readIntake`), not at eligibility time.
Fix: pass the current queue entry into `tickItem`; before `claim`, `dispatch` and `brief` require `state === "eligible"` from this tick's evaluation (otherwise park as `needs-human` with the reasons); compute `trusted` from `eligibility()` rather than passing `true`.

**M2. Any commenter can forge or block a claim; claim cleanup trusts comment ids.**
`claims.ts:58-96` accepts any comment whose body matches the marker regex; `ClaimComment` has no author, and `Github.listComments` (`github.ts:131-142`) keeps none. The lease is unbounded. Trigger: a user posts `<!-- durable-claim agent=x lease=2999-01-01T00:00:00Z -->` on a public issue before the agent claims; it has the lowest id, the agent loses, `claimItem` parks the item (`workItemTask.ts:68-71`). Copying a prior legitimate marker (agent and owner are public) makes `prior` match a foreign comment, then `updateComment` PATCHes it (403 or an edit of someone else's comment if the token has write access) and `finish()` may `deleteComment` that id (`workRuntime.ts:313-323`). Also a losing claim still adds `durable/agent:<agent>` to an issue it does not own (`github.ts` `addLabel`).
Fix: include `user.login` in `ClaimComment`, accept only comments by the profile login (or `author_association` ≥ COLLABORATOR), cap lease at `now + max lease`, and add the label only after winning.

**M3. Worker command guard is bypassable (spec labels it a guardrail; these are cheap, non-adversarial forms). [repro]**
`src/guard/commands.ts` regexes assume the verb directly follows `git`/`gh`:
- `git -C /w push --force origin x` → not blocked (probe `false`).
- `gh api graphql -f query='mutation{mergePullRequest(...)}'` → not blocked (`\bmerge\b` does not match `mergePullRequest`); `gh api repos/o/r/git/refs/heads/main -X PATCH …` (ref force-update) → not blocked.
- `gh pr --repo o/r merge 5`, `gh -R o/r pr merge 5` → not blocked.
The Pi extension uses only these regexes. The PATH shim (`bin/durable-worker-tool.ts`) additionally parses `git` options, but: its read/write audit classification only matches exact tokens (`-X`, `--method`, `-f`), so `--method=POST`, `-XPOST`, `-fk=v`, `--field=…` are logged as reads; `DURABLE_ITEM`, `DURABLE_AGENT`, `DURABLE_FENCE_FILE` come from the worker's own environment, so a worker can `export DURABLE_ITEM=other` to push to another item's branch or point the fence file at an empty journal and defeat `workerFenced()`; and `/usr/bin/gh` or `/usr/bin/git` skips the shim entirely while the worker holds GH_TOKEN. Branch protection is the real stop (spec 06), but the fence and audit claims in spec 06 item 12 overstate what the shim enforces.
Fix: parse argv instead of matching text (skip global options, resolve the subcommand, block any `gh api` with a mutating method or a GraphQL `mutation`), match `--opt=value` forms, derive `item`/`agent` from a root-owned file or from the gate's `DURABLE_INVOCATION` rather than caller-editable env, and say in `docs/workers.md` that the shim is advisory.

**M4. A failing notification channel prevents the work item state from being saved; the GitHub channel is unusable for work events.**
`workRuntime.ts:196-197`: `await o.notify("escalation", item.id)` runs before `this.store.save(state)`. `Notifier.send` rethrows anything but `ENOENT` (`notify/notifier.ts:260-262`), so a command channel that exits non-zero or times out aborts `monitor`; `tickItem` swallows the error (`workRuntime.ts:87-93`) and the `needs-human` outcome and attempt end are never persisted; the item retries the same path every tick. The `github` channel is also wired with `target: item.id` (`workerSetup.ts:153`), but `deliverGithub` runs `gh issue comment <target>` with the **ambient** environment (no profile env) and an item id is not an issue ref, so it always fails.
Fix: save state before notifying and treat notifier errors as non-fatal (audit them); give notifications a real issue/PR URL as `target`; run `gh` with the profile env or drop the channel for work events.

**M5. Quiet-hour holds and reminders are never delivered (slice 4b).**
`Notifier.due()` (`notifier.ts:128-150`) is the only code that releases `held` and `reminders` entries. No production code calls it (`grep` finds only tests). Events raised in quiet hours, which includes `escalation` from `hold()` and `budget-stop`, are saved in `steward.notify.json` and then stay there; configured reminder policies never fire.
Fix: call `notifier.due()` from the steward loop tick (and on `notify`), and add a loop-level test.

### Low

**L1. git-process adapter can kill a foreign process group after PID reuse.** `gitProcess.ts:111-122` `interruptProcess` signals `-<pid>` from the stored pid file with no start-time check; `processStatus` (`:104-111`) reports `running` for any live pid. After a worker exits (or a reboot, since the handle is persisted in work-items state), a reused pid gets `SIGKILL` on hard interrupt or hold. `procs.ts` records `startTime`; use it. Related: the log `.durable-<id>.log` is created inside the worktree (`:78`), so `git add -A` can commit worker output, and it makes `assertRemovableWorkspace` report the tree as dirty.

**L2. Phantom attempts consume concurrency slots.** `dispatchItem` pushes the attempt before `workers.launch` (`workItemTask.ts:107-118`); if launch throws (fence, identity check), the attempt stays open. `capacity()` subtracts only the current item's pending intent (`workRuntime.ts:339-346`), so with `maxConcurrentWorkers: 1` one persistently failing item blocks every other item until `itemMinutes` expires.

**L3. Hold overwrites prior outcome and release can re-dispatch without a claim.** `hold()` sets `work.outcome = "held"` (`workRuntime.ts:478`); `release()` → `resetForAttempt` deletes the outcome and, with no PR, sets `phase: "dispatch"`. An item that was `parked` because it lost the claim (`workItemTask.ts:68-71`) is then dispatched on an issue another agent owns. Restore the previous outcome or re-enter at `claim`.

**L4. Hold drain runs inside the serial work queue.** `workRuntime.ts:485-487` sleeps `drainMs` (10 s) in `enqueue`, stalling every other item's tick, retries and interrupts; startup recovery (`harness.ts:829-840`) does the same per held item.

**L5. Steward-level launches share one containment slice.** `procs.ts:323-326` hashes `agent:steward:steward` for every item-less call, and `systemdContainment.kill` signals the whole slice. An identity-probe timeout or `terminate({task})` kills unrelated concurrent `gh` calls, and `empty()` on a shared slice keeps unrelated records in the journal.

**L6. Release route edge cases.** `POST /v1/items/:id/release` with a malformed or `null` body throws in `c.req.json()`/`value.code` and returns 500 (`routes.ts`) before the nonce check runs. Release is also accepted while the hold is still `holding` (containment unconfirmed), so the nonce flow does not prove `held`; spec 06 says release re-derives state after the human has confirmed. Consider requiring `state === "held"` or an explicit `verified` flag.

**L7. Token store takes a no-retry sync lock on every request.** `api/tokens.ts:16-27` uses `lockSync` (no retries) and rewrites `tokens.json` for `lastUsedAt` on each authenticated request. A concurrent `durable token create/revoke` from the CLI makes the API return 500 (`ELOCKED`). Retry with a short backoff and throttle `lastUsedAt` writes.

**L8. Non-draft worker PR stalls silently.** `attributePr` throws for non-draft PRs (`github.ts` `attributePr`), which `tickItem` swallows with only an `audit` line; there is no escalation or outcome. The shim forces `--draft`, but a shim bypass (M3) lands here.

**L9. Worker brief template substitution mangles `$` sequences. [repro]** `scout/brief.ts:25-30` uses `replaceAll(string, string)`, which interprets `$&`, `` $` `` and `$'` in the replacement; probe `"cost $& and $' end"` produced `cost {{brief}} and y end`. Use a function replacer. Substitution is also sequential, so brief text containing `{{branch}}` is rewritten.

### Spec gaps (claimed done, not delivered or unwired)

- **G1 (spec 05 items 6, 8).** `scout/judge.ts` `applyJudgment` has no production caller (only `test/unit/scout.test.ts`); the tick in `harness.ts:497-535` never calls a judge, so the "demote-only judge" and `models.judge` for eligibility do nothing. (`models.judge` is only used as the scout-conversation model, `harness.ts:757`.)
- **G2 (spec 05 item 5).** `eligibility()` supports `claimed`, `blockedAuthors`, `attempts`, `size`, `updatedBefore`, but the tick passes only `trustedAuthors`, `requiredLabels`, `excludedLabels`, `maxAttempts`, `maxSize`, `maxAgeMs` (`harness.ts:501-513`), and no source sets `candidate.attempts`. "Not blocked/claimed; attempts left" is therefore not enforced at queue time; only the later claim race and `monitorWorker` limits apply. With no `requiredLabels` and no `trustedAuthors`, every open issue by an OWNER/MEMBER/COLLABORATOR is eligible and auto-dispatched; consider making a required label mandatory for write-capable agents.
- **G3 (spec 05 risk controls).** No backoff with jitter on source polling; `GitHubIssuesSource` returns `[]` inside its minimum interval, which with `pollSeconds: 30` skips roughly every other tick. NaN `updatedAt` also passes age checks (`eligibility.ts:48-55`).
- **G4 (spec 06 items 5b, 11).** `WorkAttempt.cost` (`workItems.ts:17`) is never written; `limits.dailyDollars`/`dailyTokens` count only steward model usage (`harness.ts:392-394`), not worker spend. `maxConcurrentWorkers`/`maxWorkersPerDay` default to unlimited when unset.
- **G5 (spec 06 item 9 acceptance).** Guard tests cover the table only; no test exercises option-interleaved forms (M3), shim-level push/PR rewriting with `--opt=value`, or restart with the non-cgroup backend (H2).

## Remediation status

| Finding | Status | Regression coverage |
| --- | --- | --- |
| H2 | Fixed | `test/contract/process-fallback.test.ts` |
| M4 | Fixed | Work state is persisted before notification; notification errors are audited. |
| M5 | Fixed | Steward loop invokes `Notifier.due()` through production wiring. |
| G1 | Fixed | Scout queue evaluation calls `applyJudgment` when `models.judge` is configured. |
| G2 | Fixed | Queue evaluation supplies claim, block-list, attempt, size and age eligibility inputs. |
| G3 | Fixed | Invalid source timestamps are ineligible; GitHub issue polls use capped exponential backoff with jitter after failures and reset after success. `scout.test.ts`. |
| G4 | Fixed | Worker result costs are persisted on attempts and added to the steward budget. |
| L2 | Fixed | Failed worker launches close their attempt before rethrowing. |
| L3-L8 | Not fixed | Outside this remediation slice. |

## Suggested order

1. H1 (token in argv), H2 (restart on non-cgroup), H3 (queue-to-prompt and `request_work`).
2. M1, M2, M4, M5, M3.
3. Low and gap items as follow-ups; G1/G2 need a decision (wire the judge or remove it from the spec and docs).
