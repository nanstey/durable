# Slice 11 multi-machine console evidence

| Spec item | Automated evidence |
| --- | --- |
| 1 | `test/unit/net.test.ts` verifies explicit tailnet-only address validation and allow/deny/unavailable `whois` results. `src/api/server.ts` retains loopback and adds the tailnet listener only after address discovery. |
| 2 | `src/steward/main.ts` / `src/identity/doctor.ts` assign deterministic per-agent ports and reject collisions. |
| 3, 4 | `src/api/tokens.ts`, `src/console/registry.ts`, and console tests cover scoped hashes, expiry metadata, server-side tokens and private registry storage. |
| 5 | `test/unit/console.test.ts` covers monitor mismatch and subscription cap; monitor checks devices concurrently. |
| 6 | Existing console proxy and daemon state are independent; `README.md` records the stance. |
| 7, 10 | `test/unit/console.test.ts` checks browser request guards and token non-exposure. Serve writes require same-origin/CSRF and configured identity. |
| 8 | `docs/network.md` and `durable doctor --acl` give the non-mutating policy guidance. |
| 9 | Unit seams use separate device URLs and `whois` stubs; live rig remains operator evidence. |

## Pending operator: live tailnet drill

1. Tag daemon hosts `tag:durable-daemon` and the console host `tag:durable-console`; apply the ACL printed by `durable doctor <agent> --acl`.
2. On each daemon set `network.bind: tailnet`, `peerCheck: required`, and `allowedPeers: [tag:durable-console]`; start two independent daemons (two local homes are acceptable).
3. Create a `read,chat,pause` console token for each daemon, pipe each token to `durable console add-device`, then run the command printed by `durable console serve` (never Funnel).
4. Set the Serve hostname and operator login allowlist in console configuration. From laptop and phone browsers, verify equivalent fleet, chat/scout, transcript, pause, interrupt and capability-gated steer controls.
5. Rotate one daemon token by adding the replacement registry device token before revoking the old client. Confirm the SSE reconnects and continues.
6. Stop or unplug the console host while agents work; verify their GitHub-side claim/gate activity continues, then restart the console and confirm the view returns.

Status: **pending operator**. Do not record identities, hostnames, URLs, tokens, or repository names in this public file.
