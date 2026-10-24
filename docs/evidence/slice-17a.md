# Slice 17a evidence

## Spec-item audit

| Item | Implementation | Focused evidence / resolved gap |
| --- | --- | --- |
| 1. Plan and progress | `src/onboarding/{plan,state,apply,index}.ts` | `test/unit/onboarding.test.ts`: interrupted/repeated runs retain one manifest; state is 0600 and has only plan/profile/stages. Organization and agent remain reserved. |
| 2. Modes and answers | `src/onboarding/index.ts`, `answers.ts`, `diff.ts` | Interactive Clack menus use numbered labels and recommended defaults; strict YAML/JSON validation rejects unknown or credential-like fields; dry run names the exact manifest and state paths without writes. |
| 3. GitHub handoff | `src/onboarding/apply.ts`, `src/identity/{github,env}.ts`, `src/cli/profile.ts` | Browser device flow uses an isolated temporary `GH_CONFIG_DIR`; hidden paste and `token-env:<NAME>` write only `GH_TOKEN` to the profile 0600 secret file. Existing bind verifies the non-secret login. Ambient tokens are never read. |
| 4. Model providers | `src/onboarding/{apply,providers}.ts`, `src/identity/modelAuth.ts` | The wizard invokes Pi's supported OAuth/API-key login API directly against the named profile auth file, displays only URLs/codes, and probes with `createModelsFor`. Failed auth has an exact repair. Anthropic selection requires explicit risk acknowledgement. |
| 5. Profile completion | `src/onboarding/apply.ts`, `src/cli/profile.ts` | Reuses `profile init`, `configure-providers`, `bind-github`, and `check`; existing manifests are not overwritten and repeated plans are idempotent. |
| 6. Demo and platform | `src/onboarding/index.ts`, `src/onboarding/prerequisites.ts` | `--demo` remains temporary/fake-only and does not invoke credential handoffs. Capability reporting treats Android/Termux as not requiring systemd; onboarding adds no native dependency. |
| 7. Documentation | `docs/operator.md`, this file | Operator documentation covers interactive/noninteractive/defaults, answers, credential boundary, resume, dry run, demo, Pi login, and device-flow fallback. Examples use placeholders only. |

## Automated

- `test/unit/onboarding-interactive.test.ts` exercises immediate GitHub/provider execution order, per-provider defaults, consecutive numbering, hidden paste, failure repairs, Anthropic refusal, cancellation, short rerun menus, replacement, credential deletion, and interactive dry-run isolation with injected fakes.
- `python3 scripts/onboarding-pty.py` drives the actual Clack UI in a Python PTY (three runs). It uses a temporary HOME, Pi directory, Durable state and fake `gh`/`pi` on PATH. The injected provider adapter invokes fake Pi and writes fake-only credentials; this checks wizard sequencing and hidden input, not live OAuth or provider network validity. No real GitHub or Pi credential store is accessed. Each child has a 30-second deadline and is killed on timeout.
- `test/unit/onboarding.test.ts` covers non-interactive validation, credential rejection before writes, dry-run no-write output, provider probe repair, Anthropic refusal, every incomplete-step rerun, idempotent manifests, and fake-only demo isolation.
- `node --experimental-strip-types --test test/unit/onboarding*.test.ts`: 17 tests pass. Full-suite execution is left to both push and PR CI per contributor rules.
- `pnpm check` and `pnpm hygiene` pass. Biome reports repository warnings, which are non-fatal.
- Complexity measurement reduced `onboard` from CCN 19 to below the review threshold by separating input preparation. `setupProvider` remains review-band CCN 13 (28 lines): its guarded login/probe and sanitized failure handling stay together.
- Source review traced hidden GitHub paste, device token read-back, provider exceptions, state, and summary output. Provider exceptions are never echoed because SDK errors may contain credentials. This review does not validate live provider OAuth or remote token validity.

## PTY transcript

Captured with `python3 scripts/onboarding-pty.py`. ANSI redraws and intermediate cursor frames are omitted by the harness; the following are submitted prompt headings and application output. The API-key input was masked; the harness asserts that neither hidden input nor fake stored credentials occur in captured output.

```text
### Fresh profile; immediate GitHub and three provider sign-ins
◇  Start a profile (recommended: work)
◇  GitHub authentication
FAKE GitHub: open https://example.invalid/device code TEST-CODE
GitHub: bound as octocat
◇  Sign in to a model provider now?
FAKE Pi: openai-codex sign-in completed (no network)
Provider openai-codex: ready
◇  Sign in to a model provider now?
◇  Acknowledge Anthropic OAuth shaping and provider terms risk? (required)
FAKE Pi: anthropic sign-in completed (no network)
Provider anthropic: ready
◇  Sign in to a model provider now?
FAKE Pi: openrouter sign-in completed (no network)
Provider openrouter: ready
◇  Sign in to a model provider now?
Profile work: created
GitHub: bound as octocat
Provider openai-codex: ready
Provider anthropic: ready
Provider openrouter: ready
Profile ready. Organization and agent stages are not built yet.
Manual setup (docs/operator.md): fill in profile-meta/<profile>.json git identity; write the agent definition and machine.yaml assignments.
durable profile check work
Next: durable doctor <agent>
Then: loginctl enable-linger (Linux); durable enable <agent>

### Rerun; finish without authentication questions
◇  Start a profile (recommended: work)
work: GitHub bound as octocat, providers ready: openai-codex, anthropic, openrouter
◇  Profile already configured
GitHub: bound as octocat
Profile work: selected
GitHub: bound as octocat
Provider openai-codex: ready
Provider anthropic: ready
Provider openrouter: ready
Profile ready. Organization and agent stages are not built yet.
Manual setup (docs/operator.md): fill in profile-meta/<profile>.json git identity; write the agent definition and machine.yaml assignments.
durable profile check work
Next: durable doctor <agent>
Then: loginctl enable-linger (Linux); durable enable <agent>

### Rerun; re-verify with failed GitHub probe
◇  Start a profile (recommended: work)
work: GitHub bound as octocat, providers ready: openai-codex, anthropic, openrouter
◇  Profile already configured
GitHub: failed
  Fix: GitHub probe failed; check the token has access, then run durable profile bind-github work
Profile work: selected
GitHub: failed
  Fix: GitHub probe failed; check the token has access, then run durable profile bind-github work
Provider openai-codex: ready
Provider anthropic: ready
Provider openrouter: ready
Run durable onboard to finish GitHub authentication.
```

## Credential boundary

Onboarding may acquire a GitHub credential through browser flow, hidden paste, or a named environment variable, but writes it only to the selected profile's existing 0600 secret file. It never prints, diffs, logs, stores it in answers/state, or includes it in an error. Provider credentials are written by Pi's login API only to the named profile auth store; onboarding state contains only a plan hash, profile name, and completed stages.
