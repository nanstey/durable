import assert from "node:assert/strict";
import test from "node:test";
import {
	defaultPipeline,
	pipelineDoctorErrors,
	selectPipeline,
} from "../../src/pipeline/select.ts";
import {
	type ClaimComment,
	type ClaimGithub,
	claim,
} from "../../src/steward/claims.ts";
import {
	emptyWorkItems,
	migrateEligible,
	reconcilePrs,
} from "../../src/steward/workItems.ts";

class FakeGithub implements ClaimGithub {
	comments: ClaimComment[] = [];
	labels = new Set<string>();
	async addLabel(_repo: string, _issue: number, label: string) {
		this.labels.add(label);
	}
	async removeLabel(_repo: string, _issue: number, label: string) {
		this.labels.delete(label);
	}
	async createComment(_repo: string, _issue: number, body: string) {
		const comment = { id: this.comments.length + 1, body };
		this.comments.push(comment);
		return comment;
	}
	async listComments() {
		return [...this.comments];
	}
	async deleteComment(_repo: string, id: number) {
		this.comments = this.comments.filter((comment) => comment.id !== id);
	}
}
test("claim uses read-after-write and the lowest marker wins", async () => {
	const github = new FakeGithub();
	const first = await claim(github, {
		repo: "acme/repo",
		issue: 1,
		agent: "a",
		lease: "2999-01-01T00:00:00.000Z",
	});
	const second = await claim(github, {
		repo: "acme/repo",
		issue: 1,
		agent: "b",
		lease: "2999-01-01T00:00:00.000Z",
	});
	assert.equal(first.state, "won");
	assert.deepEqual(second, { state: "lost", commentId: 2, winner: "a" });
});
test("concurrent claimants elect the lowest comment, retain its label and replay without another comment", async () => {
	const github = new FakeGithub();
	const target = {
		repo: "acme/repo",
		issue: 1,
		lease: "2999-01-01T00:00:00.000Z",
	};
	const results = await Promise.all([
		claim(github, { ...target, agent: "a" }),
		claim(github, { ...target, agent: "b" }),
	]);
	assert.deepEqual(
		results.map((result) => result.state),
		["won", "lost"],
	);
	assert.equal(github.comments.length, 1);
	assert.ok(github.labels.has("durable/claimed"));
	await claim(github, { ...target, agent: "a" });
	assert.equal(github.comments.length, 1);
});
test("two installations of the same agent cannot reuse each other's claim", async () => {
	const github = new FakeGithub();
	const target = {
		repo: "acme/repo",
		issue: 1,
		agent: "agent",
		lease: "2999-01-01T00:00:00.000Z",
	};
	assert.equal(
		(await claim(github, { ...target, owner: "installation-a" })).state,
		"won",
	);
	assert.equal(
		(await claim(github, { ...target, owner: "installation-b" })).state,
		"lost",
	);
	assert.equal(
		(await claim(github, { ...target, owner: "installation-a" })).state,
		"won",
	);
	assert.equal(github.comments.length, 1);
});
test("expired claims cannot win arbitration", async () => {
	const github = new FakeGithub();
	github.comments.push({
		id: 1,
		body: "<!-- durable-claim agent=old lease=2000-01-01T00:00:00.000Z -->",
	});
	assert.equal(
		(
			await claim(github, {
				repo: "acme/repo",
				issue: 1,
				agent: "new",
				lease: "2999-01-01T00:00:00.000Z",
			})
		).state,
		"won",
	);
});
test("pipeline defaults and rejects missing mandatory stages", () => {
	assert.deepEqual(selectPipeline(), defaultPipeline);
	assert.throws(() =>
		selectPipeline({ stages: ["scout", "build", "handoff"] }),
	);
	assert.deepEqual(
		pipelineDoctorErrors(
			selectPipeline({
				stages: ["spec", "build", "review", "gate", "handoff"],
				gates: { specApproval: true },
			}),
		),
		[
			"pipeline spec stage is not supported until slice 7",
			"pipeline specApproval gate is not supported until slice 7",
		],
	);
});
test("eligible queue entry migrates once and only primary PR completion finishes it", () => {
	const queue = {
		items: {
			one: {
				ref: "one",
				kind: "issue" as const,
				repo: "acme/repo",
				title: "x",
				author: "a",
				labels: [],
				updatedAt: "",
				state: "eligible" as const,
				reasons: [],
				firstSeen: 1,
				lastSeen: 1,
			},
		},
	};
	const workItems = migrateEligible(queue, emptyWorkItems(), 1);
	migrateEligible(queue, workItems, 2);
	assert.equal(Object.keys(workItems.items).length, 1);
	const item = Object.values(workItems.items)[0];
	item.prs.push(
		{ number: 1, primary: true, state: "open" },
		{ number: 2, primary: false, state: "open" },
	);
	reconcilePrs(item, [{ number: 2, state: "merged" }], 3);
	assert.equal(item.outcome, undefined);
	reconcilePrs(item, [{ number: 1, state: "merged" }], 4);
	assert.equal(item.outcome, "merged");
});
