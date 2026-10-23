# Slice 7c evidence

| Item | Evidence |
| --- | --- |
| Local schema and default compatibility | `test/unit/organizations.test.ts` validates strict documents, sibling directory lookup, and unchanged implicit-default materialization. |
| Approval, materialization, and isolation | `src/config/organizations.ts` requires a matching approved hash-pinned release for named policies, persists only immutable non-secret materialization metadata, and applies organization limit/quiet-hour ceilings before runtime profile resolution. `test/unit/organizations.test.ts` covers rejection of an unapproved named policy. |
| Per-organization stop control | `src/steward/killswitch.ts` maintains a separate organization pause fence; `src/steward/workerSetup.ts` applies it only to member runtime dispatch. `test/unit/steward.test.ts` proves another organization remains runnable. |
| Approved fleet transport and materialization | `src/api/routes.ts` exposes hash-pinned approved bundle pull and sync-scoped member receipt; `src/config/organizations.ts` verifies and stores received bundles separately from operator-managed files. `durable org sync <name> --from|--to` performs explicit member pull/origin push. |
| Offline and stale behavior | Received bundles preserve the last verified materialization while offline and block new starts after `maxStaleAge`; `test/unit/organizations.test.ts` covers convergence, offline reuse, stale expiry, and tampered-bundle rejection. |
| Fleet version visibility | `/v1/device` and daemon SSE snapshots include organization ID, bundle hash and version state. `src/console/monitor.ts` and `/api/fleet?organization=<name>` group reachable devices per organization and retain `unreachable` for offline members. |
| Attribution | `src/steward/audit.ts` records organization and bundle hash; `/v1/device` includes organization ID, bundle hash, and version state. |
| Connector ceiling | `src/connectors/select.ts` rejects connector/tool/access outside a named organization policy. |
| Documentation | `docs/organizations.md`. |

## Pending operator evidence

A live multi-machine pilot remains pending operator execution. The automated two-member fixture proves the transport and fail-closed behavior without a tailnet or production credentials.
