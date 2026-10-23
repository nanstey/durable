# Independent review: slices 7 and 7b

Scope: PRs #32, #34, #36 (`src/gate/**`, approval, nonce, CLI/API, reviewer wiring) and #37 (connectors), at main `d759fe1`. Reviewed against specs 07 and 07b, architecture D6/D8, invariants A1-A4, and the defect classes in `review-slices-3-6b.md` and `review-slice-6c.md`. The reviewer was an Anthropic-family model and the code authors were OpenAI-family. This was a read-only source review: no source was edited, and the only scratch script lives in `/tmp`.

Focused tests: `node --experimental-strip-types --test test/unit/gate.test.ts test/unit/gate-review.test.ts test/unit/connectors.test.ts test/contract/work-flow.test.ts` gave 23 passed, 0 failed. Passing tests do not cover most findings below, because the relevant paths have no tests.

## Verdict

No path was found where a bearer token, console request or worker can approve. `/v1/approvals/*` rejects any `Authorization` or `X-Durable-Token` header (`src/api/auth.ts:34-52`), and the nonce is delivered over a nonce-safe desktop or command channel only (stdin for `command`, `src/notify/channels/command.ts`). Nothing merges, since `decide` returns `merge` only for a verified policy, and no policy source exists. Several correctness gaps exist, though.

- The runtime gate decision is made from hard-coded facts, not GitHub facts.
- The only approval nonce expires after 5 minutes and is never reissued.
- The reviewer-family check fails open for identity-less entries.
- The connector budget and audit controls have holes.

Counts: **High 3, Medium 8, Low 8.**

## High

**H1. The gate runs on fabricated facts; `collectFacts` is never called in production.** `src/steward/workRuntime.ts:371-385`.
- `reviewAndGate` calls `decide(...)` with a literal object: `draft:false, mergeClean:true, reviewRequired:false, checksPassed:true, paths:[], hardPath:false, crossFamilyReview:true, dailyCapAvailable:true, coolingOffElapsed:true, killSwitchOff:true`.
- `grep collectFacts src` outside `src/gate` finds nothing.
- Trigger A: a PR touching `.github/workflows/**` or `CODEOWNERS` is still moved to ready-for-review, mirrored, and issued an approval nonce with reason `human-approval-required`. The hard-path rule (spec item 2, G12) never fires, and the persisted gate reason is wrong.
- Trigger B: a repo with `REVIEW_REQUIRED` never reports `github-requires-approval-from-other-account`.
- Trigger C: failing checks and a dirty merge state are never read.
- Today `noPolicy` makes everything `wait-human`, so there is no merge. But `slice-7.md` marks items 1, 2 and 8 "Implemented", and the fixture tests only exercise the pure functions. When spec 09 enables `auto-when-safe`, this becomes a fail-open gate with no compile-time warning.
- Fix: call `collectFacts(pr, sha)` in `reviewAndGate`. Fill `crossFamilyReview` and `riskAcceptable` from `item.review`. A `null` read must yield `wait-human`. Add a test that a `.github/` PR yields `policy-or-owner-file-change`.

**H2. Approval is dead after 5 minutes and has no reissue path.** `src/approval/nonce.ts:36` has a fixed TTL of 5 min. `workRuntime.ts:392-408` issues the nonce once and sets `gate.notified = true`.
- There is no `approve/request` route, unlike `POST /v1/items/:id/release/request` (`routes.ts:330`).
- Reminders (`notifier.due`) are nonce-free.
- Trigger: the operator is away for more than 5 minutes, which is the normal case for a human-approval wait. `durable approve --code` then answers 403 for that SHA forever. The only exits are a human merge or a new head commit.
- This breaks spec resolution path (c). `slice-7.md` marks item 5 "Implemented" without a live run (spec item 9 is not evidenced).
- Fix: add `POST /v1/gate/:item/approve/request`, which issues and delivers a fresh nonce for the current SHA, the same shape as release. Wire it to a `durable approve --request` flag.

