# Slice 9 evidence

| Spec item | Implementation | Focused evidence |
| --- | --- | --- |
| Neutral policy and source seam | `src/gate/policy.ts`, `policySource.ts`; built-in `none` and test-only `fixture` | `test/contract/policySource.test.ts` |
| Tightening, hard paths and shadow report | `tighten.ts`, `hardPaths.ts`, `shadow.ts` | `test/unit/gate.test.ts`, policy-source contract |
| SHA-pinned merge executor | `gate/merge.ts`; `gate/merge.ts` invokes the merge command only with a matched head SHA and never elevated options | policy-source contract |
| Runtime gating | `WorkRuntime` resolves source before decision and immediately again before merge; it fails closed if GitHub method/protection facts are unavailable. Cooling-off, kill-switch and UTC daily-cap facts are re-evaluated before merge. | Focused gate tests; a `fixturePolicies` runtime merge-path fixture remains open. |
| Report API/CLI | `GET /v1/gate/report`; `durable gate report [id]` | Type-check |

## Local validation

- `pnpm install --frozen-lockfile`
- `node --experimental-strip-types --test test/unit/gate.test.ts test/contract/policySource.test.ts`
- `pnpm exec tsc --noEmit`

## Live merge

Pending operator. `none` is the default and makes real auto-merge unreachable. After a future real source is designed, implemented and contract-tested: enable its per-repository `policySource`, run shadow mode on a disposable PR, inspect `durable gate report <item>`, then set `shadow: false`. Confirm GitHub branch rules, required checks, and reviews still pass; never use an administrator or bypass option.
