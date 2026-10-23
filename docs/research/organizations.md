# Organization design analysis

## Current attachment points

Durable's unit of execution is an agent definition: it selects one named profile, `scope.repos`, sources, pipeline, limits, quiet hours, notifications, worker selection and connector allowlists. `machine.yaml` assigns agent IDs and supplies machine-local checkout roots, channels and capabilities; it must not become an organization credential registry. A steward remains one process per agent/scope, so organization is not a supervisor or shared datastore.

Profiles are the existing machine-local identity and credential boundary. They hold model auth, GitHub token and profile manifest. This stays unchanged: an organization can refer to a profile name only as an explicit sharing alias; it never owns, copies or resolves credential material. `buildAgentEnv` continues to begin with the agent's selected profile, then applies the resolved organization policy.

`scope.repos` is the primary context boundary. Organization policy is checked before intake, checkout, claims, pipeline selection, dispatch and GitHub effects; agent scope can only reduce the organization set. Organization defaults may supply pipeline, limits, quiet hours and notification policy, but an agent can only select a stricter effective policy. This makes work/personal/client segmentation enforceable rather than a prompt convention.

`doctor` is the configuration gate: it validates membership, missing organization or profile references, effective-policy loosening, repos outside the organization scope, unavailable connectors, and named cross-organization profile sharing. The latter is a visible warning (names only), while unresolved or undeclared sharing is blocking.

The steward, worker and connector paths consume the same effective policy. Connector spec 07b's wrappers receive organization allow/deny in addition to agent allowlists; writes require both explicit permissions. The profile-bound connector credential model remains intact. No worker environment exposes another organization’s profile, tool, connector or repository.

Approvals and nonce/passkey bindings stay agent/item/SHA-bound; organization membership cannot broaden them. An organization pause fences new member work alongside existing global and agent pause controls. Audit, work-item, notification, connector and metrics records add an organization id, including `default`, allowing per-organization filters without changing approval authority.

The console/fleet is a viewer/controller, not an organization coordinator: it groups reported agents by organization and filters existing per-agent daemon data. `durable org list|show` provides the local CLI equivalent. Cross-machine claims, pipeline execution and audit storage remain per agent.

## Attachment decision

Attach `organization` as an optional field on the agent definition and resolve it before doctor or steward startup. Use a flat, non-secret organization definition file with member IDs and policy ceilings. Omission resolves to an implicit `default` that is constructed from the agent's existing policy, preserving shipped semantics and avoiding a migration rewrite. Place the implementation in slice 7c after 7b: connector policy then has an existing enforcement seam, while no shipped or in-flight slice is renumbered or blocked.
