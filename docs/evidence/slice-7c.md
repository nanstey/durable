# Slice 7c evidence

| Item | Evidence |
| --- | --- |
| Local schema and default compatibility | `test/unit/organizations.test.ts` validates strict documents, sibling directory lookup, and default materialization. |
| Approval and local release | `src/config/organizations.ts` hashes local bytes and binds one-time approval nonces to organization, parent hash, and candidate hash. |
| Connector ceiling | `src/connectors/select.ts` rejects connector/tool/access outside a named organization policy. |
| Documentation | `docs/organizations.md`. |

## Pending operator / fleet evidence

Slice-11 daemon links are not present in this repository revision. A live two-machine pilot, explicit push/member-pull bundle transport, reachable-member version states, stale-age expiry, and console/SSE fleet status require that dependency. Do not treat `durable org sync` as network transport; it reports the supported operator-managed local-file mode.
