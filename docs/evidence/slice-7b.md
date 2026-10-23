# Slice 7b evidence

| Spec item | Status | Evidence |
| --- | --- | --- |
| 1 Schema and doctor | Implemented | `src/config/{jsonSchemas,schema}.ts`, `src/identity/doctor.ts`; connector defaults, closed schema, duplicate/write/budget checks. |
| 2 Provider seam | Implemented (fake only) | `src/connectors/{types,fake,select,mediation}.ts`; cancellation, availability, output cap and redaction are covered by connector tests. |
| 3 Profile-bound credentials | Implemented | `src/identity/env.ts` scrubs connector ambient/profile variables; mediator requires the selected profile. |
| 4 Code-owned worker exposure | Implemented for durable-conversation | `src/workers/durable/{tools,anchor}.ts` registers fixed allowlisted wrappers. Pi-session bridge is a pending runtime spike. |
| 5 Authorization/classification | Implemented | `ConnectorMediator` rejects unknown/reclassified tools and writes without `write: true`. |
| 6 Limits, stop and audit | Implemented | `ConnectorMediator` checks kill switch and budgets, propagates abort signals, and emits redacted start/finish audit events. |
| 7 Untrusted boundary | Implemented | Connector result is forcibly `untrusted`, size capped, and rendered with an untrusted label. Existing gate facts do not consume connector output. |
| 8 Custody/provider decision | Implemented | `docs/connectors.md`; hosted Composio remains disabled pending operator acceptance. |
| 9 Organization policy | Not implemented | Explicitly slice 7c; no organization files were changed. |
| 10 Docs and pilot | Implemented except live pilot | `docs/connectors.md`; fake tests cover the mediation path. Live provider pilot awaits custody decision and provider spike. |
