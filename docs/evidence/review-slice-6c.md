# Independent review: slice 6c (PRs #22, #26, #28, #30)

Scope: `src/workers/durable/**`, `src/workers/durableConversation.ts`, the durable wiring in `steward/harness.ts` and `steward/workerSetup.ts`, against `docs/plan/specs/06c-durable-conversation-workers.md`, `docs/evidence/slice-6c.md` and the defect classes in `docs/evidence/review-slices-3-6b.md`, at `main` 4e51746. Read-only review; no source edited. Reviewer is Anthropic-family, the code is OpenAI-family. Leaf agent, no helpers.

Verified: `node --test` on `durable-worker`, `durable-config`, `durable-skills` (unit) and `durable-gitops`, `durable-known-limits`, `durable-worker` (contract): **36 pass, 0 fail**. A throwaway guard probe (`/tmp`, deleted) showed the shared command guard now blocks `git -C . push`, `gh -R o/r pr merge`, `--method=PATCH`, GraphQL `mutation` and `env git push`; it still allows `sh -c 'git push'`, `g=git; $g push` and `(cd /tmp && ls)` (documented advisory limits). Passing tests do not cover the defects below.

Totals: **High 2 · Medium 6 · Low 8**.

## What is sound

- File tools: `confinedPath` (`confine.ts:17-39`) rejects absolute paths, `..`, symlinked parents, `.git`, and dangling/chained symlink finals; read/edit/write all go through it.
- `durable-shell` env (`identity/env.ts:46-112`) is a whitelist (PATH/LANG/TERM/TZ/LC_*), no secrets, scratch HOME, `/dev/null` system gitconfig. Code-owned git uses a fixed `<sha>:refs/heads/durable/<agent>/<item>` refspec, no `+`, an explicit URL, the token only in that invocation's env via a credential helper, and `-c core.hooksPath=/dev/null -c core.fsmonitor=false` (`gitops.ts:259-401`). Default-branch or force push is not reachable through the tools. The `Durable-Agent` trailer is steward-appended and model-supplied trailer lines are rejected (`gitops.ts:340-345`).
- Lifecycle: tool reservation is atomic inside one harness commit (`anchor.ts:313-334`); `beforeRequest` plus the model-proxy `allowsRequest` gate (`harness.ts:782`) stop turns; `assertSubmission` blocks steer/follow-up after a terminal outcome (`harness.ts:1128-1133`); outcome uses `??=` so the first terminal reason wins.
- Replay safety: `read`, `search`, `pr_diff` are `replay: "safe"`; `write`, `edit`, `bash`, `commit`, `push_branch`, `open_draft_pr`, `report`, `report_verdict` default to non-safe, so an interrupted call returns `interrupted` and git ops reconcile from the persisted intent (`gitops.ts:30-40,111-170`).
- Reviewer tool set is filtered by role at configuration (`anchor.ts:575-582`) and each reviewer tool re-checks `job.role`; a worker cannot call `report_verdict` (role check, `anchor.ts:301`).

## High

**H1. The durable reviewer is unreachable in production; the evidence and `docs/workers.md` describe it as delivered.**
`WorkRuntime`/`WorkItemTask` only ever build `role: "worker"` jobs (`workRuntime.ts:441`, `workItemTask.ts:121`). Nothing outside `anchor.ts` sets `JobSpec.reviewedHeadSha` or `reviewedFamily` (`grep` over `src/`: only `anchor.ts` and `kind.ts`), and `NativeAnchorOptions.prDiff` is never supplied by `harness.ts:645-684` or `workerSetup.ts:138-152`, so `pr_diff` always throws "review diff source is unavailable" (`anchor.ts:289`). The only caller of the reviewer path is the faux contract test, which injects its own `prDiff`. Impact: spec item 11 ("reviewer is the first role enabled", "an opposite-family model resolvable before launch or launch is refused") and `slice-6c.md` row 11 are not true outside the test; the launch-time opposite-family refusal cannot fire because the family inputs are never populated.
Fix: wire a reviewer dispatch (PR head SHA from GitHub, `familyFor(models.worker)`), supply `prDiff` from `WorkerGithubCli` pinned to `reviewedHeadSha`, or state in the evidence that item 11 is library-only and track the wiring.

**H2. A worker that ends without calling `report` never terminates, polls forever and pins a concurrency slot.**
`run-worker`'s `watch` phase (`anchor.ts:137-179`) only completes on `record.outcome`, `reported` or `review`; otherwise it re-sleeps 100 ms. `afterResponse` (`anchor.ts:376-388`) marks `failed` only for reviewers. Trigger: the model finishes with a text-only message after (or instead of) `report` (very common). The conversation idles, `find()` still reports `running` (`anchor.ts:477-484`), `WorkItemTask` never sees an outcome, and the record counts as active in the cap check (`anchor.ts:540-542`). The only exits are `itemMinutes`/`maxTurns` (both optional) or an operator action. With the Linux default `maxConcurrent` of 2, two such workers refuse every later start. The 100 ms wake also commits to storage ten times a second per idle worker.
Fix: treat a text-only assistant turn with no pending follow-up as `failed`/`needs-human` for workers too (as is done for reviewers), and back off the watch interval (for example 1-5 s).

