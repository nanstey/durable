# Organization design analysis

## Current attachment points

Durable's execution unit is an agent definition. It selects one named profile, `scope.repos`, sources, pipeline, limits, quiet hours, notifications, worker selection and connector allowlists. `machine.yaml` assigns agent IDs and supplies machine-local checkout roots, channels and capabilities. A steward remains one process per agent/scope.

Profiles are the machine-local identity and credential boundary. They hold model auth, GitHub token and the profile manifest. An organization never owns, copies or resolves credentials. Each member agent continues to name the profile available on its machine. `buildAgentEnv` starts with that selected local profile and applies the resolved organization policy.

`scope.repos` is the context boundary. Organization policy is checked before intake, checkout, claims, pipeline selection, dispatch and GitHub effects. Agent scope can only reduce the organization set. Organization defaults may set pipeline, limits, quiet hours, notification policy, tools and connectors, but an agent can only make the effective policy stricter.

`doctor` validates membership, missing organization references, effective-policy loosening, repos outside scope and unavailable connectors. It also reports the organization bundle hash each machine has materialized, stale or unreachable members, and any local override or materialized-file drift. Audit, work-item, notification, connector and metrics records include organization id and version.

The console/fleet remains a viewer/controller, not a coordinator. Slice-11 daemon links may carry an approved organization bundle or request status, but must not author policy or carry organization credentials. Approvals and nonce/passkey bindings remain agent/item/SHA-bound; organization membership cannot broaden them. Per-organization pause fences member work without changing the global pause.

## Distribution options

| Option | Fit | Decision |
| --- | --- | --- |
| Operator-managed file synchronization | The operator may already use rsync, Syncthing, dotfiles or a shared checkout. Each daemon validates and materializes the bytes on disk; there is no network requirement in Durable. | Supported opt-out from daemon distribution. |
| Daemon-to-daemon approved bundle | A designated origin uses the slice-11 link to push or serve a pull of canonical file bytes, content hash and approval record. Receivers independently verify and materialize. | Used for cross-machine distribution. |
| Hybrid | Plain files remain the source of truth on the origin. The origin distributes approved, hash-pinned bundles; an operator can instead synchronize files and disable distribution. | Recommended. |

## Attachment decision

An optional `organization` field resolves before doctor or steward startup. Named organizations are flat, non-secret files in `organizations/<name>.yaml` beside the existing machine-local agent definitions: by default `~/.config/durable/organizations/`, or the sibling `organizations/` directory when `DURABLE_AGENTS_DIR` selects another definitions directory. No organization needs a remote, checkout or Git. A release bundle contains canonical file bytes, its content hash and an approval record. `durable org apply <name> --code <nonce>` validates the origin's local candidate, shows the effective diff, and records an approval-class release only after nonce verification bound to organization name, candidate hash and parent hash. The publisher is a named local operator policy, not an agent or bearer token.

The origin distributes an approved release bundle over slice-11 daemon links by explicit push or member pull. A receiver verifies canonical bytes, content hash, approval record and schema, then materializes an immutable effective organization configuration beside that agent state. The materialization records organization name, bundle hash and effective-policy hash. Operators who prefer their existing file synchronization disable link distribution; every machine validates and materializes the file on disk. Profile names are resolved only after materialization on the local machine.

A new version may tighten policy immediately. A version that would loosen a security-relevant setting is refused unless it is a separately approved apply whose nonce is bound to the exact diff; the default remains reject-and-report. An unavailable machine retains its last verified materialization, marks `stale`, and may continue only under that same-or-stricter policy until `maxStaleAge`, then stops new source, dispatch and connector work. Invalid file bytes, an unapproved/hash-mismatched bundle, invalid schema or local file drift keeps the last valid materialization and fails closed for new work. No daemon writes or merges organization files; doctor reports a version mismatch per machine.

The implicit `default` organization remains in memory for unmodified definitions. It has no file, sync or migration requirement and preserves shipped semantics. Slice 7c works on one machine without slice 11; it uses slice 11 only for its recommended cross-machine distribution and fleet status, and does not change shipped work or reorder later slices.
