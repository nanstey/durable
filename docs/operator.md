# Profiles and identity doctor

Definitions contain portable intent: profile names, repository slugs, models,
worker kinds and notification channel names. The machine file contains assignment,
checkout paths and channel backends. Neither contains credentials. Schemas in
`schema/` reject unknown keys, non-empty peers and non-loopback binds.

## Control plane and notifications

Durable has four control layers. **L0** is the repository and GitHub's own branch
rules. **L1** is the local daemon API and `durable` terminal commands, protected
by scoped local tokens. **L2** is notification delivery: the agent inbox/console,
desktop, an operator-owned command hook, or GitHub. **L3**, planned in slices 8,
11 and 12, is the optional web console. The console is a client, not a hub: it
adds no authority and does not own queue, claim, gate, or approval state.

Map events (`approval-needed`, `escalation`, `budget-stop`, `identity-failure`,
`agent-down`, `merged`, or `digest`) to named machine channels in the agent
`notify` block. `inbox` and `console` write the durable `steward.inbox` document.
`desktop` uses Linux `notify-send`. `command` executes configured argv without a
shell and receives JSON on standard input. `github` posts an @mention to its
target login. It is intentionally skipped when that login is the agent profile's
login: GitHub does not notify an account about its own activity.

The notifier de-duplicates an event by agent, event, target and SHA, persists
that state, honours priority, and holds notifications during configured quiet
hours rather than dropping them. It sends only the configured capped reminders.
If nobody resolves an item by `notify.staleDays`, Durable parks it as
`needs-human`, releases its claim and workers, posts one GitHub comment, and
sends one final escalation. It never approves, merges, or widens privileges to
unblock work.

Notification payloads contain only identifiers, titles and URLs. They never
contain bodies, paths, tokens, or credentials. An approval nonce is the sole
exception and is delivered only to `desktop` or `command`; it is never sent to
the inbox, console, GitHub, logs, or durable state. This prevents API-readable
and agent-readable surfaces from becoming approval-secret stores. A platform
backend must explicitly report `nonceSafe`; Linux `notify-send` does, whereas
future Android/Termux notifications do not.

Use these daemon-independent controls after configuring the definition and
machine file:

```sh
durable notify --test escalation --agent <id>
durable notify --event agent-down --agent <id>
durable notify status --agent <id> --json
```

`agent-down` is also invoked by the systemd `durable-agent-failure@.service`
`OnFailure=` hook, so it can notify after the agent process is dead. Missing
local desktop tooling is recorded in the audit log and skipped.

## Onboard a profile

`durable onboard` starts the resumable profile stage. It creates or selects a named profile manifest only; organization and agent stages are reserved for later releases.

```sh
durable onboard                         # accessible numbered choice; `work` is recommended
durable onboard --yes                   # accept the recommended named profile
durable onboard --non-interactive --answers onboarding.yaml
durable onboard --dry-run               # show manifest and private-state changes only
durable onboard --demo                  # temporary fake-only profile; no credential handoff
```

Before applying, onboarding reports Node, Git, `gh`, systemd-user, and Pi readiness. Missing checks do not cause it to read credentials or guess an identity; complete the indicated repair and rerun. Android/Termux does not require systemd-user and uses the same pure-JavaScript answers and dry-run path.

The answers file is plain YAML or JSON and accepts only non-secret choices:

```yaml
profile: work
github: pending # or bind, after pi-secret has stored the token
providers: [openrouter]
# Anthropic OAuth requires this explicit acknowledgement:
# anthropicOAuth: true
```

Unknown keys and credential-like values are rejected before a file is written. The private onboarding state records only the plan hash, profile name and completed stages; it never contains provider credentials, tokens, or answers-file contents. Rerun the same command to resume. `--dry-run` never writes, opens Pi, invokes `pi-secret`, calls GitHub, or probes a provider.

GitHub tokens are entered only through `pi-secret -p <profile> set GH_TOKEN`. Use a fine-grained selected-repository token with the least privileges needed; do not grant Administration or workflow-write. Then use `durable profile bind-github <profile>` to verify the non-secret login. On systems where `gh` supports a device-flow command, operators may use that handoff; otherwise complete the manual `pi-secret` step. Do not paste a token into onboarding input.

For each model provider, select the named Pi profile and run `/login`; onboarding records no credential. Anthropic subscription OAuth is offered only after the explicit acknowledgement above because authentication shaping and provider terms may change. If a handoff is incomplete, onboarding reports it as **pending operator** and gives the exact resume command.

