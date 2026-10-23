# Product review: durable, proactive agents as the base of the harness

Planning only. No source, tests, config or dependencies are changed by this plan.
Revision 1 (user comments C1-C7 applied). Revision 2 (U1: no ntfy; U2: multi-machine web console on one chosen machine). Revision 7 (U6: durable-conversation workers as a second, opt-in worker kind; a durable conversation tree and `durable attach` TUI shown in Orca terminals; a human-held rule). Revision 6 (U5: the engine and this plan move to the public `nanstey/durable` repo; the skills repo keeps only a thin integration; public-repo hygiene rules and a CI scan). Revision 5 (Q18-Q23: policy mechanism deferred behind a `RepoPolicySource` seam; the phone is just another browser client; no default chat rate limits; Android defaults accepted). Revision 4 (U3: dpi-* projects are inspiration only; U4: an Android/Termux daemon as an additional platform target). Revision 3 (Q5-Q17 answers: repo-committed human-trusted merge policy; interactive chat from the phone; PWA/Web Push as an additive follow-up; Linux-only first fleet; see README Decision log).

## Problem (user's terms)

The harness today is reactive. A human opens a Pi TUI, picks a task, and delegates to
`pi-interactive-subagents` (one TUI per child) or `handoff` (one Orca worktree + Pi session).
Three things hurt:

1. **The human is the scheduler.** Nobody looks at the projects that need work unless the user
   does. Work stalls between sessions.
2. **Background work is expensive and fragile.** Interactive subagents strain the machine (many
   TUIs). A crashed or closed Pi session loses its state.
3. **Identity mistakes.** Agents use the wrong `gh` account or the wrong model login (work vs
   personal). Nothing declares or checks which credential set an agent should use.

## Desired outcome

Each machine runs one or more long-lived **stewards**. A steward owns one project (or one group of
related projects), finds work in that scope, assigns workers to push it forward, and stops at one of
two places: a PR waiting for human review, or an automatic merge when the repo's policy and
GitHub's own rules allow it. The "operating system" is now two repos: the public **`nanstey/durable` repo** ships the engine, schemas, examples, docs and this plan; the **skills repo** keeps a thin integration (a pinned clone installed by `install.sh`, the `durable` CLI on PATH, a thin skill) plus the skills and agent profiles workers reuse. Each machine supplies its own profiles
(credentials) and assignments.

Reframe (current -> desired):

| Today | After |
| --- | --- |
| Human picks work and opens sessions | Steward polls sources, picks eligible work, dispatches workers |
| Background work = interactive TUIs | Background work = dispatched workers behind an adapter: Pi sessions (default, Orca-visible) or headless durable child conversations (opt-in); one small process per steward |
| Crash loses state | `kill -9` of a steward resumes from checkpoints; GitHub holds the truth |
| Identity implicit (ambient `gh`, ambient Pi login) | Each agent names one **profile**; the profile is checked before every start |
| "Is it safe to merge?" asked ad hoc | Code-owned gate with a recorded decision per PR; auto-merge off by default, per repo |

## Credential model: profiles (C1, C3)

A **profile** is the existing `@nanstey/pi-auth-profiles` concept, extended, not replaced:

| Part of a profile | Where it lives (machine-local, never in the repo) | Managed by |
| --- | --- | --- |
| Model auth: OAuth and API keys per provider | `~/.pi/agent/auth-profiles/<name>.json` (`default` = `auth.json`) | Pi `/login` under that profile |
| Env secrets: `GH_TOKEN`, `OPENROUTER_API_KEY`, `TYPESAFE_API_KEY` ... | `~/.pi/agent/secrets/<name>.env` (mode 600) | `pi-secret -p <name>` |
| **New, non-secret manifest:** expected GitHub login/host, git author name/email, providers the profile is meant for | `~/.pi/agent/profile-meta/<name>.json` | `durable profile` subcommands (slice 2) |

Rules:
- **One profile = one identity.** An agent references exactly one profile by name (`profile: work`). The agent file contains no credentials and no identity details.
- **Names are portable labels; contents are per machine.** Every machine that runs an agent for profile `work` defines its own `work` (its own OAuth login, its own token). The agent definition travels; the secrets never do.
- **Fail closed.** If an agent is assigned to a machine that lacks the profile, `durable doctor` says exactly what is missing (login, `GH_TOKEN`, manifest) and the agent does not start.
- **Isolation stays.** Profiles remain isolated (no fallback to `auth.json`, no shared refresh tokens), as `pi-auth-profiles` requires.

