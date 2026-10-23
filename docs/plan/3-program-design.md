# Program design

Inputs: [1-product-review](./1-product-review.md), [2-system-architecture](./2-system-architecture.md). Revision 1 (C1-C7). Revision 2 (U1 no ntfy; U2 multi-machine console, remote-ready API, guarded approvals). Revision 3 (repo-committed, human-trusted merge policy; interactive chat; PWA-ready console; Linux only). Revision 4 (dpi-* inspiration only; platform abstraction for an Android/Termux target). Revision 5 (pluggable `RepoPolicySource` seam with mechanism-independent invariants P1-P6; no phone-specific capability gating; no default chat rate limits). Revision 7 (U6: `WorkerDispatcher` split into workspace/process hosting plus a `WorkerKind` registry with `pi-session` (default) and `durable-conversation` kinds; conversation tree API and tree TUI; human-held rule; invariants DW1-DW9, T1-T3, H1-H3). Revision 7 review (cross-family): minimal `durable-shell` environment (I4); fenced `holding -> held` sequence (H4, H5); advisory-only confinement (sandbox hardening deferred); per-attempt process containment with a gated launch handshake (S5, round 2); operation intent and reconciliation for push/PR (DW5); `ModelRuntime` instead of `AuthStorage`; named profiles only; launcher flags; per-(kind, role) required skills; kind selection precedence and truth table (§2.1); one lifecycle table (§2.2); release in the approval class; kind-neutral `ReviewResult` + `ModelProvenance`. Revision 6 (the engine lives in its own public repo `nanstey/durable`; the skills repo keeps only a thin integration; paths below are repo-root paths of the durable repo unless marked "skills repo").
This document fixes code shape only where a wrong guess would be costly. Names are proposals bound by the invariants below.

Evidence for conventions (in the skills repo, mirrored by the thin integration): `install/main.sh` (HARNESSES table, typed pairs `config|hoist|vendor-git|patch-*`), `install/modules/*.sh` (definitions only, `ok|copy|update` reports), `harness/pi/bin/pi-improve` (zero-dependency Node CLI: Orca resolution, locks, caps, kill switch, `PI_CODING_AGENT_DIR`, dry-run), `harness/pi/bin/pi-secret` and `extensions/profile-secrets.ts` (profile resolution, `secrets/<profile>.env`, same name regex), `@nanstey/pi-auth-profiles` (profile files), `@gotgenes/pi-anthropic-auth/src/{oauth-transport,host-transport}.ts` (transport wrapper), `harness/pi/tests/*` and `install/tests/install.test.sh` (offline, stubs), `.github/workflows/ci.yml`, reference `durable-pi` (`jobs.ts` `{again:{nextAt}}` repeat tasks, `extensions.ts` approval task + `beforeTool` guard).

## 1. Repository layout

### 1.1 The durable repo (public, MIT, package `@nanstey/durable`, Node >= 22, `main` protected: PRs required, squash-only)

Layout, stated once. Everything of the engine lives at the repo root of `nanstey/durable`:

```
bin/durable                          CLI entry shim (runs src/cli/main.ts with Node type stripping)
src/
  platform/  detect.ts  capabilities.ts  service/{types,systemdUser,termuxRunit}.ts  notifier/{notifySend,termuxNotification}.ts
  config/    schema.ts  agent.ts  machine.ts  manifest.ts  load.ts  paths.ts
  identity/  profiles.ts  env.ts  pidir.ts  github.ts  token.ts  modelAuth.ts  doctor.ts  skills.ts(required-skills check)
  api/       types.ts  routes.ts  sse.ts  auth.ts  tokens.ts  net.ts(whois,bind)  chat.ts(screen,size-ceiling,audit,optional-ratelimit)
  client/    client.ts  stream.ts  transcript.ts          # durable-client: our own, from scratch; used by CLI, TUI and console hub
  steward/   conversations.ts  main.ts  harness.ts  loop.ts  audit.ts  limits.ts  killswitch.ts  claims.ts  inbox.ts  procs.ts(process groups, S5)
  sources/   types.ts  githubIssues.ts  githubPrs.ts  localFiles.ts  eligibility.ts
  scout/     judge.ts  brief.ts
  dispatch/  types.ts(WorkerDispatcher: workspace + process host)  orca.ts  gitProcess.ts  fake.ts  select.ts  monitor.ts  launcher.ts  hold.ts(human-held)
  workers/   kind.ts(WorkerKind registry)  piSession.ts  durableConversation.ts  durable/{tools,confine,gitops,playbook,skills,limits,anchor}.ts   # durable worker kind (D19)
  tree/      nodes.ts  build.ts  frames.ts            # conversation tree model + API/SSE frames (D20)
  notify/    types.ts  notifier.ts  channels/{inbox,desktop,command,github}.ts  dedup.ts  reminders.ts
  gate/      policy.ts  policySource.ts(+ sources/{none,fixture}.ts)  hardPaths.ts  tighten.ts  facts.ts  decide.ts  review.ts  merge.ts  approval.ts  shadow.ts
  approval/  nonce.ts  webauthn.ts  keys.ts  challenge.ts
  console/   main.ts  monitor.ts  proxy.ts  mux.ts  guard.ts  registry.ts  auth.ts  push.ts(stub: 501 until 12b)  routes.ts   # the console hub server (our own; dpi-* inspiration only)
  tui/       main.ts  views.ts  tree.ts  transcript.ts  composer.ts   # `durable attach`: tree + transcript + capability-gated composer
  guard/     commands.ts
  cli/       (commands: doctor, profile, status, queue, inbox, audit, attach, ask, chat, approve, policy, stop, enable, token, notify, console, approval, ...)
web/         console static front end, NO build step: index.html app.js views/*.js style.css sw.js manifest.webmanifest vendor/{preact,htm}.js + SHA256SUMS
schema/      generated JSON Schemas (agent, machine, profile-meta) + drift test
examples/    agent.example.yaml  machine.example.yaml  profile-meta.example.json   (placeholders only)
units/       durable-agent@.service  durable-agent-failure@.service  durable-console.service     (systemd user; rendered/installed by `durable enable`, not by an installer)
termux/      bootstrap.sh  service-run.tmpl  log-run.tmpl                                     (Android/Termux, slice 14; clones and pins this repo directly)
templates/   worker-brief.md  reviewer-brief.md
pi-extension/ durable-worker-guard.ts   (Pi extension for workers; loaded through the derived per-agent Pi settings, so it needs no installation into the user's Pi directory)
test/        unit/  contract/ (dispatcher, policySource, recovery)  rig/ (two daemons + fake tailnet)  fixtures/{github,orca}/ (recorded, scrubbed)  hygiene.test.ts
scripts/     hygiene-scan.sh  hygiene-allow.txt                                              (public-repo secret/path/host scan, run in CI)
docs/        operator.md  architecture.md  security.md  console.md  network.md  workers.md  android.md  install.md  skills-contract.md     (the real documentation)
docs/plan/   this plan (README.md index, 1-product-review.md ... 4-vertical-slices.md, specs/)
docs/evidence/ spike.md  android-checklist.md                                                (slice 1 results)
spike/       throwaway slice 1 scripts (excluded from the npm package via `files`; may be deleted after slice 1)
.github/workflows/ci.yml   unit + contract tests, `tsc --noEmit`, hygiene scan
package.json  pnpm-lock.yaml  tsconfig.json  LICENSE(MIT)  README.md  AGENTS.md
```
The console server stays in `src/console/` (it shares types and the client with the rest of the TypeScript tree) and the static front end in `web/`; there is no separate `console/` top-level directory.

**Public repo rules (durable repo):** no secrets, no machine-local state, no absolute or personal paths, no real host or tailnet names, no personal emails, no private repo names in any committed file; examples and docs use placeholders (`<console-host>`, `<operator-login>`, `acme/api`, `operator@example.invalid`). Enforced by `scripts/hygiene-scan.sh` in CI from slice 2 (spec 02) and by review.

### 1.2 The skills repo (this repo): thin integration only (spec 02b)

```
harness/durable/vendor/nanstey-durable.txt   NEW  `<url> <40-char commit>` pin manifest, same format as harness/pi/vendor/*.txt
harness/durable/README.md                    NEW  managed-file table for the integration (repo path, install destination, purpose); not installed
harness/durable/bump-pin.sh                  NEW  resolves a ref to a full SHA (git ls-remote) and rewrites the manifest line; idempotent; offline-testable
install/modules/durable.sh                   NEW  install_durable_deps (pnpm install --frozen-lockfile --prod in the pinned clone, stamped), install_durable_cli_link (~/.local/bin/durable)
install/main.sh                              EDIT a `vendor-git` pair for the durable clone plus the two functions above (see spec 02b for the exact mechanism)
install/tests/install.test.sh                EDIT cases: clone/ok/update with stub git, deps stub, CLI link, skip on old Node, run twice
skills/agent/durable/SKILL.md                NEW  thin operator skill: what durable is, key commands, link to the durable repo docs
README.md                                    EDIT catalog row for the skill
harness/pi/README.md                         EDIT one table row documenting the contract between Pi's directory and durable (derived per-agent Pi dirs symlink auth-profiles/, secrets/, profile-meta/, extensions/, skills/, agents/, prompts/; `profile-meta/<name>.json` is created by `durable profile`)
```
Not in the skills repo any more: the engine, console, client, TUI, API, schemas, tests, units, Termux bootstrap, examples, docs, the worker guard extension, the spike, and this plan. The skills repo still owns: the skills and agent profiles durable workers reuse (`idea-to-pr`, `pr`, `build`, `review-code`, `handoff`, ...), Pi settings and patches (including slice 13), and the installer.

### 1.3 Machine-local layout (unchanged)

