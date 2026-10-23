# Organization design analysis

## Current attachment points

Durable's execution unit is an agent definition. It selects one named profile, `scope.repos`, sources, pipeline, limits, quiet hours, notifications, worker selection and connector allowlists. `machine.yaml` assigns agent IDs and supplies machine-local checkout roots, channels and capabilities. A steward remains one process per agent/scope.

Profiles are the machine-local identity and credential boundary. They hold model auth, GitHub token and the profile manifest. An organization never owns, copies or resolves credentials. Each member agent continues to name the profile available on its machine. `buildAgentEnv` starts with that selected local profile and applies the resolved organization policy.

`scope.repos` is the context boundary. Organization policy is checked before intake, checkout, claims, pipeline selection, dispatch and GitHub effects. Agent scope can only reduce the organization set. Organization defaults may set pipeline, limits, quiet hours, notification policy, tools and connectors, but an agent can only make the effective policy stricter.

`doctor` validates membership, missing organization references, effective-policy loosening, repos outside scope and unavailable connectors. It also reports the organization content hash each machine has materialized, stale or unreachable members, and any local override or materialized-file drift. Audit, work-item, notification, connector and metrics records include organization id and version.

The console/fleet remains a viewer/controller, not a coordinator. It groups agents by organization and reports synchronization status. Existing slice-11 console-to-daemon links can request a sync, but must not be the source of truth or carry organization credentials. Approvals and nonce/passkey bindings remain agent/item/SHA-bound; organization membership cannot broaden them. Per-organization pause fences member work without changing the global pause.

## Distribution options

| Option | Fit | Decision |
| --- | --- | --- |
| Git-backed organization repository | Portable, reviewable history, offline clones and content-addressed versions. Every machine can pull independently. | Required source of truth. |
| Existing daemon-to-daemon or console links | Console already reaches daemons, but daemons must remain independent and the console is not durable state. | Not a source of truth or credential channel. |
| Hybrid | Git distributes immutable policy; the slice-11 console observes versions and asks reachable daemons to pull immediately. Startup and periodic pulls remain independent. | Recommended. |

## Attachment decision

An optional `organization` field resolves before doctor or steward startup. Named organizations are flat, non-secret documents in a dedicated Git-backed organization repository. A release is an immutable commit whose canonical version is its content hash. `durable org publish <name> --code <nonce>` creates the release only after approval-class nonce verification bound to the organization name, candidate hash and parent hash. The publisher identity is a named local operator policy, not an agent or bearer token.

A member daemon pulls the configured remote at startup, on a bounded periodic check and after a signed console sync request from slice 11. It verifies the approved version/hash, validates schema and materializes an effective, read-only organization configuration beside that agent state. The materialization records organization name, source commit/hash, fetch time and effective-policy hash. Profile names are resolved only after materialization on the local machine.

A new version may tighten policy immediately. A version that would loosen a security-relevant setting is refused unless it is a separately approved publish whose nonce is bound to the exact diff and every reachable member validates the change; the default remains reject-and-report. An unavailable machine retains its last valid materialization, marks `stale`, and may continue only under that same-or-stricter policy until `maxStaleAge`, then stops new source, dispatch and connector work. A bad fetch, conflict, unsigned/unapproved version or local file drift keeps the last valid materialization and fails closed for new work. Git conflict resolution occurs only in the publisher checkout, never in agent state.

The implicit `default` organization remains in memory for unmodified definitions. It has no remote, sync or migration requirement and preserves shipped semantics. Slice 7c therefore depends on slice 11 for immediate cross-machine sync and fleet status, but does not change shipped work or reorder later slices.
