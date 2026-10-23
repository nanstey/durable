# Spec 15 — Minimal metrics

Objective: expose a small, trustworthy per-project view of outcomes after work-item, dispatch, gate and console data exist. Metrics are derived from GitHub and the steward store; they do not introduce a hosted service.
Design refs: architecture D21, §3.4, §7; program design `metrics/*`; slice 15.
Depends on: specs 06 (work items), 07 (gate outcomes) and 08 (console).

## Checklist

1. **Metric model:** `metrics/collect.ts` joins work-item records with GitHub PR and commit facts. Report `prsOpened`, `prsMerged`, `autonomy` (a merged PR with no human code push), cycle time (eligible intake to confirmed merge) and cost per PR (`attempts[].cost` divided by opened PRs). When cost is absent, including Pi-session workers, report `unavailable` rather than guessing.
2. **Completion facts:** only GitHub-confirmed merge marks a merged outcome. Cancelled and parked items remain visible as non-merged outcomes; handoff never counts as completion.
3. **Surfaces:** `GET /v1/metrics` and `durable metrics <agent>` expose a bounded time range and project filter. The slice-8 console adds the same read-only view.
4. **Tests:** recorded GitHub and steward-store fixtures cover zero PRs, merge, cancellation, rework, a human code push, missing cost and cycle-time boundaries. Tests prove GitHub facts win over stale local projections.
5. **Docs:** document definitions, unavailable values and the fact that these are personal-tool operational metrics, not team ranking.

## Risk controls

- Never infer a human push from untrusted PR text; use GitHub commit/author facts.
- Do not expose model prompts, issue bodies, tokens or private commit content in metric output.
- A missing GitHub or steward fact yields unavailable, never a favourable default.

## Out of scope

LLM judges, benchmarks, hosted dashboards, team reporting and automatic tuning.

## Done when

CI fixtures prove the definitions; CLI, API and console agree for a recorded project; the operator reviews one real metrics report.