## Configure a profile

1. Use Pi's profile extension to select a **named** profile and `/login` to its
   providers. Its credentials stay in `$PI_AGENT_DIR/auth-profiles/<name>.json`.
2. Store the GitHub token with `pi-secret -p <name> set GH_TOKEN`. Use a
   fine-grained token limited to the repositories the agent needs. Profile secrets
   live in `secrets/<name>.env`; never commit this file.
3. Run `durable profile init <name>`. Fill in `git.name`, `git.email` and
   `providers` in `profile-meta/<name>.json`.
4. Run `durable profile bind-github <name>` and confirm the printed login. This
   probes `gh api user` with the **profile's** token, never an ambient token.
5. Run `durable profile check <name>`. `list` enumerates manifests and `show`
   prints only non-secret manifest metadata. `--dry-run` prevents manifest writes.

Manifest directories are 0700 and manifests are 0600. Initialization refuses to
overwrite a manifest. Binding an identity is an explicit operator action: doctor
never silently updates a pinned login when tokens change.

`default` is refused unless the machine explicitly sets
`profiles.allowDefault: true`. Even with opt-in, Pi-session roles cannot use it.
Only in-process users opening the operator's canonical `auth.json` path can share
that credential store safely.

## Add a machine

Each machine is independent and has its own local profiles, checkout roots and
channels. Profile names are shared labels only: `work` on two machines can name
different credentials and must never mean copied credential files.

1. Install Durable either through the skills repository's pinned-clone `install.sh`
   flow or with the standalone steps in [install.md](install.md).
2. Select the named Pi profile and run `/login` for its providers. Then run
   `pi-secret -p <profile> set GH_TOKEN` for that machine's GitHub token.
3. Run `durable profile init <profile>`, fill in its manifest, then run
   `durable profile bind-github <profile>`.
4. Write `machine.yaml` with a distinct `name`, its assigned agent IDs, checkout
   roots, channels and ports. Copy or synchronize the portable agent definition;
   keep both files and every profile private to the machine.
5. Run `durable doctor <id>`. It fails closed if that machine lacks the named
   profile, manifest or GitHub secret; fix the reported profile steps before
   continuing.
6. On Linux with systemd --user, run `loginctl enable-linger` for an unattended
   host, then `durable enable <id>`. Other operating systems skip service setup;
   launchd support is deferred.

Claims coordinate machines through GitHub; they are not a security boundary. A
claim marker records the agent ID, lease expiry and optional installation ID.
Stewards re-read GitHub before acting; lowest comment ID wins. A running worker
renews its lease and releases it after finish or failure. A takeover waits for
expiry plus the grace period, then starts a new attempt from pushed branch state;
it never resumes the vanished machine's Pi session or durable conversation.

Use a conservative `schedule.pollSeconds` (300 seconds is the default guidance)
for each machine. Two machines polling five repositories use roughly 2,880 list
requests per day before item/PR reads. Raise the interval or narrow sources before
adding machines if GitHub rate limits become material.

## Assignment and diagnosis

Put definitions in `~/.config/durable/agents/<id>.yaml` (override with
`DURABLE_AGENTS_DIR`). Set assignment in `~/.config/durable/machine.yaml`
(override with `DURABLE_MACHINE_FILE`). State defaults to `~/.pi/durable`
(`DURABLE_HOME`). Pi's directory is selected by `PI_CODING_AGENT_DIR`.

```sh
durable doctor <id>
durable doctor <id> --json
```

Doctor prints PASS/FAIL/WARN rows and remediation steps. Any failure exits 1;
advisory token scope or self-notification warnings do not fail the report.
Missing credentials require Pi `/login`, `pi-secret -p <name> set GH_TOKEN` and
`durable profile init <name>` on **this machine**; there is no profile fallback.
A token-login mismatch must be investigated before rebinding.

Doctor checks detected vs declared platform capabilities, service availability,
Linux worker containment, port collisions, channels, worker kind enablement,
required skills, providers, manifest and GitHub identity. Literal loopback binding
is supported. Peer-checking settings and `approval` blocks report
`not-yet-supported`; do not mistake parsed configuration for implemented
remote-network or approval security.
Android state must be under private Termux HOME, not shared storage. Android
notifications cannot safely carry approval nonces. Auto-merge requires an explicit
Android opt-in and never bypasses repository policy or GitHub rules.

## Credential sharing and shell limitations

