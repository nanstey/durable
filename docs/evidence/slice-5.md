# Slice 5 — read-only scout evidence

Date: 2026-10-23. Scope: [spec 05](../plan/specs/05-read-only-scout.md).

## Implemented coverage

| Spec item | Implementation | Validation |
| --- | --- | --- |
| Candidate/source contract | `src/sources/types.ts` | Source fixtures |
| GitHub issues | `src/sources/githubIssues.ts` | Stubbed `gh`; list and rate-limit reads only |
| Own PRs | `src/sources/githubPrs.ts` | Stubbed PR checks/requests/behind summary |
| Local files | `src/sources/localFiles.ts` | Front matter and symlink escape fixture |
| Eligibility | `src/sources/eligibility.ts` | Trusted-author and instruction-like untrusted-item tests |
| Tighten-only judge | `src/scout/judge.ts` | Stub high-risk and failure tests |
| Persisted queue | `src/steward/queue.ts`, `src/steward/harness.ts` | Native document queue test |
| Tick integration | `src/steward/harness.ts` | Fixture tick polls, filters and records count-only audit fields |
| API, SSE and tools | `src/api/routes.ts`, `src/steward/harness.ts` | `GET /v1/queue`; queue state is included in SSE snapshots/deltas; `list_queue` and `explain_item` do not expose bodies |
| CLI | `src/cli/queue.ts`, `src/cli/main.ts` | Uses the local read token to call `GET /v1/queue` |

## Executed checks

- `pnpm install --frozen-lockfile`
- `node --experimental-strip-types --test test/unit/eligibility.test.ts test/unit/scout.test.ts test/contract/queue.test.ts`: 7 passed.
- `pnpm exec tsc --noEmit`: passed.

## Pending operator check

A live pilot needs the operator's read-only GitHub token and selected pilot checkout. Before it runs, configure `schedule.pollSeconds`, a local checkout in `machine.checkouts`, source thresholds, and inspect the per-tick `github-rate-limit` audit records and count-only scout audit summaries. No GitHub write command is implemented or invoked by this slice.
