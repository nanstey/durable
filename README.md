# durable

Durable, proactive agents that find project work and push it to human review.
Built on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable).

Status: shipped slices include profile-isolated steward, loopback API v1, crash
recovery, queue/work orchestration, review and approval gates, organizations,
connectors, metrics, and the loopback console. Pending operator work: configure
real profiles, verify machine identity, and make the final human merge decision;
Durable does not autonomously bypass GitHub policy.

Start with the credential-free [demo sandbox](docs/demo.md), [installation](docs/install.md), [profiles and doctor](docs/operator.md),
and the [skills contract](docs/skills-contract.md). `durable profile` manages
non-secret manifests; `durable doctor <id>` checks machine assignment and identity
without starting a daemon. See [daemon operation](docs/daemon.md),
[API v1](docs/api.md), and the [execution matrix](docs/evidence/slice-3.md).

Inspired by `disler/durable-pi`; no code copied from it.

## Development checks

Run `pnpm check` for TypeScript, Biome linting and formatting, and Fallow dead-code and duplication analysis. Use `pnpm test` and `pnpm hygiene` before opening a PR.

## Principles

- One agent uses one credential profile and one GitHub identity.
- GitHub is the durable record. Each machine runs independently; the optional console can run on more than one machine and holds no coordination state.
- Auto-merge is off unless a repo opts in. The agent never bypasses GitHub rules.
- The repo holds no secrets, no machine-local state and no absolute paths.
