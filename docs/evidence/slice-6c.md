# Slice 6c part 1 evidence

## Implemented

| Spec item | Evidence |
| --- | --- |
| 1. Kind skeleton and selection | `DurableConversationKind` reports the durable capability set and reuses its background owner key. Existing selection truth-table tests cover precedence and enablement. |
| 2. Ownership anchor | `workers/durable/anchor.ts` defines the task-owned conversation adapter and idempotent owner lookup. |
| 3. Tool guardrails | File tools realpath-check the worktree and reject `.git`, traversal and symlink escapes. `durable-shell` uses the credential-free environment and command output is screened. Bash guardrails are advisory, not a sandbox. |
| 4. Git/GitHub intent | Operation intents serialize one in-flight operation and remote-head reconciliation confirms, retries, or conflicts without overwriting. Git invocation options disable hooks and fsmonitor. |
| 5. Limits and holds | Shared limit evaluation gives pause, hold, wall clock, turn, tool-call and token limits deterministic terminal reasons for both tool hooks and the item supervisor. |

## Executed checks

- `pnpm install --frozen-lockfile`
- `node --experimental-strip-types --test test/unit/durable-worker.test.ts`: 4 passing tests
- `pnpm check`
- `pnpm hygiene`

## Guardrail boundary

The shell runs as the operator's OS user. The fixed file tools enforce their own paths, but bash can still use interpreters, scripts, and absolute credential-file paths available to that user. No profile secret or GitHub token is passed in `durable-shell`; code-owned operations are the supported path, not an enforced boundary. Sandbox hardening remains deferred.