## Medium

**M1. A second commit in the same attempt is never pushed, and the retry silently reports success then kills the worker.**
`GitOperations.run` persists one intent per `(attemptId, op)` with `commitSha: head(job)` taken on the first call (`gitops.ts:121-135`, key at `anchor.ts:~108`). Trigger: `commit` → `push_branch` → fix → `commit` → `push_branch`. The second push re-reads the old intent, `reconcilePush` sees remote == old `commitSha` and returns `confirmed`; commit 2 is never pushed and the model is told it was. Then `open_draft_pr` creates its own intent at commit 2, finds remote ≠ commit 2, writes `conflict` and `conflict()` stops the worker `interrupted` (`gitops.ts:159-168`, `anchor.ts:~122`). A normal "push, then address a problem" flow ends in a stopped attempt.
Fix: refresh the intent when `git.head(job)` differs from a confirmed intent's `commitSha` (new intent, `expectedRemoteHead` = old sha), and make `report` check that the PR head equals the current local head.

**M2. Anthropic OAuth opt-in is enforced only in `doctor`, not at launch.**
`createModelsFor(..., "plain")` (`identity/modelAuth.ts:5-23`) never inspects credential type; it opens the profile `authFile`, and the child's `ProviderDoc`/model runtime then uses whatever the profile holds, including an Anthropic OAuth login. Only `doctor.ts:405-430` flags it. Spec item 9: "Anthropic OAuth only when the `modelAuth` option is on ... Acceptance: doctor and launch tests". No launch test or refusal exists (`harness.ts:715`, `anchor.ts:create`).
Fix: in `create`, refuse when `providerFor(job.model)` is `anthropic` and the stored credential is `oauth`, unless the option is set; add the launch test.

**M3. Reviewer provenance and the independence check do not come from child assistant entries.**
Spec item 11 and `slice-6c.md` row 11 say provenance is "taken from the child conversation's assistant entries". `report_verdict` builds it from `job.model` (the configured model) and `entries: record.turns` (`anchor.ts:303-316`); family is `familyFor(job.model)`. A fallback or provider substitution inside pi-durable would be recorded as the configured model, and the "same-family assistant entry -> refuse and rerun" case cannot happen. `afterResponse` already sees each message; record `message.provider/model` per turn and check every one.

**M4. Reviewer acceptance cases are untested although the evidence implies they are.**
`test/contract/durable-worker.test.ts:193-252` covers only a valid verdict and the tool snapshot. Missing: malformed verdict, wrong head SHA, same-family refusal, second `report_verdict` call, no verdict -> `failed`, `pr_diff` behaviour. `slice-6c.md` row 11 says malformed/wrong-SHA/same-family calls "are refused by the code-owned tool"; the code does (`anchor.ts:301-310`), but nothing executes it.

