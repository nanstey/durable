# System architecture

Inputs: [1-product-review](./1-product-review.md). File placement, types and call stacks are in
[3-program-design](./3-program-design.md). Revision 1 (user comments C1-C7). Revision 2 (U1: no ntfy; U2: multi-machine web console; remote-ready daemon API; guarded console approvals). Revision 3 (repo-committed, human-trusted merge policy; interactive chat from the phone; PWA/Web Push as an additive follow-up; Linux-only first fleet). Revision 4 (dpi-* are inspiration only, no code reuse; Android/Termux daemon as an additional platform target behind a platform abstraction). Revision 7 (U6: a second worker kind, `durable-conversation`, alongside Pi-session workers; a conversation tree and `durable attach` TUI viewable in Orca terminals; a human-held rule; D4, D19, D20). Revision 6 (the engine moves to its own public repo `nanstey/durable`; the skills repo keeps a thin integration; D18). Revision 5 (repo policy mechanism undecided: a pluggable `RepoPolicySource` seam with mechanism-independent invariants; the phone is just another browser client with identical capabilities; no default chat rate limits).

Evidence base (read for this plan):
- `@earendil-works/pi-durable` spec and the `disler/durable-pi` reference (`apps/dpi-backend`,
  `apps/dpi-playground`, `apps/proactive-dpi-demo`, `ai_docs/durable_pi/*`, `ai_docs/pi/pi-ai.md`), read at github.com/disler/durable-pi, **read for ideas only (revision 4): no code from `dpi-backend`, `dpi-playground` or `dpi-sdk` is copied, adapted or vendored.**
- The skills repo (conventions the thin integration follows): `install/main.sh`, `install/modules/*.sh`, `harness/pi/{README.md,settings.json,bin/pi-improve,bin/pi-secret,extensions/profile-secrets.ts}`, `skills/agent/handoff`, `.github/workflows/ci.yml`.
- Installed Pi: `~/.pi/agent/npm/node_modules/{@nanstey/pi-auth-profiles,@gotgenes/pi-anthropic-auth,@earendil-works/pi-coding-agent}`.

## 1. Shape of the system

```
                 per machine (no hub, no shared DB)

  systemd --user                                   GitHub  (source of truth across machines)
  durable-agent@<id>  ── one OS process per agent ──┐     issues, PRs, labels, claims, checks, reviews
   │  env = built from the agent's PROFILE only      │          ▲  gh CLI, token of that profile only
   ▼                                                 │          │
 ┌──────────────────────── Steward (Node, pi-durable Harness) ─────────────────────────┐
 │ main conversation  (human-facing: explain, reprioritize, pause; narrow tools)       │
 │ steward-loop task  (durable timer: tick → sources → eligibility → dispatch)         │
 │ scout child conv.  (read-only brief writer; Jev/LLM judgments can only tighten)     │
 │ work-item tasks    (claim → brief → dispatch → await PR → review → GATE → …)        │
 │ documents: queue, claims, budgets, reviews, gate decisions                          │
 │ Gate (pure code) ── only code path that can request a merge                          │
 │ Notifier ── channels from machine.yaml; dedup, quiet hours, reminders                │
 │ WorkerDispatcher (adapter) ── orca | git-process | (future)                          │
 │ HTTP+SSE API v1 (loopback; tailnet listener from slice 11), scoped bearer tokens     │
 │ Inbox (events document)   Approval verifier (nonce, passkey)   audit.jsonl (append-only)│
 └──────┬───────────────────────────────────────────────────────────────┬───────────────┘
        │ WorkerDispatcher                                               │ durable CLI/TUI · web console (optional, any machine)
        ▼                                                                ▼
   Worker = Pi session in an Orca worktree (default) OR a durable        human terminal / Orca terminal / phone via the console
            child conversation inside the steward (opt-in, D19)
   (clean env from the profile, idea-to-pr skill)
   Reviewer = Pi session, opposite model family, read-only checkout
```

Process model: **one OS process per agent** (systemd template `durable-agent@<id>.service`; macOS/launchd is deferred, Linux only for the first fleet). Reasons: pi-durable allows one process per storage and has no
cross-process locking (spec; dpi-backend opens one SQLite per session); one process has exactly one
environment, so "one profile per agent" is structural; per-agent kill, restart, logs and resource
limits come free from the service manager (behind a `ServiceManager` interface so Android/Termux fits, D17). Cost: one small Node process per agent. There is no
always-on supervisor daemon beyond the service manager.

**Multi-machine view (revision 2).** The web console is an optional, separate process on one chosen machine (the console host).
It is a viewer/controller, not a coordinator:

```
  phone / laptop browser ──HTTPS (tailscale serve, tailnet only)──▶ Console (server + static web app)   [console host]
                                                                      │  token-injecting proxy, one SSE per tab,
                                                                      │  device registry (urls + scoped tokens, 0600)
                       tailnet (WireGuard), ACL: console tag → daemon ports │
        ┌─────────────────────────────┬──────────────────────────────┴──────────┐
        ▼                             ▼                                         ▼
  machine A: durable-agent@x      machine B: durable-agent@y             console host: durable-agent@z
  (own SQLite, own profile)       (own SQLite, own profile)              (agents may run here too)
        └──────────── each daemon works alone; GitHub is the coordination record ────────────┘
```
No daemon talks to another daemon. If the console or its host is down, nothing in the agents changes.

### Roles

| Role | Runs as | Owns | May do | May not do |
| --- | --- | --- | --- | --- |
| Steward | durable process | queue, claims, budgets, audit, gate, notifications | read GitHub/files, claim, dispatch, comment, request merge via Gate | edit repo code itself, merge outside Gate, change its own definition or policy |
| Scout | durable child conversation | a brief per item | read-only tools, `gh ... view` | any write |
| Worker (`pi-session`, default) | Pi session in worktree | one item's branch and draft PR | edit, test, push its branch, open a draft PR | merge, push to the default branch, force-push, edit other repos |
| Worker (`durable-conversation`, opt-in) | durable child conversation inside the steward process, tools confined to the worktree | one item's branch and draft PR | edit, test, commit; push its own branch and open a draft PR **only through code-owned tools**; no raw token in its shell | raw `git push`, merge, rebase, reset --hard, branch switching, anything outside the worktree, spawning subagents |
| Reviewer | Pi session or durable child conversation (read-only), opposite family | a verdict on one head SHA | read PR checkout, write a verdict file | edit code, merge |
| Gate | pure code in steward | merge/wait/block decision | call `gh pr merge --match-head-commit` | anything with `--admin`, any bypass |
| `durable` CLI/TUI | short process | none | read status, send messages, approve (with code), stop | act without the agent's token and definition |
| Console | optional separate process on one chosen machine | device registry, UI state, push subscriptions | read, chat, pause (scoped tokens); relay a passkey assertion it cannot forge | approve or resume by itself, hold GitHub or model credentials, run shell or file operations |

## 2. Decisions this change settles

### D1. Daemon: our own steward, API and client, written from scratch (inspired by dpi-backend)

`disler/durable-pi` (`dpi-backend`, `dpi-tui`, `dpi-sdk`, `dpi-playground`) is **inspiration only**. We read it for ideas and copy nothing: no code, no vendored files, no adapted modules, no attribution obligations. Reasons: it is built for OpenRouter-only auth, pins pi-durable 1.0.3, hosts many sessions per process and carries demo/hub features this plan does not need; our trust model (profiles, scoped tokens, approval credential classes, chat guardrails) differs. Decision: we write our own steward, daemon API, typed client, TUI and console from scratch in this repo. Ideas taken, each reimplemented to our own contract: a versioned `/v1` API with bearer auth; SSE with `hello -> snapshot -> deltas`; idempotent `requestId`; a device `uid` and `apiVersion`; a token-injecting proxy so browsers never see daemon tokens; one multiplexed SSE stream per browser tab; a device registry with `online | offline | unauthorized | mismatch | incompatible` states. We do **not** aim for `dpi-tui`/`dpi-sdk` wire compatibility; `durable attach` is our own terminal client on our own API.

*Inspired by:* `disler/durable-pi` (`apps/dpi-backend/API.md`, `apps/dpi-playground`).

### D2. Model auth: generic reuse through the profile; Anthropic OAuth as a ranked spike question

Findings (verified in installed code and docs):
- pi-ai takes an injectable `CredentialStore` (`createModels({ credentials })`). OAuth refresh runs
  inside the store's serialized `modify()`.
- `@earendil-works/pi-coding-agent` exports `AuthStorage.create(path)`, a file-backed store over Pi's
  `auth.json` format with a lock. Pi's own experimental durable agent states "credentials are shared" with Pi.
- `@nanstey/pi-auth-profiles`: a profile is a separate file with the same schema as `auth.json`
  (`default` = `~/.pi/agent/auth.json`, `<name>` = `~/.pi/agent/auth-profiles/<name>.json`). Profiles are
  isolated on purpose; refresh-token rotation breaks if files are shared. Env vars and `models.json` keys
  apply in every profile.

**Generic reuse (answer to C4):** the steward resolves `profile` to one file and calls
`createModels({ credentials: AuthStorage.create(thatFile) })`. That store can hold OAuth for any provider
pi-ai supports. OpenAI/Codex OAuth, OpenRouter and other API keys, and TypeSafe work without extra code.
The process never opens a second store, so it cannot use another profile's credentials.

**Anthropic subscription OAuth** (`sk-ant-oat...`) additionally needs request shaping. Inspection of
`@gotgenes/pi-anthropic-auth` 3.4.2: `src/oauth-transport.ts` exports
`createAnthropicOAuthStreamSimple(delegate)`, which wraps pi-ai's built-in
`anthropicMessagesApi().streamSimple` (read from `@earendil-works/pi-ai/compat`) and injects
`shapeAnthropicOAuthPayload` (billing header, Claude Code system-prompt shaping, version sync) through
`onPayload` and a version-aware `fetch`. Only `src/index.ts` touches Pi's extension API
(`pi.registerProvider("anthropic", ...)`). The package ships TypeScript source and declares no
`exports` map, so a deep import of the transport is possible in principle. Peer floor is pi-ai >= 0.86.

Slice 1 ranks these options by executed evidence:
1. **Host the wrapper in the steward.** Deep-import `oauth-transport.ts`, supply the delegate from
   pi-ai, and install it as the Anthropic stream in the steward's `Models` (custom provider or per-request
   `onPayload`/`fetch`, or pi-durable's `beforeRequest` hook). No extra process; couples to a third-party
   file layout and to Claude Code version tracking. Pin the version; vendor a copy if the layout is unstable.
2. **Route steward model calls through a Pi process in RPC/SDK mode** that already loads the extension
   (`pi --mode rpc` per agent, same derived `PI_CODING_AGENT_DIR`). Works with the real extension; adds a
   process and a protocol adapter.
3. **Fallback:** Anthropic-OAuth profiles run only in Pi-session workers and reviewers (where the
   extension loads, as today). The steward uses an API-key, OpenAI-OAuth or OpenRouter provider from the
   same profile, or from a profile the operator designates for it.

Caveat (stated plainly): the shaping imitates Claude Code requests. It is fragile (tracks Claude Code
versions; the extension already handles `claude_code_version_too_old` rejections) and may conflict with
the provider's terms. The operator accepts that risk per profile. This repo already hit the unshaped
symptom (`400 You're out of extra usage`, `harness/pi/README.md`).

