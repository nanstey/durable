# Independent review: slices 9, 10 and 11

Scope: PR #44 (auto-merge seam: `src/gate/{policySource,auto,merge,shadow}.ts`, runtime wiring), PR #43 (claim leases), PR #45 (Tailscale listener, remote tokens, console registry and mux), at main `1d0edfa`. Reviewed against specs 09, 10 and 11 and the defect classes in `review-slice-7.md`. The reviewer was an Anthropic-family model and the code authors were OpenAI-family. This was a read-only source review. No source was edited. PoC scripts live in `/tmp` only.

Focused tests (all passed): `node --experimental-strip-types --test test/unit/gate.test.ts test/contract/policySource.test.ts test/unit/claims-pipeline.test.ts test/unit/console.test.ts test/unit/net.test.ts` gave 30 passed, 0 failed. Passing tests do not cover most findings below.

## Verdict

Real auto-merge is unreachable today: the only sources are `none` and a test-only `fixture`. The merge executor itself is sound. It re-reads the PR, pins the head with `--match-head-commit`, uses no `--admin`, and confirms `MERGED`. `grep` finds no bypass flag anywhere in `src/`, and `fixture` is gated. The Tailscale listener binds to the explicit Tailscale address (never `0.0.0.0`), and approval routes still reject bearer credentials. Several defects remain.

- The gate silently ignores most policy fields, so a future real source inherits a fail-open gate.
- The console identity check can be skipped by the client.
- The lease protocol relies on the absolute wall clock and has no write-time fencing.
- Several evidence claims are not backed by tests.

Counts: **High 2, Medium 9, Low 8.**

## High

**H1. The console identity allowlist is skipped when the request carries a loopback `Host` header.** `src/console/guard.ts:21-27,38-45`.
- `local` is derived from the client-controlled `Host` header. The `allowedUsers` check runs only when `serve` is true (`host === serveHostname`).
- Trigger: a Tailscale peer that can reach the Serve URL sends `Host: localhost:4319`, `Origin: http://localhost:4319`, and the CSRF token from `GET /api/bootstrap` (which has no identity check, see M7). The host/origin check passes, `serve` is false, and the write (chat, pause, interrupt, steer) is allowed with no `Tailscale-User-Login`.
- PoC `/tmp/rev911/poc.ts`: `serve host, no identity: 403`, `serve host, other user: 403`, `spoofed Host: localhost, no identity: 200`.
- This depends on Tailscale Serve forwarding the client's `Host` unchanged. I could not verify that offline; confirm it in the live drill. The guard has no way to tell a Serve-proxied request from a local one, so it should not rely on `Host` for that.
- Fix: decide "came through Serve" from something the client cannot choose, such as the presence of `Tailscale-User-Login` or `X-Forwarded-For`, or run the Serve proxy on a separate listener or port. Require the allowlist for every request that is not a direct loopback connection (use `getConnInfo`). Add a test: spoofed loopback `Host` with no identity must give 403.
- Also: `test/unit/console.test.ts:30-43` is named "Serve writes require the allowed Tailscale identity" but only asserts a 421 for a bad host. It never exercises the identity check, so this was missed.

**H2. Most policy fields are never enforced, and three gate facts are hard-coded `true`.** `src/steward/workRuntime.ts:437-446`, `src/gate/auto.ts`.
- `dailyCapAvailable: true`, `coolingOffElapsed: true`, `killSwitchOff: true`. `riskAcceptable` is `low || medium` regardless of `policy.maxRisk`.
- `grep` finds no consumer of `coolingOffMinutes`, `maxRisk`, `requiredChecks`, `requireCrossFamilyReview`, or any daily-cap source outside `tighten.ts`.
- Trigger: a verified policy with `maxRisk: low`, `coolingOffMinutes: 60` and a PR whose review says `medium` is merged immediately. The same applies to `requireCrossFamilyReview: false` (the reviewer is always counted), `requiredChecks` lists, and any number of merges per day or tick.
- The kill switch is covered only indirectly by `options.check()` (`:501`), which throws. That is fail-safe, but `decide` never sees it, so the `block` / `kill-switch-on` path and its audit reason are dead.
- Spec 09 items 8 and 12 and its risk controls ("Kill switch, policy state and daily cap are re-checked immediately before the merge call") are therefore not met. This is the same defect class as slice-7 H1: facts are fabricated, so the gate is a no-op for those inputs. `slice-9.md` does not list this as a gap.
- Fix: compute `riskAcceptable` from `policy.maxRisk`. Persist a merge ledger for the daily cap and per-tick limit. Persist `reviewedAt` and compare it with `coolingOffMinutes`. Evaluate `requiredChecks` and `requireCrossFamilyReview`. Reject any policy field that is set but has no enforcement, and test each negative case from spec item 12.

