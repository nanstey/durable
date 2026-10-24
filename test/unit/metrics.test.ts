import assert from "node:assert/strict";
import test from "node:test";
import { collectMetrics } from "../../src/metrics/collect.ts";
import type { WorkItem, WorkItems } from "../../src/steward/workItems.ts";

const range = {
	agent: "agent",
	organization: "org",
	since: 1_000,
	until: 10_000,
};
function item(overrides: Partial<WorkItem> = {}): WorkItem {
	return {
		id: "item",
		intakeRef: "acme/repo#1",
		repo: "acme/repo",
		candidate: {
			ref: "acme/repo#1",
			repo: "acme/repo",
			kind: "issue",
			title: "Change",
			author: "owner",
			authorAssociation: "OWNER",
			labels: [],
			updatedAt: new Date(1_000).toISOString(),
		},
		attempts: [{ id: "attempt", startedAt: 1_000, cost: 4 }],
		workerLogin: "agent",
		prs: [
			{
				number: 1,
				primary: true,
				openedAt: 2_000,
				state: "open",
			},
		],
		createdAt: 1_000,
		updatedAt: 2_000,
		...overrides,
	};
}
function store(...items: WorkItem[]): WorkItems {
	return {
		items: Object.fromEntries(items.map((entry) => [entry.id, entry])),
		byIntakeRef: {},
	};
}

test("metrics are unavailable for no PRs", () => {
	const report = collectMetrics(store({ ...item(), prs: [] }), [], range);
	assert.deepEqual(report.projects["acme/repo"], {
		prsOpened: 0,
		prsMerged: 0,
		autonomy: "unavailable",
		cycleTimeMs: "unavailable",
		costPerPr: "unavailable",
	});
});

test("GitHub-confirmed merge, audit push facts, and per-project aggregation are deterministic", () => {
	const merged = item({
		prs: [
			{
				number: 1,
				primary: true,
				openedAt: 2_000,
				github: {
					observedAt: 4_000,
					state: "merged",
					mergedAt: new Date(4_000).toISOString(),
					commitAuthors: ["agent"],
				},
			},
		],
	});
	const report = collectMetrics(
		store(merged),
		[
			{
				at: 3_000,
				agent: "agent",
				event: "github-code-push",
				item: "item",
				actor: "code",
			},
		],
		range,
	);
	assert.deepEqual(report.projects["acme/repo"], {
		prsOpened: 1,
		prsMerged: 1,
		autonomy: 1,
		cycleTimeMs: 3_000,
		costPerPr: 4,
	});
});

test("cancellation, rework, human pushes, missing costs, and stale projections do not improve metrics", () => {
	const cancelled = item({ id: "cancelled", outcome: "cancelled", prs: [] });
	const rework = item({
		id: "rework",
		attempts: [
			{ id: "first", startedAt: 1_000, endedAt: 1_100, cost: 2 },
			{ id: "second", startedAt: 1_200 },
		],
		prs: [
			{
				number: 2,
				primary: true,
				openedAt: 2_000,
				github: {
					observedAt: 5_000,
					state: "merged",
					mergedAt: new Date(5_000).toISOString(),
					commitAuthors: ["agent", "human"],
				},
			},
		],
	});
	const stale = item({
		id: "stale",
		outcome: "merged",
		prs: [{ number: 3, primary: true, openedAt: 2_000, state: "merged" }],
	});
	const report = collectMetrics(
		store(cancelled, rework, stale),
		[
			{
				at: 3_000,
				agent: "agent",
				event: "github-code-push",
				item: "rework",
				actor: "human",
			},
		],
		range,
	).projects["acme/repo"];
	assert.equal(report.prsOpened, 2);
	assert.equal(report.prsMerged, 1);
	assert.equal(report.autonomy, 0);
	assert.equal(report.costPerPr, "unavailable");
});

test("cycle time uses eligible intake and confirmed merge boundaries", () => {
	const report = collectMetrics(
		store(
			item({
				createdAt: 1_000,
				prs: [
					{
						number: 1,
						primary: true,
						openedAt: 2_000,
						github: {
							observedAt: 9_000,
							state: "merged",
							mergedAt: new Date(9_000).toISOString(),
							commitAuthors: ["agent"],
						},
					},
				],
			}),
		),
		[
			{
				at: 2_000,
				agent: "agent",
				event: "github-code-push",
				item: "item",
				actor: "code",
			},
		],
		range,
	).projects["acme/repo"];
	assert.equal(report.cycleTimeMs, 8_000);
});
