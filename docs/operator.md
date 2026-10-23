# Profiles and identity doctor

Definitions contain portable intent: profile names, repository slugs, models,
worker kinds and notification channel names. The machine file contains assignment,
checkout paths and channel backends. Neither contains credentials. Schemas in
`schema/` reject unknown keys, non-empty peers and non-loopback binds.

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
required skills, providers, manifest and GitHub identity. `network` and `approval`
blocks parse but report `not-yet-supported` until their implementation slices;
do not mistake parsed configuration for implemented network/approval security.
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
