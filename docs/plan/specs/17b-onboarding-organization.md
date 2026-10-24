# Spec 17b — Onboarding: Create an organization

Objective: extend `durable onboard` with a second guided stage that selects accessible repositories, chooses or creates a non-secret organization, configures connector allowlists, and proposes operational defaults without bypassing organization or connector policy.

Design refs: product review W13-W14, decisions 31-35 and Q28-Q36; architecture D22-D24; program design §2 and §3.5; specs 07b and 07c.

Depends on: spec 17a, 07b and 07c. It is additive: the implicit default organization and manually authored definitions keep their existing behavior.

## Checklist

1. **Profile-scoped repository discovery:** use the selected profile's existing GitHub identity/client to list accessible repositories. Present an accessible multi-select with search and recommended conservative selection; never infer repositories from ambient `gh` state. Write only selected slugs into the candidate `scope.repos`. Acceptance: pagination, inaccessible repository, empty selection and profile-isolation fixtures pass.
2. **Organization choice:** offer the implicit `default`, an existing named organization, or creation of a plain local organization document through the existing `org` schema and apply flow. Show organization repository/tool/connector ceilings before selection; reject any requested value that would loosen them. Do not make the console, a worker or bearer token an organization author. Acceptance: schema, precedence and implicit-default compatibility snapshots pass.
3. **Connector setup:** present only providers and tools allowed by slice 7b. Start with no connectors; make read and write classes distinct and require an explicit write choice. `fake` is available for demo/test; Composio remains unavailable until its provider spike and hosted-custody decision are accepted, and no UI wording implies that authorization. Do not collect provider credentials or connected-account identifiers. Acceptance: allow/deny/read/write, hosted-custody refusal and no-credential-field fixtures pass.
4. **Operational defaults:** propose a valid default pipeline, conservative limits, quiet hours and notification mapping from the selected organization/machine. Show recommended values in a list, permit only schema-valid tightening, and explain mandatory pipeline order and that auto-merge remains off. Acceptance: pipeline order, organization narrowing and quiet-hour/notification validation tests pass.
5. **Review and apply:** merge profile-stage selections and this stage into one non-secret plan. `--dry-run` shows every organization/definition candidate diff; apply calls existing organization approval semantics where needed and records the stage only after success. Rerun reuses matching files and asks for an explicit new name rather than silently replacing policy. Acceptance: approval-required, partial failure, diff and idempotency fixtures pass.
6. **Docs and examples:** document repository visibility, organization choice, connector custody boundary, recommended defaults and how to continue manually with `durable org`. Keep the answers-file reference non-secret and placeholder-only.

## Risk controls

- Repository discovery, connector selection and organization materialization stay profile- and policy-bound.
- No token, provider credential, connected-account value or organization approval nonce enters answers, state, output or diffs.
- Default connectors are empty; default pipeline preserves code-enforced stages; auto-merge remains off.
- A failed or abandoned stage leaves no enabled service and preserves the last valid organization materialization.

## Out of scope

Agent creation, service enablement, new connector providers, resolving hosted Composio custody, remote organization distribution changes and console onboarding.

## Done when

Profile-scoped repository selection, policy-safe organization selection, connector matrices, recommended operational defaults, dry-run and resumed apply all pass with fake providers and no credential exposure.
