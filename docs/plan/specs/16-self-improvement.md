# Spec 16 — Self-improvement proposals (PR-only)

Objective: use metrics and work-item outcomes to identify repeated failed or reworked runs, then propose a reviewable change. Nothing is adopted automatically.
Design refs: architecture D21; program design `improve/*`; slice 16.
Depends on: spec 15.

## Checklist

1. **Outcome grouping:** `improve/group.ts` reads failed, cancelled and reworked work-item outcomes plus slice-15 metrics, groups repeatable patterns using code-owned fields and bounded summaries, and records the evidence links.
2. **Proposal:** `improve/propose.ts` opens a draft PR only when a configured repeat threshold is met, using the agent's own identity. Its code-owned per-target-repo glob allowlist permits only skills-repo skill/prompt paths and durable agent-file `scope.repos[].pipeline` paths; every other path is rejected.
3. **No automatic adoption:** the proposal is notification-only after PR creation. It cannot change the running pipeline, dispatch work, merge its own PR or alter engine source. Normal human review and merge apply.
4. **Surfaces:** CLI/API show grouped evidence and proposal PR links; the console links to the same read-only records.
5. **Tests:** fixtures cover a repeated failure, a one-off failure, rework and false grouping. Tests prove out-of-allowlist diffs are rejected, no PR is opened below threshold and no state changes after PR creation.

## Risk controls

- Never include raw untrusted issue or PR bodies in a proposal.
- Treat a proposal as advice, not a gate decision or policy authority.
- GitHub write uses the existing identity, audit and draft-PR controls.

## Out of scope

Automatic prompt/config changes, automatic merge, model retraining, LLM scoring and benchmarks.

## Done when

CI proves the proposal boundary; one draft proposal PR is reviewed by the operator; no change is adopted without a human merge.