**H3. The same-family check fails open for entries without provider or model.** `src/gate/review.ts:150-157`.
- An entry is judged by `entry.family ?? familyFor({provider: entry.provider, model: entry.model ?? ""})`.
- A PoC in `/tmp` showed `familyFor({provider: undefined, model: ""})` returns `""`, which is not the producer's family, so the entry counts as independent.
- Trigger: a Pi-session log assistant line that lacks `provider`/`model`, or a fallback or aborted message with a different shape, passes the check. This is the "fallback can change family" class the spec calls out.
- Also, `provenance` (`review.ts:158-166`) records the configured `reviewerModel`, not the observed entries. The spec requires provenance from the session log or durable entries, and the recorded value could be false.
- Fix: treat any entry with no resolvable provider, model or family as refusal (fail closed). Record the first observed `{provider, model, family}` and require all entries to match the configured reviewer family.

## Medium

**M1. Mode `never`, hard-path and review-failed outcomes still get an approval task and nonce.** `workRuntime.ts:386-408`. State is `waiting-approval` for every non-`block` decision, so `merge-disabled-by-definition` and `human-approval-required` look identical. Spec item 6 says `never` stops at ready-for-review with no approval task. `approveGate` (`:668`) does not check `gate.state === "waiting-approval"` or the decision action. Fix: derive the state from `decision.reasons`, and skip the nonce unless the mode is `human-approval`.

**M2. `readyPr` uses REST `PATCH {draft:false}`.** `src/steward/github.ts:271-278`. As far as I know, the REST update-PR endpoint does not support converting draft to ready. That needs GraphQL `markPullRequestReadyForReview` or `gh pr ready`. No live check is evidenced (spec item 9). If this is right, the PR stays draft while the gate reports `draft:false`. Fix: use `gh pr ready` or GraphQL, and add a post-read assertion.

**M3. Review failure is permanent, silent and unretried.** `workRuntime.ts:344-352`.
- Any exception (transient timeout, `workers.get` miss after restart, malformed result, same-family entry) writes `item.review = {failed}` and `gate = wait-human/review-failed`.
- The spec says same-family means "verdict refused and the review re-run". Here the SHA is never retried.
- No notification is sent, so the operator learns nothing. The gate state is neither visible nor actionable.
- Fix: bounded re-run (for example 2 attempts) keyed by SHA, then `needs-human` with an escalation notify.

**M4. Verdicts `changes` and `blocked` do nothing.** `workRuntime.ts:359-366`. The gate parks `wait-human/review-requested-changes`, but spec item 5 requires a requeue to the worker with the review text. The PR stays draft and the item is stuck. Also, a `high` risk `approve` still yields `waiting-approval` plus a nonce in human-approval mode. `slice-7.md` does not claim requeue, but it also does not list it as a gap.

**M5. The Pi-session reviewer's result file is in the repository checkout and predictable.** `workRuntime.ts:313` uses `join(checkout, ".durable-review-<id>.json")`, where `<id>` includes the item and 12 characters of the SHA. Spec item 3 requires a steward-provided file outside the checkout.
- The producer worker shares the OS user, and the guard is not a sandbox (`durable-worker-guard.ts`). A producer or other process can pre-write or replace the file.
- `collectReview` reads it without checking that the reviewer wrote it. A forged `approve` passes whenever the reviewer's transcript is merely opposite-family.
- It also pollutes the operator's checkout, and nothing removes it.
- Fix: write to a `0700` per-attempt directory under the agent state directory, and delete the file after collection.

**M6. Stale-SHA window and approval not re-verified at approval time.**
- `approveGate` (`workRuntime.ts:668-690`) and the route (`routes.ts:233-270`) bind to the *stored* `gate.sha`, not the live head. A push between ticks lets an approval land as `approved` for the old SHA. The next tick's `reconcilePrs` deletes the gate, which is safe today.
- Spec item 5(c) wants the steward to re-check at attempt time. `approveGate` does not call `readPr`.
- `item.gate ??=` (`:386`) also never replaces a gate whose SHA differs from the reviewed SHA. It relies entirely on `reconcilePrs`.
- This is a hard requirement for spec 09. Fix: `approveGate` reads the PR, and a head mismatch returns a conflict (409).

