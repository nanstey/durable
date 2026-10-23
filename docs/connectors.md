# Connectors

Connectors are opt-in worker tools. They are not intake sources and their output is untrusted text. Empty `connectors:` is the default.

Each agent definition declares a provider, profile-bound connection alias, exact tools, read/write class, and call/cost ceilings. A write requires both `access: write` and `write: true`. Durable invokes only these declarations through its mediator; workers receive fixed wrappers, never a provider client, endpoint, or credential.

Connector credentials/configuration are not copied into worker or durable-shell environments. Ambient `COMPOSIO_*`, `MCP_*`, and `CONNECTOR_*` variables are scrubbed. The selected agent profile is part of every mediation call, so there is no default or most-recent account fallback.

Every call checks the kill switch and connector budget immediately before invocation. Durable writes redacted start and finish audit records with provider, connection alias, tool class, byte counts, outcome, duration, budget delta, and vendor request ID. Content and credentials are never audited. Results are capped at 100 KB and labelled untrusted; they cannot affect gates, approvals, holds, definitions, or merge authorization.

## Providers and custody

`fake` is the only enabled provider. It is deterministic and exists for contract tests and operator configuration checks. Composio remains disabled pending an explicit third-party credential-custody decision and a pure-JavaScript provider spike. No hosted OAuth or connected account is enabled, and no provider receives an ambient credential. The pricing/limit research was checked 2026-10-23; recheck it before enabling a live provider.

`durable connectors list [agent]` and `durable connectors show [agent] <connector>` display only declaration metadata. They never display credentials.

Pi-session connector bridging remains a provider/runtime spike. It must forward only to the same steward mediator; arbitrary MCP servers and raw SDK access are not permitted.
