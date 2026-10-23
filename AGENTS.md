# Durable contributor rules

This is a public repository. Do not commit secrets, machine-local files, absolute paths, personal emails, host names, or tailnet data. Run `pnpm check`, `pnpm test`, and `pnpm hygiene` before a PR. `pnpm check` includes TypeScript, Biome linting and format verification, and Fallow dead-code and duplication analysis. Use focused conventional commits; main is merged squash-only.

## Prefer maintained libraries

Do not write low-level code that a maintained, pure-JS library already covers (Android/Termux forbids native modules). Defaults: `citty` (CLI), `hono` + `@hono/node-server` (HTTP/SSE), `typebox` (validation), `@octokit/rest` (GitHub API), `execa` (subprocesses), `pino` (logging), `ink` (TUI), `node-notifier` (desktop notices), `msw` (HTTP test doubles). Pin exact versions. If a PR hand-rolls an equivalent, justify it in the PR description.

## Testing locally versus in CI

Run only focused tests locally: the test files for the code you changed (`node --test <file>`), plus `pnpm check` when you finish. Do not run the full suite or long integration probes in a loop. Push and let CI run the exhaustive suite, then fix failures from the CI logs.
