import assert from "node:assert/strict";
import test from "node:test";
import { eventually, fixture, isolate } from "../support/harness.ts";

const item = {
	ref: "org/repo#1",
	kind: "issue" as const,
	repo: "org/repo",
	title: "safe item",
	author: "member",
	authorAssociation: "MEMBER",
	labels: ["ready"],
	updatedAt: "2026-01-01T00:00:00Z",
	bodyRef: "github:org/repo#1",
};
test("scout persists an eligible queue item without storing a body", async () => {
	isolate();
	const now = 1000;
	const timers = new Set<() => void>();
	const { harness } = await fixture({
		now: () => now,
		definition: {
			profile: "fixture",
			schedule: { pollSeconds: 1 },
			sources: [
				{ kind: "github-issues", repo: "org/repo", requiredLabels: ["ready"] },
			],
			models: { steward: { provider: "faux", model: "one" } },
		},
		pollCandidates: async () => [item],
		setTimer(callback) {
			timers.add(callback);
			return () => timers.delete(callback);
		},
	});
	try {
		harness.start();
		await eventually(async () => (await harness.queue()).length === 1);
		const [queued] = await harness.queue();
		assert.equal(queued.state, "eligible");
		assert.equal("body" in queued, false);
		assert.deepEqual(queued.reasons, []);
	} finally {
		await harness.close();
	}
});