**Seam:** `identity/modelAuth.ts` exposes `createModelsFor(profile, providers) -> Models`. Implementations:
`plain` (default), `anthropicShaped` (options 1 or 2). Agent definitions do not change when the choice
changes.

### D3. Profiles, manifests, definitions and machine file (answers C1, C3, Q2)

Three kinds of files with a clear home each:

| Kind | Contains | Secrets? | Portable? | Home |
| --- | --- | --- | --- | --- |
| **Profile** (existing + manifest) | model auth file, `secrets/<name>.env`, and a **new** non-secret manifest | yes (first two) | name only | `$PI_AGENT_DIR/{auth-profiles,secrets,profile-meta}` |
| **Agent definition** `agents/<id>.yaml` | `profile: <name>`, repo slugs, sources, limits, merge policy per repo, notification mapping, dispatcher choice | **no** | yes (no absolute paths, no hostnames) | local dir `~/.config/durable/agents/` by default; a private repo checkout via `DURABLE_AGENTS_DIR` |
| **Machine file** `machine.yaml` | which agent ids run here, checkout roots/paths per repo slug, channel definitions, Orca binary override | no (secrets referenced by profile + name) | no | `~/.config/durable/machine.yaml` |

The public durable repo ships schemas and examples only (placeholders). Nothing machine-local or absolute goes in it.

**Profile manifest** `profile-meta/<name>.json` (extension of pi-auth-profiles that stays out of its way; pi-secret-like CLI `durable profile ...`):
```json
{ "version": 1, "label": "work",
  "github": { "host": "github.com", "login": "operator-login" },
  "git": { "name": "Operator Name", "email": "operator@example.invalid" },
  "providers": ["openai-codex", "anthropic", "openrouter"] }
```
`durable profile init <name>` creates it; `durable profile bind-github <name>` runs `gh api user` once with that profile's
`GH_TOKEN` and writes the login, so later runs compare against a pinned value. `durable profile list|show|check`.

**Cross-machine behaviour:** profile **names** are shared labels (`work`, `personal`). Each machine defines its own contents. An
agent definition names a profile and nothing else about identity. If the machine lacks the profile, `doctor` fails closed with the exact
missing parts: Pi login for the providers the agent uses, `pi-secret -p <name> set GH_TOKEN`, manifest.

**Assignment:** `machine.yaml` `agents: [id, ...]` lists the agents that run on this machine. `durable enable <id>` only enables an
assigned agent whose definition and profile validate. An agent id on two machines is allowed (claims prevent double work, slice 10).

**Launcher and doctor checks, derived from the profile:**

| Concern | Mechanism |
| --- | --- |
| Pi model auth (steward) | `AuthStorage.create(<profile file>)` |
| Pi model auth (workers) | derived `PI_CODING_AGENT_DIR=$DURABLE_HOME/agents/<id>/pi`: generated `settings.json`, `auth-profiles.json` pinning `defaultProfile`, symlinks to the canonical `auth-profiles/`, `secrets/`, `profile-meta/`, `extensions/`, `skills/`, `agents/`, `prompts/`, `npm/`, `vendor/`. **No `auth.json`** unless the profile is `default` (then a symlink to it), so no profile falls back to another. Own `sessions/`. |
| GitHub token | `GH_TOKEN`/`GITHUB_TOKEN` from `secrets/<profile>.env`, overriding anything ambient |
| `gh` config | `GH_CONFIG_DIR=$DURABLE_HOME/agents/<id>/gh` (empty) |
| git identity and creds | `GIT_CONFIG_GLOBAL=$DURABLE_HOME/agents/<id>/gitconfig` generated from the manifest (`user.name/email`, `credential.helper` -> `gh auth git-credential`, HTTPS rewrite of `git@github.com:`), `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_TERMINAL_PROMPT=0`, `SSH_AUTH_SOCK` unset |
| Other provider keys | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ... scrubbed; only `secrets/<profile>.env` entries are added |
| Verification (every start and every worker launch) | profile exists on this machine; manifest present; `gh api user --jq .login` equals manifest login; `git` identity equals manifest; model auth present for every provider the agent's models need and for the reviewer family; token type check (see D6); no ambient credential variables survive in the built env. Any failure -> refuse, audit, notify. |

Assumption to verify in slice 2: symlinked `auth-profiles/` survives the file lock + atomic rename in `FileAuthStorageBackend`.

### D4. Workers: two kinds behind a `WorkerDispatcher` (revised in revision 7, U6)

Orca runs on every machine (C7), but dispatch is an interface so the choice stays swappable. Revision 7 separates two concerns that were one:

1. **`WorkerDispatcher`** = *where work lives*: workspace (worktree) creation and removal, hosting an external process, viewing it. Adapters: `orca` (primary), `git-process` (second and test double), `fake`.
2. **`WorkerKind`** = *what runs in the workspace*: **`pi-session`** (a standard Pi session, the **default**) or **`durable-conversation`** (a pi-durable child conversation inside the steward, opt-in, D19). A worker kind picks the workspace first (always through the dispatcher), then starts its session.

Dispatcher contract (types in program design §2): `createWorkspace` (idempotent), `removeWorkspace` (refuses dirty or unpushed work), `listWorkspaces`, `hostProcess` / `processStatus` / `interruptProcess` / `sendInput` / `readOutput` (for process-hosted kinds), `attachInfo`, `openViewer` (create a terminal that runs `durable attach ...`, D20) and `capabilities`. A kind contract: `start`, `status`, `result`, `interrupt`, `steer?`, `transcript`, `resume` (after a crash), `capabilities`.

| Adapter | Role |
| --- | --- |
| `orca` | **Primary.** `ORCA worktree create --no-parent --json`, `ORCA terminal create --worktree path:<p> --title <t> --command <cmd> --json` (hosts a Pi session **or** a viewer running `durable attach`), `terminal list/read/send`. CLI resolution as in `handoff`. |
| `git-process` | Second implementation and **test double**: `git worktree add` + detached process with a log file. Selectable per agent. The workspace provider for Android. |
| future | Remote host over Tailscale (the contract passes the brief by value, the profile by name, and builds secrets on the executing host). |

**Capabilities by worker kind** (confirmed per adapter in slices 1 and 6; "Orca" = the `orca` adapter, "git" = `git-process`):

| Capability | `pi-session` | `durable-conversation` |
| --- | --- | --- |
| Where it runs | Pi TUI process in an Orca terminal (or a detached process on `git-process`) | Inside the agent's steward process, headless (no extra process; tool subprocesses only) |
| `attach` | Orca: `interactive` (its own terminal); git: `read` (log tail) | `interactive` through `durable attach` (viewable in an Orca terminal, D20); `read` everywhere else |
| `steer` | Orca: `true` (`terminal send --text --enter`, spike-verified on a throwaway terminal; one live-TUI check in slice 6); git: `false` | `true` (follow-up or steer on the child conversation), subject to the chat guardrails |
| `transcript` | Tail of the Pi session JSONL under the per-agent sessions dir | Native conversation events (live, durable) |
| `interrupt` | Orca: `terminal send --interrupt` or close; git: signal | Abort the owning task (bottom-up) |
| `resumeAfterCrash` | **No** native resume: the steward re-dispatches with `pi --continue` (process-level, bounded by `maxAttemptsPerItem`) | **Yes**: pi-durable resumes the child; an interrupted non-replay-safe tool returns `interrupted` and the model re-checks state |
| User skills, extensions, prompts, Pi packages | **Yes** (the derived per-agent Pi directory; `idea-to-pr` etc.) | **No**; only allowlisted skill documents as prompt sections (D19) |
| Anthropic subscription OAuth | Yes (the extension loads in the Pi session) | Only if the `modelAuth` Anthropic option is enabled (D2) |
| Process isolation | One process per worker | **Shared** steward process and event loop (limits, D19) |
| Token exposure | `GH_TOKEN` in the worker's environment (guard + GitHub rules are the stop) | **Not in the model's shell**; only code-owned tools use it |
| Viewable in Orca | Terminal tab (the Pi TUI) plus the worktree's branch/diff | Worktree branch/diff **plus** a `durable attach` viewer terminal |

Selection (agent definition, overridable in `machine.yaml`): `workers.dispatcher: orca | git-process`; `workers.kind: pi-session | durable-conversation` (**default `pi-session`**); `workers.durable: { maxConcurrent, roles, skills, viewer }` (D19). No silent automatic fallback between dispatchers or kinds (a silent switch would change visibility, token exposure and recovery behaviour).

**What this replaces.** The first revisions treated durable-conversation workers as a deferred migration. They are now a planned opt-in kind (slice 6c); Pi-session workers stay the default because they reuse the whole skills ecosystem unchanged. Pros and cons of the two kinds:

| | Pi sessions in Orca worktrees (default) | Durable conversations in the steward (opt-in) |
| --- | --- | --- |
| Pros | Reuses skills, agent profiles, extensions, `idea-to-pr`, Pi packages unchanged. Process isolation per worker. Visible in Orca as a terminal. Anthropic subscription works. Stable surface. | Crash-resume of the worker itself. No TUI or extra process per worker (headless). Native API/TUI attach and a conversation tree. Owned task trees: abort bottom-up. One audit stream. Token never in the model's shell; code-owned push/PR tools. |
| Cons | A TUI per worker (cost). No crash-resume (re-dispatch with `pi --continue`). Coupling by polling GitHub/Orca. Token in the worker env. | Experimental pi-durable subagent API (1.4.0). One process owns the storage: workers share the steward's event loop and fate. No user skills/extensions. Confinement is cwd + path checks + a command guard, not a sandbox. Anthropic OAuth needs D2 option 1. |

Adoption path (evidence-gated): slice 6 ships both adapters and the `pi-session` kind; slice 6c adds `durable-conversation` for **read-only roles first** (reviewer, scout-style tasks) and small code-writing items behind per-agent opt-in; both kinds pass the same contract suite; rollback is a config change. Android defaults to `durable-conversation` (D17, slice 14).

### D5. Orca integration (inside the `orca` adapter)

Resolve `ORCA_CLI_COMMAND` > `orca-dev` > `orca-ide` on Linux outside an Orca terminal > `orca` (bare `orca` can start the GNOME screen reader).
Worktree per work item, terminal per job (title includes agent and item), `terminal list --worktree ... --json` before create to avoid duplicate
sessions. **Viewers:** `ORCA terminal create --worktree path:<p> --title 'durable:<agent>/<item>' --command 'durable attach <agent>/<conversation>' --json` opens a `durable attach` TUI in an Orca terminal, so Orca lists durable conversations (the steward, chat threads, durable workers) beside the user's normal sessions. The Orca CLI's `terminal create --command` is documented in its `--help` and was executed in slice 1; **unverified** is whether a full-screen TUI renders and accepts input in such a terminal and whether closing the terminal leaves the work running (slice 1 addendum). Fallback if unsupported: `openViewer` returns the command string and the user runs `durable attach` themselves. Orca flag drift is a named risk;
the adapter is the only place that knows the flags.

### D6. GitHub identity: the operator's account (C2) and what follows

Design consequences (all part of the contract):

1. **Self-approval is impossible.** GitHub refuses an approving review from the PR's author. Therefore:
   - The cross-family review verdict is **not** a GitHub review. It is stored in the steward's `steward.reviews` document (head-SHA-pinned, model family recorded) and mirrored for humans as a commit status (`durable/review`, needs "Commit statuses: write"; optional) and a PR comment with a marker. **The gate reads the steward record, never the status or comment.**
   - Repos whose rules require approving reviews (`reviewDecision == REVIEW_REQUIRED` for a required count) are **not auto-mergeable**. Gate result: `wait-human`, reason `github-requires-approval-from-other-account`. The human merges in GitHub, or approves from another account and the steward may then merge if policy allows.
