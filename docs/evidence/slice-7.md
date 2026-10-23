# Slice 7 evidence

| Spec item | Status | Implementation | Focused evidence |
| --- | --- | --- | --- |
| 0. Optional spec gate | Implemented | `pipeline/spec.ts` evaluates the persisted source/judge size and `WorkRuntime` opens an idempotent draft spec PR before any worker dispatch. `approve-spec` nonces bind the work item, spec PR and head SHA; a changed head invalidates approval. | `test/unit/claims-pipeline.test.ts`, `test/contract/work-flow.test.ts` |
| 1. Policy + facts | Implemented | `src/gate/{policy,tighten,hardPaths,facts}.ts` | `test/unit/gate.test.ts` |
| 2. Decide | Implemented | `src/gate/decide.ts` | `test/unit/gate.test.ts` |
| 3. Reviewer job and production wiring | Implemented | `WorkRuntime` launches an opposite-family reviewer after a draft PR, persists its SHA-bound result/failure, then routes the verdict through the gate before making the PR ready. Durable reviewers receive a code-owned SHA-pinned GitHub diff provider. | `test/unit/gate-review.test.ts`, `test/contract/work-flow.test.ts` |
| 4. Human mirror | Implemented | `Github.mirrorGate()` writes one SHA-marked report comment and attempts `durable/review`; permission failures are audited and do not affect the gate. | Type-check and workflow coverage |
| 5. Approval task | Implemented | SHA-bound persisted `WorkItem.gate`, shared action-bound nonce store, nonce-safe notifier delivery, and nonce-only approval endpoint. | `test/contract/work-flow.test.ts`, nonce/release coverage |
| 6. Ready transition | Implemented | Gate transition marks the PR ready, sends the nonce-free approval-needed event (with notifier reminders), then separately delivers the nonce. | Workflow coverage |
| 7. CLI/API/queue/audit | Implemented | `durable approve`, `GET /v1/gate/:item`, persisted gate state in queue projection, and gate approval audit events. | Type-check |
| 8. Required reviews | Implemented in gate core | `gate/decide.ts` returns the unbypassable `github-requires-approval-from-other-account` reason. | `test/unit/gate.test.ts` |
| 9. Live | Pending operator | On a real no-required-review PR, enable the `spec` stage if required, observe the draft PR, receive the desktop/command nonce, run `durable approve-spec <agent> <spec-pr> --code <nonce>`, then verify exactly one worker dispatch. Separately resolve a worker PR once by human GitHub merge and once with `durable approve <agent> <worker-pr> --code <nonce>` on a repository without required reviews. Record PR URLs and resulting audit events here. | Requires operator-owned GitHub identity and nonce-safe channel |

## Local validation

- `pnpm install --frozen-lockfile`
- `pnpm exec tsc --noEmit`
- `node --experimental-strip-types --test test/unit/gate.test.ts test/unit/gate-review.test.ts test/contract/work-flow.test.ts`: 16 passed