`$DURABLE_HOME` (default `~/.pi/durable`) holds `agents/<id>/{state.sqlite,audit.jsonl,token,gh/,gitconfig,pi/,disabled,lock}`, per agent `tokens.json` (hashed), `port`, `approval/`, and `vendor/` (the pinned durable clone when installed through the skills repo); definitions in `~/.config/durable/agents/<id>.yaml` (`DURABLE_AGENTS_DIR`); `~/.config/durable/machine.yaml`; on a console host `~/.config/durable/console/{console.yaml,devices.yaml,ui-state.json,push-subscriptions.json}`; profiles under `$PI_AGENT_DIR/{auth-profiles,secrets,profile-meta}`.

## 2. Key types and invariants

```ts
// config/*.ts — TypeBox schemas, unknown keys rejected, peers must be [], network.bind must be "loopback".
type AgentDef   = Static<typeof AgentDefSchema>;    // no secrets, no absolute paths (validator rejects "/" or "~" prefixed path fields)
type MachineCfg = Static<typeof MachineSchema>;
type ProfileManifest = Static<typeof ManifestSchema>;

// identity/profiles.ts — mirrors @nanstey/pi-auth-profiles + pi-secret name regex ^[A-Za-z0-9._-]+$ (not "." or "..")
resolveProfile(name): { authFile: string; secretsFile: string; manifestFile: string; isDefault: boolean }
// INVARIANT P1: never falls back to another profile or to auth.json. Agents use NAMED profiles only: "default" is refused unless machine.yaml profiles.allowDefault=true, and then only for in-process users (steward, durable workers) that open the canonical auth.json path string; no live credential file is ever symlinked (directory symlinks only; the spike lost updates through a file symlink). Credential writes are lock + in-place write (no atomic rename).
listProviders(profile): string[]       // top-level provider ids of the profile file, parsed read-only; values never resolved or printed (AuthStorage is not exported since pi-coding-agent 0.80.8)

// identity/env.ts
buildAgentEnv(def, machine, role: "steward" | "worker" | "reviewer" | "durable-shell", ctx): NodeJS.ProcessEnv
// INVARIANT I1: built from an allowlist + profile secrets + manifest; never from process.env wholesale.
// INVARIANT I2: for steward|worker|reviewer: GH_TOKEN (and GITHUB_TOKEN), GH_CONFIG_DIR, GIT_CONFIG_GLOBAL/SYSTEM, PI_CODING_AGENT_DIR always set; ambient provider keys never survive.
// INVARIANT I4: "durable-shell" (a durable worker's bash) is a minimal allowlist (PATH, LANG/LC_*, TERM, TZ, scratch HOME and TMPDIR, credential-free GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM=/dev/null, GIT_TERMINAL_PROMPT=0, empty GH_CONFIG_DIR, DURABLE_WORKER=1). It never contains GH_TOKEN, GITHUB_TOKEN, any secrets/<profile>.env entry, any provider key, PI_CODING_AGENT_DIR, SSH_AUTH_SOCK or DURABLE_HOME (test: both aliases + provider secrets in the profile file and the parent env never reach it).

// identity/modelAuth.ts — the swap seam for the Anthropic decision
createModelsFor(profile: ResolvedProfile, providers: string[]): Models   // plain = ModelRuntime.create({ authPath: profile.authFile }) (public, pi-coding-agent 1.4.0; own pi-ai CredentialStore as fallback) | anthropicShaped (spike decides)
// model changes on an existing conversation go through configure(); harness.root(ctx, { agent }) applies the agent only on creation.

// identity/doctor.ts
doctor(def, machine, env): Promise<DoctorReport>   // { checks: {name, ok, detail, fix?}[]; ok }
// INVARIANT I3: steward start and every dispatch call doctor-lite; false => refuse. A missing profile yields a fix string listing exact steps.

// dispatch/types.ts — WorkerDispatcher: WHERE work lives (C7, split in revision 7). Adapters: orca, git-process, fake.
interface WorkerDispatcher {
  readonly kind: string;                                                  // "orca" | "git-process" | ...
  capabilities(): { visible: boolean; processHost: boolean; viewer: boolean };   // processHost=false means durable-conversation workers only get a workspace
  createWorkspace(spec: WorkspaceSpec): Promise<Workspace>;              // idempotent by spec.id; list-before-create
  removeWorkspace(ws: Workspace, opts: { force: false }): Promise<void>; // refuses dirty, unpushed or human-held work
  listWorkspaces(filter: { agent: string }): Promise<Workspace[]>;
  hostProcess?(ws: Workspace, p: ProcessSpec): Promise<ProcHandle>;      // pi-session kind: a Pi process (Orca terminal or detached); idempotent by p.id
  processStatus?(h: ProcHandle): Promise<{ state: "running"|"exited"|"missing"|"unknown"; exitCode?: number; lastActivityAt?: number }>;
  interruptProcess?(h: ProcHandle, mode: "soft" | "hard"): Promise<void>;
  sendInput?(h: ProcHandle, text: string): Promise<void>;                // orca: terminal send; present only if supported
  readOutput?(h: ProcHandle, cursor?: Cursor): AsyncIterable<string>;
  openViewer?(ws: Workspace, v: ViewerSpec): Promise<AttachInfo>;       // create a terminal running `durable attach ...`; may return {kind:"command"} when unsupported (D20)
  workspaceTerminals?(ws: Workspace): Promise<TerminalInfo[]>;           // advisory: foreign-terminal detection for the human-held rule
}
type WorkspaceSpec = { id: string; repo: string; baseRef: string; name: string };           // deterministic id: durable-<agent>-<item>
type ProcessSpec  = { id: string; title: string; argv: string[]; env: Readonly<Record<string,string>> };   // env already built by identity/env
type ViewerSpec   = { title: string; command: string };                                      // e.g. "durable attach <agent>/<conversation>"
type AttachInfo   = { kind: "orca-terminal"; handle: string } | { kind: "command"; command: string; openIn?: "orca-terminal" };

// workers/kind.ts — WorkerKind: WHAT runs in the workspace (revision 7). Registry keyed by "pi-session" (default) | "durable-conversation".
interface WorkerKind {
  readonly kind: "pi-session" | "durable-conversation";
  capabilities(): KindCapabilities;                                      // { attach, steer, transcript, interrupt, resumeAfterCrash, skills, extensions, anthropicOAuth, headless, processIsolated, tokenInShell, viewable }
  start(ws: Workspace, job: JobSpec): Promise<WorkerHandle>;            // idempotent by job.id; the kind obtains the workspace from the dispatcher first
  status(h: WorkerHandle): Promise<WorkerStatus>;                       // { state: "running"|"done"|"failed"|"aborted"|"held"|"missing"; lastActivityAt? }
  result(h: WorkerHandle): Promise<WorkerResult>;                       // PR discovery is NOT here (GitHub via monitor)
  interrupt(h: WorkerHandle, mode: "soft" | "hard"): Promise<void>;
  steer?(h: WorkerHandle, text: string): Promise<void>;                 // only when capabilities().steer; 501 not_supported otherwise
  transcript(h: WorkerHandle, from?: Cursor): AsyncIterable<TranscriptFrame>;
  resume(h: WorkerHandle): Promise<WorkerHandle>;                       // pi-session: re-launch `pi --continue`; durable: re-attach via the ownership index (pi-durable resumes it)
  describe(h: WorkerHandle): TreeNodeInfo;                              // feeds the conversation tree (D20)
}
type JobSpec = { id: string; role: Role; profile: string; briefText: string; model: string; thinking: string;
                 env: Readonly<Record<string,string>>; limits: { itemMinutes: number; maxTurns?: number; maxToolCalls?: number; tokenBudget?: number };
                 skills?: string[] };                                  // skills only honoured by the durable kind (allowlisted prompt text)
type KindCapabilities = { attach: "none"|"read"|"interactive"; steer: boolean; transcript: boolean; interrupt: boolean; resumeAfterCrash: boolean;
                          skills: "full"|"allowlisted-text"; extensions: boolean; anthropicOAuth: "extension"|"modelAuth-option"; headless: boolean;
                          processIsolated: boolean; tokenInShell: boolean; viewable: "terminal"|"durable-attach" };
// kind x capability (defaults): pi-session = {attach: interactive(orca)|read(git), steer: orca only, transcript: jsonl tail, interrupt: true, resumeAfterCrash: false, skills: full, extensions: true, anthropicOAuth: extension, headless: false, processIsolated: true, tokenInShell: true, viewable: terminal}
//                               durable-conversation = {attach: interactive via durable attach, steer: true, transcript: native, interrupt: true, resumeAfterCrash: true, skills: allowlisted-text, extensions: false, anthropicOAuth: modelAuth-option, headless: true, processIsolated: false, tokenInShell: false, viewable: durable-attach}

// workers/durable/* — durable-conversation worker kind (architecture D19)
// INVARIANT DW1 (ownership): the child conversation is created in a transaction with ownership {kind:"task", taskId: runWorkerTaskId}; run-worker is a BACKGROUND task owned by the item's WorkItemTask (loop-owned); the steward main conversation is only the logical tree parent. A rerun reuses the child through scanConversations({ownerTaskId}).
// INVARIANT DW2 (kill switch beats background): every worker tool call passes beforeTool(killswitch, budgets, human-held); WorkItemTask watches kill switch, human-held, itemMinutes and explicitly aborts run-worker (explicit abort crosses the background boundary and writes a terminal outcome); `durable stop --workers` uses abort({background:true}); daemon close() writes no outcome so unfinished workers resume on restart unless already aborted. Effects, outcomes and restart rules of every stop-like operation: the lifecycle table (§2.2).
// INVARIANT DW3 (tool set is fixed in code): worker = read, edit, write, bash, plus code-owned commit, push_branch, open_draft_pr, report; reviewer (read-only) = read, search, pr_diff, report_verdict (no bash, no writes). No subagent tool; no tool that reads secrets; outputs screened.
// INVARIANT DW4 (guardrails, NOT a boundary): file tools resolve realpath inside the worktree and outside .git/ (symlink and `..` escapes refused; enforced for file tools only); bash cwd = worktree, own process group, env = buildAgentEnv(def, machine, "durable-shell") (I4); the shared guard/commands.ts block-list (push, merge, rebase, reset --hard, branch switching, worktree, gh pr merge, --admin, --force, cd/absolute paths outside the worktree) runs in beforeTool. bash runs as the operator's OS user, so outside-worktree reads/writes (interpreters, scripts, credential files by absolute path) remain possible; a known-limits suite asserts exactly that (R47). The only guarantee is credentials omitted from the shell environment (I4); code-owned tools are the supported, guarded GitHub write path, not an enforced one (a shell could read a credential file and push directly). Sandbox hardening (bubblewrap/container) is deferred, with its config, to a follow-up spec.
// INVARIANT DW5 (code-owned git/GitHub, replay-safe by intent): before any effect commit steward.ops/<attemptId> {op, repo, branch, commitSha, expectedRemoteHead, state}; one in-flight op per (item, op); push exactly commitSha to refs/heads/durable/<id>/<item> as a plain fast-forward push (never +/--force/--force-with-lease) to an explicit URL from a steward-owned git dir, hooks and fsmonitor disabled, worktree git config ignored; read the remote head through the API before and after; an ambiguous outcome is reconciled by that read (== commitSha confirmed; == expected retry same record; else conflict -> needs-human, never overwrite). open_draft_pr looks up by head branch + marker before and after create and refuses a PR whose head SHA differs from commitSha.
// INVARIANT DW6 (recovery): replay-safe tools rerun; non-replay-safe tools return `interrupted`; the playbook tells the model to inspect git status and files after an interrupted result; after restart the WorkItemTask re-attaches via the ownership index (no re-dispatch).
// INVARIANT DW7 (skills): the kind loads no user skills, extensions, prompts or packages; `skills` allowlist entries are read as SKILL.md body text only, size-capped, inlined as prompt sections; an entry whose text requires subagent/codemode/scripts is rejected. Default empty.
// INVARIANT DW8 (single owner): all durable worker conversations live in the agent's steward storage; maxConcurrent (default 2; Android 1) is enforced in code; no cross-process access to the storage; retention/export of finished worker conversations is configurable.
// INVARIANT DW9 (model auth): the child uses createModelsFor(profile, providers); Anthropic OAuth only if the modelAuth option is on; a reviewer of the opposite family must be resolvable before launch or launch is refused.
// workers/* + dispatch/hold.ts — human-held rule
// INVARIANT H1: a workspace item with a hold fence (state holding or held) is never resumed, re-dispatched, written to, pushed from or cleaned up by the daemon, for either kind; the claim and lease are kept.
// INVARIANT H2: `durable hold <item>` = POST /v1/items/<item>/hold (scope pause); `durable release <item>` = POST /v1/items/<item>/release, an approval-class action (CLI nonce from slice 6b, passkey from 12a) bound to {agent, action: "release", item, holdEpoch}: no bearer scope can release, and a credential for another item, another action or an older holdEpoch is rejected.
// INVARIANT H4 (fence before resume): steward/main.ts loads steward.holds before harness.open() resumes any task; a "holding" fence completes its sequence, a "held" fence stays in force.
// INVARIANT H5 (holding -> held): (1) commit the fence {holdEpoch++, state: holding}; (2) reject every new daemon operation on the item; (3) interrupt soft, then hard after drainSeconds (durable: explicit abort of run-worker, outcome held); (4) kill the item's containment unit (S5) and wait until it is empty (Linux: the attempt slice's cgroup); (5) only then state: held, audit, acknowledge. If containment cannot be confirmed empty (Android: no cgroups; Linux: kill/wait failure or timeout) the item stays fenced in "holding", never "held", escalates, and names the independent check: Linux, stop the slice and confirm populated 0; Android, stopping the steward is NOT enough (unmarked setsid descendants survive), so the operator verifies with `durable hold --verify` (processes with cwd/open files under the worktree) and kills them, or force-stops Termux / reboots, before editing.
// INVARIANT H3: foreign terminals in a worker's workspace (workspaceTerminals) are reported as advisory `suspected human session`; they never block by themselves.
// tree/* — conversation tree (architecture D20)
type TreeNode = { id: string; parentId: string | null; kind: "steward"|"chat"|"scout"|"worker-durable"|"reviewer-durable"|"worker-pi"|"reviewer-pi"|"subagent";
                  status: "idle"|"running"|"waiting"|"done"|"failed"|"aborted"|"holding"|"held";   // holding: fenced, takeover unconfirmed (rendered "holding: do not edit yet") item?: string; ownerTaskId?: string; source: "durable"|"dispatcher";
                  workspace?: string; startedAt: number; capabilities: { attach: string; steer: boolean; transcript: boolean; interrupt: boolean; resumeAfterCrash: boolean } };
// INVARIANT T1: the tree is built from the durable ownership index and taskGraph for source "durable" and from the WorkerKind registry for source "dispatcher"; node ids are opaque; the same builder serves GET /v1/conversations?tree=true and the SSE `tree` frames for the CLI, TUI and console.
// INVARIANT T2: a client sees a control (follow-up, steer, abort, interrupt) only if node.capabilities allows it AND its token scope permits it; nothing is hard-coded per client type.
// INVARIANT T3: `durable attach` and every viewer terminal use only the typed client; closing a viewer never affects a worker.
// INVARIANT W1: adapters and kinds never read process.env for credentials or forward ambient env; they pass `env` (allowlist-built) only.
// INVARIANT W2: nothing in the contract assumes a local filesystem (a remote adapter can fit); secrets are resolved on the executing host via profile name.
// INVARIANT W3: a dispatcher contract suite runs against every adapter with a fake `pi` binary (and the fake adapter) and asserts W1, idempotency, interrupt, dirty- and human-held-refusal; a kind contract suite runs against both kinds (with a faux model for the durable kind) and asserts the same acceptance flow (claim -> workspace -> work -> draft PR), capability reporting, interrupt and resume.

// gate/decide.ts — pure; no I/O; table-tested
decide(policy: EffectivePolicy, facts: GateFacts): { action: "merge" | "wait-human" | "block"; reasons: string[]; shadow?: boolean }
// INVARIANT G1: unknown/null fact => wait-human. G2: mode "never" => wait-human. G3: "merge" only if every required fact is true.
// INVARIANT G4: LLM-derived facts (risk class, review verdict) can only lower the outcome.
// INVARIANT G5: gate/merge.ts is the only module that spawns `gh pr merge`; always --match-head-commit; never --admin/--force (lint test).
// INVARIANT G6: facts come only from GitHub-computed fields and the steward's own records. Labels, comments, statuses and reactions authored by the shared identity are NEVER inputs (except `durable/hold`, which can only block).
// INVARIANT G7: shadow=true => decide() output is computed and audited as would-merge, but the executor performs the human-approval path.
// gate/policySource.ts + hardPaths.ts + tighten.ts — the policy MECHANISM is undecided; only the seam and invariants are fixed (architecture D8, §3.6)
interface RepoPolicySource { kind: string; resolve(repo): Promise<PolicyResolution>; protectedLocations(repo): ProtectedLocation[]; describeChange(repo, since): Promise<ChangeSummary> }
type PolicyResolution = { state: "verified" | "unverified" | "invalid" | "unavailable" | "none"; policy?: AutoMergePolicy; ref: string; fingerprint: string }
effectivePolicy(resolution: PolicyResolution, def: MergeDef): EffectivePolicy      // intersection with the definition; the definition may only tighten; clamps and records warnings
isHardPath(path, protectedLocations): boolean                                      // CODEOWNERS variants, .github/**, plus the source's protected locations
// built-in sources: `none` (state "none", auto off; default) and `fixture` (tests). Real sources are chosen per repo later; nothing here names a file, path or pin format.
// INVARIANT P1 (was G9): a source reads only from a trusted ref/location the STEWARD resolves and records; never from a PR head, fork, worker worktree or any worker-writable filesystem. Sources take no path/ref from PR or worktree input (lint test).
// INVARIANT P2 (was G10/G11): auto-merge needs state "verified"; a source may return "verified" only on evidence the agent cannot forge (an approval-class human action, or GitHub-computed state). The `verify-policy` approval action carries source-supplied display data (describeChange).
// INVARIANT P3 (was G12): a PR touching a hard path or any protectedLocation yields wait-human (policy-or-owner-file-change), is never would-merge in shadow mode, and is excluded from any auto path; after such a change the policy state drops to "unverified" until re-verified through the approval class. Changes to GitHub rules/CODEOWNERS are treated the same.
// INVARIANT P4 (was G14): missing, unparseable, invalid, unavailable or unverified policy => auto-merge disabled (human-approval path unaffected). `none` is such a state.
// INVARIANT P5 (was G13): effectivePolicy never loosens: each numeric/set field = most restrictive of policy and definition; the definition cannot enable auto-merge without a verified policy that says enabled: true (reason no-verified-repo-policy).
// INVARIANT P6: shadow mode first; never --admin or any bypass; policy state, kill switch and daily cap are re-checked immediately before any merge call (G5).
// INVARIANT G8: reviewDecision REVIEW_REQUIRED from GitHub rules => wait-human with reason github-requires-approval-from-other-account; no override exists.

// approval/* — credential classes (D15). Bearer tokens (scopes read|chat|pause) NEVER approve, resume an agent, enroll, verify a policy or release a hold. Actions: approve | resume | enroll | verify-policy | release.
issueNonce(action, item, binding): string          // CLI path (release from slice 6b; approve/resume/verify-policy from slice 7). binding = headSha (approve), holdEpoch (release), fingerprint (verify-policy). Returned to the notifier for nonce-safe desktop/command ONLY; steward stores sha256(nonce+agent+action+item+binding)+expiry; never logged, never in any file, GitHub object, inbox or API response
verifyNonce(action, item, binding, code): boolean  // constant-time; single use; expires; a nonce for another action, item or binding fails
issueChallenge(action, item, binding): Challenge   // console path; public, single use, short expiry, bound to {agent,action,item,binding}; returns display data from daemon state
verifyAssertion(challengeId, assertion): Verified | Rejected   // WebAuthn: signature over the stored challenge, origin + rpId from machine.yaml, counter, enrolled public key, head SHA unchanged
// INVARIANT A1: the only code paths that can authorize an approval or resume are verifyNonce and verifyAssertion. No route accepts a bearer token for them.
// INVARIANT A2: the daemon, not the console, verifies assertions. The console holds no signing key and no approval secret.
// INVARIANT A3: enrollment of the first key requires an enrollment code printed on a TTY on the daemon's machine; later keys require an existing key's assertion. Every enroll/approve/resume is audited and notified (desktop/command).
// INVARIANT A5: verify-policy challenges carry display data produced by the daemon from the source's describeChange (what changed since the last verified fingerprint, from the daemon's own reads), never supplied by the client.
// INVARIANT A4: an approval authorizes only an attempt to merge within GitHub rules for that exact head SHA (gate re-runs). It never changes policy.

// notify/notifier.ts
notify(event: NotifyEvent): Promise<void>   // maps event -> channels via def.notify; dedup(agent,event,target,sha) with TTL; quiet-hours hold (never drop); reminders; redacted payload (ids, titles, URLs)
// channels: inbox|console (always writes steward.inbox), desktop, command, github(targetLogin != agent login; else skipped with an audit note). No other kinds exist.
// INVARIANT N1: payloads never contain bodies, tokens or nonces. The CLI approval nonce is the single exception and goes only to `desktop` and `command` channels.
// INVARIANT N2: no inbound network is required for notifications; the notifier only makes outbound calls (Web Push, when enabled in slice 12b, is sent by the console, not by daemons).

// api/* — daemon API v1
// INVARIANT D1: every route requires a scoped bearer token (read | chat | pause) except /healthz; scope table in architecture §3.3; 403 on scope mismatch.
// INVARIANT D2: tokens are stored hashed; creation prints the token once; no endpoint ever returns a token.
// INVARIANT D3: SSE sends hello -> snapshot -> deltas; reconnect = new snapshot; slow viewers are dropped.
// platform/* — capability flags and interfaces (architecture D17)
interface ServiceManager { install(agent): Promise<Result>; enable(agent): Promise<Result>; disable(agent): Promise<Result>; start(agent): Promise<Result>; stop(agent): Promise<Result>; status(agent): Promise<ServiceStatus>; logs(agent, opts): AsyncIterable<string>; }   // impls: systemdUser, termuxRunit
interface DesktopNotifier { readonly nonceSafe: boolean; notify(e: NotifyPayload): Promise<void> }                                                         // impls: notifySend (nonceSafe true), termuxNotification (nonceSafe false)
type Capabilities = { os: "linux" | "android"; service: "systemd-user" | "termux-runit"; tailscaleCli: boolean; dispatchers: ("orca" | "git-process")[]; storage: "sqlite" | "jsonl"; desktop: "notify-send" | "termux-notification" | "none"; peerCheck: "required" | "optional" | "off" };
// INVARIANT PL1: nothing outside platform/* imports systemd, termux or notify-send specifics; the daemon core (steward/, api/, gate/, notify/) depends only on the interfaces above.
// INVARIANT PL2: capabilities are detected (TERMUX_VERSION / $PREFIX, `systemctl --user`, `tailscale` on PATH, `node:sqlite` import, `orca` reachable) and may be overridden in machine.yaml; doctor reports detected vs declared and fails on a contradiction.
// INVARIANT PL3: the approval nonce is delivered only to channels whose backend reports nonceSafe=true (notifySend, command); termuxNotification is nonceSafe=false, so on Android the CLI nonce path is unavailable and approvals need the passkey path or a GitHub merge.
// INVARIANT PL4: network.peerCheck=required needs tailscaleCli=true; with tailscaleCli=false the check is reported "unavailable (optional)" and the bearer token plus the tailnet ACL remain the baseline; no code path treats a missing peer check as a pass for approval-class actions.
// INVARIANT PL5: on os=android, merge.mode "auto-when-safe" is a doctor error unless platform.allowAutoMerge=true; default budgets are conservative; DURABLE_HOME must be under the Termux private $HOME (never /storage or ~/storage).
// INVARIANT PL6: daemon dependencies install with `--ignore-scripts` and are pure JavaScript (including the WebAuthn verifier); storage is chosen by capability (sqlite via node:sqlite, else jsonl).

// api/chat.ts + steward/conversations.ts — interactive chat (architecture D16)
// INVARIANT CH1: message bodies are plain text only; the API has no role, attachment, HTML or tool-call field; max bytes enforced (default 8192).
// INVARIANT CH2: credential screening on every message (token prefixes, private-key headers, cloud-key patterns, high-entropy strings) => 400 invalid:credential-like-content. Heuristic and documented; the model has no secret-reading tool.
// INVARIANT CH3 (Q20): no default rate limits. A body-size sanity ceiling (default 1 MiB, configurable via chat.maxMessageBytes) protects the daemon process from a runaway client or loop; rate limiting exists only if the agent opts in (chat.rateLimit) => 429 rate_limited. Runaway cost stays bounded by the existing per-agent budgets and the kill switch.
// INVARIANT CH4: every message audited {actor:human, via, client, serveUser?, conversationId, bytes, sha256}; content lives only in the conversation history.
// INVARIANT CH5: conversation kinds startable by ANY console/API client are only those in startableKinds (console-wide, not per client type) and implemented: chat, scout. Workers and reviewers are never startable by API clients; no client type (phone or otherwise) has different capabilities.
// INVARIANT CH6: chat conversations get a fixed code-defined tool set (list_queue, explain_item, status, set_priority, pause, request_merge, request_work). request_* only enqueue a request that gate/dispatcher evaluate under policy, budgets, caps, kill switch and trusted-author rules. No resume/approve/merge/edit/shell tool exists.
// INVARIANT CH7: worker steer routes call dispatcher.steer only if capabilities().steer; interrupt works for every adapter and requires scope pause.
// INVARIANT D4: non-loopback listeners are created only for network.bind=tailnet, bind only the Tailscale interface address, and reject peers failing `whois` allowedPeers.

// console/* — INVARIANTS
// C1: the browser never receives a daemon token; the proxy injects it server-side. C2: the console exposes no shell, file, config-edit or arbitrary-passthrough route (route table is an allowlist). C3: untrusted text (conversation, issue, PR, audit) is rendered as text nodes only; no markdown, no innerHTML; CSP forbids inline and remote script.
// C4: writes require same-origin Host/Origin, JSON content type and the CSRF header; Serve identity header must be in allowedUsers for any non-GET.
// C5: approve/resume/enroll/verify-policy go through the daemon's challenge/assert routes only; the console cannot approve on its own and stores no approval secret.
// C6 (PWA-ready, Q16): all URLs same-origin and relative; CSP always includes worker-src 'self' and manifest-src 'self' and forbids inline script/style; /api/push/* reserved (501 not-enabled); VAPID keys + push-subscriptions.json paths, schemas and `push.enabled` flag defined now, implemented in 12b; `web-push` lazy optional import.
// C7: chat UI sends only what the API accepts (text); the console shows capability-gated controls exactly as reported by the daemon (e.g. no steer button on a worker whose adapter has steer:false).

// steward/claims.ts
claim(item): Promise<"won" | "lost">  // label + marker comment (agent id), read-after-write, lowest comment id wins; lease renewal

// gate/review.ts — kind-neutral reviewer result (spec 07)
type ReviewResult    = { verdict: "approve" | "changes" | "blocked"; risk: "low" | "medium" | "high"; summary: string; headSha: string };
type ModelProvenance = { provider: string; model: string; family: string; entries: number; source: "pi-session-log" | "durable-entries" };
// pi-session reviewer: ReviewResult JSON file outside the checkout + provenance from the session log; durable reviewer: code-owned report_verdict tool + provenance from assistant entries.
// INVARIANT G9r: a verdict is recorded only if the schema validates, headSha equals the reviewed SHA, and EVERY successful assistant entry is of the opposite family.
```