## Model providers: what can the steward reuse? (C4)

Straight answer: **yes, generically.** Pi's file-backed credential store (opened through `ModelRuntime.create({ authPath })`; the older `AuthStorage` export is gone, slice 1) holds OAuth
or API-key credentials for any provider pi-ai supports. Agents use **named** profiles only (slice 1 showed a file-symlinked `auth.json` loses updates). The steward opens the agent's profile file
and uses it through pi-ai, so OpenAI/Codex OAuth, OpenRouter, other API-key providers and TypeSafe all
work the same way, with refresh under the same lock Pi uses.

**Anthropic subscription OAuth is the one provider that needs more.** Requests with an `sk-ant-oat`
token must be reshaped. `@gotgenes/pi-anthropic-auth` does that in a transport wrapper
(`createAnthropicOAuthStreamSimple`, `shapeAnthropicOAuthPayload`, billing-header and Claude Code
version logic). Reading its source shows the wrapper depends on pi-ai only, not on Pi's extension
runtime. It may therefore be hostable inside the steward. This is a first-class question in the
slice 1 spike with three ranked options (architecture D2). Anthropic is **not** declared
unsupported. Caveat: the shaping imitates Claude Code requests, which is fragile (it tracks Claude Code
versions) and a terms-of-service risk the operator must accept.

## Users and workflows

Single operator, several machines, Orca for session management, Tailscale between machines.

