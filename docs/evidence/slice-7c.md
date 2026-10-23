# Slice 7c evidence

| Item | Evidence |
| --- | --- |
| Local schema and default compatibility | `test/unit/organizations.test.ts` validates strict documents, sibling directory lookup, and unchanged implicit-default materialization. |
| Approval, materialization, and isolation | `src/config/organizations.ts` requires a matching approved hash-pinned release for named policies, persists only immutable non-secret materialization metadata, and applies organization limit/quiet-hour ceilings before runtime profile resolution. `test/unit/organizations.test.ts` covers rejection of an unapproved named policy. |
| Per-organization stop control | `src/steward/killswitch.ts` maintains a separate organization pause fence; `src/steward/workerSetup.ts` applies it only to member runtime dispatch. `test/unit/steward.test.ts` proves another organization remains runnable. |
| Attribution | `src/steward/audit.ts` records organization and bundle hash; `/v1/device` includes an organization id and bundle hash. |
| Connector ceiling | `src/connectors/select.ts` rejects connector/tool/access outside a named organization policy. |
| Documentation | `docs/organizations.md`. |

## Pending operator / fleet evidence

Slice-11 daemon links are not present in this repository revision. A live two-machine pilot, explicit push/member-pull bundle transport, reachable-member version states, stale-age expiry, and console/SSE fleet grouping require that dependency. Do not treat `durable org sync` as network transport; it reports the supported operator-managed local-file mode. These remain pending operator/fleet work rather than claimed as implemented.
