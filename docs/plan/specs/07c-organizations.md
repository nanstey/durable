# Spec 07c — Organizations

Objective: add an optional organization policy boundary that groups durable agents by context (for example work, personal or client), supplies shared defaults, and constrains their repos, tools and connectors. Profiles remain machine-local credential units; organization policy neither stores credentials nor replaces profiles. An agent without `organization` has exactly today's behaviour through an implicit `default` organization.

Design refs: product review decisions 32-33 and Q29-Q32; architecture D23, D3, D22, D16 and §3; program design §2-3; specs 02, 06b, 07, 07b, 08 and 15.

Depends on: shipped 02-06b and 08, in-flight 06c only for durable-worker coverage, 07 (approval/gate), and 07b (connector enforcement). It follows 07b so organization connector policy feeds the established provider wrappers; it does not block slices 8-16 or change their shipped behaviour.

## Checklist

1. **Organization files and schema:** add a non-secret `organizations/<name>.yaml` definition, loaded beside agent definitions. It has `name`, `settings`, `memberAgents`, default `pipeline`, `limits`, `quietHours`, `notify`, allowed `tools`, allowed `connectors` (explicit read/write classes and allow/deny), and allowed `scope.repos`. Add optional `organization: <name>` to `AgentDefSchema`; unknown keys, duplicate membership, path-like values and missing named files fail closed. Acceptance: generated schema/drift and valid/unknown-key/membership fixtures pass.
2. **Default and migration:** resolve an omitted `organization` to the implicit, in-memory `default` organization, whose effective policy is permissive only to the agent's existing definition. Do not require a default file and do not rewrite existing definitions, machine files or state. Acceptance: fixture snapshots prove pre-organization definition, doctor result, generated environment, dispatch selection and audit semantics are unchanged.
3. **Effective policy and precedence:** compute `organization defaults < agent definition`, then validate the result. Agent definitions may narrow repos, tools, connectors, limits, pipeline, quiet hours and notification delivery; they may not add a repo/tool/connector, change read to write, raise a limit, shorten quiet hours, enable a disabled pipeline stage, or add a notification target beyond organization policy. Agent-only fields with no organization counterpart retain their present semantics. Any attempted loosen is a doctor error, not a silent clamp. Acceptance: precedence matrix and property tests cover every field.
4. **Profiles and explicit sharing:** each agent still selects exactly one named, machine-local `profile`. Organization files contain only named `profileRefs` aliases; a profile may be shared only when every participating organization explicitly names the same alias. No default, most-recent, ambient or cross-organization profile lookup exists. Sharing a GitHub identity, model subscription or connector credential between organizations is opt-in by named reference; credential custody remains in the profile files on each machine. Acceptance: two-org fixtures prove absent/typoed aliases and cross-org profile selection refuse before start; a shared named alias works only when declared on both sides.
5. **Isolation at launch:** build the worker environment from the resolved agent profile plus the effective organization policy only. Enforce organization repo scope before sources, checkout, claims, pipeline and git/GitHub operations; expose only organization-permitted code-owned tools and connector wrappers. No process can use another organization’s profile, repo, connector or tool because it exists elsewhere. Acceptance: hostile definition, ambient env and cross-org dispatch fixtures fail closed for Pi-session and durable-conversation workers.
6. **Doctor and operator surfaces:** add `durable org list|show <name>` and organization-aware `doctor` rows for membership, effective-policy violations, dangling organization/profile/connector references, out-of-policy repos, and explicit cross-org shared-profile warnings. Warnings identify names only, never credential values. Acceptance: text and JSON reports distinguish blocking errors from sharing warnings and contain no secret-like values.
7. **Audit, metrics, CLI and console:** persist and emit `organization` (including `default`) in audit, work-item, connector, notification and metric records; add organization filters to status/queue/audit/metrics and group fleet/agent views by organization. Preserve unfiltered output for backward-compatible scripts. Acceptance: API/SSE/CLI/console fixtures show one organization cannot read or control another through a filtered route, and aggregate metrics retain organization attribution.
8. **Approvals, stop controls and recovery:** global pause remains global; add per-organization pause/resume that affects only member agents and fences new source, dispatch and connector work. Existing agent-level pause/hold, nonce and passkey bindings remain agent/item/SHA-bound and are never broadened by organization membership. Recovery reloads organization policy before work resumes. Acceptance: pause matrix, restart, nonce/passkey cross-organization rejection and global-vs-org stop tests pass.
9. **Connector integration:** make the effective organization connector allow/deny policy an additional mandatory check in spec 07b’s provider selection and wrapper path. A connector allowed by an agent but denied by its organization is unavailable; writes require both organization and agent explicit write permission. Acceptance: read/write matrix covers allow, deny, inherited allow, agent narrowing and cross-organization alias rejection.
10. **Documentation and rollout:** document context segmentation, implicit-default compatibility, profile custody, sharing warnings, policy editing workflow and the selected answers to Q29-Q32. Add examples with placeholders only and a migration guide that requires no action for current users. Run a two-organization pilot with separate profiles and repos before enabling any shared reference.

## Risk controls

- Organizations are policy/configuration boundaries, not credential stores or a new shared daemon.
- Optional `organization` fields and the implicit default preserve every shipped path’s semantics.
- Security-relevant policy is tighten-only; attempted loosening fails closed.
- Sharing is named and bilateral; all credential material stays machine-local in profiles.
- Audit and metrics always carry organization id; policy/configuration text and credentials are never logged.
- Organization pause blocks new work but does not weaken existing item holds, approval bindings or the global kill switch.

## Out of scope

Organization nesting, multi-user roles/RBAC, organization-owned secrets, a shared database or cross-daemon coordinator, automatic profile sharing, changing GitHub identities, and retroactively changing historical audit records.

## Done when

Schema, migration/default, precedence, sharing/isolation, doctor, environment, dispatch, connector, approval/pause, audit/metrics, CLI/API/console and two-worker-kind tests pass; a two-organization pilot confirms no cross-context repo, connector, tool or profile use; the Q29-Q32 defaults are recorded or explicitly chosen.
