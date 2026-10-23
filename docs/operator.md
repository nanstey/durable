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

## API access and tokens

Start the agent using [daemon commands](daemon.md). Its port is the assignment's
explicit `port`, or `daemon.portBase` (default 7330) plus its assignment index.
The [API reference](api.md) lists routes, message bodies and SSE frames.

```sh
durable token create <agent> --client <client-name> --scopes read,chat,pause --expires 90d
durable token list <agent>
durable token revoke <agent> --client <client-name>
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
