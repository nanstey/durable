# Spec 05 — Read-only scout: sources, eligibility, queue

Objective: the steward finds and ranks work in its scope from GitHub issues, own PRs and local files, with code-owned reasons. Zero GitHub writes.
Design refs: architecture §1 (Scout), D7.3, D7.6, §3.3, §4 steps 1-2; program design §3.2.
Revision 1: identity is the operator's account via the agent's profile (C2); trusted-author filtering matters more because injected text now acts with the operator's reach.
Revision 2: renumbered (was 04). `GET /v1/queue` and the SSE `queue` frames extend API v1 additively; the CLI (`durable queue`) and the console (spec 08) display them.
Depends on: spec 04 (client, notifier) and spec 03 (API).

## Checklist

1. **Source interface** `sources/types.ts`: `Source.poll(): Promise<Candidate[]>`; `Candidate = { ref, kind, repo, title, author, authorAssociation, labels, updatedAt, bodyRef, url, state }`. Bodies are stored as references and never logged. Acceptance: type tests via fixtures.
2. **GitHub issues** `sources/githubIssues.ts`: `gh issue list --json ... --label ...` with the agent env; pagination; `exclude` labels; conditional requests or a minimum interval; rate-limit remaining read from `gh api rate_limit` and logged. Acceptance: fixture-driven tests (stub `gh`).
3. **Own PRs** `sources/githubPrs.ts`: PRs authored by the declared login with labels `durable/agent:<id>`, summarised needs (failing checks, changes requested, behind base, conflicts). Acceptance: fixtures.
4. **Local files** `sources/localFiles.ts`: glob within a declared repo checkout; parse front matter (`status`, `priority`, `size`); `readyValue` filter; reject paths escaping the checkout (symlink and `..` tests). Acceptance: fixtures incl. traversal attempt.
5. **Eligibility (code owns thresholds)** `sources/eligibility.ts`: trusted authors only (`OWNER|MEMBER|COLLABORATOR` or explicit list); required/excluded labels; not blocked/claimed; attempts left; size and age bounds; per-source max items. Output `{ eligible, reasons[] }`. Acceptance: table tests; **injection test**: an untrusted-author issue with instruction-like text never becomes eligible and never reaches an LLM prompt.
6. **Judge** `scout/judge.ts` (optional; `models.judge`): bounded typed judgments (`actionable: yes|no|unclear`, `risk: low|medium|high`, `size: small|medium|large`) through the pi-ai TypeSafe provider (per-agent key from `secrets/<profile>.env`). Rule: result can only demote (to `needs-human`, `too-big`) or raise risk, never promote. Acceptance: tests with a stub model; judge disabled and judge failing both leave code decisions unchanged.
7. **Queue document** `steward.queue` (typed, committed with entries): items with state `candidate|eligible|skipped|...`, reasons, first/last seen. Update each tick; stale items expire. Acceptance: persistence across restart test.
8. **Tick integration** in `steward/loop.ts`: poll -> eligibility -> judge -> queue update -> audit summary (counts only). No dispatch.
9. **Main conversation tools**: `list_queue`, `explain_item` (returns stored reasons, not raw bodies). `durable queue <id>` CLI and `GET /v1/queue`.
10. **Live run** on the pilot scope (a low-risk pilot repo of the operator's choice; the skills repo is a candidate; read-only token): queue is plausible; record API request count per tick and rate-limit headroom; tune `pollSeconds`.

## Risk controls

- Run this slice with a profile whose fine-grained token is read-only (Contents R, Issues R, Pull requests R, Metadata R); doctor warns if write permissions are present while no writer slice is enabled (advisory). Operator-identity reach makes this the safest first live run.
- Issue/PR text is untrusted: truncated, never executed, never placed in a prompt unless the author is trusted.
- Respect rate limits: minimum interval, backoff with jitter.
- Audit logs counts and ids, not bodies.

## Out of scope

Claims, labels, comments, worktrees, workers, gate.

## Done when

CI green; live queue reviewed by the user; thresholds tuned in the agent file.