**M7. Connector budgets are in-memory, post-hoc and race-prone.** `src/connectors/mediation.ts:19-20,61-69,84-90`.
- The call and cost Maps reset on every steward restart, so the budget is trivially refreshed.
- The check runs before `await provider.invoke` and the increment runs after it. Parallel tool calls (the durable anchor allows concurrent tools) all pass the check, so a `maxCalls:1` write can fire N times.
- A failed or throwing call (`catch`, line 107) does not count. A write that succeeded at the provider but then threw (for example the post-hoc cost check at line 84) is audited as `failed` and not counted, so retries repeat the write.
- Spec item 6 requires "restart/reconciliation tests make no duplicate write call". There is no such test.
- Fix: reserve the budget before invoking and settle after. Persist the counters in agent state. Count attempted writes.

**M8. Connector denials are not audited, and there is no timeout.**
- Kill-switch, allowlist, write, budget and unavailability throws (`mediation.ts:35-66`) happen before the first `audit`. Spec item 6 says write an audit event before and after *every* call.
- The failure audit lacks `profile`, `connection` and `inputBytes`.
- No timeout exists in the mediator. `tools.ts:~180` passes `ctx.abortSignal ?? new AbortController().signal`, which never aborts, so a hung provider hangs the worker tool. The tests cover only a pre-aborted signal.
- Fix: audit the denial reason, apply `AbortSignal.timeout`, and add tests.

## Low

- **L1. Hard-path blind spots.** `facts.ts:84-99`, `hardPaths.ts`.
  - `gh pr view --json files` is capped (the GraphQL default is 100 files), so a PR above that cap may hide a `.github/` file. It is not detected as truncated; `additions`/`deletions` are requested but unused.
  - A rename away from `.github/CODEOWNERS` reports only the new path.
  - Protected locations match exactly, with no directory or glob support.
  - Fix: treat `files.length >= 100` or a mismatched changed-file count as `hardPath:null`, and include the previous path.
- **L2. Tighten-only is untested at the edge and unused.** `decide` ignores `maxChangedLines`, `maxFiles`, `authors`, `pathAllow/pathDeny`, `methods`, `baseBranches` and `policy.maxRisk`; no facts exist for them. `tighten()` can return `[]` from an empty intersection, and the semantics of an empty list are undefined. When spec 09 lands, ensure an empty list means "none allowed".
- **L3. The mirror comment and status are weak.**
  - The comment body (`workRuntime.ts:399`) is a static string ("Head SHA | current") with no SHA, verdict, risk or reasons, contrary to spec item 4.
  - Any user can post the marker `<!-- durable-gate sha=... -->` and suppress Durable's comment, since `mirrorGate` checks only `includes(marker)`; `listComments` pagination was not verified.
  - `durable/review` is posted as `success` ("Durable review complete") even though the human has not approved. If a repo lists it as a required check, it can satisfy branch protection.
  - Fix: post `pending` until human approval.
