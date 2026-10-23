# Slice 7a evidence: gate core

| Spec item | Status | Implementation | Focused evidence |
| --- | --- | --- | --- |
| 1. Policy + facts | Implemented | `src/gate/{policy,tighten,hardPaths,facts}.ts` defines a definition ceiling, tighten-only intersection, auto-disabled `none` state, hard paths, and fail-closed `gh pr view` facts. | Fixture-style `gh` JSON test covers computed fields, author self-review exclusion, and failed reads. |
| 2. Decide | Implemented | `src/gate/decide.ts` is pure, has no I/O, fails closed on unknown facts, preserves hard-path and GitHub required-review reasons, and exposes the future `merge` outcome without an executor. | Table-driven modes and paths plus every required fact changed to false/null. |
| 3. Reviewer job | Implemented | `src/gate/review.ts` launches the selected reviewer kind through `WorkerRegistry`, validates a SHA-bound JSON result or durable `report_verdict`, and records kind-neutral provenance. `templates/reviewer-brief.md` supplies the Pi result-file contract. | Faux dispatcher/kind tests record provenance for Pi-session and durable reviewers; same-family fallback is refused. |

## Local validation

- `pnpm install --frozen-lockfile`
- `node --experimental-strip-types --test test/unit/gate.test.ts test/unit/gate-review.test.ts`: 8 passed
- `pnpm exec tsc --noEmit`: passed during focused validation

Items 0 and 4–10 are intentionally not implemented in this change.
