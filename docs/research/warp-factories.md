# Warp Factories versus Durable

Status: research report. Sources: Warp docs under `docs.warp.dev/factories/` (Early Access, schema `v1alpha1`) and this repo's plan in `docs/plan/` and code in `src/`.

## Bottom line

Both systems automate the same loop: work arrives, an agent triages and builds it, a different agent reviews it, and a human merges. They differ in who owns the control plane.

- **Warp Factories** is a hosted, team-oriented control plane. Warp runs the foreman, the sandboxes and the dashboard.
- **Durable** is a local, operator-owned steward per identity. GitHub is the only shared record. Nothing is hosted.

Warp is far more complete. Durable has stronger identity isolation, crash-safety and gate design. Durable should borrow Warp's stage vocabulary, spec gate, work-item model, metrics and factory-as-code layout. It should not copy the hosted architecture.

## What Warp Factories is

- A factory is "a team of cloud agents connected to your repositories" that routes work from Slack, GitHub, Linear, Jira and others through triage, planning, implementation and review. The output is usually a PR returned to the originating thread.
- A work item keeps one identity from intake to handoff.
- Pipeline: intake, foreman, triage, planning (optional), human spec approval (default policy), building, reviewing, a loop back to building when revisions are needed, human handoff, complete. Completion needs a merge confirmation, not just handoff.
- Roles: foreman (the only agent that talks to humans), triage, spec (writes a draft PR), implement ("never merges"), review (advisory verdict only). Custom agents and skills are allowed.
- Inputs: seven integrations, signed webhooks, a factory API, a local-agent MCP bridge, cron schedules and direct chat. Filters must all match and fail closed.
- Human gates: spec approval and answering questions are prompt policy. Merge is enforced by the repository.
- Config: a YAML and Markdown tree rooted at `factory.yaml`, hosted or in a GitHub repo, validated by a PR check, with the last valid definition kept on failure.
- Execution: control plane at Warp, execution plane in a Warp sandbox or a self-hosted worker (Enterprise). Harnesses are Warp Agent, Claude Code and Codex.
- Credentials: inference credentials never enter the sandbox. Secrets are allow-listed per agent. Repository identity is the creator or the agent.
- Measurement: dashboard (autonomy, cycle time, cost per PR), LLM-judge scorers, benchmarks, and self-improvement PRs for repeated failures. Warp says it automates about 30% of its own tasks this way.

## Overlap

| Concern | Warp Factories | Durable (plan) | Match |
| --- | --- | --- | --- |
| Core idea | Autonomous lifecycle from intake to PR | Proactive agents that find work and push it to review | Same |
| Lifecycle | triage, spec, build, review, handoff | scout brief, worker draft PR, reviewer, gate, human | Close |
| Roles | foreman, triage, spec, implement, review | steward, scout, worker, reviewer, gate | Close |
| Cross-checking | Separate review agent, advisory | Reviewer from the opposite model family, pure-code gate | Durable stricter |
| Human merge | Never merges; repo rules enforce | Auto-merge off; opt-in needs verified policy; no `--admin` | Same stance |
| Work record | Work item in Warp app; spec in draft PR | GitHub issues, PRs, labels and leases | Durable is more portable |
| Config as code | `factory.yaml` tree with JSON Schemas | YAML agent and machine files with JSON Schemas | Same pattern |
| Access is not prompt | "never from its instructions" | Gate trusts only GitHub facts and steward records | Same principle |
| Isolation | Per-agent secret allowlist | One profile, one identity, one process per agent | Durable stronger |
| Execution | Hosted sandbox or Docker/K8s worker | Pi session in an Orca worktree, systemd cgroup scope | Different |
| Recovery | Revision loop; no documented retry or timeout | Checkpoint resume, lock expiry, journal sweep | Durable stronger (plan) |

## Differences that matter