**M5. A completed reviewer keeps its concurrency slot forever.**
`create()` counts records with `!outcome && reported === undefined` (`anchor.ts:540-542`). `report_verdict` sets `review` and neither of those, so each finished reviewer stays "active". Two finished reviews at the default cap of 2 refuse every later start (`capacity_exceeded`). Latent until H1 is wired; fix the predicate to also exclude `record.review`. (The doc also grows without bound; item 8's retention/prune is not implemented.)

**M6. Skill workflow screening is a bypassable substring test.**
`skills.ts:6` `/\b(?:subagent|codemode|helper scripts?)\b/i` does not match `subagents` (no word boundary before `s`), `sub-agent`, `code mode`, or "run `scripts/foo.sh`". A skill that orchestrates subagents (spec: reject) passes and is inlined. Also `skills/<name>/SKILL.md` may itself be a symlink and is read without the realpath containment used for worker files (`skills.ts:9-23`; the directory is steward-owned, so risk is low). Fix: match `subagents?`, `sub-agents?`, `code[- ]?mode`, `scripts?/`, and test the plural.

## Low

- **L1. One `gh-XXXX` temp dir leaked per bash call.** `shellEnv` is called per call (`anchor.ts:196`) and `buildAgentEnv` does `mkdtempSync(join(home, "gh-"))` for shells (`identity/env.ts:63`); nothing removes them. Unbounded growth under a busy loop (the spec's load test). Use a stable per-item dir.
- **L2. `bash` has no per-call timeout and buffers all output.** `durableBash` (`tools.ts:123-140`) waits until exit; a hung `sleep`/blocking read is stopped only by an optional `itemMinutes`. Full stdout/stderr is held before the 100 KB slice. Add a per-call timeout and output cap.
- **L3. The "hash-checked config" is a tautology.** `prepare` writes the steward config then hashes the file it just wrote (`gitops.ts:290-300`); no later check runs between `prepare` and the push. Real protection is the explicit URL and the `-c` overrides, so impact is low; either hash-check immediately before the network call or drop the claim.
- **L4. `pr_diff` is not bound to `reviewedHeadSha`.** `anchor.ts:289` calls `prDiff(job)` and the verdict later matches only the SHA the model echoes; a moved PR head yields a diff for a different commit than the one approved.
- **L5. `report` does not check that the latest commit is the one in the confirmed PR** (see M1), and its summary is screened but the model-controlled commit message and PR title are not (`open_draft_pr` title, `gitops.ts:148-160`). PR body embeds the issue brief verbatim.
- **L6. Capacity refusal is an error, not a queue.** `capacity_exceeded` throws from `create`; `dispatchItem` ends the attempt and rethrows (`workItemTask.ts:151-155`), `tickItem` swallows it silently, so each tick can add an attempt and count toward `maxWorkersPerDay`. Spec: "queued or refused" is satisfied, but no audit/diagnostic is emitted.
- **L7. Generic failure text.** An empty commit (nothing to add) surfaces as `code-owned git operation failed` (`gitops.ts:276`) with no hint, which tempts the model to retry via bash.
- **L8. `read` loads whole files before slicing to 100 KB** (`tools.ts:44-48`); a very large or FIFO file in the worktree can stall or bloat the steward process.

## Remediation status

| Finding | Status | Evidence |
| --- | --- | --- |
| H1 | Deferred | Reviewer production dispatch is slice 7 work; this change does not touch its wiring. |
| H2 | Fixed | `anchor.ts`; text-only workers fail, watch backs off to 1 s, and terminal workers release capacity. `durable-worker.test.ts`. |
| M1 | Fixed | `gitops.ts` refreshes a confirmed intent when HEAD changes. `durable-gitops.test.ts`. |
| M2 | Fixed | `modelAuth.ts` refuses Anthropic OAuth unless `workers.durable.modelAuth` is true. `modelAuth.test.ts`. |
| M3/M5 | Fixed | `anchor.ts` records assistant provider/model provenance and excludes finished reviews from capacity. `durable-worker.test.ts`. |
| M4 | Fixed | `durable-worker.test.ts` covers malformed, wrong-head, same-family, duplicate-call, and no-verdict refusals. |
| M6 | Fixed | `skills.ts` recognizes plural and hyphenated subagents, code-mode variants, and script paths. `durable-skills.test.ts`. |
| L1 | Fixed | `env.ts` reuses the item shell's `gh` directory. |
| L2 | Deferred | ProcessManager does not expose streaming output or a per-launch timeout; adding it would cross the containment interface. |
| L3 | Fixed | `gitops.ts` checks the steward-owned git config immediately before network use. |
| L4 | Deferred | Requires the slice 7 PR-diff source wiring to fetch a SHA-pinned diff. |
| L5 | Partially fixed | Push intents refresh for a new HEAD; report/PR title screening remains deferred. |
| L6 | Deferred | Queue/audit behavior is in `workItemTask.ts`, excluded from this slice. |
| L7 | Fixed | Git errors now suggest checking staged changes and status. |
| L8 | Fixed | `tools.ts` rejects non-regular and over-100 KB reads before loading them. |

## Claims in `docs/evidence/slice-6c.md` not backed by code or tests

| Claim | Status |
| --- | --- |
| Row 11: reviewer tool "refuses malformed/wrong-SHA/same-family" | Code present, no test (M4); family input never populated in production (H1). |
| Row 11: provenance "from durable entries" | Taken from configured model and turn count (M3). |
| Row 9: model-auth opt-in | Doctor only; no launch refusal or test (M2). |
| Row 8: cap enforced | True for workers that call `report`; leaks for reviewers and non-reporting workers (H2, M5). Retention/prune not implemented. |
| Row 6: SIGKILL mid-`bash` -> containment unit gone | Disclosed as untested; the tests cover close-during-bash and idle SIGKILL only. |
| Item 8 responsiveness benchmark, live pilot | Disclosed as pending operator. |

## Not found

No confinement escape, token leak into the shell, default-branch/force push, trailer forgery, or lifecycle-table violation (kill switch, hold, budgets, abort/soft/hard, restart fences) was found beyond the items above. A worker cannot forge a verdict through the tool API; a reviewer's verdict is attacker-influenced only through the content it reads (PR diff), which is inherent. Direct file/credential access via `bash` stays out of scope per R47.
