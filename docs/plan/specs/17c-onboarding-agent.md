# Spec 17c — Onboarding: Create an agent

Objective: complete the CLI flow by creating an agent from a mission and pipeline, selecting models/workers/dispatcher, proving it with doctor, enabling it only when safe, and giving the operator a first-run tour.

Design refs: product review W14 and decision 35; architecture D3-D9 and D24; program design §2, §3.1-3.5; specs 06, 07, 09 and 17a-17b.

Depends on: specs 17a, 17b, 06b, 07 and 09. It does not alter existing agent definitions, gate policy sources or service semantics.

## Checklist

1. **Mission templates:** offer templates for triaging issues, implementing labelled issues to draft PRs, reviewing PRs, dependency upkeep, documentation upkeep and a custom mission. Each template maps to existing source/eligibility/role fields only; a custom mission is plain text with size and credential-like-content checks. Show its generated definition preview. Acceptance: template-schema snapshots and hostile/custom text rejection tests pass.
2. **Pipeline selection:** offer a recommended preset or reuse an organization/agent preset; permit a new pipeline only through existing schema validation. Enforce mandatory `build -> review -> gate -> handoff` order, optional scout/spec constraints, and existing `specApproval` requirements. Acceptance: invalid ordering, unauthorized stage and preset-reuse tests pass.
3. **Runtime choices:** select available profile models, reviewer family, dispatcher and worker kind using current doctor capabilities and organization ceilings. Default to Pi-session on Linux and existing Android capability defaults; do not silently fall back between dispatchers or kinds. Show the required-skills and Anthropic constraints before apply. Acceptance: unavailable model, role enablement, skills and platform matrices pass.
4. **Safe merge defaults:** generate `human-approval`, `shadow: true` and `policySource: none`; auto-merge is off. A template cannot select a real policy source or loosen organization/definition restrictions. Acceptance: generated-definition and tighten-only snapshots pass.
5. **Doctor, repair and enable:** write the candidate definition only after showing the full diff, run `durable doctor`, and display its exact fixes. Allow re-check after a repair; `durable enable` is available only after a green result and remains idempotent. If enable fails, preserve the definition and clear stage state only when its result is known. Acceptance: doctor-failure/recheck, enable refusal, service fake and interrupted-apply recovery tests pass.
6. **First-run tour:** after enablement, present status, queue, attach, inbox, pause/stop, gate report and the human-merge boundary; provide copyable commands and a noninteractive completion record. Do not auto-dispatch work or create a GitHub write as part of the tour. Acceptance: tour output snapshot and no-side-effect test pass.
7. **Documentation:** update operator guidance with mission/pipeline presets, safe defaults, doctor repair loop, first-run tour and adding another agent through the resumed wizard.

## Risk controls

- The generated definition is non-secret, schema-validated and subject to organization tighten-only policy.
- Human approval, shadow mode and no auto-merge are the default and cannot be relaxed by template text.
- Doctor remains the start authority; onboarding never treats a rendered diff as proof that identity, skills or containment work.
- The first-run tour is read-only except for explicitly chosen enablement.

## Out of scope

Console onboarding, automatic work dispatch, changing a real repo policy source, passkey approvals and modifying existing agents in place.

## Done when

Every template and custom path produces a valid preview; pipeline/runtime/default safety tests pass; doctor repair and idempotent enable are proven with fakes; the tour has no unexpected GitHub or worker side effect.
