import type { AuditEvent } from "../steward/audit.ts";
import type { WorkItem, WorkItems } from "../steward/workItems.ts";

export type Unavailable = "unavailable";
export type Metrics = {
	prsOpened: number;
	prsMerged: number;
	autonomy: number | Unavailable;
	cycleTimeMs: number | Unavailable;
	costPerPr: number | Unavailable;
};
export type MetricsReport = {
	agent: string;
	organization: string;
	since: number;
	until: number;
	projects: Record<string, Metrics>;
};
export type MetricsQuery = {
	agent: string;
	organization: string;
	since: number;
	until: number;
	repo?: string;
};

type Counts = {
	opened: number;
	merged: number;
	autonomous: number;
	autonomyUnavailable: boolean;
	cycleTimes: number[];
	cost: number;
	costUnavailable: boolean;
};

function counts(): Counts {
	return {
		opened: 0,
		merged: 0,
		autonomous: 0,
		autonomyUnavailable: false,
		cycleTimes: [],
		cost: 0,
		costUnavailable: false,
	};
}

function humanPushes(audit: AuditEvent[], item: WorkItem): boolean | undefined {
	const facts = audit.filter(
		(event) => event.item === item.id && event.event === "github-code-push",
	);
	if (!facts.length) return undefined;
	return facts.some((event) => event.actor === "human");
}

function addItem(
	bucket: Counts,
	item: WorkItem,
	audit: AuditEvent[],
	query: MetricsQuery,
) {
	const primary = item.prs.find((pr) => pr.primary);
	if (
		!primary ||
		typeof primary.openedAt !== "number" ||
		primary.openedAt < query.since ||
		primary.openedAt > query.until
	)
		return;
	bucket.opened++;
	const costs = item.attempts.map((attempt) => attempt.cost);
	if (costs.some((cost) => typeof cost !== "number"))
		bucket.costUnavailable = true;
	else bucket.cost += costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);

	const github = primary.github;
	if (github?.state !== "merged" || !github.mergedAt) return;
	bucket.merged++;
	const mergedAt = Date.parse(github.mergedAt);
	if (
		Number.isFinite(mergedAt) &&
		mergedAt >= query.since &&
		mergedAt <= query.until
	)
		bucket.cycleTimes.push(mergedAt - item.createdAt);
	const human = humanPushes(audit, item);
	if (!github.commitAuthors || !item.workerLogin)
		bucket.autonomyUnavailable = true;
	else if (
		human !== true &&
		github.commitAuthors.every((author) => author === item.workerLogin)
	)
		bucket.autonomous++;
}

function report(bucket: Counts): Metrics {
	return {
		prsOpened: bucket.opened,
		prsMerged: bucket.merged,
		autonomy:
			bucket.merged === 0 || bucket.autonomyUnavailable
				? "unavailable"
				: bucket.autonomous / bucket.merged,
		cycleTimeMs:
			bucket.cycleTimes.length === 0
				? "unavailable"
				: bucket.cycleTimes.reduce((sum, value) => sum + value, 0) /
					bucket.cycleTimes.length,
		costPerPr:
			bucket.opened === 0 || bucket.costUnavailable
				? "unavailable"
				: bucket.cost / bucket.opened,
	};
}

/** Derives public operational aggregates from persisted steward and GitHub facts only. */
export function collectMetrics(
	work: WorkItems,
	audit: AuditEvent[],
	query: MetricsQuery,
): MetricsReport {
	const buckets = new Map<string, Counts>();
	for (const item of Object.values(work.items)) {
		if (query.repo && item.repo !== query.repo) continue;
		const bucket = buckets.get(item.repo) ?? counts();
		buckets.set(item.repo, bucket);
		addItem(bucket, item, audit, query);
	}
	return {
		agent: query.agent,
		organization: query.organization,
		since: query.since,
		until: query.until,
		projects: Object.fromEntries(
			[...buckets.entries()].map(([repo, bucket]) => [repo, report(bucket)]),
		),
	};
}