2. **Any GitHub-surface signal the operator identity can write is forgeable by a compromised agent** (labels, comments, statuses, reactions, issue edits). The gate trusts only: (a) GitHub-computed facts (`mergeStateStatus`, `reviewDecision` from *other* accounts, `statusCheckRollup` from required checks, head SHA, changed files, author), and (b) steward-internal records. A label or comment is never an authorization.
3. **Attribution:** commits authored with the profile's git identity plus trailer `Durable-Agent: <id>`; branches `durable/<id>/<item>`; label `durable/agent:<id>`; PR body footer ("Opened by durable agent <id> for <login>; not yet reviewed by a human"). Draft first.
4. **Token guidance (doctor enforces what it can):** fine-grained PAT (`github_pat_...`), **selected repositories only** (the scope's repos), permissions Contents RW, Pull requests RW, Issues RW, Metadata R, Actions R, Commit statuses RW (optional), **no** Administration, **no** Workflows write (so `.github/workflows` edits fail), expiry <= 90 days. Doctor warns on classic `ghp_` or broad OAuth `gho_` tokens (including the `gh auth login` default), on `x-oauth-scopes` containing `admin:*`, and on repos in the token's reach beyond the agent's scope when detectable. One profile per scope; work and personal never share a token.
5. **Blast radius:** a prompt-injected agent can do what the operator account can do within the token's repos. Mitigations in depth: trusted-author eligibility; token scope; no admin; guards; gate in code; human merge by default; audit with identity per write; kill switch. Hardening beyond v1 (not planned): run workers under a separate OS user or container with a token proxy.
6. **Human approval resolution** (see D8): human merges in GitHub (strongest), or `durable approve` with an out-of-band code, which authorizes the steward to *attempt* the merge within GitHub rules.

### D7. Coordination: GitHub first, files second, no shared DB

- **Claim** = label `durable/claimed` + marker comment `<!-- durable-claim agent=<id> lease=<iso> -->`; read-after-write, lowest comment id wins; lease expires (default 2 h) and renews while a worker lives. Because identity is shared, two machines' stewards authenticate as the same account; the **agent id in the marker** distinguishes them. Claims are coordination, not security.
- **Worker -> steward** report = the draft PR (branch `durable/<id>/<item>`, label, marker). Steward polls. No callback endpoint in v1.
- **Human -> steward** control = `durable` CLI/API (L1), push-notification link to GitHub (L2), GitHub `durable/pause` label (informational pause: honoured, since a forged pause only stops work; a forged "resume" is never honoured automatically), or human merge.

### D8. Gate contract, human approval and per-repo policy (answers C2, C6)

`decide(policy, facts) -> { action: "merge" | "wait-human" | "block", reasons[] }`, pure and tested over a table.
Unknown or missing fact -> `wait-human`. Mode `never` -> `wait-human`.

**Policy: a pluggable `RepoPolicySource` seam; the mechanism is deliberately undecided (revision 5, Q18).** The user decided not to fix how a repo's auto-merge policy is stored: it may vary per repo and is decided when the first repo needs auto-merge. This plan therefore defines only the **seam** and the **mechanism-independent invariants**, not a file format, a path or a trust-pin format.

Effective policy = intersection of three things:
1. **GitHub's own repo rules** (branch protection or rulesets, required checks, required reviews, allowed merge methods), read through the API and, above all, through GitHub-computed state on each PR (`mergeStateStatus`, `reviewDecision`, `statusCheckRollup`). Never re-implemented, never bypassed.
2. **The policy resolved by the repo's declared `RepoPolicySource`** (below), expressed in a neutral `AutoMergePolicy` model the gate understands.
3. **The agent definition**, which may only **tighten** (`merge.mode` ceiling, `merge.shadow`, `merge.tighten.*`).

**The seam (per repo, declared in the agent definition as `scope.repos[].policySource: { kind: ... }`, default `none`):**
- A source implements `resolve(repo) -> { state, policy?, ref, protectedLocations, fingerprint }` and `protectedLocations()`. `state` is one of `verified | unverified | invalid | unavailable | none`. `ref` is the trusted ref or location the **steward** resolved and records (opaque to the gate). `protectedLocations` lists whatever holds the policy (repo paths, a ruleset id, a store key) so the gate can recognize a change to it.
- **Candidate kinds, listed as options only, none chosen:** policy stored in a file in the target repo; GitHub rules/rulesets only (no durable-specific extras); agent-definition-only (tighten-only values with no repo-side policy); an out-of-repo store; `none`.
- **Built in this plan:** `none` (auto-merge off; the default and the only kind real repos use until one is chosen) and a test-only `fixture` source (drives gate tests and shadow-mode tests). The first real source is chosen per repo later and specified then (open decision Q18; a small spec when the first repo needs it).
- The neutral `AutoMergePolicy` model the gate consumes (any source must produce it): `enabled`, `authors`, `baseBranches`, `pathAllow`/`pathDeny`, `maxChangedLines`, `maxFiles`, `maxRisk`, `requiredChecks` (`github-required` or a list), `methods`, `requireCrossFamilyReview`, `requireHumanApproval`, `coolingOffMinutes`. This is the gate's input contract, not a storage format.

**Mechanism-independent invariants (these stay whatever the source is):**
- **P1** Policy is never read from the PR head, a fork, a worker worktree or any filesystem a worker can write. A source reads only from a trusted ref or location that the steward resolves itself and records.
- **P2** A policy is usable for auto-merge only in state `verified`, and a source may return `verified` only on evidence the agent cannot forge: an approval-class human action (D15) or GitHub-computed state. The verification mechanism is source-specific.
- **P3** Changes to whatever holds the policy (the source's `protectedLocations`), to CODEOWNERS and to GitHub rules are never auto-mergeable and always need human approval. A PR touching a protected location or a hard path (CODEOWNERS variants `CODEOWNERS`, `.github/CODEOWNERS`, `docs/CODEOWNERS`, and `.github/**`) is `wait-human` with reason `policy-or-owner-file-change`, is never `would-merge` in shadow mode, and is excluded from any auto path. After any such change the policy state drops to `unverified` until a human re-verifies it through the approval class.
- **P4** A missing, unparseable, invalid, unavailable or unverified policy means auto-merge is disabled for that repo (the human-approval path is unaffected). `none` is such a state by definition.
- **P5** The definition may only tighten: each numeric/set field is the most restrictive of the policy and the definition; loosening is clamped with a `doctor` warning; the definition cannot enable auto-merge without a `verified` policy that says `enabled: true`.
- **P6** Shadow mode first (below); never `--admin`, never any bypass; kill switch, daily cap and re-verification are checked immediately before any merge call.

**Verification action in the approval class:** `verify-policy` (renamed from the earlier `trust-policy`): the source supplies the challenge display data (what changed, as the daemon can establish it from its own reads), and the action is performed with the CLI nonce or a passkey assertion exactly like approve/resume/enroll. With `none` and `fixture` it only exists to test the path.

**Shadow mode** `merge.shadow`: evaluate the auto decision on every PR, log `would-merge`/`would-not-merge` with full reasons, behave as `human-approval`. With policy state other than `verified` (including `none`), shadow output is `would-not-merge: <state>` **plus a readiness list** of every other gate fact (checks, verdict, paths, size, mergeable state) so the operator can see what would otherwise have happened.

Facts (read by code at the head SHA): author is the profile login and in the policy's `authors`; draft state; `mergeStateStatus == CLEAN`; `reviewDecision`; required checks passed; steward review record for **this head SHA** from a family different from the producer's; changed paths and sizes; risk class; policy state `verified`; daily merge cap; cooling-off elapsed; kill switch off. The merge call uses `gh pr merge --match-head-commit <sha>` (and `--auto` where the repo uses a merge queue). No `--admin`, no `--force`, no bypass. A crash mid-merge yields an "interrupted" result; the next run re-reads `state/mergedAt`.

**Proof without a canary:** (1) gate tests over recorded GitHub API fixtures (scrubbed `gh pr view --json` outputs and CODEOWNERS/rules fixtures from real repos, including protected-branch and review-required cases, plus `fixture`-source cases for every policy state); (2) **shadow mode** on real PRs, reviewed by the operator before any repo gets a real policy source with `enabled: true`.

**Human-approval task** (durable, waits through restarts) resolves by any of:
- the PR is **merged by a human** (steward observes `MERGED`, records "merged by human", releases claim);
- an approving review from an account **other than the agent's** appears; the gate re-runs and, if policy permits, the steward merges;
- `durable approve <agent> <pr> --code <nonce>` (or the TUI; also `durable resume` after a kill and the policy verification action `durable policy verify <repo>`): the nonce is generated per PR+head SHA and delivered **only** to the `desktop` and `command` channels (never to GitHub, the console inbox or any API-readable place, never written to a file, comment, label or log; the steward keeps a hash). It authorizes the steward to attempt the merge within GitHub rules. If GitHub still requires another account's approval, the steward says so and stops. Worker sessions never see the nonce.
- a **passkey assertion from the console** (slice 12a; D15): the daemon verifies a WebAuthn assertion over its own challenge bound to agent, item, head SHA and action. No bearer token and no console-held secret can produce it.
Honest limit: workers share the operator's OS user and token, so these are protections against accidents and prompt injection, not against a fully compromised worker (D15 states the residual risks).

### D9. Safety layers (defence in depth, in order of strength)

1. **GitHub rules** (branch protection/rulesets, required checks/reviews, token scope). The gate reads `mergeStateStatus`, `reviewDecision`, `statusCheckRollup` from `gh pr view --json` instead of re-implementing protection logic.
2. **Gate in code** (D8). 3. **Eligibility in code**: only trusted-author items enter the queue (OWNER/MEMBER/COLLABORATOR or explicit list); issue and PR text is untrusted.
4. **Guards**: the steward `beforeTool` hook, the same shared block-list inside durable-conversation workers' tools (D19) and the Pi extension `durable-worker-guard.ts` (loaded when `DURABLE_WORKER=1`) block `gh pr merge`, `git push` to default/protected branches, force pushes, `--admin`, `gh api -X PUT .../merge`. A guardrail, not a sandbox.
5. **Human-held workspaces (D19):** a worktree marked `human-held` is never resumed or written to by the daemon (either worker kind) until a human releases it.
6. **Budgets and kill switch** (disabled file, `systemctl --user stop`, GitHub `durable/pause`, console/CLI `pause` (bearer scope `pause`), quiet hours). **Resume** after a pause requires the approval credential (D15), so an agent cannot un-pause itself. 7. **LLM can only tighten** decisions.

### D10. Control plane, notifications and channels (answers C5; revised by U1 and U2)

Layering and the recommendation are in the product review ("Control plane and notifications"). Architecture contracts:

- **Daemon API v1** is shaped for remote clients from slice 3 (D14 and §3.3): versioned `/v1`, scoped bearer tokens, SSE `hello -> snapshot -> deltas`, idempotent `requestId`, device identity. The CLI/TUI and the console are both clients of it.
- **Notifier** (`notify/`): event taxonomy (`approval-needed`, `escalation`, `budget-stop`, `identity-failure`, `agent-down`, `merged`, `digest`), priority, de-dup key `agent+event+target+sha` with TTL, quiet-hours holding (never dropping), reminder cadence, redaction (ids, titles, URLs only; never bodies, tokens or nonces except the approval nonce to `desktop`/`command`).
- **Channels** (machine-local definitions in `machine.yaml`; agent definitions map events to channel names). Only these kinds exist:
  | Kind | Delivery | Notes |
  | --- | --- | --- |
  | `inbox` / `console` | always writes the agent's `steward.inbox` entry; the console shows a badge/inbox and, in slice 12b, sends Web Push to subscribed browsers | Inbox is API-readable by token holders (agents too), so it never carries a secret. |
  | `desktop` | platform-aware: `notify-send` on Linux machines with a desktop; `termux-notification` on Android (D17) | Carries the approval nonce on Linux only; **never on Android** (notifications are readable by other Termux processes and the lock screen). |
  | `command` | operator-defined argv with the event as JSON on stdin | May carry the approval nonce. For the operator's own scripts. |
  | `github` | review request, @mention or assignment to a **target login** that is not the agent's profile login | Silent when the target equals the actor (GitHub does not notify you of your own activity). Never carries secrets. |
- `agent-down` uses a systemd `OnFailure=` unit that runs `durable notify --event agent-down` because a dead agent cannot report itself; the console also shows a device offline state.
- **No answer:** durable wait, capped reminders, then park as `needs-human` after `staleDays` (release claim and workers, one GitHub comment). Never escalate privileges, approve, or merge to unblock.
- **Console:** see D13. It adds no authority; it relays reads, steering, pause and passkey assertions.

### D11. Retirement of `pi-interactive-subagents`

Do not remove it before replacements cover its documented uses. Replacement map: background/headless work -> steward workers or `pi -p` runs;
"run this in a new worktree" -> `handoff`; parallel read-only analysis in an interactive session -> headless `pi -p` or Claude Code subagents
(`agents/` profiles stay valid for Claude Code). Slice 13 removes the package from `settings.json`, its config, its two patches and fixtures, and the
reviewer provider-lock patch if it depends on `PI_SUBAGENT_AGENT`, after an inventory of `subagent`, `subagent_done`, `caller_ping` references.

### D12. Existing skills

| Skill | Fate |
| --- | --- |
| `idea-to-pr` | Unchanged. It is the **Pi-session** worker's engine (brief = "load idea-to-pr, autopilot"). Worker brief forbids merging. Durable-conversation workers do not load it (D19): its workflow stays on Pi-session workers. |
| `handoff` | Unchanged. For humans. Its Orca recipe is mirrored inside the `orca` adapter; if both drift, extract a shared helper later. |
| `orchestration` | Unchanged. Not used by the steward (poll-based). |
| `pi-improve` / self-improvement loop | Unchanged. Its kill switch and cap pattern are reused. It could later become a steward source. |
| New thin `durable` skill (`skills/agent/durable`, skills repo) | Short operator pointer: what durable is, key commands, link to the durable repo's `docs/operator.md`. Catalog row required in the skills repo. The detailed operator guide lives in the durable repo. |

### D13. Web console: a multi-machine viewer/controller, not a hub (U2)

**Tension resolved.** Earlier revisions said "no hub, no cross-machine network in v1". The console does not break that: it coordinates nothing. It holds no queue, claim, lease, gate or approval state. Daemons never call each other or the console. Claims, gates and approvals run inside each daemon and on GitHub. The console only (a) reads daemon APIs, (b) relays scoped steering/pause and a passkey assertion, and (c) stores a registry, UI state and push subscriptions. It is optional per machine and may run on more than one machine. If it is down, agents are unaffected and the CLI still works on each machine.

**Placement.** One process on the console host: `durable-console.service` (systemd user), installed by `install.sh` but never started by it (`durable console enable`). Its name and URLs are machine-local (`console.yaml` on that host). A console host may also run agents.

**Ideas inspired by `dpi-playground` (hub + web client), all reimplemented by us from scratch:** token-injecting server-side proxy (the browser never sees a daemon token); one multiplexed SSE connection per browser tab with subscription keys (`<device>/agent/<id>`), 20-key cap; device registry with a status machine `checking -> online | offline | unauthorized | mismatch | incompatible` and backoff (offline 1 s -> 30 s, human-fixable states 30 s or explicit check); `guard` (Host allowlist against DNS rebinding, same-origin check, JSON-only writes). Tree: **machine -> agent (profile name, repo scope) -> conversation / worker**. `mismatch` = the daemon's `uid` differs from the registered one (replaced host or impostor); `incompatible` = `apiVersion` outside the console's range.

**What `dpi-playground` is:** the web interface in `disler/durable-pi` (a hub server plus a Vue 3 client, about 6.6k lines with its SDK, experimental) for managing durable Pi sessions across devices. It runs no agents and was built for that project's demos, so it ships panels we do not want (session creation, state editor, jobs, model picker, directory browser). **Decision (Q15, revised by U3): build our own minimal console, hub, client library and API from scratch, using dpi-playground only as inspiration.** For scale only: upstream hub about 650 lines, front end about 4,200 lines of Vue 3 + Vite 8, SDK about 1,800 lines, plus `express`, `marked`, `dompurify`, `lucide` and a Vite/vue-tsc/oxlint toolchain. We do not reuse any of it.

| Option | For | Against |
| --- | --- | --- |
| Reuse upstream code (vendor or adapt) — **rejected (U3)** | Fastest to a UI; tested | About 5k lines of mostly irrelevant panels (state editor, jobs, extensions, directory browser = file access we must not ship); API is the dpi session model, not ours; Vue/Vite toolchain and `marked`+`dompurify` markdown path (XSS surface); upstream is experimental and moves with pi-durable. |
| Build our own from scratch, inspired by upstream ideas (**chosen**) | Domain fits (fleet, queue, claims, workers, approvals, audit, gate); our own API contract and tests; no build step; fewer dependencies; no license or attribution bookkeeping; untrusted text rendered inert | We write and test the hub, client library and front end ourselves (a few thousand lines at most, each with its own tests). |
| Hybrid: reuse only the upstream SDK and hub, write a new front end — **rejected (U3)** | Reuses a tested protocol client | Couples to dpi API shapes; extra surface; contradicts the inspiration-only decision. |

Front end: **no build step.** Static ES modules with small pinned, checksummed third-party libraries (Preact + htm; unrelated to the dpi projects), a plain service worker and manifest. No markdown or HTML rendering of conversation, issue or PR text: it is shown as text with preserved whitespace; links are shown as text with a copy/open action only for `github.com` URLs. Strict CSP (`default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'`).

**PWA-ready from the first release (Q16).** The first console release (slice 8) is built so that the manifest, service worker, push subscription store and HTTPS are purely additive later (slice 12b): same-origin only with relative URLs; every response carries a CSP that already allows `worker-src 'self'` and `manifest-src 'self'`; no inline script or style; cookies, if any, use `Secure` when the request came over HTTPS; routes under `/api/push/*` are reserved and answer `501 not-enabled`; the notifier core already models events and writes the `console` channel inbox, so Web Push is just another consumer of the same `inbox` SSE frames; VAPID handling is decided now (keys generated by `durable console push-keys init`, stored `vapid.json` mode 600 beside `console.yaml`, subject from `console.yaml push.subject`, `web-push` loaded lazily as an optional dependency) and implemented in 12b. Tests in slice 8 assert same-origin URLs, the CSP directives and the reserved routes.

**Capabilities by slice**
| Capability | Slice |
| --- | --- |
| Fleet overview (machines, agents, status, budget, kill-switch state), per-agent view (queue, claims, workers, PRs), **interactive chat** (D16: live transcript, follow-up, steer, abort a turn, start new chat/scout conversations, resume existing ones), pause, audit viewer, inbox (read/ack) — **one machine, loopback**, responsive layout | 8 |
| Shadow-mode gate report tab | 9 (endpoint) and 8's tab shell |
| Multi-machine registry, tailnet daemon listener, status machine across devices, per-machine grouping, **any browser (laptop or phone) over Tailscale Serve HTTPS with the identity allowlist, with the same capabilities as localhost, including interactive chat and pause** | 11 |
| Passkey enrollment; approvals inbox; guarded approve, agent resume after a kill/pause, enroll and policy verification (any browser) | 12a |
| Installable PWA, service worker, Web Push (best effort), VAPID keys, push subscription store | 12b (follow-up; blocks nothing) |
| Explicitly **never**: shell, file browsing/reading, arbitrary API passthrough, config editing, token display, starting workers or reviewers directly | all |

### D14. Network and auth design (answers C; keeps "tailnet membership alone is not trust")

**Daemon exposure (Linux with the Tailscale CLI; Android differs, D17): recommend binding the Tailscale interface address (the machine's `100.x` address) in addition to loopback, never `0.0.0.0`/LAN.** Reasons: the daemon sees the real peer address, so it can ask the local Tailscale daemon `whois` for the peer's node, tags and user and enforce `network.allowedPeers` (for example `tag:durable-console`) **in addition to** the bearer token; nothing depends on spoofable headers; no extra proxy per port. TLS is not needed on this leg (WireGuard encrypts and authenticates the tailnet hop). Alternative considered: loopback plus `tailscale serve` per daemon, which gives HTTPS and identity headers but hides the peer address (headers are only as trustworthy as the proxy path, and tagged sources may not carry user headers; verified in slice 1). The daemon retries the tailnet bind until Tailscale is up; loopback always serves the local CLI.

**Per-daemon credentials (not profile secrets).** Profile secrets (`secrets/<profile>.env`) are exported into agent environments by `profile-secrets`; a daemon token stored there would be visible to the agent it protects. So daemon tokens are daemon-level: `durable token create --client <name> --scopes read,steer,pause` prints the token once on the daemon's machine; the daemon stores only a hash in `$DURABLE_HOME/agents/<id>/tokens.json` (0600) with client name, scopes, created/last-used, expiry (default 90 days). Rotation: create the new token, update the console registry, revoke the old one (`durable token revoke`). **No token scope can approve or resume or enroll keys.** The local CLI uses a separate local token file (0600) with the same scope rules.

**Console registry** (on the console host only): `~/.config/durable/console/devices.yaml` (mode 600): per device `machine` label, `agent`, `url`, `tokenFile` (token stored in its own 0600 file or an OS keychain reference), expected `uid` after first pairing. `durable console add-device` reads the token from stdin and records the daemon's `uid`. Never in the repo. The console host therefore holds read/steer/pause tokens for every daemon (concentration risk, R22).

**Browser authentication.** The console server listens on loopback or a unix socket only. `tailscale serve --bg https` publishes it on the tailnet with a Tailscale-issued certificate (never `funnel`). Auth layers: (1) tailnet reachability limited by ACL to the operator's devices; (2) Serve identity headers `Tailscale-User-Login` checked against `console.allowedUsers` for view, steer and pause; (3) **passkey step-up** for approve, resume and enrollment (D15). No passwords. Caveat: on a host where agents also run, the loopback backend can be reached by agent processes, which could forge identity headers; that is why approve/resume never rest on headers or tokens, and why headers only guard operations an agent token could already do. Requests also pass the Host/Origin/JSON-only guard plus a CSRF header, because Serve injects identity into any request from the operator's browser, including cross-site ones.

**ACL guidance** (tailnet policy, machine-local to the operator; the operator confirmed the tags may be created when slice 11 is reached, and `doctor` then prints the snippet for them to apply, never editing the policy itself): tag daemon hosts `tag:durable-daemon` and the console host `tag:durable-console`; allow `tag:durable-console -> tag:durable-daemon:<daemon port range>`; allow the operator's user devices -> `tag:durable-console:443`; **no** rule from daemon hosts to each other or to the console; phones do not reach daemon ports directly. Daemons additionally check `whois` tags, so a misconfigured ACL is not the only barrier.

**Peer-to-peer** stays deferred (D-1). The console does not replace it, and agents still never message each other.

### D15. Approval credential and the threat model under a shared identity (answers A)

Facts that shape the design: agents and workers run as the operator's OS user with the operator's GitHub token. They can read any file or token that user can read and can call any local or tailnet-reachable endpoint the daemon bearer token allows. They cannot produce a signature from a hardware or phone-held passkey.

Design:
1. **Approval is a separate credential class**, covering these high-risk actions only: **approve** (merge attempt), **resume** an agent after a kill/pause, **enroll** a key, and **verify a repo policy** (D8). Chat, steering, aborting a turn and pausing are not in this class (D16). Daemon bearer tokens (scopes `read`, `chat`, `pause`) can never approve, resume or enroll. The daemon's approval endpoints accept only (a) a valid **CLI nonce** (slice 7), or (b) a valid **WebAuthn assertion** (slice 12a).
2. **WebAuthn verified by the daemon.** The console is a conduit. Flow: console asks the daemon for a challenge for `{agent, item, headSha, action}`; the daemon stores the challenge (single use, short expiry, bound to that SHA) and returns it with display data (PR URL, title, diffstat, reviewer verdict, SHA); the browser calls `navigator.credentials.get` with `userVerification: required`; the console forwards the assertion; the daemon verifies the signature against public keys enrolled for that agent, the origin and RP ID from machine-local config, the counter, and that the **head SHA is still the same**; only then does it authorize the steward to *attempt* the merge within GitHub rules (D8). No secret exists on the console host or the daemon that can mint an approval.
3. **Enrollment** is the trust root: `durable approval enroll` on a TTY on the daemon's machine prints a short-lived enrollment code; the operator enters it in the console while registering a passkey. Further keys require an existing key's assertion. Every enrollment and approval is audited and sent as a `desktop`/`command` notification.
4. **Confirm step:** the approval screen shows the PR URL, title, diffstat and head SHA and requires an explicit tap; the SHA is inside the signed challenge, so a stale approval fails when new commits arrive.
5. **Console-side checks (defence in depth):** Serve identity header allowlist, Host/Origin/CSRF guard, inert rendering of untrusted text, strict CSP. A script injected into the page cannot sign an assertion without the person completing the passkey prompt.
6. **Resume after pause** uses the same credential classes; **pause** is a plain token scope. (Terminology: *agent resume* = un-pause after a kill/pause, guarded; *conversation resume* = continuing an existing chat, a normal chat action.)

The passkey step-up applies to **any browser**, not specially to phones. A passkey on a phone is the natural step-up device (a desktop browser can use it through the cross-device flow; to be checked in the slice 1 spike). Fallback ladder if the spike shows WebAuthn is not viable behind Tailscale HTTPS for the operator's browsers and devices: console approvals stay disabled for every browser (interactive chat and pause are unaffected, D16); approvals, resume and policy verification use GitHub merge by the human or the CLI nonce on a machine terminal. TOTP is not offered: its secret would sit on a host the agent can read.

**Residual risks (stated plainly):**
- Same-OS-user compromise: an agent with arbitrary shell can read the console registry and daemon token files, so it can read everything and steer or pause through the API. It cannot sign a passkey assertion. But it can attempt enrollment of a new key (needs a passkey device it controls, for example a virtual authenticator in an automated browser) or attack the daemon process directly. Enrollment is audited and notified; strong separation needs a separate OS user or container (not planned for v1).
- A compromised console host can mislead the human about what is being approved (it renders the UI). The signed challenge fixes the item and SHA; the human can verify through the GitHub link; the daemon only ever authorizes a merge attempt that GitHub's own rules still gate.
- A stolen unlocked device (phone or laptop) with a logged-in tailnet identity can view and chat; approval still needs the passkey's user verification.
- Tailnet node compromise: ACL tags plus daemon `whois` allowlists plus tokens limit it; Serve identity headers are not trusted for approvals.
- Web Push payloads transit the browser vendor's push service (encrypted end to end to the browser); content is minimal ("approval needed" + agent + PR number).

### D16. Interactive chat from the console (revision 3 Q17; revised in revision 5 by Q19 and Q20)

**The console is one client with one set of capabilities.** A phone is just another browser client of the same console, with **identical capabilities and the same guardrails** as a laptop browser; there is no phone-specific gating anywhere. From any console client the operator can view transcripts live, send follow-ups and steers, abort a turn, pause, ask an agent questions, and start or resume conversations. Only approve, agent resume after a kill, enroll and policy verification stay behind the guarded credential class (D15), for any browser. Merge itself is never a chat action.

**Console-wide rule for starting conversations (stated once):** any console client may start the conversation kinds the daemon supports, `chat` threads and `scout` Q&A. Workers and reviewers are started by dispatch (claims, budgets), not from the console. The daemon's `startableKinds` setting is console-wide, not per client type.

**Chat-able conversation types**
| Type | View | Chat (follow-up, steer, abort turn) | Start new | Notes |
| --- | --- | --- | --- | --- |
| Steward supervisor conversation (`main`) | always | yes | yes: new **chat thread** (a child/fork conversation of the steward, `kind: chat`) | Narrow tool set (S3). The loop task is separate; chat never blocks or edits it. |
| Scout conversations (per item, read-only tools) | always | yes: follow-up questions | yes: **scout Q&A** about an item (`kind: scout`) | Read-only tools only; cannot write. |
| Worker sessions (Pi sessions) | always (live transcript tailed from the worker's Pi session log, plus `attachInfo`) | **only if the dispatcher adapter reports `steer: true`**; `interrupt` for all adapters (scope `pause`) | **no** (workers start only through claim -> dispatch with budgets) | Expected: `orca` steer only if the installed Orca CLI offers terminal input (checked in slice 6); `git-process` view + interrupt only; `fake` all. |
| Reviewer sessions | view | no | no | Verdict integrity. |

**Guardrails (all enforced by the daemon, not the model or the client)**
1. **Inert rendering:** agent, issue, PR, audit and chat text is rendered as text only (C3). Chat input is sent as plain text; there is no HTML, attachment, role or tool-call field in the API.
2. **No credentials in chat:** `POST .../messages` is screened server-side for credential-like content (GitHub token prefixes, `sk-` style keys, private-key headers, cloud key patterns, long high-entropy strings) and rejected with `invalid: credential-like-content`; best-effort heuristic, documented. The steward's system prompt says it never asks for or accepts credentials, and no chat conversation has a tool that reads secrets or environment.
3. **No default rate limits (Q20).** The earlier hard limits (messages per minute/day, 8 KB messages, open-conversation caps) are removed as defaults: they are unnecessary friction. Runaway cost is already bounded by the **existing per-agent budgets and the kill switch**. Only a very generous sanity ceiling remains: a message body ceiling (default 1 MiB, configurable) so a runaway client or loop cannot exhaust the daemon process's memory. Rate limiting is **opt-in** per agent (`chat.rateLimit`, default off).
4. **Audit:** every message audited with `actor: human`, `via: cli|console`, token client name, the Serve identity login when the request came through the console (informational), conversation id, byte length and SHA-256 of the content (content itself lives in the conversation history, not the audit log).
5. **Per-agent tool policy beats chat:** chat conversations get a fixed, code-defined tool set. Tools are `list_queue`, `explain_item`, `status`, `set_priority` (code-validated document write; never bypasses eligibility or trusted-author rules), `pause`, and `request_merge` / `request_work` that only **enqueue a request** the gate or dispatcher then evaluates under policy, budgets, caps, kill switch and trusted-author rules. There is no tool to resume, approve, merge directly, edit the definition or policy, raise a limit, or run shell/files. A steer can ask for a merge; the gate still decides.
6. **The loop is independent:** the steward loop, claims, budgets and kill switch run in their own tasks; chat messages cannot pause the loop's checks or reorder safety gates.

**What a hijacked chat session can do** (stolen unlocked device or console session within the tailnet identity, any client type): read everything the console shows, talk to agents (no default rate limit, so it can also spend model quota until budgets, the kill switch or an opt-in rate limit stop it), pause agents and interrupt workers, steer a steer-capable worker, and ask for merges that the gate will still evaluate. It cannot approve, resume, enroll, verify a policy or reach credentials. The audit log records every message.

### D17. Platform support: Linux first fleet, Android (Termux) as an additional target (revision 4, U4)

The daemon core must not assume systemd, Orca, a desktop, the Tailscale CLI or a normal Linux filesystem. Platform differences live behind small interfaces selected by **capability flags** (declared in `machine.yaml`, auto-detected where possible):

| Interface | Linux (first fleet) | Android / Termux |
| --- | --- | --- |
| `ServiceManager` (install, enable, disable, start, stop, status, logs, failure hook) | `systemd-user` (`durable-agent@<id>.service`, `OnFailure=`) | `termux-runit`: `termux-services` (runit) service dirs under `$PREFIX/var/service/`, started at boot by Termux:Boot, wake lock via `termux-wake-lock` |
| `Dispatcher` default | `orca` (primary), `git-process` | `git-process` only (no Orca) |
| `DesktopNotifier` backend (the `desktop` channel is platform-aware) | `notify-send` | `termux-notification` (needs Termux:API). **Not nonce-safe**: other processes in Termux can read notifications (`termux-notification-list`) and the lock screen shows them, so the CLI approval nonce is never sent to the Android desktop backend. |
| Tailscale access | CLI present: `whois` peer-tag check, `tailscale serve` | Tailscale Android app has no usable CLI for Termux: peer-tag check **capability-detected and optional**; optional userspace `tailscaled` inside Termux is a spike option |
| Storage | `node:sqlite` via pi-durable's `openNodeSqliteStorage` | same if Termux Node provides `node:sqlite`; else pi-durable's JSONL storage core (capability `storage: sqlite|jsonl`); never a native module that needs install scripts |
| Install path | skills-repo `install.sh` step (pinned clone of the durable repo) or the durable repo's own `docs/install.md` | durable repo `termux/bootstrap.sh` (documented, idempotent, clones and pins durable directly); `install.sh` is not extended |

**Machine capabilities (machine file, §3.2):** `platform.os: linux | android`, `platform.service: systemd-user | termux-runit`, `platform.tailscaleCli: true | false`, `workers.dispatcher` default per platform, `network.peerCheck: required | optional | off`, `network.tailnetAddress` (explicit address because interface enumeration can fail on Android). `doctor` and the console adapt to them (for example, no Orca checks on Android; peer check reported as `unavailable (optional)`).

**What an Android agent does by default (Q21):** steward + scout + chat, plus **light workers** that open draft PRs for **small repos**. **Revision 7 decision: the default Android worker kind is `durable-conversation`** (D19): Pi sessions are heavy on a phone (a TUI process per worker, the skills repo needed), while a headless durable child conversation runs inside the steward with `git-process` providing only the git worktree, needs no skills and keeps the token out of the shell; the cost is the shared-process limits (`workers.durable.maxConcurrent: 1`) and no user skills, so workflows such as `idea-to-pr` run on desktop machines. Pi-session workers stay available on Android as an opt-in (`maxConcurrentWorkers: 1`, short `itemMinutes`, repo-size warning in `doctor`; optional battery floor through Termux:API). Heavy builds and long test suites stay on other machines. **Auto-merge is disabled on Android** (a `merge.mode: auto-when-safe` ceiling on an `os: android` machine is a `doctor` error unless the operator explicitly sets `platform.allowAutoMerge: true`; default budgets are conservative).

**Termux directly, not proot-distro (Q22):** fewer layers, matches the Pi Termux docs (`pkg install nodejs git`, `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`); proot adds a second filesystem and process model that complicates paths, service supervision and wake locks. Revisit only if a required tool is missing in Termux.

**Not always on (Q23):** Android may be asleep, offline, killed by the OS, or out of battery. Consequences designed in: pi-durable resumes after the process is killed and restarted (committed WAL; the newest commit may be lost on host power failure, as for any host); the console shows the device `offline`; `agent-down` cannot be sent by a dead agent and the systemd `OnFailure` hook does not exist, so the console's offline state and GitHub claim lease expiry are the signals; leases (slice 10) must tolerate an agent vanishing mid-claim; the daemon starts conservative after a restart (re-derive world state before acting, as always).

**Android-specific constraints (spike checks, not assumptions):** Termux must be the F-Droid or GitHub build (not Google Play); Android 12+ may kill background child processes (phantom-process limits) and Doze/battery optimization can stop the service, so the user exempts Termux from battery optimization and uses a wake lock; Termux state stays in Termux's private `$HOME` (never shared storage, which cannot hold 0600 permissions; `doctor` refuses `DURABLE_HOME` under `/storage` or `~/storage`); daemon dependencies must install with `--ignore-scripts` and be pure JavaScript (including the WebAuthn verifier); the Termux package set can drift under `pkg upgrade` (Node ABI), so versions are recorded by the bootstrap.

**Network options on Android (ranked by the spike):** (1) bind the daemon to the tailnet address if the Android app exposes it to Termux and it is bindable, using the explicit `network.tailnetAddress`; (2) run `tailscaled --tun=userspace-networking` in Termux as a separate tagged node and forward a tailnet port to the loopback daemon with `tailscale serve --tcp` (needs the Termux `tailscale` package; unverified); (3) loopback only, reachable by a console that runs on the same phone (see below). Never `0.0.0.0` (LAN exposure on public Wi-Fi). Baseline security does not depend on the peer-tag check: the tailnet's own ACL is enforced by the destination node's packet filter, the bearer token is always required, and high-risk actions stay behind the approval credential class.

**Phone as daemon host and console client:** the same phone can run an agent daemon in Termux and open the console in its browser; the browser reaches the console host over the tailnet, and a console running in Termux on the same phone can reach the local daemon over loopback (`http://127.0.0.1:<port>`).

**Shared identity on a device that is easier to lose:** use a **separate profile** and a fine-grained token limited to the small set of repos the Android agent works on, shorter expiry (default 30 days), no auto-merge, human merge by default; rely on the device lock and Android's default file-based encryption (stated as an assumption `doctor` cannot verify); the operator checklist includes remote wipe, token revocation and `durable token revoke`.

### D18. Repository split: the engine is its own public repo (revision 6, U5)

**Decision.** The engine lives in `https://github.com/nanstey/durable` (public, MIT, package `@nanstey/durable`, Node >= 22, `main` protected: PRs required, squash-only; local checkout under the operator's projects directory). The skills repo (this one) keeps only a thin integration. The plan itself lives in the durable repo at `docs/plan/`.

**Why.** The engine is an application with its own dependencies, tests, CI and release cadence, not portable harness configuration; the skills repo's rules (config copied into runtime directories, one skill per commit) do not fit it. A separate repo lets Android install the engine without cloning every skill, keeps dependency growth (pi-durable, WebAuthn verifier, `web-push`) out of the skills repo, and lets public-repo hygiene be enforced by CI on one purpose-built repository.

**What lives where**
| In the durable repo | In the skills repo |
| --- | --- |
| Daemon, API, typed client, TUI, CLI, console hub and front end, schemas, examples, units, Termux bootstrap, worker guard Pi extension, brief templates, tests, docs, this plan, spike scripts and evidence | A pin manifest for the durable clone (`harness/durable/vendor/nanstey-durable.txt`), an `install.sh` step (clone at the pinned commit, install dependencies, link the `durable` CLI), a thin `durable` skill, a README catalog row, a `harness/pi/README.md` contract row, the skills and agent profiles durable workers reuse (`idea-to-pr`, `pr`, `build`, `review-code`, `handoff`, ...), Pi settings and patches (including slice 13) |

**Install mechanism (skills repo).** Mirrors the existing `vendor-git` pair: a manifest line `<url> <40-char commit>`, cloned at that exact commit, `ok|cloned|updated` reporting, fail-closed on bad input. The update flow is a pin bump PR in the skills repo (`harness/durable/bump-pin.sh` resolves a ref to a full SHA and rewrites the manifest line), then `install.sh` reports `updated`. One change per commit in the skills repo (AGENTS.md).

**Cross-repo coordination.**
1. Order: **durable first, then the skills repo pin bump.** A change that touches both repos (for example a `profile-meta` manifest field, a Pi directory contract, a skill name that durable requires) is merged and verified in durable first; the skills repo then bumps its pin and updates its docs/rows in the same PR as the bump.
2. Compatibility: durable keeps reading older formats. Additive changes stay within `version: 1`; a breaking change to `profile-meta` or the machine/definition schemas bumps the schema `version` and ships a `durable profile migrate` (or equivalent) **before** the pin bump. The `profile-meta/<name>.json` file is created and owned by `durable profile`; the skills repo only documents it.
3. Skills contract: durable's `docs/skills-contract.md` lists the skill names workers need (default `idea-to-pr`, `pr`, `build`, `review-code`); `durable doctor` checks they exist under the Pi agent directory's `skills/`. Renaming a required skill is a coordinated change: durable accepts both names for one release, then the skills repo renames.
4. Pins: pi-durable, pi-ai and pi-coding-agent are pinned **exactly** in the durable repo (`package.json` plus the committed `pnpm-lock.yaml`), changed only by a durable PR that passes the contract suite and the `kill -9` recovery test. The skills repo pins durable by commit only; it never pins pi-durable. Durable's `doctor` verifies that its pinned `pi-coding-agent` can read the installed Pi's auth file format.
5. Pi-directory interface: durable's derived per-agent Pi dirs symlink `auth-profiles/`, `secrets/`, `profile-meta/`, `extensions/`, `skills/`, `agents/`, `prompts/` from the user's Pi directory. That list is a contract documented in both repos; renaming any of those in the skills repo's Pi harness needs the durable-first sequence above.

**Android.** The Termux bootstrap lives in the durable repo and clones and pins durable directly. The skills repo is an optional, separately pinned input needed only for worker dispatch (D17); steward, scout and chat run without it.

**Public repo rules (durable repo).** No secrets, no machine-local state, no absolute or personal paths, no real host or tailnet names, no personal emails, no private repo names in any committed file. Documents and examples use placeholders. CI runs a secret/path/host scan (`scripts/hygiene-scan.sh`, from slice 2) over the whole repo including `docs/plan/`. Agent definitions, machine files, tokens, audit logs and state stay outside the repo, as before.

### D19. Durable-conversation workers (revision 7, U6, option 1)

Reference: pi-durable's own subagent model (its README "Abort and Subagents"; examples 22 foreground, 23 background, 24, 26, 28, 29 in github.com/earendil-works/pi). A subagent is a **child conversation owned by a task**: the creating tool call commits `ownership: { kind: "task", taskId }`, the child starts as a copy of its parent's agent (model, extensions, tools, cwd) and can be reconfigured, model and tool calls are durable tasks, a non-replay-safe tool interrupted by a crash returns `interrupted`, aborts propagate bottom-up, and a `background: true` task is an abort boundary.

**What it is.** A worker kind in which the steward asks the dispatcher to create the Orca (or git) workspace/worktree, then starts a **headless durable child conversation** whose cwd and file/shell tools are confined to that worktree. Orca shows the worktree's branch, diff and git state; `durable attach` shows the conversation (D20). The Pi-session kind stays the default; this kind is opt-in per agent (`workers.kind: durable-conversation`, or per role via `workers.durable.roles`).

**Ownership.** The worker conversation is owned by a **`run-worker` task** (one per attempt) that is a child of the item's `WorkItemTask`; the `WorkItemTask` belongs to the steward loop, and the steward's `main` conversation is the *logical* parent shown in the tree. `run-worker` is created as a **background** task: aborting a chat turn, the loop tick or the steward `main` conversation does **not** lose worker progress. Reaching the worker again after a restart uses the ownership index (`scanConversations({ ownerTaskId })`), so a rerun reuses the same child (the pi-durable replay-safe pattern from example 22/23). Foreground ownership (the parent waits and aborts the child) is not used for workers; it is used for short read-only children such as the scout.

**How the kill switch still stops it (background does not mean uncontrollable).** (1) a `beforeTool` hook on every worker tool call checks the kill switch and the item's budgets and blocks with an abort request when paused or exhausted; (2) the supervising `WorkItemTask` watches the kill switch, `human-held` marks and per-item wall-clock and issues an **explicit abort of the `run-worker` task** (explicit task abort crosses the background boundary and follows the owned subtree), which writes a terminal outcome so nothing resumes afterwards; (3) `durable stop --workers` and the console/CLI `pause` abort every worker anchor (`abort({ background: true })`); (4) `close()` on daemon shutdown stops invocations **without** writing outcomes, so unfinished workers resume on the next start unless step 2 had already aborted them. Per-item limits: `itemMinutes`, max turns and tool calls, and a token budget read from the conversation's usage document.

**Tool set (fixed in code).** `read`, `edit`, `write` (path realpath must stay inside the worktree and outside `.git/`; symlink escapes refused), `bash` (cwd = worktree; environment built by `buildAgentEnv(def, "worker")` **without `GH_TOKEN`**; the shared command guard blocks `git push`, `git merge`, `git rebase`, `git reset --hard`, branch switching, `git worktree`, `gh pr merge`, `--admin`, `--force`, and `cd`/absolute paths outside the worktree), plus **code-owned tools**: `commit` (author identity from the manifest, trailer `Durable-Agent`), `push_branch` (pushes only `durable/<id>/<item>` with a fixed refspec; checks the remote head first so a rerun is idempotent), `open_draft_pr` (label, marker, footer; looks up an existing PR first), `report` (progress note). No `subagent`, no GitHub write other than through the code-owned tools, no credential-bearing tool output (outputs are screened). The worker playbook (system prompt) is steward-authored: implement, test, commit, push, open the draft PR; after any `interrupted` result, inspect `git status` and the files before repeating.

**Confinement is not a sandbox.** It is cwd + realpath checks + a command denylist; a determined model could still do harm through `bash`. The token is not in the shell, which is the main gain over Pi-session workers. Hardening candidates, spiked and optional: a per-conversation container/sandbox environment (pi-durable example 29).

**Crash recovery.** After a steward crash or restart pi-durable resumes unfinished tasks. Replay-safe tools (`read`, searches) rerun; non-replay-safe tools (`bash`, `write`, `edit`, `commit`, `push_branch`, `open_draft_pr`) return `interrupted`; the code-owned tools are idempotent by deterministic names and remote checks (S1). The child conversation continues, and the `WorkItemTask` re-attaches via the ownership index. Tool subprocesses killed by `KillMode=control-group` also yield `interrupted` (slice 1 correction 4). This replaces the Pi-session path's re-dispatch with `pi --continue`.

**Differences from Pi-session workers (skills and extensions).** Durable workers load **no user skills, extensions, prompts or Pi packages** (no `codemode`, Jev, web access, observational memory, no `subagent`). A **minimal skill-prompt mechanism** exists: `workers.durable.skills` is an allowlist of skill names; the worker kind reads only the `SKILL.md` body from the Pi directory's `skills/<name>/`, size-capped, and inlines it as a system-prompt section. No scripts, tools or referenced files are loaded, and skills known to need other tools (the allowlist validator rejects any skill whose text requires `subagent`, `codemode` or helper scripts) are refused. Default allowlist: empty. **Consequence:** workflows built on those facilities stay on Pi-session workers: `idea-to-pr`, `build`, `review-code`, `planning` and anything that orchestrates subagents or runs skill scripts. Durable workers suit small, well-scoped, single-PR tasks with a steward-authored playbook, and read-only reviewer/scout-style roles.

**Models.** The child uses the agent's profile through the `modelAuth` seam; Anthropic subscription OAuth works only if D2 option 1 is enabled; a cross-family reviewer therefore needs a non-Anthropic or API-key family unless that option is on.

**Storage and ownership constraint.** One process owns a storage and pi-durable has no cross-process locking, so every durable worker conversation lives in **the agent's steward process** and database. Resulting limits: (1) worker count per steward is bounded (`workers.durable.maxConcurrent`, default 2, conservative on Android: 1); more parallelism means more agents (processes), not more threads; (2) workers share the event loop with the loop, the API and the SSE streams (spiked under load); (3) a steward crash or restart interrupts all in-flight worker tools at once; (4) transcripts grow the steward's SQLite, so finished worker conversations are retained for a configurable period then exported and pruned if pi-durable allows (spike check); (5) a stolen-lease takeover by another machine cannot resume the conversation (single owner), it starts fresh from the pushed branch state.

**Human-held rule (both worker kinds; safety, not a handoff feature).** Users may open a regular Pi session in a worktree a worker uses. Minimal rule: a workspace item can be marked **`human-held`** from the CLI or console (`durable hold <item>`), which interrupts the worker (soft), keeps the claim and its lease, and makes the daemon **refuse to resume, re-dispatch, write, push or clean up** that worktree. `durable release <item>` clears the mark and belongs to the **same guarded class as agent resume** (D15), so an agent cannot lift a human's hold; after release the steward re-derives state from the branch and either continues or reviews. An advisory check reports a **foreign terminal** (an Orca terminal in the worktree that durable did not create) as `suspected human session` in `status`/`doctor`; it does not block anything by itself.

### D20. Conversation tree and the durable TUI harness (revision 7, U6, option 2)

**One tree for everything.** The daemon API exposes every conversation-like thing in an agent as nodes of a tree, with a stable shape for the CLI, TUI and console:

`{ id, parentId, kind, status, item?, ownerTaskId?, source: "durable" | "dispatcher", workspace?, startedAt, capabilities: { attach, steer, transcript, interrupt, resumeAfterCrash } }`

where `kind` is `steward | chat | scout | worker-durable | reviewer-durable | worker-pi | reviewer-pi | subagent`, `status` is `idle | running | waiting | done | failed | aborted | held`, and `parentId` is the logical parent (the steward `main`; a worker's parent is the steward, a nested subagent's parent is its worker). `worker-pi` and `reviewer-pi` are **leaf nodes sourced from the dispatcher** (their transcript is the Pi session JSONL tail), the rest are pi-durable conversations (children found through the ownership index). Node ids are opaque. Routes (additive in v1): `GET /v1/conversations?tree=true`, `GET /v1/conversations/<id>`, `GET .../<id>/transcript`, `GET .../<id>/events` (SSE), `POST .../<id>/messages`, `POST .../<id>/abort`; the worker routes remain as aliases. A `tree` SSE frame carries deltas in the steward scope. What a client may do with a node follows `capabilities` and the token scopes (`read`, `chat`, `pause`).

**`durable attach <target>` TUI.** `<target>` is an agent id (opens the tree) or `<agent>/<conversation-id|item>`. The TUI renders the tree live (parent -> child), a transcript pane for the selected node, and a composer that offers follow-up, steer and abort exactly where the node's capabilities and the token scopes allow; Pi-session leaf nodes are view-only unless `steer: true`, and `interrupt` works for all. It uses the typed client only (no direct database access), runs headless-safe (no state of its own) and exits cleanly; closing it never affects the work.

**Orca integration.** `attachInfo` for a durable worker is `{ kind: "command", command: "durable attach <agent>/<conversation>", openIn: "orca-terminal" }`. With `workers.durable.viewer: on-start` (default for durable workers) the `orca` adapter calls `openViewer`, creating an Orca terminal titled `durable:<agent>/<item>` in the worktree, so Orca lists durable conversations beside normal sessions; `on-demand` (via `durable open <conversation>`) and `never` are the alternatives. Viewers are cheap API clients, are not workers, never keep a worker alive and are not closed by the steward (the TUI shows the final state and waits for a keypress). If the Orca CLI cannot create such a terminal on a given machine, `openViewer` returns the command string and the console/CLI display it.

**Console.** The console shows the same tree (machine -> agent -> conversation tree) from the same API, with the same capability-gated controls.

## 3. Contracts

### 3.1 Agent definition (`agents/<id>.yaml`; no secrets, no absolute paths, no hostnames)

```yaml
version: 1
id: acme-api                 # [a-z0-9-]{3,32}; unit name, branch prefix, label suffix
description: Keep acme/api moving
profile: work                # name of a pi-auth-profiles profile; contents are per machine
models:
  steward: { model: openai-codex/<model>, thinking: low }
  worker:  { model: anthropic/<model>,    thinking: medium }
  reviewer: auto             # opposite family of worker; its provider must exist in the profile
  judge:   { model: typesafe/jev-latest } # optional, bounded judgments
scope:
  repos:
    - slug: acme/api         # checkout path comes from machine.yaml
      base: main
      policySource: { kind: none }   # none (default; auto-merge off) | fixture (tests) | <kinds chosen per repo later, D8)
      merge:                 # CEILING + tighten-only overrides (D8); the policy itself comes from the policy source
        mode: human-approval # never | human-approval | auto-when-safe (auto needs a TRUSTED repo policy with enabled: true)
        shadow: true
        tighten: { maxChangedLines: 150, coolingOffMinutes: 60, requireHumanApproval: true }   # may only restrict
sources:
  - { kind: github-issues, repo: acme/api, labels: [agent:ready], exclude: [agent:hold], trustedAuthors: [member] }
  - { kind: github-prs,    repo: acme/api, own: true }
  - { kind: local-files,   repo: acme/api, glob: "tasks/*.md", statusField: status, readyValue: ready }
schedule: { pollSeconds: 300, quietHours: "22:00-07:00" }
limits: { maxConcurrentWorkers: 2, maxWorkersPerDay: 6, maxAttemptsPerItem: 2, itemMinutes: 90, maxMergesPerDay: 2 }
notify:                        # channel names come from machine.yaml; kinds: inbox, desktop, command, github
  approval-needed: { channels: [console, desktop], priority: high, reminders: { afterMinutes: 60, everyMinutes: 240, max: 3 } }
  escalation:      { channels: [console, desktop], priority: high }
  budget-stop:     { channels: [console] }
  agent-down:      { channels: [desktop] }       # console shows offline devices without a channel
  staleDays: 7
workers:
  dispatcher: orca                       # orca | git-process (workspace + process hosting)
  kind: pi-session                       # pi-session (default) | durable-conversation
  durable:                               # only used by the durable-conversation kind
    maxConcurrent: 2                     # per steward process (single storage owner)
    roles: [worker, reviewer]            # roles allowed to use this kind when kind is pi-session
    skills: []                           # allowlist of skill names inlined as prompt text (default none)
    viewer: on-start                     # on-start | on-demand | never (durable attach terminal in Orca)
chat:                          # all optional
  startableKinds: [chat, scout]   # console-wide; never workers or reviewers (dispatch starts those)
  maxMessageBytes: 1048576        # sanity ceiling protecting the daemon process; default 1 MiB
  # rateLimit: { perMinute: 20, perDay: 500 }   # opt-in; absent = no rate limiting
peers: []                      # reserved; non-empty rejected in v1
network: { bind: loopback }    # loopback | tailnet (tailnet accepted from slice 11; never 0.0.0.0)
```

### 3.2 Machine file (`~/.config/durable/machine.yaml`, never committed)

```yaml
version: 1
name: <machine-label>                    # shown in the console tree; machine-local, never committed
platform:                                # auto-detected; explicit values override
  os: linux                              # linux | android
  service: systemd-user                  # systemd-user | termux-runit
  tailscaleCli: true                     # false on Android (Tailscale app only)
  allowAutoMerge: true                   # android defaults to false
agents:                                  # assignment: which agents run here (id, or id + port)
  - acme-api
  - { id: acme-docs, port: 4802 }        # default: stable allocation from daemon.portBase, recorded in agents/<id>/port
daemon: { portBase: 4800 }
checkouts: { root: ~/code, overrides: { acme/api: ~/code/acme/api } }
channels:
  console: { kind: console }             # inbox always; Web Push when the console has subscriptions
  desktop: { kind: desktop }
  hook:    { kind: command, argv: ["notify-hook", "--event-json"] }
  review:  { kind: github, targetLogin: <other-login> }   # must differ from the agent's profile login
network:                                  # slice 11+
  bind: tailnet                           # loopback | tailnet
  peerCheck: required                     # required | optional | off; `optional` when tailscaleCli is false
  tailnetAddress: <address>               # optional explicit bind address (needed where interface enumeration fails)
  allowedPeers: ["tag:durable-console"]   # enforced via local tailscale whois when available, plus the bearer token
approval:                                 # slice 12a
  webauthn: { rpId: <console-host-fqdn>, origins: ["https://<console-host-fqdn>"] }
orca: { command: orca-ide }              # optional override of CLI resolution
```

`<...>` values are placeholders; real host names and logins exist only in the machine-local file.

### 3.3 Steward API v1 (HTTP + SSE; shaped for remote clients from slice 3)

- **Versioning and discovery:** everything under `/v1`; `GET /healthz` (open); `GET /v1/device` returns `{apiVersion, durableVersion, uid, machine, agent, profile (name only), scope summary, capabilities, startedAt}`. Changes inside v1 are additive; clients check `apiVersion` (`incompatible` state).
- **Auth:** `Authorization: Bearer <token>` (also `X-Durable-Token` for proxies). Tokens are scoped and stored hashed (D14): `read` = all GET; `chat` = messages (follow-up/steer), abort a conversation turn, start/resume conversations, steer a worker where supported; `pause` = pause an agent, interrupt a worker. Constant-time compare. 401 `unauthorized`, 403 `forbidden` (scope). Approve/resume/enroll are not token scopes.
- **Streams (SSE):** `hello {apiVersion, scope, serverTime}`, then a snapshot, then deltas; `: ping` every 15 s; 45 s of silence = dead; reconnect gets a fresh snapshot (no replay); a viewer more than 2 MB behind is dropped; closing a stream never stops work. Scopes: device (`tree`, `activity`, `doc`), agent conversation (`snapshot`, `batch`, `inbox`), steward (`queue`, `workers`, `gate`, `inbox`, `budget`).
- **Idempotency:** `POST .../messages` takes a required `requestId`; creating routes accept `Idempotency-Key`.
- **Errors:** `{error:{code,message}}` with codes `unauthorized`, `forbidden`, `not_found`, `invalid`, `busy`, `conflict`, `unavailable`, `internal`.
- **Routes (our own contract; names chosen for familiarity):** `GET /v1/sessions`, `.../transcript?format=`, `.../events`, `.../tasks`, `POST .../messages` (`whenBusy`), `POST .../abort`. Conversation tree and chat additions (additive in v1): `GET /v1/conversations?tree=true`, `GET /v1/conversations/<id>` and `.../<id>/{transcript,events,messages,abort}` for every node kind (D20), plus `GET /v1/conversations?kind=&item=`, `POST /v1/conversations {kind: chat|scout, item?, name?}` (kind must be in `startableKinds`, which is console-wide; `Idempotency-Key`), `POST /v1/workers/<id>/steer {content}` (`501 not_supported` unless the adapter reports `steer`), `POST /v1/workers/<id>/interrupt {mode}` (scope `pause`); messages are screened and size-ceilinged (D16); `429 rate_limited` only if the opt-in `chat.rateLimit` is configured; `invalid credential-like-content`. Ours: `GET /v1/queue`, `GET /v1/workers`, `GET /v1/audit?since=`, `GET /v1/inbox` + `POST /v1/inbox/<id>/ack`, `GET /v1/gate/<item>`, `GET /v1/budget`, `POST /v1/pause` (scope `pause`). Approval routes (no bearer scope): `POST /v1/approvals/challenge`, `POST /v1/approvals/assert` (WebAuthn), `POST /v1/approvals/nonce` (CLI), `POST /v1/resume`, `POST /v1/approvals/enroll/*`.
- **Listeners:** loopback always. `network.bind: tailnet` (slice 11) adds the Tailscale interface address; peers are checked via `whois` against `allowedPeers` when the Tailscale CLI is available (`peerCheck: required`), otherwise the check is reported as unavailable (`optional`) and the bearer token plus the tailnet's own ACL remain the baseline (D17). No `0.0.0.0`.

### 3.5 Console files (on the console host only, never committed)

`~/.config/durable/console/console.yaml` (listen address, `allowedUsers` for Serve identity logins, `rpId`/origins, VAPID subject; `push.enabled: false` until slice 12b), `devices.yaml` (registry, mode 600, with per-device token files or keychain refs and the paired `uid`), `ui-state.json`, `push-subscriptions.json` (0600), VAPID private key (0600). Console state is cache-like: deleting it loses only the registry and subscriptions, never agent or approval state.

### 3.6 Repo policy source seam and neutral policy model (mechanism undecided)

```ts
interface RepoPolicySource {
  readonly kind: string;                                         // "none" | "fixture" | (chosen per repo later)
  resolve(repo: RepoRef): Promise<PolicyResolution>;             // reads only from a trusted ref/location the STEWARD resolves (P1)
  protectedLocations(repo: RepoRef): ProtectedLocation[];        // what holds the policy: paths, ruleset ids, store keys (P3)
  describeChange(repo: RepoRef, since: Fingerprint): Promise<ChangeSummary>;   // display data for the verify-policy approval action
}
type PolicyResolution = { state: "verified" | "unverified" | "invalid" | "unavailable" | "none"; policy?: AutoMergePolicy; ref: string; fingerprint: string };
type AutoMergePolicy = { enabled: boolean; authors: string[]; baseBranches: string[]; pathAllow: string[]; pathDeny: string[]; maxChangedLines?: number; maxFiles?: number; maxRisk?: "low" | "medium"; requiredChecks: "github-required" | string[]; methods: ("squash" | "merge" | "rebase")[]; requireCrossFamilyReview: boolean; requireHumanApproval: boolean; coolingOffMinutes?: number };
```
No file name, path, format or trust-pin layout is specified. The invariants P1-P6 (D8) bind every source. `steward.policy` stores, per repo, the source kind, the last `PolicyResolution` summary (state, ref, fingerprint) and the verification record written by the `verify-policy` approval action; its internal shape is source-defined. Built in: `none` and `fixture`. Source kinds under consideration, none chosen: in-repo file, GitHub rules/rulesets only, agent-definition-only, out-of-repo store.

### 3.4 Documents and audit

`steward.queue`, `steward.budget`, `steward.gate` (decisions: facts, reasons, sha, action), `steward.reviews` (verdict, family, sha), `steward.notify` (dedup keys, reminder state, nonce hashes), `steward.inbox` (events, ack state; never secrets), `steward.approval` (enrolled public keys, challenge hashes and expiry; no secrets), `steward.policy` (per repo policy source summary and verification record), `steward.chat` (conversation index; rate-limit counters only if the opt-in is on).
External state wins on conflict: on resume, code re-derives each non-terminal item from GitHub and the dispatcher before acting.
Audit: `$DURABLE_HOME/agents/<id>/audit.jsonl`, append-only: `{ts, agent, profile, login, actor: "code"|"llm"|"human", action, target, decision, reasons, sha}`. Redacted. Separate from the DB. Merges also leave a PR comment with the gate report.

## 4. Data flow (one item)

1. `steward-loop` tick (durable timer). Kill switch/quiet-hours/budget checked.
2. Sources poll -> candidates -> eligibility -> optional Jev judgment (tighten-only) -> queue.
3. Dispatch while `maxConcurrentWorkers` allows. **Intent first**: commit an intent entry; claim on GitHub; `dispatcher.createWorkspace` then `launch`. Each effect has a deterministic name.
4. Scout writes the brief (read-only). Worker runs `idea-to-pr` on the brief with the clean profile env and opens a draft PR.
5. Steward sees the PR (poll), launches a reviewer on that head SHA (opposite family), records the verdict in its own store, mirrors it to GitHub.
6. Gate decides. `wait-human` -> approval task + `approval-needed` notification with the PR URL. `merge` (auto, per-repo opt-in) -> `gh pr merge --match-head-commit`. `block` -> comment + back to worker or human.
7. After merge or close: release claim, record outcome, remove workspace only if clean and merged.

## 5. Failure paths

| Failure | Handling |
| --- | --- |
| Steward crashes or restarts | pi-durable resumes loop and tasks. Intent-first, deterministic names; "interrupted" -> world re-read. `agent-down` notification via `OnFailure`. |
| Steward crash with durable workers running | pi-durable resumes the child conversations; interrupted tools return `interrupted`; code-owned tools are idempotent; the `WorkItemTask` re-attaches through the ownership index (D19). |
| Human opens a session in a worker's worktree | `durable hold`/`status` advisory: daemon refuses to resume or write until a guarded `durable release` (D19). |
| Worker session dies without a PR | Liveness check (`dispatcher.status` + no PR + lease) -> re-dispatch (`pi --continue`) up to `maxAttemptsPerItem`, then `escalation`. |
| Profile missing or identity mismatch | Fail closed, audit, notify (`identity-failure`), do not start. |
| GitHub rate limit/outage | Back off with jitter; no queue loss. |
| Orca unreachable | `doctor`/status shows `dispatcher: degraded`; no silent switch; optional configured fallback adapter. |
| Nobody answers an approval | Durable wait, capped reminders, park after `staleDays` (D10). |
| Two stewards, same repo | Claim lease with read-after-write; loser releases. |
| Gate facts missing | `wait-human`. |
| Console or console host down | Agents unaffected; CLI works; GitHub remains the record. Devices show offline in any other console. Web Push stops until it returns. |
| Daemon unreachable from the console | Status `offline`/`unauthorized`/`mismatch`/`incompatible` with backoff; no cached approvals; nothing queued for later approval. |
| Passkey assertion invalid, expired or for a stale SHA | Rejected, audited; the approval task keeps waiting. |

## 6. Compatibility, packaging, rollout

- **Language/runtime:** TypeScript on Node >= 22.19 using native type stripping (no build step); `tsc --noEmit` and `node --test` in CI. Pinned exactly in a committed lockfile: `@earendil-works/pi-durable@1.4.0`, matching `pi-ai`, `@earendil-works/pi-coding-agent` (for `AuthStorage`), `typebox`, `yaml`. `node:http`, no Express.
- **Install:** (a) skills-repo `install.sh` step: clone the pinned `nanstey/durable` commit, `pnpm install --frozen-lockfile --prod --ignore-scripts` in the clone (stamped), link `~/.local/bin/durable`; idempotent (`ok|cloned|updated`); never enables or starts an agent; (b) standalone: the durable repo's `docs/install.md`; (c) Android: `termux/bootstrap.sh`. Units are rendered and installed by `durable enable` through the `ServiceManager`, not by an installer. Tests stub `git`, `pnpm`, `systemctl`, `sv`.
- **Repo vs machine split:** the durable repo = engine, schemas, examples, units, docs, plan. The skills repo = thin integration only (D18). Machine = profiles, `profile-meta`, `machine.yaml`, definitions (a private checkout via `DURABLE_AGENTS_DIR` is optional), state, audit, tokens.
- **Upgrade process for pi-durable:** bump the exact pin + lockfile in one durable-repo PR; the contract suite and the `kill -9` recovery test must pass; no patches to pi-durable (if ever needed: unified diff, idempotent installer step, new patch file per change, per AGENTS.md).
- **Rollout:** slices 1-5 are read-only toward GitHub. Writes begin in slice 6. Auto-merge is per repo, default off, shadow first (slice 9). The console is localhost-only until slice 11, and public exposure (Funnel) never exists.
- **Console dependencies:** the console is part of the same pinned package (the durable repo's `package.json`); front-end libraries are vendored, pinned and checksummed (no bundler); the only added runtime npm dependencies planned are a WebAuthn verifier (for example `@simplewebauthn/server`) and `web-push` (slice 12a for the verifier; 12b, optional, for `web-push`). Both are chosen in the slice 1 spike and confirmed in 12a/12b.
- **Public repo rules:** see D18; no secrets, machine-local state, absolute/personal paths, real host or tailnet names, emails or private repo names in either repo's committed files.

## 7. Observability

`durable status`, `durable queue <id>`, `durable inbox <id>`, `durable audit <id> --since`, `durable attach <id>` (TUI), `durable logs <id>`, `durable doctor <id|--all>`, `durable profile show|check`, `durable token create|list|revoke`, `durable console ...`. Workers: Orca terminals (`attachInfo`) and per-agent Pi sessions. Console: fleet and per-agent views, transcript attach, audit, inbox, gate report.

## 8. Unresolved and deferred

- Open: Q18 only, deferred by the user: the policy mechanism is decided per repo when the first repo needs auto-merge (default `none`). Q19-Q23 are resolved. None blocks slices 1-6.
- Deferred, not specced: **D-1 Peer-to-peer agent messaging** (hooks: reserved `peers`; reuses the daemon `whois` + token design; the console does not replace it). **D-2 (now planned):** durable-conversation workers are slice 6c (D19), not deferred. Remote attach is no longer deferred: it is the console (D13, D14). macOS/launchd is deferred (Linux is the first fleet; Android/Termux is an additional target, D17, slice 14). PWA and Web Push are an additive follow-up (12b), not deferred design.

## 9. Review status

Revised after user comments (rounds 1-5). No reviewer opted in. Needs user review.
