# Workers

Durable's default worker is a Pi session in an isolated worktree. The worker receives an assembled scout brief and the `idea-to-pr` workflow. It may create a draft PR, but it must not merge, force-push, or push a protected branch.

The generated worker launcher uses a private, derived Pi directory and an allowlisted environment. It passes provider and model as separate Pi flags. Detached (`git-process`) sessions have standard input connected to `/dev/null`.

`pi-extension/durable-worker-guard.ts` is enabled only when `DURABLE_WORKER=1`. It blocks merge, force-push, protected-branch push, GitHub merge API, and `--admin` command forms. This is a guardrail; repository rules and token scope remain the security boundary.

Dispatchers are `orca` (interactive terminal) and `git-process` (detached process with a log). Both create a worktree first. Use `durable open <agent>/<conversation>` where supported to open a viewer; the git-process fallback is a command to run locally.