## Medium

**M1. "Checks passed" is vacuously true, and facts are not refreshed before the merge call.** `src/gate/facts.ts:76-81`, `src/steward/workRuntime.ts:489-520`, `src/steward/github.ts:245`.
- `rollup.every(...)` on `[]` returns `true`. PoC: `no-CI PR checksPassed: true`.
- `baseProtected` returns `protected === true`. That does not show that any required check or review exists.
- Trigger: a protected base with no required checks and a PR with no CI. `mergeClean` and `checksPassed` pass with nothing run.
- After `collectFacts`, `mergeWhenSafe` re-reads only `state` and `headSha`. Mergeability, checks, base branch and draft state are not re-read. `--match-head-commit` pins the head but not the base. An administrator token with unenforced protection can merge a PR whose checks changed since the facts were read.
- Fix: treat an empty rollup as not passed unless the policy says `requiredChecks: github-required` and GitHub shows no required contexts. Call `collectFacts` again right before `runGh` and re-run `decide`. Re-check `baseRefName`.

**M2. `pathAllow` absent means any path is allowed. Soft-deny paths are not implemented.** `src/gate/auto.ts:30-37`.
- Spec item 6 says lockfiles and secret-like paths are allowed only if listed in a verified `pathAllow`. `policy.pathAllow && ...` is skipped when the list is absent, so `.env`, `*.pem`, `pnpm-lock.yaml` and workflow-adjacent files are not denied by default.
- Fix: default to deny. Require `pathAllow` for any auto-merge. Add a built-in soft-deny list that only `pathAllow` can lift.

**M3. Lease expiry compares absolute timestamps from two clocks, and `readClaim` does not bound foreign leases.** `src/steward/claims.ts:60-63,102-125`.
- The holder writes `lease=<its now + duration>`. Another machine compares that with its own `Date.now()`. The only skew tolerance is `graceMs`, default 5 minutes. A peer clock more than 5 minutes ahead takes over a live holder (split brain).
- A foreign marker with `lease=9999-...` from any trusted commenter (`OWNER`/`MEMBER`/`COLLABORATOR`, or any commenter when `login` is unset: `trustedComment`) is treated as active and blocks the item. Only `claim()` clamps leases; `readClaim` does not.
- No test covers skew. `slice-10.md` lists "clock skew tolerance (grace)" in spec item 1 but the only evidence is the fixed-offset grace test.
- Fix: use GitHub's `created_at`/`updated_at` (server time) plus the duration, or clamp `lease` to `commentUpdatedAt + maxDuration`. Warn in `doctor` when the local clock differs from the GitHub `Date` header by more than half the grace.

**M4. A takeover uses the same branch, and a stale holder is not fenced at write time.** `src/steward/workRuntime.ts:859-861,711-714`, `src/steward/claims.ts`.
- Branch is `durable/<agent>/<item.id>`. Both machines run the same agent definition (the evidence drill says so), so a takeover pushes to the same branch name. The spec risk control says takeover must use a new branch name or stop and ask.
- The claim is re-read only in `renew()`, once per tick. The task `check()` (`:711`) tests only the local process fence and the kill switch. A holder that was suspended past lease + grace resumes with live worker processes and can push, update the PR or call `readyPr` before its next tick finds `claim-lost`. The window is at most `pollSeconds`, and longer if a worker is mid-turn.
- Fix: use a per-attempt branch suffix, for example `-<owner short id>`. Make `check()` call `readClaim` before each external write (push, PR create or update, ready, merge) and abort on `lost`.

**M5. `token revoke` removes every token of a client name, so a rotation with a reused client name kills the new token.** `src/api/tokens.ts:102-107`, `docs/operator.md:320`.
- `revokeToken(agent, client)` deletes all records with that `client`. The documented rotation is "create a new client token, switch the registry device to it, then revoke the old client token". If the operator reuses `--client console-<host>` (the natural choice), the revoke deletes both. There is no way to revoke one token, and `token list` shows no id.
- Spec 11 item 3 requires a rotation test with an open SSE stream reconnecting on the new token. No such test exists.
- Fix: show a short hash id in `token list`, add `token revoke --id`, document distinct client names per rotation, and add the rotation test.