Derived per-agent Pi directories link **directories**, including `auth-profiles`,
`secrets`, `profile-meta`, `extensions`, `skills`, `agents`, `prompts`, `npm` and
`vendor`. They pin `defaultProfile`. Their `auth.json` must be absent or exactly
`{}`, never a file symlink. Credential rotation uses Pi's `proper-lockfile` lock
and in-place write; copying credentials or atomically renaming a private copy
would break rotation/locking semantics.

Worker process environments are allowlist-built. The `durable-shell` role has a
scratch HOME/TMPDIR, identity-only gitconfig and an empty gh directory, but no
GitHub tokens, provider keys, profile secrets or Pi directory. **This is not an OS
sandbox.** A same-user shell can still read files outside the worktree by an
explicit path; environment omission does not claim otherwise.

See [skills-contract.md](skills-contract.md) for per-role dispatch prerequisites.

## Console

The optional local console is a viewer/controller, not a hub. Run `durable console
enable`, then open the loopback address configured in its private `console.yaml`.
It reads status, queue, inbox, audit and live conversations; it can send
plain-text chat, abort a turn, pause an agent and use capability-gated worker
controls. It cannot approve, resume an agent, enroll a credential, verify policy,
run a shell command or browse files. Closing the console never stops an agent.
See [console.md](console.md) for its localhost guardrails and PWA-ready boundary.

## API access and tokens

Start the agent using [daemon commands](daemon.md). Its port is the assignment's
explicit `port`, or `daemon.portBase` (default 7330) plus its assignment index.
The [API reference](api.md) lists routes, message bodies and SSE frames.

```sh
durable token create <agent> --client <client-name> --scopes read,chat,pause --expires 90d
durable token list <agent>
durable token revoke <agent> --id <token-id>
```

Creation prints the token once. Save it outside the repository. Token storage
contains SHA-256 hashes only, client labels, scopes, creation/last-use timestamps
and expiry, mode 0600. Expiry defaults to 90 days. Revocation removes every token
with that client label. The local CLI keeps its own 0600 token file with the same
scopes and expiry; it renews an expired or revoked local token on its next use.
Do not put daemon tokens in a profile secrets file or send credentials in chat.

`read` grants GET requests and notice acknowledgement. `chat` grants screened
messages and turn abort. `pause` grants agent pause. Combining scopes never
grants approval, agent resume, enrollment, policy verification or hold release.
Those actions have no bearer authorization path. Agent resume currently requires
`durable resume <agent>` at a local TTY; it cannot clear global/environment stops.

These controls protect against accidental or prompt-induced actions, not a
compromised process running as your OS user. Such a process can read your local
token files. Filesystem confinement is not an OS sandbox.

## Work items and workers

A work item is a durable record created only from an eligible queue entry. The
queue remains a derived view: it retains its eligibility reasons after migration.
A work item completes only when GitHub confirms its primary PR is merged, or when
the steward records it cancelled or parked. Handoff alone is not completion.

Workers are capped by `limits.maxConcurrentWorkers`, `limits.maxWorkersPerDay`,
and `limits.itemMinutes`. Quiet hours prevent new dispatch but do not stop running
workers. Pause, disabled files and `DURABLE_DISABLED=1` prevent dispatch and stop
running attempts with outcome `paused`. A TTY-authorized `durable resume <agent>`
requeues paused items; global/environment stops and budgets still apply.
`durable stop <agent> --workers` ends attempts without stopping the daemon.
`durable stop <agent>` shuts down the service without recording cancellation, so
unfinished work can recover on restart. `durable retry <agent> <item>` enqueues
an explicit retry under the current eligibility rules and budgets.

For a Pi-session worker, view the terminal through Orca where available.
`durable open` asks the configured dispatcher for a viewer and prints a fallback
command if a terminal cannot be opened. Draft PRs use `durable/<agent>/<item>`, a
`durable/agent:<agent>` label, and a Durable-Agent commit trailer.

## Human ownership and viewers

Use `durable open <conversation>` with one assigned agent, or
`durable open <agent>/<conversation>`, for the steward, chat, scout or worker.
The dispatcher opens an Orca viewer where available; otherwise the CLI prints a
`durable attach` command. Closing a viewer never stops work. `GET /v1/workers`
and a running-daemon `durable doctor <agent>` report foreign terminals as
`suspected human session`. This is advisory, not a lock.

Before editing a worker workspace:

```sh
durable hold <agent> <item>
durable hold <agent> <item> --verify
durable release <agent> <item>
durable release <agent> <item> --code <code>
```

