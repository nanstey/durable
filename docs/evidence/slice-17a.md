# Slice 17a evidence

## Automated

- `test/unit/onboarding.test.ts` covers non-interactive validation, credential rejection before writes, dry-run no-write output, resumable/idempotent manifest creation, and fake-only demo isolation.
- The test fixture uses fabricated paths and does not load a real Pi credential or GitHub token.

## Pending operator

Live GitHub identity binding and model-provider login/probe are deliberately not run in repository automation. An operator must use a named Pi profile, enter the GitHub token only through `pi-secret`, run `durable profile bind-github <name>`, run Pi `/login` for chosen providers, and then run `durable profile check <name>`. No credential was received, displayed, or stored by onboarding.
