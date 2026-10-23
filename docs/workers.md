# Workers

An eligible queue entry becomes one persistent work item and a loop-owned native
`steward.work-item` task. Its phases claim the intake, obtain a read-only scout
brief, create an isolated worktree, start the selected kind, and monitor GitHub.
The default kind is `pi-session`. Selecting an unavailable or disabled kind
refuses dispatch; it never silently switches kinds.

## Dispatch and recovery

Configure `models.worker`, the repository checkout in the machine file, and the
required worker skills. `workers.dispatcher` selects Orca or git-process. Orca
hosts an interactive Pi terminal; git-process hosts a detached process and log.
Both create the workspace before starting Pi. `templates/worker-brief.md` loads
`idea-to-pr`, explains isolation, and forbids merges, protected-branch pushes,
force pushes and secret disclosure.

Every phase commits its intent before effects. Claim comments use read-after-write
arbitration; the lowest active comment wins. Replay reuses the claim, workspace,
job identity and scout submission. Worker handles and attempt counts survive
restart, but credentials are reconstructed from the profile rather than stored in
the work-item document. An exited worker without a PR gets a bounded continuation
attempt; exhaustion records an escalation and one intake comment. Human- or
policy-cancelled work is never automatically retried.

A detected draft PR moves the item to review, not completion. The mandatory
review and gate stages cannot be skipped. Only the primary PR merging completes
the item; closing it without merging parks the item. PR state is reconciled after
restart. Spec stages and spec-approval gates are refused until their implementation
is available.

## Identity and containment

The generated launcher uses a private derived Pi directory and an allowlisted
environment. It references supplied environment variables without embedding their
secret values in the launcher file. Initial and continued launches pass provider
and model as separate flags. Headless launches use stdin `/dev/null`; Orca keeps
terminal input.

A terminal-hosted gate records the process identity before its release token is
written. On Linux the gate and Pi run inside the attempt's systemd slice. Holds,
hard interruption, limits, pause, shutdown and startup recovery terminate that
containment, including descendants that use `setsid`.

Git author and committer identity come from the profile manifest. Supported worker
`git`/`gh` shims add `Durable-Agent: <agent>`, restrict pushes to the explicit
`durable/<agent>/<item>` branch, require draft PR attribution, and audit GitHub
writes with profile and login. Daemon GitHub writes use the same item fence and
an audited injectable adapter. PRs have label `durable/agent:<agent>`, an item
marker, and the operator-identity footer.

The repository's `pi-extension/durable-worker-guard.ts` loads through generated Pi
settings; no user extension installation is needed. When `DURABLE_WORKER=1`, its
`tool_call` hook rejects tools while holding/held and blocks merge, force-push,
default-branch push, merge API and admin command forms. The shared policy and
actual Pi extension loader are tested offline.

These are guardrails, not an OS sandbox: Pi-session workers have the profile's
GitHub token and share the operator's filesystem permissions. Explicitly bypassing
the supported shims can bypass their audit and attribution. Use repository rules
and a fine-grained, repository-limited token without administration or workflows
write permission.

## Durable-conversation workers

The opt-in `durable-conversation` kind runs headlessly in the steward process.
It has only fixed code-owned tools and loads no user skills, extensions, prompts,
or Pi packages. `workers.durable.skills` can inline allowlisted `SKILL.md` text
from the generated Pi directory; a skill requiring subagents, codemode, or helper
scripts is refused. Keep `idea-to-pr`, `build`, `review-code`, `planning`, and
any workflow that orchestrates subagents or runs skill scripts on Pi-session
workers.

Durable workers share one steward storage owner. `workers.durable.maxConcurrent`
defaults to 2 (and to 1 on Android); extra starts are refused rather than opening
the storage from another process. After a crash, replay-safe tools rerun. A
non-replay-safe tool can report `interrupted`; the worker playbook requires
checking `git status`, files, the remote branch, and any draft PR before retrying.

See [operator controls](operator.md#work-items-and-workers), the
[API reference](api.md), and [integration evidence](evidence/slice-6b.md).
