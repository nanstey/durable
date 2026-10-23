# Slice 6a evidence

## Implemented

- `WorkerDispatcher` and `WorkerKind` contracts define workspace, hosted-process, viewer, capability, transcript, interrupt and steering boundaries. Their headers record W1-W3.
- `orca`, `git-process`, and in-memory `fake` dispatchers support idempotent workspaces and processes. Orca uses the current `orca --help` flags, lists terminals before creating one, refuses dirty removal, and falls back to a command viewer.
- Pi-session workers launch through a private launcher with an allowlisted environment, separate `--provider` and `--model` flags, and `/dev/null` stdin for headless dispatchers.
- Worker registry launches a dispatcher-created workspace before starting a Pi session. Its routes expose list, transcript, steer and interrupt operations; worker leaves are included in the conversation tree and worker SSE stream.

## Validation

- `pnpm install --frozen-lockfile`: passed.
- Focused dispatcher, kind, and process-fallback tests: 20 passing (five contract cases cover fake, git-process with a stubbed `pi`, and Orca with a recording stub CLI).
- `pnpm check` and `pnpm hygiene`: passed.
- Live Orca and git-process pilot: pending operator. The installed Orca CLI was inspected with `orca --help`; its terminal list, create, read, send, and close flags match the adapter.
