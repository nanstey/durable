# Spec 17a — Onboarding: CLI wizard core and Start a profile

Objective: deliver `durable onboard` as a resumable, idempotent CLI-first guided flow. Its first stage creates or selects a named machine-local profile, guides GitHub and model-provider setup while confining any GitHub credential to the selected profile secret store, and leaves a verified profile ready for an organization and agent.

Design refs: product review W14, decision 35 and Q37-Q39; architecture D2, D3, D24; program design §1, §2 and §3.5; specs 02, 02b and 07c.

Depends on: shipped spec 02 and the skills-repo Pi-profile contract in 02b. It follows 7c for the complete onboarding sequence but does not change organizations, existing profiles, definitions or installer behavior.

## Checklist

1. **Onboarding plan and progress:** add `onboarding/{plan,answers,state,diff,apply}.ts` and `durable onboard`. Model stages as `profile`, `organization`, `agent`; stage 17a implements `profile` and reserves the latter stages without writing them. Store completed stages, plan hash and non-secret selected names in a private machine-local state file. A rerun resumes a matching plan or starts another profile without mutating a completed profile. Acceptance: interrupted/repeated-run fixtures produce one manifest and no duplicate state.
2. **Modes and answers:** interactive mode presents accessible numbered choices and a visible recommended default. `--yes` accepts those defaults. `--non-interactive --answers <file>` validates a plain YAML or JSON answers file against a strict non-secret schema; unknown keys, token-like values, credential fields and inline connector/provider secrets fail before any action. `--dry-run` renders the complete diff for every manifest/state file that apply would write and performs no write, login or probe. Acceptance: schema, redaction, defaults and no-write snapshots pass.
3. **GitHub identity handoff:** explain fine-grained selected-repository token guidance (least privilege; no Administration or workflow-write), store the resulting credential directly in the selected profile's existing `pi-secret`-format secret file (0600). Browser device flow uses a temporary `GH_CONFIG_DIR`; pasted input is hidden. The credential is never accepted from answers, persisted in state, printed, diffed or logged. `token-env:<NAME>` is the only noninteractive credential reference. Run existing `profile bind-github` and show only its non-secret identity result. Acceptance: stubbed supported/unsupported `gh`, ambient-token rejection and no-secret-output tests pass.
4. **Model providers:** let the operator choose providers from supported profile providers; the wizard performs each Pi OAuth/API-key login immediately against the selected named profile auth store and records providers only in the existing non-secret manifest. After login, run a bounded cheap probe through `createModelsFor`; report an exact repair for absent/failed auth without exposing values. Anthropic subscription OAuth is offered only behind an explicit acknowledgement of D2's shaping and terms risk; declining leaves it unconfigured. Acceptance: fake Pi/login/probe tests cover success, failure, cancellation and the Anthropic opt-in.
5. **Profile completion:** reuse `durable profile init|check|bind-github`, never duplicate their manifest or credential writes. Show the next stage and a resume command after successful completion. Existing profiles can be selected after their identity/provider checks; no overwrite occurs without the profile command's existing explicit behavior. Acceptance: profile selection, missing manifest, mismatch and rerun tests pass.
6. **Demo and platform path:** offer `--demo` as a try-first path using only a fake provider, fabricated identity and fixture repositories in temporary state; it never opens Pi login, `pi-secret`, device flow or a real GitHub client. Keep dependencies pure JavaScript and exercise the same answers/dry-run contract on the Android/Termux capability fixture. The skills-repo installer may print `durable onboard` after linking it but never runs it. Acceptance: demo isolation and Termux fixture tests pass.
7. **Documentation:** add operator/install guidance for profile-stage modes, credential boundary, answers-file format, resume, dry-run, demo and device-flow fallback. Keep examples placeholder-only.

## Risk controls

- GitHub credentials may be acquired by the wizard, but are written only to the selected profile's existing secret store; onboarding never prints, diffs, logs or persists them elsewhere. Provider credentials are written only by Pi's login API to the selected named profile auth store.
- Answers and progress state contain names and choices only, are machine-local, and reject secret-like fields.
- Every external handoff is optional and failure leaves the profile incomplete rather than guessing or falling back to ambient identity.
- The wizard creates no agent, service or connector in this slice.

## Out of scope

Organization selection, repository discovery, connector setup, agent definitions, service enablement and the console client.

## Done when

The profile stage is resumable and idempotent; interactive, `--yes`, noninteractive and dry-run contracts pass; fake GitHub/Pi probes prove no credential leakage; docs describe the repair path and demo boundary.