- **L4. Restart mid-approval.** `gate.notified = true` is saved only at the end of the tick (`workRuntime.ts:408` then `:259`). A crash between `notifyApproval`, `issueApproval` and the save repeats the notification and replaces the nonce (`nonce.ts:48` overwrites the key), so the first desktop nonce stops working. Fix: persist `notified` before delivery, or make delivery idempotent. No restart test exists, though spec item 5 lists one.
- **L5. Resolution paths (a) and (b) are not implemented.** There is no "merged by human" record, only `reconcilePrs` setting `outcome=merged`. There is no approving-review-from-another-account re-run, no `merge.approvers` review request, and no `docs/operator.md` approval-flow section. Spec items 0 (spec gate), 6 and 10 are absent. `slice-7.md` omits item 0, items 9 and 10, and the unimplemented parts of items 5 and 6.
- **L6. Producer family is taken from config.** `producer: models.worker` (`workRuntime.ts:~305`) is the configured model, not the observed producer entries. A producer fallback to the reviewer's family is not detected. The reviewer's own cost is not recorded through `recordCost` (the durable anchor's `account` covers durable reviewers only).
- **L7. Connector hardening gaps.**
  - The tool-level `maxCalls ?? connector.maxCalls` override can exceed the connector ceiling. The doctor budget check inspects the connector value only if the tool values are unset, and an absent budget passes as `0`/unlimited.
  - Budgets are per item, not per agent, so total spend is items x max.
  - There is no input schema or target validation (`Type.Unknown()`).
  - The output cap slices characters, not bytes, so up to ~400 KB can pass.
  - The doctor has no missing-credential or custody check (only `fake` exists).
  - `read`/`write` classification comes from the same definition that the fake provider echoes, so the reclassification test is tautological for a real provider.
  - Wrapper names `connector_${connector.id}_${tool.id}` can collide (`a_b`+`c` vs `a`+`b_c`) and are not checked by the doctor.
- **L8. `durable approve` and nonce-route minor points.** `POST /v1/approvals/nonce` is unauthenticated by design (the nonce is the credential). It has no attempt limit or lockout, so wrong codes within the TTL are not counted. The notifier title reads "Durable release approval" for gate approvals (`notifier.ts:154`). There is no test for the route, the CLI, `approveGate`, the bearer rejection on approval routes (only release, `work-flow.test.ts:371`), or the grep-for-nonce-leak acceptance.

## Checked and found sound

- Nonce: random 192-bit value, stored as `sha256([code, agent, action, item, binding])`, compared with `timingSafeEqual`, action- and item-bound, consumed on success (`src/approval/nonce.ts`). Single use holds: load, check and save are synchronous, so there is no TOCTOU within the daemon. Expiry is checked, and a SHA change changes the key.
- `approve` and `release` nonces are rejected for each other (`work-flow.test.ts:433-441` for the release route).
- The CLI refuses without a TTY unless `DURABLE_NONINTERACTIVE_OK=1`. The nonce is never persisted, the gate state holds none, and delivery is stdin or a desktop notification.
- `decide` is pure, and an unknown or null fact never yields `merge`. The property test passes, and `tighten` never enables auto.
- The durable reviewer toolset is limited to read, search, `pr_diff` and `report_verdict`, so connector tools are excluded for reviewers (`anchor.ts:601`). `report_verdict` requires role `reviewer`, a matching head SHA, one verdict, and non-same-family first and subsequent entries. `pr_diff` is SHA-pinned before and after fetch (`gitops.ts` `prDiff`).
- Connector tool calls go through the `beforeTool` fence and budget hook (`anchor.ts:379`), so a held or stopped item blocks connector calls. Provider tokens are not inherited, because `buildAgentEnv` uses an allowlist and strips `COMPOSIO_|MCP_|CONNECTOR_` from profile secrets. Results are labelled untrusted and are not consumed by the gate.

## Evidence-doc claims versus code

| Claim | Status |
| --- | --- |
| slice-7 items 1-2 "Implemented" | Pure functions only; not wired (H1). |
| slice-7 item 5 "Approval task" with nonce-only endpoint | Endpoint exists; no test; nonce expires in 5 min with no reissue (H2). |
| slice-7 items 6-7 "Type-check" evidence | There is no behavioural test, and the REST ready transition is doubtful (M2). |
| slice-7 item 8 "Required reviews" | The reason string exists in `decide`, but the runtime hard-codes `reviewRequired:false` (H1). |
| slice-7b item 6 "Limits, stop and audit" | Budgets are not persisted or race-safe, no timeout, denials unaudited (M7, M8). |
| slice-7b item 3 "Profile-bound credentials" | Only the env scrub is real; no provider consumes credentials yet (fake only). Honest, but the two-profile test is absent. |
| slice-7b items 4-5, 7 | Hold for durable workers with the fake provider; the Pi bridge is correctly marked pending. |

## Resolution status

| Finding | Status | Evidence |
| --- | --- | --- |
| H1 | fixed | `workRuntime.ts` collects GitHub facts before deciding. |
| H2 | fixed | `POST /v1/gate/:item/approve/request` reissues an active gate nonce; `durable approve --request` invokes it. |
| H3 | fixed | Missing observed assistant provenance now refuses the review; regression in `gate-review.test.ts`. |
| M1 | fixed | Only `human-approval-required` creates a waiting approval gate or nonce. |
| M6 | fixed | Approval requires an active gate and a matching live PR head SHA. |
| M2-M5, M7-M8, L1-L8 | not fixed | Not addressed in this focused remediation. |

## Top fixes in order

1. Wire `collectFacts` into the gate (H1).
2. Add an approval-nonce reissue request route (H2).
3. Fail closed on identity-less entries and record observed provenance (H3).
4. Re-verify the live head and gate state at `approveGate` (M6, M1).
5. Persist and reserve connector budgets, add timeouts, audit denials (M7, M8).
