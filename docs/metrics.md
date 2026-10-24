# Metrics

`durable metrics <agent>` and `GET /v1/metrics` provide personal operational
metrics from the persisted work-item store, its redacted audit facts, and the
GitHub facts recorded while reconciling a pull request. They are not a team
ranking, benchmark, performance review, or hosted dashboard.

The default range is the last 30 days. `--since` and `--until` (or API query
parameters) accept ISO dates or epoch milliseconds; ranges are limited to 90
days. `--repo` filters one project and `--organization` must match the agent's
organization.

For each project, `prsOpened` counts primary work-item PRs opened inside the
range. `prsMerged` counts only PRs whose saved GitHub observation confirms a
merge. A cancelled or parked item remains represented by its opened PR but
never becomes a merge; handoff is not completion. Stale local `outcome: merged`
projections do not count.

`autonomy` is the fraction of confirmed merged PRs whose GitHub commit authors
exclusively match Durable's configured worker login. A recorded human code push
makes it zero for that PR. `cycleTimeMs` is
the mean from eligible intake (`createdAt`) to GitHub's confirmed merge time.
`costPerPr` is all recorded attempt costs divided by opened PRs. Pi-session and
other attempts without a cost make cost per PR `unavailable` rather than an
estimate.

Any missing steward, audit, or GitHub fact makes the affected derived value
`unavailable`; Durable never treats absent evidence as a favourable outcome.
The console shows the same read-only report per reachable agent.
