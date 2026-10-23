# Spec 10 — Second machine and claim leases (Linux)

Objective: a second machine runs its own steward under its own copy of the profile (often the same GitHub account, since the identity is the operator's); two stewards never work the same item; install and bring-up are one `install.sh` run plus profile steps, `machine.yaml` and a definition. No network between machines.
Design refs: architecture D3, D7, §5, §6; program design §2 (claims).
Revision 3 (Q7): Linux only for the first fleet; the launchd/macOS work is removed and deferred (D-3).
Revision 4: leases must tolerate an agent that **vanishes mid-claim** (killed OS process, asleep or offline phone): expiry + grace + world re-read take over; the vanished agent, when it returns, re-derives its claims from GitHub before acting and releases stale ones (spec 14 relies on this).
Depends on: spec 06 (claims) — it does not need the console; spec 11 is testable with two local daemons if this slice has not shipped. Revision 2: renumbered (was 09), `machine.yaml` `name` and port assignment per machine documented for the console. Revision 1: renumbered; profile names are shared labels while contents differ per machine (C1, C3); no canary repo, validation uses a real low-risk repo.

## Checklist

0. **Both worker kinds (revision 7):** the lease belongs to the item, not to the worker process; a durable-conversation worker lives only in its steward process, so a vanished machine's durable worker cannot be resumed elsewhere (single storage owner): after lease expiry another agent starts a **new attempt from the pushed branch state** (never from the other machine's conversation); Pi-session workers behave the same way (their sessions are local). A `human-held` item keeps renewing its lease while its steward is up. Acceptance: fake-GitHub tests for both kinds (kill the holder; takeover starts fresh from the branch; no duplicate PR).
1. **Lease lifecycle** in `steward/claims.ts`: lease duration from config (default 2 h), renewal while a worker lives, expiry takeover rule (another agent may take an item only after expiry + grace and a world re-read). Because both stewards post as the same account, the **agent id in the marker comment** is the only distinguishing key; document that claims are coordination, not security, release on finish/failure. Acceptance: fake-GitHub tests incl. expiry, takeover, clock skew tolerance (grace).
   2b. **Vanishing-agent test:** `SIGKILL` the holder with no graceful release (and, separately, a long stop of the process); the other agent takes over only after lease expiry + grace; on return the first agent finds the claim lost and does not touch the item; no duplicate worker or PR. Acceptance: fake-GitHub test with a fake clock; live check later on the Android daemon (spec 14).
2. **Two-process race test**: two stewards against one fake GitHub; exactly one launches a worker; the loser audits `claim-lost` and moves on.
3. **Linux-only scope:** the durable docs state that only Linux with systemd --user is supported (`loginctl enable-linger` for unattended hosts; Android is spec 14); on any other OS `durable enable` and the skills-repo installer step skip with a clear message. macOS/launchd is deferred (one line in `docs/install.md`). Acceptance: tests for the non-Linux skip (durable `ServiceManager` selection and the skills-repo installer test).
4. **Bring-up docs/skill**: "add a machine" flow in `docs/operator.md` (durable repo): either run the skills repo's `install.sh` (pinned durable clone, skills, Pi settings) or follow `docs/install.md` standalone; then `/login` under the profile name, `pi-secret -p <profile> set GH_TOKEN`, `durable profile init` + `bind-github`, write `machine.yaml` (assign agents, checkout roots, channels), copy or sync the agent definition, `durable doctor` (must fail closed if the profile is missing on this machine), `durable enable`. Cover that the same profile name has different credentials per machine.
5. **Machine-local state check**: assert no absolute machine path or secret is written under the repo during install or run (test greps a sandbox repo copy after a run).
6. **Live validation**: second machine (different Pi profile and GitHub identity) on a real low-risk repo; label one issue; confirm one worker; kill the winner; confirm lease expiry takeover.
7. **Rate-limit review**: measure combined polling cost; adjust `pollSeconds` guidance in docs.

## Risk controls

- Claim protocol relies on GitHub read-after-write ordering; ties resolved by lowest comment id; document eventual-consistency window and the grace period.
- Never let a lease takeover touch a branch with unpushed work of another agent: takeover starts a new branch name or stops and asks.
- Each machine's agent file is private; nothing machine-specific is committed.

## Out of scope

Cross-machine messaging, shared DB, Tailscale, peer calls.

## Done when

CI green; live race and takeover drills recorded; second machine installed from the pinned durable clone (through the skills repo's installer) or from durable alone; nothing machine-specific committed to either repo.