Durable-side invariants:
- **S1 intent-first:** every external effect is preceded by a committed intent entry and uses a deterministic id (`durable/<agent>/<item>` for branch, workspace, job, label). On resume, code **re-derives** world state (GitHub/dispatcher) before acting.
- **S2 tool replay classes:** read tools `replay: "safe"`. `claim`, `startWorker`, `requestMerge`, `postComment`, `notify` and the durable worker's `commit`, `push_branch`, `open_draft_pr` are not replay-safe; "interrupted" is resolved by a world read (notify: dedup key), never by blind retry.
- **S3 steward LLM tools are narrow:** list_queue, explain_item, status, set_priority (code-validated document write), pause, and request_merge / request_work (enqueue only). No bash, no GitHub write, no resume. Chat conversations use the same set (CH6).
- **S4 kill switch** (`disabled` file, `DURABLE_DISABLED=1`, GitHub `durable/pause` (stop only), quiet hours) is checked at tick start and immediately before each side effect.
- **S5 process containment:** every subprocess runs in a containment unit registered through a gated launch handshake (intent -> spawn behind a gate -> record pid, start time, pgid, cgroup -> release; per-state recovery at start). Linux: a transient systemd user scope per invocation inside a per-attempt slice, killed and waited on until the slice is recursively empty (cgroup v2 `cgroup.events` `populated 0`, never the slice's own `cgroup.procs`; covers `setsid` descendants and groups whose leader exited); scope creation failure refuses the invocation. The gate execs only after reading the exact release token (EOF, error, mismatch or timeout exit without exec); `releasing` is committed before the token is written; every spawned state is treated as live at recovery; a record is deleted only after confirmed cleanup, and a failed cleanup keeps it and fences the item (`recovery`). Android: process group + `DURABLE_INVOCATION` env marker, best effort. Units are terminated on hold, interrupt-hard, pause, stop and shutdown, and swept at start before any task resumes (spec 03 item 13b).

### 2.1 Worker kind selection (precedence and truth table)

Role enablement and kind selection are separate. **Selection** (first match wins): (1) `machine.yaml` `workers.roles.<role>.kind`; (2) definition `workers.roles.<role>.kind`; (3) definition `workers.kind`; (4) platform default (`pi-session` on Linux, `durable-conversation` on `os: android`). **Enablement** is checked after selection: an effective `durable-conversation` needs the role in `workers.durable.enabledRoles` (default `[]` on Linux, `[worker, reviewer]` on Android); otherwise doctor fails and dispatch for that role is refused (never switched). Enablement alone never selects the durable kind. Required skills are then checked for the effective (kind, role) (spec 02 item 12).

| # | Platform | `workers.kind` | definition `roles.<r>.kind` | machine override | `enabledRoles` has r | Effective kind for role r |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | linux | unset | unset | unset | no | `pi-session` |
| 2 | linux | unset | unset | unset | yes | `pi-session` (enablement alone does not select) |
| 3 | linux | `pi-session` | `durable-conversation` | unset | yes | `durable-conversation` |
| 4 | linux | `pi-session` | `durable-conversation` | unset | no | error `role-not-enabled` (dispatch refused) |
| 5 | linux | `durable-conversation` | unset | unset | yes | `durable-conversation` |
| 6 | linux | `durable-conversation` | unset | `pi-session` | yes | `pi-session` (machine override wins) |
| 7 | linux | `pi-session` | unset | `durable-conversation` | yes | `durable-conversation` |
| 8 | linux | `pi-session` | unset | `durable-conversation` | no | error `role-not-enabled` (a machine cannot enable a role) |
| 9 | android | unset | unset | unset | yes (platform default) | `durable-conversation` |
| 10 | android | unset | `pi-session` | unset | any | `pi-session` (opt-in; needs the skills) |

### 2.2 Lifecycle operations (one table; specs 03, 06 and 06c refer here)

Automatic resume or retry happens **only** after a crash, restart or shutdown (rows 7-8) and after non-human failures within `maxAttemptsPerItem`. Every human- or policy-initiated cancellation (rows 1-6) records `cancelledBy` on the item (or the open turn), survives restarts, and the monitor never resumes, re-dispatches or restarts that work without the listed restart action.

| # | Operation | Entry points (route alias, CLI, console) | Scope / credential | Effect on running work | Outcome written | Auto retry? | How work restarts |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Abort turn | `POST /v1/conversations/<id>/abort` (any node); TUI/console Abort | `chat` | ends the node's current model turn; a worker attempt stays alive, node `waiting` | none (turn marked aborted) | no | a follow-up or steer message |
| 2 | Interrupt soft | `POST /v1/workers/<id>/interrupt {mode: soft}` (alias of row 1 on worker nodes; pi-session: `terminal send --interrupt` / SIGINT) | `pause` | as row 1 | none | no | follow-up/steer; for pi-session also `durable retry` |
| 3 | Interrupt hard | `POST /v1/workers/<id>/interrupt {mode: hard}`; also `itemMinutes`/budget exhaustion (outcome `limit`) | `pause` (limits: code) | ends the attempt: durable explicit abort of `run-worker`; pi-session process killed; item process groups terminated | `interrupted` or `limit` (terminal); item `needs-human` | no | `durable retry <item>` / `request_work` (scope `chat`, enqueue; budgets apply) -> new attempt from the pushed branch |
| 4 | Hold | `POST /v1/items/<item>/hold`, `durable hold`, console Hold | `pause` | H5 sequence (fence, reject, drain, kill containment and wait until empty, acknowledge; stays `holding` if containment cannot be confirmed) | `held` (or `holding`) | never while held | approval-class release (`POST /v1/items/<item>/release`, nonce or passkey) -> re-derive, new attempt or review |
| 5 | Pause / kill switch | `POST /v1/pause`, `durable pause`, `disabled` file, `DURABLE_DISABLED=1`, GitHub `durable/pause` | `pause` (files/env: local) | no ticks or dispatch; every running worker as row 3 | `paused` | no | approval-class agent resume (`durable resume` + nonce, or passkey) re-queues `paused` items |
| 6 | Stop workers | `durable stop --workers` | `pause` (local token) | every running worker as row 3; the agent keeps ticking for other items | `stopped`; items `needs-human` | no | `durable retry <item>` |
| 7 | Shutdown | `durable stop` (service stop), SIGTERM, `systemctl --user stop`, `sv down` | local service manager | `close()`: invocations stop, process groups terminated, no outcome | none | yes | automatic on next start (durable: native resume; pi-session: re-dispatch with `pi --continue`) |
| 8 | Crash / restart | `kill -9`, OOM, reboot, `systemctl --user restart` | none | process gone; cgroup kill (Linux) and the start-up group sweep (all platforms) | none | yes, within `maxAttemptsPerItem` | automatic, after H4 fences are loaded |

Tests (`lifecycle` row in §5): for each row and both kinds, start a worker, apply the operation, then advance time and restart the steward: assert the outcome, that no new turn or attempt starts without the restart action, and that the restart action then works.

## 3. Call paths

### 3.1 Process start (`durable-agent@<id>.service` -> `steward/main.ts`)

```
main(id)
├─ config/load: machine.yaml (agent assigned here?), agents/<id>.yaml (validate), profile-meta/<profile>.json
├─ identity/doctor.lite()   profile files exist, token → login == manifest login, git identity, providers present, reviewer family present
├─ lockfile agents/<id>/lock   (second instance exits)
├─ steward/procs.sweep()        terminate recorded process groups still alive from a previous run (S5)
├─ dispatch/hold.load()         hold fences in force before any task resumes (H4)
├─ steward/harness.open()   Harness.open(sqlite, registry); models = identity/modelAuth.createModelsFor(profile, providersOf(def))
│    └─ ensure main conversation + steward-loop task exist (idempotent)
├─ dispatch/select(def, machine) → WorkerDispatcher; dispatcher.capabilities() recorded in status
├─ steward/api.listen(127.0.0.1, token)
└─ audit("start", {profile, login})
```
Isolation: `steward/harness.ts` is the only pi-durable importer; `identity/modelAuth.ts` is the only place that knows about Anthropic shaping.

### 3.2 `steward-loop` (repeat task; step returns `{ again: { nextAt } }`)

```
step()
├─ killswitch.check()  → stop ticking, audit("paused")
├─ limits.rollover()
├─ sources.pollAll() → eligibility.filter [code] → scout/judge [LLM, tighten-only] → queue.update
├─ notify.reminders.due()   (re-send approval-needed reminders within cadence caps; park items older than staleDays)
├─ for item in ready while workers < maxConcurrentWorkers && budget ok: spawn WorkItemTask(item)
└─ return { again: { nextAt: now + pollSeconds } }
```

### 3.3 `WorkItemTask`

```
phase claim        intent → claims.claim → lost? release, end
phase brief        scout child conversation (read-only) → brief document
phase dispatch     intent → dispatcher.createWorkspace(spec) → kind = workers/select(def, role) → kind.start(ws, JobSpec{env=buildAgentEnv(...,"worker"), limits, skills})
                     [durable kind: create run-worker (background task) → child conversation in the steward; dispatcher.openViewer when workers.durable.viewer=on-start]
phase await-pr     loop: sleep → dispatch/monitor: kind.status + GitHub PR lookup + hold/kill-switch/limits watch
                     pi-session exited && no PR → kind.resume (pi --continue) up to maxAttempts → else notify(escalation), park
                     durable: pi-durable resumes the child after a restart; WorkItemTask re-attaches (DW6); failed/aborted && no PR → one fresh attempt up to maxAttempts → else escalate
                     hold fence → stop touching the workspace (H1, H5) until released; any recorded cancelledBy → no resume or re-dispatch (§2.2)
phase review       launch reviewer JobSpec{role:"reviewer", model=opposite family} (kind per §2.1) → ReviewResult + ModelProvenance (G9r) → review.record in steward.reviews → mirror status+comment
phase gate         facts.collect(head SHA) → decide(policy, facts)
   ├─ merge        (auto + not shadow + cooling-off elapsed) → merge.request(sha); re-read state first; interrupted → re-read
   ├─ wait-human   approval.create(): issueNonce → notify(approval-needed; nonce to desktop/command only; console inbox gets a nonce-free request) → durable wait, resolves on:
   │                 (a) PR merged by someone else  (b) approving review from another account → re-run gate  (c) `durable approve --code` or a console passkey assertion (slice 12a) → attempt merge within GitHub rules
   │                 reminders per cadence; stale → park
   └─ block        comment + requeue to worker or human
phase finish       release claim, outcome → queue, notify(merged), dispatcher.removeWorkspace only if merged/closed and clean
```
New commits after review invalidate the verdict and the nonce; the item returns to `review`.

### 3.4 Dispatch (`dispatch/launcher.ts` + adapters)

```
launch(ws, job)           (orca adapter)
├─ identity/pidir.build(def, profile)  → $DURABLE_HOME/agents/<id>/pi  (settings generated; symlinks; no auth.json unless profile=default)
├─ brief written to a 0600 file outside the worktree from job.briefText
├─ launcher script 0700: `env -i <job.env> exec pi --provider <p> --model <m> --thinking … "$(cat brief)"`   (separate flags, every launch; headless: stdin </dev/null)
├─ list-before-create: ORCA terminal list --worktree … ; reuse a live job with the same id
└─ ORCA terminal create --worktree path:ws --title … --command launcher --json
(git-process adapter: same launcher, detached spawn + log file; attachInfo = `tail -f <log>`)
```
Re-launch after a crash: `pi --continue --provider <p> --model <m>` in the same workspace with a short resume brief (pi-session kind only; headless stdin `/dev/null`; never after an intentional cancellation, §2.2).

```
openViewer(ws, {title: "durable:<agent>/<item>", command: "durable attach <agent>/<conversation>"})   (orca adapter)
├─ list-before-create: ORCA terminal list --worktree … ; reuse a viewer with the same title
├─ ORCA terminal create --worktree path:ws --title … --command 'durable attach …' --json   → AttachInfo{kind:"orca-terminal"}
└─ unsupported or failing → AttachInfo{kind:"command", command} (shown by CLI/console; no retry loop)
```

### 3.5 CLI

`durable <cmd>` reads definitions, machine file, tokens; calls the loopback API; `doctor`, `enable`, `status`, `profile` work without a running agent.
`durable profile init|bind-github|show|list|check <name>`; `durable approve <agent> <pr> --code <nonce>` (refuses without a TTY unless `DURABLE_NONINTERACTIVE_OK=1` is set by the operator's own shell); `durable notify --event <e> --agent <id>` (used by `OnFailure`); `durable pause|stop [--workers]|retry <item>|hold <item>|release <item> [--code <nonce>]` (semantics in §2.2); `durable token create|list|revoke`; `durable inbox <agent>`; `durable approval enroll` (TTY only); `durable console enable|add-device|serve|status`. `--dry-run` prints effects.

### 3.6 Console flows

```
browser tab ─GET /api/stream (SSE, one per tab)─▶ console/mux ──subscribes──▶ [monitor: per-device status machine] ─▶ daemon SSE (hello→snapshot→deltas)
browser tab ─PUT /api/stream/:id {subs:["<device>/agent/<aid>", ...≤20]}─▶ mux
browser tab ─ALL /api/devices/:id/v1/<allowlisted route>─▶ guard(Host,Origin,JSON,CSRF,identity) ─▶ proxy(inject token) ─▶ daemon
```
Approve (slice 12a): `POST /api/devices/:id/approvals/challenge {item, headSha}` → daemon challenge + display data → browser `navigator.credentials.get` (user verification required) → `POST .../approvals/assert` → daemon `verifyAssertion` → steward re-runs the gate at the current head SHA → audit + notification. The console never sees a secret that could replace the assertion.

Console startup: load `console.yaml` + `devices.yaml` → `monitor.checkAll()` (probe `/healthz`, `/v1/device`: `uid` match → `online`; `uid` differs → `mismatch`; `apiVersion` outside range → `incompatible`; 401/403 → `unauthorized`; unreachable → `offline` with 1 s → 30 s backoff) → listen on loopback/unix socket → (slice 11) `tailscale serve` is configured by `durable console serve`, which only prints or runs the documented command; it never enables Funnel.

### 3.7 TUI and CLI clients

`tui/main.ts` and `cli/*` use `client/` (the same typed client the console hub uses). `durable attach <agent>[/<conversation|item>]` opens a **tree** (steward, chat threads, scout conversations, Pi-session workers, durable child conversations and nested subagents: parent -> child, live from `GET /v1/conversations?tree=true` and the SSE `tree` frames), a transcript pane for the selected node (`GET .../<id>/transcript` and `.../events`), a composer whose follow-up, steer and abort controls are enabled only where `node.capabilities` and the token scopes allow (T2), and queue/inbox side panels, over loopback with the local token. `durable open <conversation>` asks the Orca adapter for a viewer terminal; `durable hold|release <item>` implement the human-held rule (H2, H5; release takes `--code <nonce>`).

### 3.8 Policy resolution (per repo, each tick and at gate time)

```
policyFor(repo)
├─ source = sourceFor(def.scope.repos[repo].policySource.kind)           none (default) | fixture (tests) | (kinds chosen per repo later)
├─ resolution = source.resolve(repo)                                      reads ONLY from a ref/location the steward resolved (P1); records ref + fingerprint
├─ state not "verified" → auto disabled (P4); a change in fingerprint → state "unverified" + nonce-free approval-needed ("policy changed: verify")
└─ state verified → effectivePolicy(resolution, definition)               tighten-only (P5); clamps recorded
verify-policy action:  source.describeChange(repo, since) → challenge/nonce display data → approval class (A1-A5) → source records the verification → fingerprint accepted
```
The gate calls `policyFor` immediately before `decide` and again right before `gh pr merge` (state may have changed between ticks). With `none`, `decide` still evaluates every other fact so shadow mode can print a readiness list.

### 3.9 Chat flow (CLI, TUI and console)

```
client ─POST /v1/conversations {kind: chat|scout, item?}─▶ api/chat (startableKinds? scope chat?) ─▶ steward/conversations.create (fixed tool set)
client ─POST …/messages {content, requestId, whenBusy}─▶ screen(credentials) → size ceiling (1 MiB) → [opt-in rate limit] → audit → pi-durable conversation.submit
client ─SSE agent stream─▶ transcript frames (text only rendering on the client)
client ─POST /v1/workers/<id>/steer─▶ dispatcher.steer if capabilities().steer else 501 not_supported
```

### 3.10 Android/Termux start (slice 14)

```
Termux:Boot ─▶ ~/.termux/boot/durable (termux-wake-lock; sv-enable services) ─▶ runsv durable-agent-<id> ─▶ `durable run <id>`
durable run <id> ─▶ platform.detect() (os=android, service=termux-runit, tailscaleCli?, storage?) ─▶ doctor.lite() with Android rules (PL3-PL5)
                 ─▶ steward/harness.open(storage by capability) ─▶ api.listen(loopback [+ tailnetAddress if configured])
runit restarts the process if it dies; if Termux itself is killed nothing runs until Termux/boot starts it again → console shows `offline`, claims expire via leases.
```

## 4. Install paths

- **Skills-repo integration (spec 02b), Linux:** `install.sh` clones `nanstey/durable` at the pinned commit through a `vendor-git` pair (manifest `harness/durable/vendor/nanstey-durable.txt`, destination `$DURABLE_HOME/vendor/github.com/nanstey/durable`, `ok|cloned|updated` reporting and the same fail-closed behaviour as `install_vendor_git`), runs `install_durable_deps` (pnpm with the clone's lockfile, `--frozen-lockfile --prod --ignore-scripts`, only when `package.json` or the lockfile changed, hash stamp), and links `~/.local/bin/durable` with the existing `link_one`. It skips with a message when Node < 22.19 or `pnpm` is missing. It never writes `profile-meta`, `machine.yaml`, definitions, tokens, secrets or units.
- **Standalone install (durable repo, `docs/install.md`):** `git clone`, `pnpm install --frozen-lockfile --prod --ignore-scripts`, link `bin/durable` onto PATH. Units are rendered and installed by `durable enable <id>` (through the `ServiceManager`), so no installer is needed for them.
- **Termux (spec 14, durable repo only):** `termux/bootstrap.sh` refuses to run outside Termux (`TERMUX_VERSION`/`$PREFIX`), installs packages (`pkg install nodejs git gh termux-services`, optionally `termux-api`), installs Pi with `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@<pin>`, clones this repo at a pinned commit given by `--ref` (default: the commit the script itself was fetched at) into `$DURABLE_HOME/vendor/...`, installs dependencies with `--ignore-scripts`, renders runit service dirs, prints the manual steps (F-Droid/GitHub Termux build, Termux:Boot, battery-optimization exemption, `termux-wake-lock`). `ok|copy|update` reporting, run twice safe, offline-testable with stubs for `pkg`, `npm`, `sv`, `git`. It has **no dependency on the skills repo**. Skills are an optional, separately pinned input (`--skills-url`/`--skills-ref`, copying only the required skill trees into the Pi agent directory); they are needed only for worker dispatch. `durable doctor` checks the required skills per effective (kind, role) (`identity/skills.ts`; Pi-session roles need the configurable contract list, default worker `idea-to-pr`, `pr`, `build` and reviewer `review-code`; durable roles need only their `workers.durable.skills` allowlist, default empty) and, when some are missing, reports a fix message and disables dispatch only for the pairs that need them; skill-free durable workers (the Android default), steward, scout and chat keep working.

## 5. Validation seams

| Seam | Check |
| --- | --- |
| `config/*` | table tests: valid example; unknown key; `peers` set; bad id; path-like field in a definition; agent not assigned in machine file; `auto-when-safe` without `pathAllow`/`maxRisk`. |
| `identity/profiles` | name regex; no fallback to `auth.json`; `default` refused without `profiles.allowDefault`; provider listing never resolves values. |
| `identity/env` | snapshot: ambient `GH_TOKEN`, `ANTHROPIC_API_KEY`, `SSH_AUTH_SOCK`, `GH_CONFIG_DIR` in the parent never appear; profile secrets and manifest-derived git identity do; `durable-shell` (I4): `GH_TOKEN`, `GITHUB_TOKEN` and provider secrets present in the profile file and the parent are absent (names and values). |
| `identity/doctor` | stub `gh`: wrong login fails; missing profile fails with a fix string; missing reviewer-family provider fails; classic `ghp_` token warns; `admin:` scope warns. |
| `identity/pidir` | tmp `PI_AGENT_DIR`; layout assertions (directory symlinks only; derived `auth.json` absent or `{}`, never a symlink); concurrent `modify()` through `ModelRuntime`'s store via the canonical path and the directory-symlinked path with fabricated credentials (exact counter, symlink intact, 0600); a file-symlinked `auth.json` is refused. |
| `identity/modelAuth` | `plain` = `ModelRuntime.create({ authPath })` returns Models for an API-key profile; rotation through lock-serialized `modify()` with a fabricated expiring credential and a stub token endpoint; model change only via `configure()`; `anthropicShaped` selected only when the spike chose it; payload shaping unit-tested with the extension's own fixtures if option 1. |
| `dispatch` | **dispatcher contract suite** against `orca` (stub CLI recording args), `git-process` (fake `pi`) and `fake`: idempotent createWorkspace/hostProcess, no ambient env (W1), list-before-create, interrupt, dirty- and human-held-refusal, `openViewer` returns an `orca-terminal` or a `command` fallback. |
| `workers/*` kinds | **kind contract suite** run for `pi-session` (fake `pi`) and `durable-conversation` (faux model): same acceptance flow, capability reporting matches the table, interrupt, resume, steer 501 when unsupported, no ambient env. |
| `workers/durable` | DW1: ownership and background boundary (aborting the main conversation or a chat turn leaves the worker running); DW2: kill switch, hold, budget and wall-clock each stop a running worker and write a terminal outcome, `durable stop --workers` stops all, `close()` leaves workers resumable; DW3-DW5: tool-set snapshot (worker and reviewer), file-tool path/symlink/`..` escapes refused, blocked commands refused, neither token alias nor any profile secret in the bash env (I4), the **known-limits suite** (interpreter, script, credential-file and direct-push cases: documented as not prevented), `push_branch`/`open_draft_pr` intent + reconciliation tests (lost response after success, intervening branch change, concurrent retries, hostile worktree git config and hooks); DW6: `SIGKILL` mid-`bash`, restart, `interrupted` result, child continues, one worker/one PR, process group gone; DW7: skill allowlist reads text only and rejects incompatible skills; DW8: `maxConcurrent` enforced; load test: API p95 < 250 ms (p99 < 1 s) and SSE heartbeat lateness (actual minus scheduled 15 s ping) < 2 s with 2 and 4 busy children. |
| `lifecycle` (§2.2) | every row x both kinds: outcome, no restart without the listed action (also across a steward restart), restart action works; tree `abort` on a worker node never ends the attempt. |
| `workers/select` (§2.1) | one test per truth-table row; doctor error text for `role-not-enabled`. |
| `tree/*` | tree from a fixture steward with chat, scout, durable worker, nested subagent and Pi-session leaf nodes: parent/child, status, capabilities; `tree` SSE deltas; a client without `chat` scope gets no steer controls (T2); `durable attach` rendering tests with a fake terminal. |
| `hold` | H5 sequence order (fence committed before any interrupt); every operation refused while `holding` and `held` (both kinds); delayed writer leaves the worktree unchanged after `held`, including a Linux `setsid` writer outside the process group; backgrounded descendants gone at `held`; failed containment kill and the Android platform end in `holding` with the stop-the-agent message; restart while `holding` and while `held` (H4: fence enforced before any task resumes); `release` impossible with any bearer scope; release nonce/assertion for another item, another action or an older `holdEpoch` rejected; foreign-terminal advisory. |
| `gate/review` | for both reviewer kinds: valid `ReviewResult` recorded with `ModelProvenance`; malformed or wrong-SHA result rejected; missing result fails the reviewer; a same-family fallback entry refuses the verdict (G9r). |
| `gate/decide` | full truth table; property test: flipping any required fact to false/null never yields `merge`; G6 test: forged label/comment inputs have no effect; G8 test over recorded `REVIEW_REQUIRED` fixtures. |
| `gate/merge` | source lint: only module spawning `gh pr merge`; argv has `--match-head-commit`, never `--admin`. |
| `gate/shadow` | real-shaped fixtures: shadow output logged with reasons, executor takes human path. |
| `gate/approval` | nonce hashing, single use, expiry, SHA invalidation, TTY refusal; cross-action and cross-item reuse rejected (`approve` vs `release` vs `resume`); nonce absent from every log, file and GitHub payload (grep test). |
| `notify` | dedup TTL, quiet-hours hold and later delivery, reminder caps, redaction; channel kinds limited to inbox/desktop/command/github; `github` channel skipped when target == agent login; nonce reaches only desktop/command stubs and appears in no inbox entry, log or GitHub payload (grep test). |
| `api` | scope matrix (read/chat/pause vs every route); no route accepts a bearer for approve/resume/enroll; token hash storage; SSE hello→snapshot→deltas with a fake clock; reconnect yields a new snapshot; non-loopback bind refused unless `network.bind: tailnet`; `whois` allowlist with a stub local Tailscale API. |
| `approval/webauthn` | assertion verification against recorded fixtures (valid, wrong origin, wrong rpId, replayed counter, expired/used challenge, stale head SHA); enrollment rules (A3); no approval path from a bearer token. |
| `console/guard,proxy,mux` | Host allowlist, cross-origin refusal, JSON-only, CSRF header; token injection (browser-visible payloads contain no token: grep test); route allowlist has no fs/shell/passthrough; mux 20-key cap; status machine with two stub daemons on different ports (online/offline/unauthorized/mismatch/incompatible). |
| `gate/policySource` | seam contract suite run against `none` and `fixture`: every state (verified, unverified, invalid, unavailable, none) disables or enables auto as P4 requires; sources cannot take a path/ref from PR or worktree input (lint); a fingerprint change moves `verified` to `unverified`; the verification record is written only through the approval class; a future real source must pass the same suite; definition tries to loosen (clamped + warning); `mode: auto-when-safe` without a verified policy is ignored. |
| `gate/hardPaths` | PR touching CODEOWNERS variants, `.github/**` or any `protectedLocations` of the source => wait-human, never would-merge, policy drops to unverified. |
| `api/chat` | screening (positive and negative cases), 1 MiB ceiling, no default rate limiting, opt-in `chat.rateLimit` window tests with a fake clock, `startableKinds` is console-wide (same result for any client type), audit record fields (hash, no content), 501 for worker steer without capability, no route to start workers/reviewers. |
| `web` | headless DOM tests for inert rendering (script-looking and markdown-looking text appears as text); CSP header test; manual browser smoke checks with `playwright-cli` recorded in the slice PR; phone layout checked at a narrow viewport. |
| `steward` recovery | faux model, `SIGKILL` mid-await, restart, one worker, one claim, one notification per dedup key. |
| `platform/*` | detection with stubbed env (Termux vs Linux, with/without `tailscale`, with/without `node:sqlite`); capability contradictions fail doctor; `ServiceManager` contract test against `systemdUser` (stub `systemctl`) and `termuxRunit` (stub `sv`, temp `$PREFIX`); `DesktopNotifier.nonceSafe` honoured (nonce never reaches `termuxNotification`); PL5 Android rules (auto-merge refused, `/storage` path refused). |
| skills-repo installer step (spec 02b) | offline sandbox with stub `git`/`pnpm`: clone, `ok`, update to a new pin, fail-closed on a bad manifest, Node-version skip, run twice, CLI link, never writes machine files; `bump-pin.sh` against a local bare repo. |
| `scripts/hygiene-scan.sh` (durable repo) | positive fixtures (home paths, emails, tokens, tailnet names, private-looking hostnames) fail the scan; allowlisted placeholders pass; the scan runs over `docs/plan/` too. |
| `termux/bootstrap.sh` | stubbed `pkg`, `npm`, `sv`, `git` and a temp `$PREFIX`: twice-run `ok`, refuses outside Termux, no skills-repo access unless `--skills-*` is passed. |

## 6. Decisions taken here (alternatives recorded)

| Decision | Alternative | Why |
| --- | --- | --- |
| Profile manifest as a separate non-secret JSON in `profile-meta/` | Put login/email in `secrets/<name>.env` or extend `auth.json` | Keeps pi-auth-profiles and pi-secret formats untouched; non-secret metadata is inspectable and diffable; the manifest pins the identity so drift is detectable. |
| Definitions without paths/secrets + machine file for assignment, paths, channels | One per-agent file with everything | Satisfies AGENTS.md (no machine state in repo) and lets definitions live in a private repo or move between machines unchanged. |
| `WorkerDispatcher` (workspace + process hosting) separated from `WorkerKind` (`pi-session` default, `durable-conversation` opt-in) | One dispatcher that launches only Pi sessions; durable workers as a third dispatcher adapter | A durable worker needs a workspace but no external process; separating the concerns lets either kind use either adapter and keeps `git-process` useful on Android (U6). `git-process` still doubles as the test double. |
| Durable workers owned by a background `run-worker` task, stopped explicitly by the kill switch | Foreground ownership (parent aborts child) | A chat abort or loop tick must not lose worker progress; the kill switch, holds and limits abort explicitly and write terminal outcomes. |
| Code-owned `push_branch`/`open_draft_pr` for durable workers; no token in their shell | Give the worker raw `git push`/`gh` | Removes the biggest weakness of the Pi-session kind (token in the model's shell); fixed refspec and idempotency. |
| Minimal skill-prompt text mechanism, default empty; `idea-to-pr` stays on Pi sessions | Port the skills runtime | Skills depend on Pi extensions, scripts and subagents; a text-only allowlist is cheap and safe, and the gap is stated. |
| `durable attach` tree + `openViewer` terminal in Orca | A bespoke Orca integration or a web-only view | One TUI serves terminals and Orca; Orca lists durable conversations beside normal sessions; falls back to printing the command. |
| Human-held mark; release is approval-class | Auto-detect and auto-handoff | The minimal safe rule; a bearer-scope release would let an agent lift a human's hold. |
| Hold is a fenced `holding -> held` sequence acknowledged only after drain and process-group termination | Mark + soft interrupt | A mark alone leaves running commands and their descendants writing (the spike saw children survive a `kill -9`). |
| Durable-worker confinement stated as advisory guardrails; sandbox hardening deferred | Claim a cwd/denylist boundary; require containers; ship an optional `bwrap` now | Overclaiming is worse than a stated limit; the only guarantee is a credential-free shell environment; GitHub rules, token scope, budgets and the gate remain the stops; a sandbox gets its own spec if the spike justifies it. |
| Per-attempt systemd scopes/slices on Linux; hold reaches `held` only on an empty cgroup | Process groups only | `setsid`/double-fork descendants leave a process group; a cgroup cannot be left. Android cannot confirm, so it never claims `held`. |
| Push/PR tools persist operation intent and reconcile by reading the remote | Retry by deterministic name only | A lost response or a moved branch must never cause a second push, a force push or a push of a different commit. |
| One lifecycle table for abort/interrupt/hold/pause/stop/shutdown/restart | Per-spec descriptions | They had drifted; intentional cancellation must never silently restart work. |
| Kind-neutral `ReviewResult` + `ModelProvenance` | Verdict file and Pi session log only | A durable reviewer has neither; one contract keeps the gate kind-agnostic. |
| Approval nonce delivered out of band | GitHub label/comment approval | Shared identity makes labels/comments forgeable by the agent. |
| Gate reads steward-internal review records, not the GitHub status/comment | Read the status/comment back | Same forgeability reason; the status/comment is display only. |
| Native Node type stripping, no build | `tsx` or `tsc` build | Fewer deps; `erasableSyntaxOnly`. |
| `gh` CLI for GitHub | Octokit | Already an installed tool; uses the profile token via env. |
| TypeBox + `yaml` | zod / JSON-only | TypeBox is pi-durable's schema layer; YAML friendlier to hand edit. |
| Poll for worker completion | Callback endpoint | No new auth surface in v1. |
| Per-agent `PI_CODING_AGENT_DIR` derived from the profile | Worktree `.pi/settings.json` `authProfile` | `authProfile` needs project trust and a file in the worktree; repo content must not choose the identity. |
| `durable-worker-guard.ts` in the durable repo (`pi-extension/`), loaded through the generated per-agent Pi settings | Install it into the user's `~/.pi/agent/extensions/` from the skills repo | It shares its block-list with the steward's `guard/commands.ts` (one repo, no cross-repo drift test) and Android workers need it without the skills repo. Assumption verified in slice 6: Pi accepts a local package path in the generated `settings.json`; fallback: the derived pidir makes `extensions/` a real directory of symlinks plus the guard. |
| Approval nonce to `desktop`/`command` only | Nonce in the console inbox or GitHub | Both are readable by agents (shared OS user, shared token). |
| WebAuthn verified by the daemon for console approvals | TOTP, console password, header-based identity | No secret on any host an agent can read; TOTP/password secrets and headers can be read or forged on a shared OS user. |
| Daemon tokens are daemon-level, hashed, scoped, per client | Reuse profile secrets / one shared token | `profile-secrets` exports profile secrets into agent environments; scopes keep approve/resume out of tokens. |
| Bind the Tailscale interface address + `whois` peer check | Loopback + `tailscale serve` per daemon | Real peer address and tags, no header trust, no proxy per port. (Serve is still used for the browser-facing console.) |
| Console, hub, client library and API written from scratch; dpi-* are inspiration only (Q15, U3) | Vendor or adapt `dpi-playground`/`dpi-sdk` | See architecture D13: fit to our domain and trust model, dependency trimming, XSS surface, upstream churn, no attribution bookkeeping. |
| `RepoPolicySource` seam with built-in `none` and `fixture`; mechanism chosen per repo later (Q18) | Fix an in-repo file and trust-pin format now | The user wants the policy mechanism to vary per repo; invariants P1-P6 hold for any mechanism and the gate is tested without picking one. |
| Definition may only tighten the resolved policy | Definition overrides | A local file must never be able to enable what the policy source does not allow. |
| Chat tools fixed in code; `request_*` only enqueue | Free-form tool use in chat | Chat cannot bypass gate, budgets, kill switch or eligibility. |
| Chat guardrails (screening, audit, tool set, 1 MiB ceiling; rate limits opt-in) in the daemon API | Client-side checks; hard default rate limits (removed, Q20) | Every client (CLI, TUI, console in any browser) gets the same guardrails and audit; there is no phone-specific gating. |
| Linux/systemd is the first fleet; Android/Termux added later behind capability-flagged interfaces | Also launchd now; hardcode systemd | Q7; keeps installer and tests small while not precluding Android (U4). macOS deferred. |
| Engine in its own public repo; the skills repo keeps a thin integration (pin manifest, installer step, thin skill, catalog and table rows) | Engine under `harness/durable/` in the skills repo | An application with its own dependencies, tests and release cadence is not harness config; Android installs without cloning every skill; public-repo hygiene is enforced on one purpose-built repo; the skills repo's AGENTS.md rules (config copied into runtime dirs) fit only the thin part. |
| `termux/bootstrap.sh` lives in the durable repo, clones and pins durable directly; skills optional | Depend on the skills repo or extend `install.sh` for Termux | `install.sh` assumes standard Linux paths, systemd and `environment.d`; the skills repo is needed on Android only for worker dispatch, so it is an optional separately pinned input. |
| `git-process` as the Android worker path; light workers only | Orca on Android; no workers | No Orca on Android; light workers on small repos keep value without heavy builds. |
| Android `desktop` backend is not nonce-safe | Send the nonce to `termux-notification` | Other Termux processes can read notifications (`termux-notification-list`). |
| Console front end without a build step (third-party Preact + htm, pinned, checksummed) | Vue + Vite as upstream | No toolchain in the repo or on installs; small, auditable; inert text rendering needs no markdown/sanitizer dependencies. |
| One process per agent, one port per agent daemon (declared or allocated, recorded) | A per-machine gateway process | No new component whose failure hides every agent on the machine; N ports is acceptable for a handful of agents. Revisit if agent counts grow. |

## 7. Uncertainties (assumptions to verify in slices)

- pi-durable 1.4.0 peer/dep range vs installed Pi (slice 1).
- Anthropic-OAuth shaping hosting: deep import of `oauth-transport.ts`, delegate from `@earendil-works/pi-ai/compat`, injection point in pi-durable/pi-ai (`Models` provider override, `onPayload`, `beforeRequest`), peer floor pi-ai >= 0.86 (slice 1).
- Resolved in slice 1: `AuthStorage` is not exported (use `ModelRuntime.create({ authPath })`); writes are lock + in-place write (no atomic rename); directory symlinks are safe, file symlinks lose updates. Slice 2 re-tests this in CI with fabricated credentials.
- Fine-grained PAT behaviour with `gh` for the calls used (`gh pr view --json`, status creation) (slice 2/7).
- `pi --continue` with per-agent `PI_CODING_AGENT_DIR` (slice 6).
- Orca CLI flags used match the installed Orca version (slice 6).
- Tailscale: `whois` from a daemon via the local API; whether Serve passes user identity for tagged sources; HTTPS certificate issuance for the console host; `tailscale serve` proxy to loopback/unix socket (slice 1, 11, 12).
- GitHub notifications for self-authored activity are suppressed; confirm with a test mention to the same account and to a second account (slice 1).
- WebAuthn: passkey registration and assertion from an iPhone/Android browser against a Tailscale-issued HTTPS origin; verifier library size/license; RP ID = console host FQDN (slice 1 spike, slice 12a).
- PWA: installable on iOS 16.4+ via Add to Home Screen; Web Push permission flow; VAPID keys; outbound internet from the console host (slice 12b).
- Whether the fine-grained token can read rulesets/branch rules for the fingerprint, and `gh api .../contents?ref=<commit>` works as assumed (slice 1, 9).
- Orca CLI terminal-input/read commands for worker steer/attach (slice 6); if absent, workers are view + interrupt only.
- Android/Termux (slice 1 checklist, slice 14): Node version and `node:sqlite` in Termux; pi-durable install and storage under `--ignore-scripts`; `os.networkInterfaces()` behaviour; whether the Tailscale app's address is bindable from Termux; whether a `tailscale`/`tailscaled` userspace option exists in Termux packages; `termux-services` + Termux:Boot + wake-lock + Doze/phantom-process behaviour; `termux-notification-list` readability; `gh` in Termux.
- pi-durable subagent mechanics for our use (slice 1 addendum): child conversation inside the steward with cwd confined to a worktree; explicit abort of a background child by the kill switch; crash recovery of an interrupted tool; ownership-index re-attach; event-loop contention with N children; transcript growth/retention and pruning; per-conversation container env (example 29); inlining a `SKILL.md` as a prompt section; child model auth.
- Orca viewer: a full-screen TUI rendering and taking input in a terminal created with `terminal create --command`; `terminal read --screen`; closing the terminal leaves the work running; one `terminal send` into a live Pi TUI (slice 1 addendum, slice 6).
- Credential-screening patterns: false-positive rate on normal chat (slice 3/4).

## 8. Review status

Revised after user comments (rounds 1-7). No reviewer opted in.