**M6. `tailscale whois` runs on every request, uncached and with no timeout.** `src/api/net.ts:36`, `src/api/routes.ts:41-50`.
- Each request (including each SSE poll or reconnect) spawns a process. `execa` has no default timeout. A hung `tailscale` blocks the request indefinitely. A peer that reconnects in a loop causes a process storm even before auth.
- Fix: add `timeout`, and a short TTL cache keyed by remote address (including negative results).

**M7. Console reads, including `/api/bootstrap` (which returns the CSRF token), need no identity.** `src/console/guard.ts:36-45`.
- The allowlist applies only to non-GET. Any Tailscale node the ACL lets reach `console:443` can read transcripts, inbox, audit and items for every device through the proxy. The documented ACL grants `autogroup:member`.
- This matches the spec literally ("non-GET requests require"), but it widens read access beyond the operator. The CSRF token is also handed to any reader.
- Fix: apply the allowlist to every request on the Serve host. Would the author consider the read path part of the identity boundary?

**M8. The evidence files claim coverage the tests do not provide.**
- `docs/evidence/slice-9.md`:
  - It names `test/contract/policySource.contract.ts`, which does not exist (the file is `policySource.test.ts`). The listed `node --test` command fails.
  - "Runtime gating", "Report API/CLI" and "Report" are backed by "Type-check" only. No test passes `fixturePolicies` to `WorkRuntime` (`grep fixturePolicies test` is empty), so the runtime merge path (re-resolve, fingerprint change, method selection, shadow) has no test.
  - Spec items 10 (`durable policy verify|show`), 11 (lint tests that only `gate/merge.ts` spawns `gh pr merge`), 12 (fixture matrix) and the PR comment and revert hint in item 9 have no code. `src/guard/commands.ts` builds `"--" + "admin"` by concatenation, which defeats the greppable "appears nowhere" lint the spec asks for. No lint test replaces it.
- `docs/evidence/slice-10.md`: the "both worker kinds" test (`claims-pipeline.test.ts:165`) only calls `claim()` twice with different agent names (`pi-session-a` / `pi-session-b`) and pushes strings into a `launches` array. It runs no worker, no runtime and no branch logic. It also hides M4, because its two agents get different branches while the real machines share one name. Spec 10 item 5 (sandbox repo grep after a run) is attributed to `hygiene.test.ts`, which does not run the steward.
- `docs/evidence/slice-11.md`:
  - Items 1, 5, 6, 7, 9 and 10 are weaker than the spec acceptance. There is no bind-address test of `startApi`, no flapping/slow-daemon test, no kill-the-console independence test (README only), no forged and missing header test (H1), no rig and no proxy-level tests.
  - "retries the Tailscale network bind until Tailscale is up" (spec item 1) is not implemented: `startApi` throws (`src/api/server.ts:22-30`) and the steward exits.
- Fix: correct the paths, mark unmet items as gaps, replace the tautological test with a runtime-level one, and add tests for H1, H2, M3 and M5.

**M9. Device URLs are unrestricted, and the console keeps sending the token after a uid mismatch.** `src/console/registry.ts:46-60`, `src/cli/main.ts:575-612`, `src/console/proxy.ts`, `src/console/mux.ts:80-110`, `src/console/monitor.ts:53-60`.
- `validUrl` and `add-device` accept any `http:` or `https:` host. The first request sends `Authorization: Bearer <token>` to it, so a mistyped or hostile URL (or a cloud-metadata address) gets the token in cleartext. The spec says "Tailscale URL".
- `mismatch` and `incompatible` are only monitor labels. The proxy and mux still forward `device.token` to a host whose `uid` changed (a different daemon now at that URL).
- Fix: require a Tailscale host (the CGNAT range 100.64/10, a MagicDNS name, or loopback) unless an explicit override is given, refuse `http:` outside those, and have the proxy and mux require `status === online` with a matching `uid` before attaching the token.

## Low

**L1. The Tailscale address check admits non-CGNAT ranges.** `src/api/net.ts:24-28`. The regex `100.([6-9]\d|1[0-2]\d).x.x` (leading octet 100) accepts second octets 60-63 and 128-129 after the leading 100 (public space). PoC: all four were `ACCEPTED`. It also accepts octets over 255 in the last two places. Impact is limited to an operator-set the explicit-address option that exists on the host. Fix: parse four octets and require the 100.64/10 range.

