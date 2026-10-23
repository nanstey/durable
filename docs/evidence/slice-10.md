# Slice 10 second-machine and lease evidence

## Automated evidence

| Spec item | Evidence |
| --- | --- |
| 0, 1, 2b | `test/unit/claims-pipeline.test.ts`: fake GitHub and fake clock prove expiry, grace, world re-read, lost returning holder and fresh replacement attempts for Pi-session and durable-conversation workers. |
| 2 | `test/unit/claims-pipeline.test.ts`: concurrent claims elect the lowest comment ID and only the winner proceeds. |
| 3 | `test/contract/stream-service.test.ts`: non-Linux service selection skips with a Linux/systemd --user message. |
| 4, 7 | `docs/install.md`, `docs/operator.md`: pinned-clone and standalone bring-up, per-machine profile guidance, linger setup and combined polling guidance. |
| 5 | `test/unit/hygiene.test.ts` and `pnpm hygiene`: fixture scans reject paths and secrets; Durable's install and runtime state live outside the repository. |

## Pending operator: two-machine drill

This requires two Linux hosts, distinct Pi profiles and GitHub identities, and a
real low-risk repository. It does not run in automated tests.

1. On each host, complete the add-machine flow in `docs/operator.md`. Give each
   `machine.yaml` a different `name`, assign the same agent definition, and use a
   different profile name and GitHub identity.
2. Configure a short temporary lease (`schedule.leaseSeconds: 120`,
   `leaseGraceSeconds: 30`) and `pollSeconds: 30` in a private definition. Label
   one low-risk issue so both agents consider it eligible.
3. Start both services. Confirm GitHub has one `durable/claimed` marker, one
   worker launch and no duplicate draft PR.
4. Kill the winning steward without graceful shutdown. Confirm the other steward
   does not launch work before 150 seconds from the marker expiry, then confirm it
   creates a new attempt from pushed branch state and opens no duplicate PR.
5. Restart the killed steward. Confirm its GitHub re-read records `claim-lost`, it
   does not touch the item or launch a worker, and the surviving steward owns the
   only active marker.
6. Restore the normal lease and polling settings. Record timestamps, comment IDs,
   branches, worker kind and PR URLs in the operator's private run record; do not
   commit identities, paths, tokens or repository names.

Status: **pending operator**.
