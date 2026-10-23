# durable

Durable, proactive agents that find project work and push it to human review.
Built on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable).

Status: identity/configuration foundation, with offline regression tests. Autonomous dispatch and merge-policy enforcement are not production-ready.

Start with [installation](docs/install.md), [profiles and doctor](docs/operator.md),
and the [skills contract](docs/skills-contract.md). `durable profile` manages
non-secret manifests; `durable doctor <id>` checks machine assignment and identity
without starting a daemon.

Inspired by `disler/durable-pi`; no code copied from it.

## Development checks

Run `pnpm check` for TypeScript, Biome linting and formatting, and Fallow dead-code and duplication analysis. Use `pnpm test` and `pnpm hygiene` before opening a PR.

## Principles

- One agent uses one credential profile and one GitHub identity.
- GitHub is the durable record. Each machine runs independently.
- Auto-merge is off unless a repo opts in. The agent never bypasses GitHub rules.
- The repo holds no secrets, no machine-local state and no absolute paths.
