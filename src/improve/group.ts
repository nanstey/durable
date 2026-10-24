import type { Metrics, MetricsReport } from "../metrics/collect.ts";
import type { WorkItem, WorkItems } from "../steward/workItems.ts";

export type ImprovementPattern = {
	repo: string;
	kind: "cancelled" | "failed" | "reworked";
	count: number;
	/** Stable local record references, never candidate titles or bodies. */
	evidence: string[];
	metrics: Metrics;
	summary: string;
};

const emptyMetrics: Metrics = {
	prsOpened: 0,
	prsMerged: 0,
	autonomy: "unavailable",
	cycleTimeMs: "unavailable",
	costPerPr: "unavailable",
};

function outcome(item: WorkItem): ImprovementPattern["kind"] | undefined {
	if (item.attempts.length > 1) return "reworked";
	if (item.outcome === "cancelled") return "cancelled";
	if (
		["parked", "needs-human", "limit", "paused", "held"].includes(
			item.outcome ?? "",
		)
	)
		return "failed";
	return undefined;
}

/**
 * Groups only code-owned lifecycle fields. Candidate text, review summaries and
 * GitHub bodies are deliberately not available to this function.
 */
export function groupOutcomes(
	work: WorkItems,
	metrics: MetricsReport,
	maxEvidence = 20,
): ImprovementPattern[] {
	if (!Number.isSafeInteger(maxEvidence) || maxEvidence < 1)
		throw Error("maxEvidence must be a positive integer");
	const patterns = new Map<string, ImprovementPattern>();
	for (const item of Object.values(work.items)) {
		const kind = outcome(item);
		if (!kind) continue;
		const key = `${item.repo}:${kind}`;
		const current = patterns.get(key) ?? {
			repo: item.repo,
			kind,
			count: 0,
			evidence: [],
			metrics: metrics.projects[item.repo] ?? emptyMetrics,
			summary: "",
		};
		current.count++;
		if (current.evidence.length < maxEvidence) current.evidence.push(item.id);
		patterns.set(key, current);
	}
	return [...patterns.values()]
		.map((pattern) => ({
			...pattern,
			summary: `${pattern.count} ${pattern.kind} work items in ${pattern.repo}`,
		}))
		.sort(
			(a, b) =>
				b.count - a.count ||
				a.repo.localeCompare(b.repo) ||
				a.kind.localeCompare(b.kind),
		);
}