Hold commits a fence before draining the worker. The API immediately returns
`202 {state: holding}`; the CLI waits for `held`. Only confirmed, recursively
empty containment permits `held`. A timeout or failed kill leaves the item
`holding`, with an escalation and instructions; do not edit merely because the
steward stopped. Restart preserves the fence and finishes an interrupted hold
before resuming tasks. The claim remains attached to the item.

On cgroup v2 Linux, `--verify` reports authoritative containment emptiness. If a
slice cannot be stopped, follow the reported `systemctl --user stop <slice>`
instruction and confirm `cgroup.events` has `populated 0`. On Android or cgroup v1,
process inspection is advisory only: future absolute-path writers with cwd `/`
can be invisible. Exclusive ownership requires force-stopping Termux in Android
Settings or rebooting; cgroup v1 Linux requires a reboot.

Release requires a local TTY and an action/item/hold-epoch-bound, single-use code
with a five-minute expiry. The first release command sends it only to a configured
nonce-safe desktop or command channel. Repeat with `--code`. No bearer scope can
release a hold, and no API response, inbox entry or audit line contains the code.
Release re-reads PR state and starts a new attempt or returns to review.

The two required low-risk pilot runs (Orca and git-process), terminal input check,
viewer check, and steward crash drill require an operator and are listed in
`docs/evidence/slice-6b.md`.

## Spec and worker approval

A repository can select the optional `spec` stage with a `complexityThreshold`
(`medium` or `large`). At or above that source-declared or judge-produced size,
Durable opens a draft spec PR from the read-only scout result. Its work-item name
is idempotent, so a restart reuses the PR. With `specApproval: true`, no worker
starts until the spec is approved:

```sh
durable approve-spec <agent> <spec-pr> --code <nonce>
```

The single-use, five-minute nonce is delivered only through a nonce-safe desktop
or command channel. It is bound to the agent, work item, spec PR number and head
SHA; a new commit voids it. A missing size, unavailable judge, or closed unmerged
spec PR parks an approval-required item as `needs-human`. Without `specApproval`,
Durable still opens the spec PR but dispatch continues.

Worker PR approval uses `durable approve <agent> <worker-pr> --code <nonce>`.
GitHub labels, comments and statuses are not approvals: under a shared GitHub
identity a worker can forge those signals with the operator token. A human GitHub
merge or review from another account is observable evidence, while the nonce
only authorizes the local steward and never bypasses GitHub rules.

The nonce limits accidents and prompt injection, not a compromised same-user
process. Never send it through the inbox, console, GitHub, logs, API responses,
or a backend that is not explicitly nonce-safe.

## Merge modes and repository policy sources

`merge.mode` is `never`, `human-approval`, or `auto-when-safe`. `none` is the
default repository policy source, so it disables automatic merging even if an
agent definition requests it. `human-approval` remains available; no bearer
token can approve a merge attempt.

A policy source supplies the neutral gate input and a steward-resolved reference
and fingerprint. It must never read a PR head, fork, worker worktree, or
worker-writable location. A policy is usable only when it is verified by an
approval-class action or GitHub-computed evidence. Changes to a
source-protected location, CODEOWNERS, or `.github/` require human approval and
invalidate verification. Definition constraints only tighten a repository
policy.

Built-in sources are `none` and test-only `fixture`. Choosing a real source is
an **open per-repository decision**. Candidate kinds are an in-repository file,
GitHub rules/rulesets only, agent-definition-only, and an out-of-repository
store; Durable does not recommend one yet.

Set `shadow: true` before any future auto-merge use. Shadow mode computes and
audits `would-merge` or `would-not-merge` without writing a GitHub merge. A
non-verified source produces `would-not-merge` and includes readiness for
checks, review family, changed paths, mergeability, and cooling-off. Read it
with `durable gate report <item>` or `GET /v1/gate/report`. Leave shadow mode
only after an operator has reviewed those reports. Automatic attempts are
SHA-pinned, re-resolve policy immediately before the merge call, remain subject
to GitHub rules, and never use a bypass or administrator mode.

## Multi-machine console

Follow [networking](network.md) for tailnet setup. Create a scoped daemon token with `durable token create <agent> --client console-<host> --scopes read,chat,pause`, then pipe it to `durable console add-device --machine <label> --agent <id> --url <tailnet-url>`. Do not put console tokens in profile secrets: those secrets are exported to agent environments. The registry stores each token in a private 0600 file.

Rotate with no intended viewer downtime: create a new token, switch the registry device to it, then use the short id from `durable token list` to revoke the old token. Tokens expire after 90 days; doctor warns when fewer than 14 days remain.
