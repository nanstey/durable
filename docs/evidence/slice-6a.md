# Slice 6a evidence

## Implemented

- `WorkerDispatcher` and `WorkerKind` contracts define workspace, hosted-process, viewer, capability, transcript, interrupt and steering boundaries. Their headers record W1-W3.
- `orca`, `git-process`, and in-memory `fake` dispatchers support idempotent workspaces and processes. Orca uses the current `orca --help` flags, lists terminals before creating one, and falls back to a command viewer.
- Pi-session workers launch through a private launcher with an allowlisted environment, separate `--provider` and `--model` flags, and `/dev/null` stdin for headless dispatchers.
- Worker registry routes expose list, transcript, steer and interrupt operations. Worker leaves are included in the conversation tree and worker SSE stream.

## Validation

- `pnpm install --frozen-lockfile`: passed.
- Focused dispatcher tests and `pnpm check`: pending final run.
- Live Orca and git-process pilot: pending operator. The installed Orca CLI was inspected with `orca --help`; its terminal list, create, read, send, and close flags match the adapter.
