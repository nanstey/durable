# Slice 7 evidence

| Spec item | Status | Implementation | Focused evidence |
| --- | --- | --- | --- |
| 1. Policy + facts | Implemented | `src/gate/{policy,tighten,hardPaths,facts}.ts` | `test/unit/gate.test.ts` |
| 2. Decide | Implemented | `src/gate/decide.ts` | `test/unit/gate.test.ts` |
| 3. Reviewer job | Implemented | `src/gate/review.ts`, `templates/reviewer-brief.md` | `test/unit/gate-review.test.ts` |
| 4. Human mirror | Implemented | `Github.mirrorGate()` writes one SHA-marked report comment and attempts `durable/review`; permission failures are audited and do not affect the gate. | Type-check and workflow coverage |
| 5. Approval task | Implemented | SHA-bound persisted `WorkItem.gate`, shared action-bound nonce store, nonce-safe notifier delivery, and nonce-only approval endpoint. | `test/contract/work-flow.test.ts`, nonce/release coverage |
| 6. Ready transition | Implemented | Gate transition marks the PR ready, sends the nonce-free approval-needed event (with notifier reminders), then separately delivers the nonce. | Workflow coverage |
| 7. CLI/API/queue/audit | Implemented | `durable approve`, `GET /v1/gate/:item`, persisted gate state in queue projection, and gate approval audit events. | Type-check |
| 8. Required reviews | Implemented in gate core | `gate/decide.ts` returns the unbypassable `github-requires-approval-from-other-account` reason. | `test/unit/gate.test.ts` |

## Local validation

- `pnpm install --frozen-lockfile`
- `pnpm exec tsc --noEmit`
- `node --experimental-strip-types --test test/unit/gate.test.ts test/unit/gate-review.test.ts test/contract/work-flow.test.ts`: 16 passed