| # | Workflow | Exit |
| --- | --- | --- |
| W1 | **Define**: write an agent definition (profile name, repos, sources, policy, notification refs). Run `durable doctor`. | `doctor` is green, or names exactly what is wrong |
| W2 | **Observe**: ask "what is the steward doing, what is queued, why?" from any terminal or Orca. | Status in under 10 s; full transcript and live stream on demand |
| W3 | **Interrogate/steer**: attach to the steward (or a worker) and ask or redirect. | Answer or new priority, recorded in the audit log |
| W4 | **Review**: a PR arrives labelled and linked, with a gate report (CI, cross-family review verdict, risk class). The operator is told through the configured channel. | Human merges in GitHub (or approves through the control plane), or requests changes and the steward re-dispatches |
| W5 | **Auto-merge** (only for repos that opt in): the gate passes and GitHub accepts the merge. | Merged PR plus audit entry; otherwise W4 |
| W6 | **Stop**: pause one agent, or all agents on a machine, from a terminal or from GitHub. | No new side effect after the next check (seconds, not minutes) |
| W7 | **Add a machine**: install, define the machine's profiles, assign agents, start. | Second steward works in parallel without double-claiming an item |
| W9 | **Run an agent on an Android phone** (Termux): install with a documented bootstrap, define a conservative agent (steward, scout, chat, light workers on small repos), see it in the console; it may be asleep or killed and the system tolerates that. | Phone daemon works within its limits, shows `offline` when away, never auto-merges |
| W10 | **View any durable conversation in Orca**: `durable attach` shows a live tree (steward, chat threads, scouts, workers, nested children) in an Orca terminal beside normal sessions, with steer, follow-up and abort where the node allows; take over a worker's worktree safely with `durable hold`. | Orca lists durable conversations; no two writers in one worktree |
| W8 | **Use the console from any browser, including a phone**: open the web console (served on the operator's always-on console machine, reached over Tailscale), see every machine's agents, watch a conversation live, send follow-ups and steers, ask an agent or scout a question, start or resume a chat, abort a turn, pause an agent. A phone is just another browser client with the same capabilities and guardrails as a laptop. Approve, resume an agent after a kill, enroll a key and verify a repo policy require a passkey on **any** browser. | Interactive chat and pause from the console in any browser; high-risk actions only through the guarded flow; nothing needed on a phone but a browser (installable app and push come later) |

## Identity decision: the operator's own GitHub account (C2)

Agents act as the operator (`GH_TOKEN` = a token of the operator's account, held in the profile's
secrets). No per-agent bot accounts. Consequences the design accepts and handles:

- **GitHub will not let the operator approve a PR the agent authored as the operator.** The
  cross-family review verdict therefore cannot be a GitHub approving review. It is recorded in the
  steward's own store (head-SHA-pinned), mirrored as a commit status and a PR comment for humans.
  Repos whose rules require an approving review are not auto-mergeable by the agent; the human merges
  or approves from another account. Nothing bypasses GitHub rules.
- **Agent and human are indistinguishable on GitHub.** Agent work is marked with a label, a PR footer,
  a commit trailer and a `durable/` branch prefix.
- **Anything the operator identity can write on GitHub, a compromised agent can forge** (labels,
  comments, statuses). The gate therefore trusts only GitHub-computed facts and the steward's own
  records, never labels or comments as authorization.
- **GitHub does not notify you about your own activity.** A comment, @mention, assignment or review request made by the agent as the operator is silent for the operator. The `github` notification channel only works when it targets a login other than the agent's profile login (for example a second account of yours, or an approver account). The slice 1 spike verifies this; the console inbox and desktop notifications are the primary channels.
- **Prompt-injection blast radius is the operator's own reach.** Mitigations: trusted-author
  eligibility, fine-grained per-repo tokens without admin, one profile per scope, guards, audit, human
  merge by default.

## Control plane and notifications (C5, revised by U1 and U2)

Question: what do you use to see, steer, approve and stop agents across machines? Answer after revision 2: a **web console** you run on one chosen always-on machine (the **console host**; its name is machine-local config and is deliberately not recorded in either repo, plans included) that connects over Tailscale to the daemons on your other machines, plus the `durable` CLI/TUI on each machine. Layers (each works without the next):

| Layer | What | Role | Ships in |
| --- | --- | --- | --- |
| L0 | **GitHub** (issues, PRs, labels, comments, review requests) | Durable record and the place a human merges. Informational only: with a shared identity, labels/comments are forgeable and never authorize. A human **merge** is the strongest approval. | used from slice 6 |
| L1 | **`durable` CLI + attach TUI + versioned loopback daemon API** (our own API and clients, inspired by the ideas in `dpi-backend`/`dpi-tui`) | Interrogate, steer, chat, pause, approve with an out-of-band code, kill. Per machine. | slices 3, 4, 7 |
| L2 | **Local notifications**: desktop (`notify-send`, Linux), a generic `command` hook for your own scripts, the daemon **inbox** (events document) and, where the target login differs from the agent's, **GitHub** review requests/@mentions | Tell the operator something needs a decision. Payloads carry ids, titles and URLs only. No push service, no extra infrastructure. | slice 4 (core), wired in 6-7 |
| L3 | **Web console** (viewer/controller, no coordination role): one server on the chosen machine, token-injecting proxy, one multiplexed stream per browser tab, device registry. Single machine first (localhost, responsive, interactive chat), then multi-machine over Tailscale (any browser over HTTPS, identity allowlist), then passkey-guarded approvals (12a), then installable PWA and Web Push as an additive follow-up (12b). | Fleet overview, per-agent view, **interactive chat** (live transcript, follow-up, steer, abort, start/resume conversations), pause, approvals inbox, audit, shadow gate report. No shell or file access. | slices 8, 11, 12a, 12b |

**The console is not a hub.** Agents and daemons stay independent. If the console or its host is down, every agent keeps working, claims and gates still run, GitHub stays the coordination and approval record, and the CLI still works on each machine. The console may be installed on any machine, including more than one. Agent-to-agent messaging (peer-to-peer) stays deferred; the console does not replace it.

Phone alerts: GitHub mobile (only with a second target login, see above), the console inbox badge, and, as a **follow-up that blocks nothing (slice 12b)**, the console as an installed web app with Web Push (needs HTTPS from Tailscale; iOS needs the app installed to the home screen; an assumption verified in slice 1 and 12b). The first console release is built so that adding the manifest, service worker, push subscription store and HTTPS is purely additive. The responsive page works without push.

Channel management model:
- **Events**: `approval-needed`, `escalation` (needs human, attempts exhausted, identity failure), `budget-stop`, `agent-down` (via a systemd `OnFailure` hook), `merged`, optional daily `digest`.
- **Channels**, machine-local definitions in `machine.yaml`: `desktop`, `command`, `github` (target login), `console` (always writes the inbox; Web Push when the console has subscriptions). No other channel kinds in v1.
- **Agent definitions map events to channel names** with priority and reminder cadence.
- **De-duplication**: key = agent + event + target + head SHA with a TTL; one notification per key; coalesced per tick.
- **Quiet hours** hold low-priority events and deliver them when the window ends; they never drop events.
- **When nobody answers**: the agent waits durably, sends capped reminders (default after 60 min, then every 4 h, at most 3), and after `staleDays` parks the item as `needs-human`, releases its claim and workers, and comments once. It never escalates its own privileges, approves for itself or merges to unblock itself.
- **Secrets are never notification content.** The CLI approval code is delivered only to `desktop` and `command` channels. The inbox and GitHub are readable by agents (shared identity, shared OS user), so they carry no secret. Console approvals use a passkey (architecture D15), not a code.

## Success signals (measurable after shipping)

- **Identity:** 100% of GitHub writes and model calls in the audit log carry the identity of the agent's profile. A deliberately wrong `GH_TOKEN` makes `doctor` fail and the agent refuse to start.
- **Proactivity:** a labelled issue becomes a draft PR with no human prompt.
- **Durability:** `kill -9` of the steward during a wait loses no queue state and starts no duplicate worker or PR.
- **Safety:** zero merges that violate the repo policy or GitHub rules. Auto-merge decisions for each repo run in shadow mode ("would merge") against real PRs before any repo gets a policy source that enables it. No `--admin` merge path exists.
- **Attention cost:** at most one notification per PR that needs a decision, plus capped reminders.
- **Any browser, including a phone:** from a device on the tailnet you can open the console, see all machines' agents, watch a conversation live and send a follow-up in under 15 s; every chat message is screened for credentials and audited; approve/resume/enroll/policy-verification work only after passkey enrollment and are verified by the daemon, not by the console.
- **Policy integrity:** whatever mechanism holds a repo's auto-merge policy, an agent-authored change to it (or to CODEOWNERS or GitHub rules) never takes effect without a human verification step; with no policy source (`none`, the default) auto-merge stays off.
- **Machine cost:** background work opens no interactive TUI beyond the capped workers.
- **Interrogation:** every steward session can be attached in under 10 s with `durable attach`.
- **Retirement:** `pi-interactive-subagents` and its two patches leave `settings.json` and the patch list (slice 13) with no loss of a documented workflow.

## Scope

In scope: per-machine steward process, remote-ready daemon API, operator CLI/TUI, multi-machine web console served from one chosen machine, profile manifests, agent/machine definitions, `doctor`, read-only
scout, a `WorkerDispatcher` adapter layer (Orca primary, git-process second), claims and worker dispatch,
notifications and channels, code-owned review/merge gate with human approval, per-repo opt-in auto-merge
with shadow mode, second machine without a shared DB, kill switch, budgets, audit log, `docs/operator.md`,
a thin skills-repo integration (pinned install, thin skill), retirement of interactive subagents (skills repo).

## Non-goals (v1)

- A coordinating hub, a shared database, agent-to-agent messaging (peer-to-peer; a reserved, rejected-if-set `peers` field stays). The console is a viewer/controller over per-daemon APIs and is optional.
- Funnel or any public-internet exposure of the console or a daemon.
- Android as part of the first fleet (it is an additional target after the second-machine and console slices, slice 14); proot-distro on Android; heavy builds on a phone.
- Shell or file access through the console.
- Push services such as ntfy (removed in revision 2).
- Replacing Orca, `idea-to-pr`, `handoff` or `orchestration`.
- Per-agent GitHub bot accounts or GitHub Apps.
- An auto-merge canary repo. Auto-merge proof is shadow mode plus recorded-fixture tests.
- Multi-user operation.
- Fixing unrelated Jev patch drift.

## Settled decisions

From the first review:
1. Retire interactive subagents over time; background workers; sessions must stay viewable.
2. One steward per project/scope. Sources vary: GitHub issues/PRs and/or repo-local files.
3. Auto-merge policy is per project (now: per repo), code-owned, and obeys GitHub/project rules.
4. One credential set per agent. (Revised: expressed as one **profile** reference.)
5. Start with a durable steward + workers as standard Pi sessions in Orca worktrees.
6. No networking in v1; GitHub/shared repo state is the coordination layer; tailnet membership is not trust.
7. Pin `pi-durable`; accept an upgrade process; trim fragile patches; all Pi changes live in the repo.

From revision 1:
8. Profiles are the credential unit (C1, C3).
9. GitHub identity is the operator's own account (C2).
10. Anthropic is a spike question with ranked options, not declared unsupported (C4).
11. Layered control plane L0-L3 (C5, revised by U1/U2: no ntfy; web console promoted to planned slices).
12. No auto-merge canary; per-repo opt-in, default off, shadow mode (C6).
13. Orca runs on every machine; dispatch goes through an adapter (C7).

From revision 2:
14. Remove ntfy entirely (U1). Channels are `github`, `desktop`, `console`, `command`.
15. A multi-machine web console runs on one chosen machine and connects to the daemons over Tailscale (U2). It is a viewer/controller, not a coordinator.
16. Console approvals and agent resume are guarded by a passkey verified by the daemon; daemon bearer tokens can never approve.

From revision 3:
17. The per-repo auto-merge policy mechanism is **not fixed**: a pluggable `RepoPolicySource` seam with mechanism-independent invariants (never read from PR head/worktree, human verification of changes, missing/unverified means off, definition only tightens, shadow first, no bypass); built-in sources `none` (default) and a test `fixture`; the real source is chosen per repo when the first repo needs auto-merge (Q9/Q18).
18. The console is interactive from any browser, phone included, with identical capabilities and guardrails (chat, steer, abort, start/resume conversations, pause); only approve, agent resume, enroll and policy verification need the passkey, on any browser (Q17, Q19).
18b. No default chat rate limits (Q20): audit, credential screening, the fixed tool set, per-agent budgets and the kill switch bound the risk; a 1 MiB body ceiling protects the daemon process; rate limiting is opt-in.
19. First fleet is Linux only; macOS/launchd is deferred (Q7).
20. PWA and Web Push are a non-blocking follow-up (12b); the first console is built PWA-ready (Q16).

From revision 4:
21. `dpi-playground`, `dpi-sdk` and `dpi-backend` are inspiration only; we write our own API, client, TUI and console from scratch and copy nothing (U3).
22. Android (Termux) daemons are an additional platform target after the multi-machine slices; platform differences sit behind capability-flagged interfaces (U4).

From revision 6:
23. The engine, console, client, TUI, schemas, tests, Termux bootstrap, examples, docs and this plan live in the public repo `nanstey/durable` (MIT, `@nanstey/durable`, Node >= 22, `main` protected). The skills repo keeps only a thin integration: a pinned clone, the CLI on PATH, a thin skill, a catalog row, a contract row, and the skills and Pi settings durable workers reuse (U5).
24. Public-repo rules for durable: no secrets, machine-local state, absolute or personal paths, real host or tailnet names, emails or private repo names in committed files; enforced by a CI scan from slice 2.

From revision 7:
25. Two worker kinds behind the dispatcher (U6): **`pi-session` (default)** reuses the whole skills ecosystem; **`durable-conversation` (opt-in)** is a headless pi-durable child conversation confined to the worktree, stopped by the kill switch, resumed natively after a crash, with no token in its shell. Durable workers get no user skills or extensions (only an allowlisted skill-text mechanism, default empty), so workflows such as `idea-to-pr` stay on Pi-session workers. Android defaults to the durable kind.
26. `durable attach` is a conversation-**tree** TUI (steward, chat, scout, workers, nested children) that Orca can show in a terminal beside the user's normal sessions; the console shows the same tree.
27. Safety rule: a worktree marked `human-held` is never resumed or written to by the daemon until a human releases it (release is a guarded action).

## Assumptions (labelled; confirm or correct)

- **A1** (replaces the dedicated-identity assumption) Agents use the operator's account through a fine-grained token per profile.
- **A2** Agent definitions contain no secrets and no absolute paths. They live in a local directory (`~/.config/durable/agents`); a private checkout via `DURABLE_AGENTS_DIR` is an optional override. Machine-specific things (assignments, checkout roots, channels) live in a machine-local file.
- **A3** The steward's models come from any profile provider that works through pi-ai. Whether Anthropic-OAuth is usable in-process is decided by the slice 1 spike.
- **A4** Notification channels are `github` (to a different login), `desktop`, `console` inbox/Web Push and `command`. No ntfy.
- **A7** The console host is always on and runs the same harness install; its name lives in machine-local config only.
- **A8** Tailscale provides HTTPS for the console (`tailscale serve` with a tailnet certificate). The ACL tags `tag:durable-daemon` and `tag:durable-console` are created by the operator when slice 11 is reached. Verified in slice 1.
- **A10** An Android daemon is optional, runs in Termux directly, is not always on, and uses a separate profile and token. Platform behaviour is behind capability flags so the main-line design does not preclude it.
- **A9** The agent token can read the repo files through the API and, ideally, branch rules/rulesets; if rules are unreadable the gate relies on GitHub-computed PR state only (spike).
- **A6** Node >= 22.19 exists on every machine.

## Open questions

Resolved:
- Q1 GitHub identity: operator account. Q2 config location: profiles per machine + definitions + machine file. Q3 Anthropic: slice 1 spike with ranked options. Q4 channels: `github` (other login), `desktop`, `console`, `command`; no ntfy. Q6 pilot: no canary, shadow mode. Q8 Orca: yes + adapter. Q11: removed with ntfy.
- **Q5 (revision 3):** yes, the ACL tags are created when slice 11 is reached.
- **Q7:** Linux only for the first fleet; macOS/launchd is deferred.
- **Q9 (superseded by Q18):** an earlier reading placed the policy in a committed repo file pinned by a trust step; the user decided not to fix any mechanism yet. The seam and invariants replace it (decision 17).
- **Q10:** default accepted: you merge in GitHub, or approve from another account, for repos that require approving reviews.
- **Q12:** agent definitions in a local directory; `DURABLE_AGENTS_DIR` stays an optional override.
- **Q13:** the console host is always on and runs the same harness install.
- **Q14:** Tailscale identity allowlist plus passkey step-up for approve/resume; no passwords.
- **Q15 (revised by U3):** build our own minimal console, hub, client library and API from scratch; `dpi-playground`/`dpi-sdk`/`dpi-backend` are inspiration only and no code from them is copied, adapted or vendored. Rationale: `dpi-playground` is the web interface in `disler/durable-pi` (a hub server plus a Vue client, about 6.6k lines with its SDK, experimental); it ships panels we do not want and a build toolchain and markdown renderer we would have to secure.
- **Q16:** responsive UI first; PWA with Web Push is a non-blocking follow-up (12b), and the first release is designed so it is additive.
- **Q17:** the console is interactive, not read-only (see W8 and architecture D16); only approve, agent resume, enroll and policy verification need the passkey.
- **Q18 (deferred by the user):** "Let's not define the policy mechanism just yet; it might vary depending on the repo." Resolved as: pluggable `RepoPolicySource` seam, invariants fixed, built-in `none` and `fixture`, real source decided per repo when the first repo needs auto-merge.
- **Q19:** no phone-specific rules. The phone is just another browser client of the same console with identical capabilities and guardrails (the passkey step-up applies to any browser; a phone passkey is the natural step-up device, and if no device supports WebAuthn the same fallback applies to every browser). Any console client may start the kinds the daemon supports (chat, scout); workers and reviewers are started by dispatch.
- **Q20:** the hard chat limits are removed; audit, screening, fixed tool set, per-agent budgets and the kill switch remain; a 1 MiB body ceiling protects the daemon process from a runaway client or loop; rate limiting is opt-in per agent, default off.
- **Q21-Q23:** accepted: the Android daemon runs steward + scout + chat + light `git-process` workers (no auto-merge by default); Termux directly; the phone is sometimes offline.

Still open (each has a default):

| # | Question | Default if unanswered |
| --- | --- | --- |
| Q18 | Which `RepoPolicySource` kind does the first repo that wants auto-merge use (in-repo file, GitHub rules/rulesets only, agent-definition-only, out-of-repo store)? Deferred by the user; decided per repo then. | `none`: auto-merge stays off; shadow mode reports readiness only |
| Q24 | Should the durable repo's CI checks (tests, `tsc`, hygiene scan) be required on `main`? | Yes: the owner marks them required when slice 2 merges (a repository setting, not a code change) |
| Q25 | Which roles use the durable-conversation worker kind first? | Reviewers (read-only) and the Android agent's small workers; desktop code-writing workers stay on Pi sessions unless an agent opts in |
| Q26 | Orca viewer terminal for durable workers: `on-start`, `on-demand` or `never`? | `on-start` (capped by `maxConcurrent`), falling back to printing the `durable attach` command when Orca cannot create the terminal |
| Q27 | Does releasing a human hold need the guarded class (TTY + nonce, or passkey)? | Yes, the same class as agent resume, so an agent cannot lift a human's hold |

## Review status

Revised after user comments (rounds 1-7). Not yet re-reviewed. No reviewer opted in.
