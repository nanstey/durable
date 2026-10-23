# Slice 3 replacement: implementation and executed evidence

Date: 2026-10-23. Scope: [spec 03](../plan/specs/03-steward-process.md).

**Implemented and locally verified; real-profile/operator inspection pending.**
The HTTP skeleton and JSON transcript imitation are replaced by Hono and native
pi-durable 1.4.0 storage, tasks and conversations. Source: **4,427 lines of
TypeScript under `src/`**. Local suite: **339 tests passed, zero skipped**,
including real user scopes and SIGKILL drills. CI hosts without a user manager
explicitly skip the 19 live-systemd cases; portable contract/gate tests still run.

## Numbered spec coverage

| Item | Implementation | Executed validation / remaining limit |
| --- | --- | --- |
| 1 | `src/steward/harness.ts` | Real adapter; capability-selected SQLite/JSONL; profile models; idempotent main/loop creation. Both backends commit an entry, close and reopen. |
| 2 | `src/steward/main.ts` | Assignment, doctor fix/audit, lock, API, graceful close. Full process-entry test rejects a second instance; identity failure queues a notice. |
| 3 | `src/steward/loop.ts`, `harness.ts` | Native repeating sleeping task; fake clock ticks twice, commits heartbeat, and stops advancing it while paused. |
| 4 | `src/steward/killswitch.ts`, `limits.ts`, `harness.ts` | Agent/global/environment stops, overnight quiet hours, UTC rollover, persisted budget stop, local TTY resume, provider/tool safety checks. |
| 5 | `src/api/chat.ts`, `routes.ts`, `harness.ts` | Plain-text field allowlist, spike corpus (12 credential cases detected; 29/30 normal cases accepted), UTF-8 ceiling, request ID/hash persistence, content-free audit, default unlimited rate and opt-in 429/Retry-After windows. |
| 5b | `src/steward/audit.ts` | Fsync JSONL, envelope and redaction; four OS processes append 120 complete unique lines concurrently. |
| 6a | `src/tree/{nodes,build,frames}.ts`, `harness.ts`, `api/routes.ts` | Real ownership-index scans and task graph; nested chat/scout/subagent tree; terminal owner re-attachment; opaque IDs; tree SSE delta. Dispatcher leaves are intentionally Slice 6. |
| 6 | `src/api/{types,routes,auth,server}.ts` | Device, sessions, transcript, tasks, audit, inbox/ack, budget, messages, abort and pause contract tests. Session aliases share native data. |
| 7 | `src/api/sse.ts` | Hello → snapshot → deltas, reconnect snapshot, fake-clock 15-second ping, bounded in-flight queue and disconnect. A real 15-second heartbeat is measured in the load probe. |
| 8 | `src/api/tokens.ts`, `auth.ts`, `cli/main.ts` | Route/scope matrix; SHA-256-only 0600 store, constant-time comparison, expiry, revoke (including open streams), last use and private local token. No bearer approval/resume/enroll/release/policy path. |
| 9 | `src/api/net.ts`, `config/schema.ts` | Literal loopback listener; wildcard/tailnet binds refused with the slice-11 diagnostic; loopback doctor configuration accepted. |
| 10 | `src/steward/inbox.ts`, `harness.ts` | Named `steward.inbox` document, persistence/ack, screened metadata; pre-harness failures are durably queued then de-duplicated into the document. |
| 11 | `src/steward/harness.ts` | Prompt section and exactly `list_queue`, `status`, `pause`; no coding tools or GitHub write tool installed. |
| 12 | `src/cli/main.ts` | Citty commands: enable/disable/start/stop/status/logs, pause, TTY resume, token create/list/revoke, run and steward run. Dry runs print effects. Worker-only stop refuses explicitly until dispatcher support; it never silently shuts down the service. |
| 12b | `src/platform/service/{types,systemdUser}.ts`, `harness.ts` | ServiceManager contract with injected command runner; core-specific command-name lint; storage selection tests. |
| 13 | `units/`, `platform/service/systemdUser.ts` | Render/install/failure-hook tests assert control-group kill, stop timeout, no-new-privileges, stable CLI symlink and no secrets. A live user-service test proves direct tool children die after main SIGKILL. Failure notification command is intentionally the spec's inert hook. |
| 13b | `src/steward/procs.ts`, `platform/*Containment.ts`, `gatedProcess.ts`, `bin/durable-gate` | Gate refusal matrix; both sides of every durable/external boundary killed; real scope sweep; recursive population test; failed cleanup retains/fences/escalates; nohup/setsid delayed writer unchanged after 15 seconds; refused scope launch; marker escape and reused-PID tests. |
| 14 | `test/contract/recovery.test.ts`, `test/fixtures/recovery-agent.ts` | SIGKILL during an owned unsafe tool; interrupted result, same child, one loop, intact heartbeat/token/inbox, old process absent after startup sweep. Normal close/reopen is tested separately without a terminal attempt outcome. |
| 15 | `spike/steward-live.ts` | **Partial:** executed real transient user-service drill through the production entry with injected faux model/identity. Curl device/SSE/transcript/inbox, read POST 403, restart, old-tool removal, pause and pseudo-TTY CLI resume pass. **Not executed:** installation/enabling against an operator's real named profile, real provider/GitHub credentials, or the operator's API-fit judgment. |
| 16 | `docs/{daemon,operator,api}.md` | Daemon/service/CLI guide, token authority, API contract, recovery limits and reproduction commands. |