1. **Hosting.** Warp is a SaaS control plane. Even self-hosted workers send prompts and transcripts through Warp. Durable has no hub and works offline except for GitHub.
2. **Intake.** Warp is event-driven across seven systems. Durable polls GitHub and local task files only.
3. **Human conversation.** Warp has a single foreman as the human contact, with an inbox for questions, spec approvals and PR reviews. Durable has notifications and an attach TUI (planned), but no equivalent of a conversational foreman.
4. **Spec stage.** Warp has an explicit spec agent and a human spec approval. Durable's plan has a scout brief but no approved spec gate.
5. **Soft versus hard gates.** Warp admits only merge is enforced. Spec approval lives in the foreman's prompt, so it is bypassable. Durable puts gates in code.
6. **Observability and learning.** Warp has scorers, benchmarks and self-improvement PRs. Durable has none planned.
7. **Maturity.** Warp is in Early Access with an alpha schema. Durable has the steward, API v1, recovery and notifier. The README states that dispatch and merge-policy enforcement are not implemented, and `src/steward/loop.ts` is a heartbeat only.

## Observations

- Both converge on the same design rules: the agent that builds never approves, humans own merge, GitHub rules are the final authority, and config is versioned files. This supports the direction of the Durable plan.
- Warp's weakest point is where Durable is strongest. Prompt-level gates and one identity model (creator or agent) leave the gap Durable closes with code-owned eligibility, steward-store verdicts and per-agent identity.
- Warp's strongest points are where Durable is thinnest: intake breadth, human interaction, metrics and the spec stage.
- Warp's "work item keeps its identity from intake to handoff" is a clean concept. Durable has queue items, claims, PRs and attempts, with no single named entity tying them together.
- Warp defines completion as a confirmed merge. That avoids counting handoff as success.
- Warp documents no retry, timeout or dead-letter policy. Durable's plan covers more, but it is not built.

## Recommendations

1. **Adopt the work-item entity.** Name one record that follows an item from claim to merge, and use it in the API, notifications and metrics. Define completion as merged (or cancelled), not handed off.
2. **Add an optional spec stage.** For items above a complexity threshold, the scout produces a spec in a draft PR and the gate waits for human approval before the worker starts. Enforce it in code, not in a prompt.
3. **Make the pipeline configurable per project, with gates enforced in code.** Let each project's config file compose the stages (scout, spec, build, review, gate, handoff) from Durable primitives, so the exact pipeline is a per-project choice. Warp expresses its pause points as prompt policy, which is bypassable. In Durable the config selects stages and gate conditions, and code enforces them. Record this contrast in `docs/plan/2-system-architecture.md`.
4. **Ship the steward loop before widening scope.** Polling, queue, claims, then scout and worker. Warp's value comes from the end-to-end path, and Durable cannot demonstrate it yet.
5. **Add intake adapters later, behind one interface.** Start with GitHub (issues, labels, comments). Add webhooks and chat only after the poll path works. Keep the code-owned eligibility check on every adapter, and fail closed on filters as Warp does.
6. **Add a minimal metrics view.** Track PRs opened, merged, autonomy (merged with no human code push), cycle time, and cost per PR. Derive them from GitHub and the steward store. Defer LLM scorers and benchmarks.
7. **Add a self-improvement loop, after metrics exist.** Record failed or reworked runs, group repeated failures, and open a PR that changes skills, prompts or the per-project pipeline config. Copy Warp's rule that proposals arrive as PRs and nothing is adopted automatically. It needs recommendation 6 first, because it reads those outcomes.
8. **Align config naming with Warp's layout** (`agents/`, `automations/`, `runners/`) only where it costs nothing. Do not take a dependency on `v1alpha1`.
9. **Commit to pi-durable as the only harness.** Do not add Claude Code or Codex workers to match Warp's harness choice.
10. **Use Warp as a source of ideas only.** Durable is a personal tool, not a product. Skip multi-team features, hosted-style access roles, interop with Warp and a market-driven roadmap. Revisit Warp's docs when it leaves Early Access for further ideas.

## Gaps in this research

Warp pages not fully read: the agent and automation field reference, runners and routers, quickstart, individual integration pages, secrets, self-hosting, scorer and self-improvement detail, the pricing rates, and the "memory" feature. Warp documents no failure, retry, timeout, concurrency or retention policy that I could find. Re-check before relying on any Warp-specific detail, since the product is Early Access and the schema is alpha.
