# Slice 17a evidence

## Spec-item audit

| Item | Implementation | Focused evidence / resolved gap |
| --- | --- | --- |
| 1. Plan and progress | `src/onboarding/{plan,state,apply,index}.ts` | `test/unit/onboarding.test.ts`: interrupted/repeated runs retain one manifest; state is 0600 and has only plan/profile/stages. Organization and agent remain reserved. |
| 2. Modes and answers | `src/onboarding/index.ts`, `answers.ts`, `diff.ts` | Interactive Clack menus use numbered labels and recommended defaults; strict YAML/JSON validation rejects unknown or credential-like fields; dry run names the exact manifest and state paths without writes. |
| 3. GitHub handoff | `src/onboarding/apply.ts`, `prerequisites.ts`, `src/cli/profile.ts` | Guidance requires a least-privilege selected-repository token in `pi-secret`, forbids Administration/workflow-write, detects documented `gh` device-flow support, then uses `profile bind-github`'s non-secret result. Ambient tokens are never read by onboarding. |
| 4. Model providers | `src/onboarding/index.ts`, `apply.ts`, `src/identity/modelAuth.ts` | Interactive choice hands the operator to named-profile Pi `/login`; `createModelsFor` is the bounded verification. Failed auth has an exact repair. Anthropic selection requires explicit risk acknowledgement. |
| 5. Profile completion | `src/onboarding/apply.ts`, `src/cli/profile.ts` | Reuses `profile init`, `configure-providers`, `bind-github`, and `check`; existing manifests are not overwritten and repeated plans are idempotent. |
| 6. Demo and platform | `src/onboarding/index.ts`, `src/onboarding/prerequisites.ts` | `--demo` remains temporary/fake-only and does not invoke credential handoffs. Capability reporting treats Android/Termux as not requiring systemd; onboarding adds no native dependency. |
| 7. Documentation | `docs/operator.md`, this file | Operator documentation covers interactive/noninteractive/defaults, answers, credential boundary, resume, dry run, demo, Pi login, and device-flow fallback. Examples use placeholders only. |

## Automated

- `test/unit/onboarding.test.ts` covers non-interactive validation, credential rejection before writes, dry-run no-write output, provider probe repair, Anthropic refusal, every incomplete-step rerun, idempotent manifests, and fake-only demo isolation.
- `pnpm check` passes. Biome reports pre-existing repository warnings, which are non-fatal.

## Credential boundary

Onboarding does not accept, store, print, diff, or log credentials. Operators enter GitHub credentials only in `pi-secret` and provider credentials only in Pi `/login`; onboarding state contains only a plan hash, profile name, and completed stages.