**L2. The mux can leak duplicate fan-in loops and raise unhandled rejections.** `src/console/mux.ts:80-135`. During the backoff `setTimeout`, the controller has already been dropped from `tab.controllers`, so a re-`PUT` that keeps the same key does not abort that loop, and `tab.subs.has(key)` stays true. The old loop wakes and a second fan-in runs for the key (duplicate frames, extra daemon connections). `await tab.write(...)` in the `catch` can also throw after the tab closes; `void this.fanIn(...)` leaves that rejection unhandled (a Node process crash by default). Tabs are not capped. Fix: use a generation counter per subscription and a try/catch around the writes.

**L3. `shadow` defaults to `false`, and repo-level `merge` replaces agent-level `tighten` wholesale.** `src/gate/tighten.ts:69`, `src/steward/workRuntime.ts:422-425`. With `mode: auto-when-safe` and a verified source, omitting `shadow` means live merging. The spread `{...definition.merge, ...repoDefinition?.merge}` is shallow, so a repo-level `tighten` drops the agent-level one (including `pathDeny`). Both come from the operator's own definition. Fix: default `shadow: true` for `auto-when-safe`, and deep-merge `tighten`.

**L4. Merge errors retry every tick with no backoff and no persisted failure.** `src/steward/workRuntime.ts:489-520`. `policy changed before merge`, `no allowed merge method before merge` and a failed `gh` call throw out of `reviewAndGate`. `progress` swallows them into a `work-item-reconcile-failed` audit. Nothing is recorded in `item.gate`, so the operator sees no reason. Fix: record a gate reason and an attempt count, and then wait for a human.

**L5. A losing or finishing machine can remove the winner's label or leave a phantom claim.** `src/steward/workRuntime.ts:795-805`, `src/steward/claims.ts:166`. `finish` always removes `durable/claimed`, even when the claim was taken over by another machine. In `claim`, if `deleteComment` of the loser's own comment fails, that comment stays as the lowest active id for up to a full lease and blocks the item. Fix: remove the label only when the held claim is the current winner, and retry the delete.

**L6. The fixture-source guard is weak.** `src/gate/policySource.ts:55-61`. `process.argv.some(/(?:^|\/)test\//)` is satisfied by any argument path containing `test/` (for example a working directory). That lifts the "test-only" refusal without `DURABLE_ALLOW_FIXTURE_SOURCE`. The risk is low, since fixture scripts cannot come from a definition. Fix: drop the argv heuristic.

**L7. An existing `devices.yaml` with inline tokens stops the console from starting.** `src/console/registry.ts:107-112`. `loadDevices` now requires `tokens/<id>` and throws `missing token`. Old inline `token` fields are neither migrated nor removed from the YAML. Fix: migrate on load and strip the field.

**L8. A `pause`-scoped token can request approval nonces without a limit.** `src/api/auth.ts:12`, `POST /v1/gate/:item/approve/request`. This cannot approve (the nonce goes only to the desktop or command channel), but a stolen console token can flood the operator and keep issuing nonces. Fix: add a per-item rate limit and an audit entry with the actor.

## Verified as correct

- `src/gate/merge.ts`: reads `state` and `mergedAt` first (idempotent), `--match-head-commit <sha>`, and no `--admin`. It re-reads after an error and verifies `MERGED`.
- `decide` (`src/gate/decide.ts`): `wait-human` unless the policy is `verified`, `enabled` and `requireHumanApproval` is false. `unknown` facts, a hard path and `REVIEW_REQUIRED` all stop before a merge. `effectivePolicy` never loosens, with clamps recorded.
- `isHardPath` covers `CODEOWNERS` variants and `.github/**`, and `collectFacts` includes `previousPath` for renames. A `files` list of 100 or more makes `paths` null (fail closed).
- The runtime re-resolves the source just before the merge and compares fingerprints (`workRuntime.ts:489-500`). Shadow mode never reaches `runGh`.
- `startApi` binds the loopback listener plus the explicit Tailscale address only. It refuses to start `peerCheck: required` without `allowedPeers`, and each request returns 503 when `whois` fails in `required` mode. Approval routes still reject bearer credentials. Tokens are stored as hashes with expiry, and device tokens are in 0600 files outside `devices.yaml`.
- The proxy allowlist is anchored, one-segment routes. I found no `..` traversal that reaches an approval route.