## Commands executed

- `pnpm install --ignore-scripts`.
- `pnpm check` (TypeScript, Biome, Fallow dead-code/duplication) passed before
  the final launch-cancellation and identity-deadline fixes. The coordinator must
  rerun the complete check on the final commit.
- Final source: `tsc --noEmit`, Biome formatting, `pnpm test` (339/339, zero
  skipped on this cgroup-v2 user-manager host), and `pnpm hygiene` passed.
- `pnpm hygiene` and `git diff --check`.
- `node spike/steward-load.ts`: 1/2/4 busy asynchronous child tools; p95
  2.47/2.35/2.32 ms, p99 3.30/2.58/2.52 ms, real heartbeat lateness
  12.38/2.53/2.39 ms. Thresholds pass; this is not CPU-bound worker load.
- `node spike/steward-live.ts`: real user-service restart/cleanup and curl/TTY
  drill, with no operator credentials. The temporary service is stopped and
  reset afterwards; no user unit templates are replaced by this probe.

## Implementation decisions and known limits

- Startup recovery metadata must be readable **before** opening a scheduler.
  `procs.json` is therefore an atomic fsynced journal of invocations and hold/
  recovery fences, not a second process opening pi-durable storage. Failed cleanup
  keeps the record and refuses startup. Held/recovery fences are never released
  by a bearer token. Hold transitions/release authorization belong to Slice 6.
- Conversation state, `steward.budget`, `steward.inbox`, and `steward.chat` are
  native session documents. Conversation anchors are background tasks; turn abort
  never aborts their attempt. Finished transcript entries are retained.
- Daily model ceilings default to 10 dollars / 1,000,000 tokens and are configurable
  downward, including zero. Accounting after responses allows an in-flight
  response to overshoot; it blocks the next request/tool. No default chat rate
  limit is added. These budget fields were absent from the skeleton schema.
- Upstream `beforeRequest` exceptions do not stop a generation. A provider-boundary
  guard also checks the kill switch; `beforeTool` is a blocking hook. The test-only
  model/identity seams cannot be selected through CLI flags or configuration.
- Launch cancellation is tracked even before the intent commit and rechecked
  before spawn/release. Six portable pause-race tests prove a concurrent cleanup
  cannot delete a record and then allow its gate to release. Read-only startup
  identity probes have a contained deadline and may run while the agent is
  disabled; this exception is not available through the API.
- Group/marker cleanup is best effort, never proof of exclusive ownership. The
  executed fallback test demonstrates a marker-dropping setsid escape. Android
  hardware, filesystem confinement, worker write tools and sandbox hardening are
  not claimed here.
- The unit restart delay exceeds the renewable-lock stale interval. Separate
  invocation scopes can outlive a crashed steward until its startup sweep;
  the tests establish emptiness **before resume**, not an instantaneous kill at
  the moment of a crash.

## Review and deployment status

The implementation's own source checks traced bearer input, body parsing,
idempotent admission, model/tool safety, token storage, process release, recovery
and audit sinks. No real secrets were used. Dependency versions are exact pins;
no online vulnerability-advisory scan is claimed.

Lizard's changed-source scan found no newly introduced function above CCN 15.
Quiet-hours parsing was reduced from CCN 17 to small parsing/window helpers.
The existing large identity `doctor` remains a complexity follow-up; it receives
only narrow loopback/cgroup diagnostic changes here. API route/tree callbacks in
CCN 11–12 remain review-band functions.

**Independent coordinated review is not claimed.** The implementation worker
cannot dispatch reviewers. A coordinator must supply that gate before merge.
The operator's real-profile deployment and API-fit checkpoint also remains
pending; the faux drill is not substituted for it. The live faux drill preceded
the final cancellation/deadline fixes; the final native containment/recovery
contract suite passed afterwards. See [the coordinator handoff](../../progress.md).
