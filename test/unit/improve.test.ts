import assert from "node:assert/strict";
import test from "node:test";
import { groupOutcomes } from "../../src/improve/group.ts";
import {
	assertProposalChanges,
	proposeImprovement,
	type ImprovementGithub,
} from "../../src/improve/propose.ts";
import type { MetricsReport } from "../../src/metrics/collect.ts";
import type { WorkItem, WorkItems } from "../../src/steward/workItems.ts";

const metrics: MetricsReport = {
	agent: "agent",
	organization: "default",
	since: 0,
	until: 1,
	projects: {
		"acme/repo": {
			prsOpened: 2,
			prsMerged: 0,
			autonomy: "unavailable",
			cycleTimeMs: "unavailable",
			costPerPr: "unavailable",
		},
	},
};
function item(id: string, overrides: Partial<WorkItem> = {}): WorkItem {
	return {
		id,
		intakeRef: `acme/repo#${id}`,
		repo: "acme/repo",
		candidate: {
			ref: `acme/repo#${id}`,
			repo: "acme/repo",
			kind: "issue",
			title: "untrusted title",
			author: "owner",
			authorAssociation: "OWNER",
			labels: [],
			updatedAt: new Date(0).toISOString(),
		},
		attempts: [{ id: "attempt", startedAt: 0 }],
		prs: [],
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}
function store(...items: WorkItem[]): WorkItems {
	return {
		items: Object.fromEntries(items.map((entry) => [entry.id, entry])),
		byIntakeRef: {},
	};
}

test("outcome grouping uses bounded code-owned evidence without intake text", () => {
	const patterns = groupOutcomes(
		store(
			item("cancelled", { outcome: "cancelled" }),
			item("reworked", {
				attempts: [
					{ id: "one", startedAt: 0 },
					{ id: "two", startedAt: 1 },
				],
			}),
			item("parked", { outcome: "parked" }),
		),
		metrics,
		1,
	);
	assert.deepEqual(
		patterns.map(({ kind, count, evidence }) => ({ kind, count, evidence })),
		[
			{ kind: "cancelled", count: 1, evidence: ["cancelled"] },
			{ kind: "failed", count: 1, evidence: ["parked"] },
			{ kind: "reworked", count: 1, evidence: ["reworked"] },
		],
	);
	assert.doesNotMatch(JSON.stringify(patterns), /untrusted title/);
});

test("proposal paths reject engine, gate, approval, policy, and credential locations", () => {
	for (const path of [
		"src/index.ts",
		"gate/decide.ts",
		"approval/nonce.ts",
		".github/workflows/ci.yml",
		"secrets/token.env",
		"agents/a.yaml",
	]) {
		assert.throws(() =>
			assertProposalChanges({ kind: "skills" }, [{ path, content: "x" }]),
		);
	}
	assert.throws(() =>
		assertProposalChanges({ kind: "durable-agent-file" }, [
			{ path: "agents/a.yaml", content: "x" },
		]),
	);
	assert.doesNotThrow(() =>
		assertProposalChanges({ kind: "durable-agent-file" }, [
			{
				path: "agents/a.yaml",
				content: "x",
				location: "scope.repos[].pipeline",
			},
		]),
	);
});

test("opt-in off and below threshold do not open a proposal", async () => {
	let calls = 0;
	const github: ImprovementGithub = {
		createDraftProposal: async () => {
			calls++;
			return { number: 1, draft: true };
		},
	};
	const pattern = groupOutcomes(
		store(item("a", { outcome: "cancelled" })),
		metrics,
	)[0]!;
	for (const input of [
		{ enabled: false, threshold: 1, disabled: false },
		{ enabled: true, threshold: 2, disabled: false },
		{ enabled: true, threshold: 1, disabled: true },
	]) {
		const result = await proposeImprovement({
			enabled: input.enabled,
			disabled: input.disabled,
			target: {
				repo: "acme/repo",
				base: "main",
				kind: "skills",
				repeatThreshold: input.threshold,
			},
			pattern,
			changes: [{ path: "prompts/retry.md", content: "bounded" }],
			github,
		});
		assert.notEqual(result.state, "opened");
	}
	assert.equal(calls, 0);
});

test("proposal opens one draft PR and has no post-creation mutation path", async () => {
	const calls: unknown[] = [];
	const github: ImprovementGithub = {
		createDraftProposal: async (input) => {
			calls.push(input);
			return { number: 12, url: "https://example.invalid/pr/12", draft: true };
		},
	};
	const pattern = groupOutcomes(
		store(
			item("a", { outcome: "cancelled" }),
			item("b", { outcome: "cancelled" }),
		),
		metrics,
	)[0]!;
	const result = await proposeImprovement({
		enabled: true,
		target: {
			repo: "acme/repo",
			base: "main",
			kind: "skills",
			repeatThreshold: 2,
		},
		pattern,
		changes: [{ path: "skills/retry/SKILL.md", content: "bounded" }],
		github,
	});
	assert.deepEqual(result, {
		state: "opened",
		number: 12,
		url: "https://example.invalid/pr/12",
	});
	assert.equal(calls.length, 1);
	assert.match(JSON.stringify(calls[0]), /"draft"/);
});
