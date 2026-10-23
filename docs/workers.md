# Workers

An eligible queue entry becomes one persistent work item and a loop-owned native
`steward.work-item` task. Its phases claim the intake, obtain a read-only scout
brief, create an isolated worktree, start the selected kind, and monitor GitHub.
The default kind is `pi-session`. Selecting an unavailable or disabled kind
refuses dispatch; it never silently switches kinds.

## Kinds and roles

Kind selection is per role: machine override, agent role override, agent default,
then the platform default. On Linux, `pi-session` is the default. Selecting
`durable-conversation` also requires that role in
`workers.durable.enabledRoles`; enablement never selects a kind. Durable reviewers
are read-only and are the safest first durable role. Code-writing durable workers
are opt-in per agent.

| Kind | Roles | Attach/viewer | Tools | Crash resume | Shell token |
| --- | --- | --- | --- | --- | --- |
| `pi-session` | worker, reviewer | dispatcher terminal | Pi session and approved skills | no | present |
| `durable-conversation` worker | opt-in worker | `durable attach <agent>/<conversation>` | read, search, edit, write, bash, commit, push_branch, open_draft_pr, report | yes | absent |
| `durable-conversation` reviewer | enabled reviewer | `durable attach <agent>/<conversation>` | read, search, code-owned `pr_diff`, code-owned `report_verdict` | yes | absent |

A durable reviewer has no shell, edit/write, commit, push, or PR-create tool.
`report_verdict` accepts one final `{ verdict, risk, summary, headSha }`, checks
that the SHA is the reviewed head, and records model provider, model, family, and
successful assistant-entry count. The reviewer model family must differ from the
reviewed worker family. A reviewer without a verdict fails; a malformed, wrong-SHA,
second, or same-family verdict is refused.

Set `workers.durable.viewer: on-start` to ask an Orca dispatcher to open a
viewer terminal when a durable child starts. If Orca is unavailable, the API
returns the `durable attach ...` command instead. `on-demand` and `never` do not
open a terminal automatically. Closing a viewer never affects the worker.

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

### Limits and lifecycle

Before every tool call Durable checks the kill switch, hold fence, wall-clock,
turn, tool-call and token budgets. Pause, stop, hard interrupt, hold, and a limit
abort the native worker and its containment unit. A soft interrupt or tree abort
ends only the current turn; the worker waits for a follow-up. A hold fences the
item before cancellation and remains fenced until an approval-class release.
After a crash, shutdown, or steward restart, an unfinished child reattaches; no
human- or policy-initiated stop restarts without its explicit release, resume, or
new work action.

### Guardrails are not a boundary

The durable file tools resolve paths inside the worktree and reject `.git`,
symlinks, absolute paths, and traversal. `bash` starts in that worktree under a
minimal `durable-shell` environment, and the shared command guard blocks common
push, merge, rebase, force, worktree, and outside-`cd` forms. This is advisory,
not a sandbox. The model runs as the operator's OS user, so an interpreter or a
script can read or write files available to that user outside the worktree,
including credential files; variable-built paths can bypass the command denylist;
and a credential read from disk can enable a direct push. The known-limits suite
proves these cases remain possible. The guarantee is only that `GH_TOKEN`,
`GITHUB_TOKEN`, profile secrets, provider keys, connector settings, and the SSH
agent are absent from the shell environment. Code-owned GitHub tools are the
supported guarded path, not an enforced boundary. Sandbox hardening is a deferred
follow-up.

See [operator controls](operator.md#work-items-and-workers), the
[API reference](api.md), and [slice 6c evidence](evidence/slice-6c.md).
