import assert from "node:assert/strict";
import test from "node:test";
import { specEligible } from "../../src/pipeline/spec.ts";
import {
	defaultPipeline,
	pipelineDoctorErrors,
	selectPipeline,
} from "../../src/pipeline/select.ts";
import {
	type ClaimComment,
	type ClaimGithub,
	claim,
	readClaim,
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
		const comment = {
			id: this.comments.length + 1,
			body,
			login: "durable-bot",
		};
		this.comments.push(comment);
		return comment;
	}
	async listComments() {
		return [...this.comments];
	}
	async deleteComment(_repo: string, id: number) {
		this.comments = this.comments.filter((comment) => comment.id !== id);
	}
	async updateComment(_repo: string, id: number, body: string) {
		const comment = this.comments.find((entry) => entry.id === id);
		if (comment) comment.body = body;
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
test("foreign claim markers cannot block, update, or be deleted", async () => {
	const github = new FakeGithub();
	github.comments.push({
		id: 1,
		body: "<!-- durable-claim agent=agent lease=2999-01-01T00:00:00.000Z -->",
		login: "untrusted",
	});
	const result = await claim(github, {
		repo: "acme/repo",
		issue: 1,
		agent: "agent",
		login: "durable-bot",
		lease: "2999-01-01T00:00:00.000Z",
	});
	assert.equal(result.state, "won");
	assert.equal(github.comments[0].id, 1);
	assert.ok(github.labels.has("durable/claimed"));
});
test("expiry takeover waits through grace and the returning holder loses on a world re-read", async () => {
	const github = new FakeGithub();
	const policy = { durationMs: 1000, graceMs: 100 };
	const target = { repo: "acme/repo", issue: 1 };
	const holder = {
		...target,
		agent: "linux-a",
		lease: new Date(1000).toISOString(),
	};
	assert.equal((await claim(github, holder, 0, policy)).state, "won");
	assert.equal(
		(
			await claim(
				github,
				{ ...target, agent: "linux-b", lease: new Date(2200).toISOString() },
				1099,
				policy,
			)
		).state,
		"lost",
	);
	assert.equal(
		(
			await claim(
				github,
				{ ...target, agent: "linux-b", lease: new Date(2200).toISOString() },
				1100,
				policy,
			)
		).state,
		"won",
	);
	assert.deepEqual(await readClaim(github, holder, 1100, policy), {
		state: "lost",
		commentId: 2,
		winner: "linux-b",
	});
});
test("a losing claimant retries a transient comment delete", async () => {
	const github = new FakeGithub();
	let deletes = 0;
	const deleteComment = github.deleteComment.bind(github);
	github.deleteComment = async (...args) => {
		deletes++;
		if (deletes === 1) throw Error("transient");
		return deleteComment(...args);
	};
	await claim(github, {
		repo: "acme/repo",
		issue: 1,
		agent: "winner",
		lease: "2999-01-01T00:00:00.000Z",
	});
	const result = await claim(github, {
		repo: "acme/repo",
		issue: 1,
		agent: "loser",
		lease: "2999-01-01T00:00:00.000Z",
	});
	assert.equal(result.state, "lost");
	assert.equal(deletes, 2);
	assert.equal(github.comments.length, 1);
});
test("a foreign marker cannot extend its lease beyond GitHub's updated timestamp", async () => {
	const github = new FakeGithub();
	github.comments.push({
		id: 1,
		body: "<!-- durable-claim agent=other lease=2999-01-01T00:00:00.000Z -->",
		login: "durable-bot",
		updatedAt: new Date(0).toISOString(),
	});
	assert.deepEqual(
		await readClaim(
			github,
			{
				repo: "acme/repo",
				issue: 1,
				agent: "agent",
				lease: new Date(0).toISOString(),
				login: "durable-bot",
			},
			1101,
			{ durationMs: 1000, graceMs: 100 },
		),
		{ state: "lost" },
	);
});
test("a killed worker is replaced once, on a fresh takeover attempt, for both worker kinds", async () => {
	const policy = { durationMs: 1000, graceMs: 100 };
	const target = { repo: "acme/repo", issue: 1 };
	for (const kind of ["pi-session", "durable-conversation"] as const) {
		const github = new FakeGithub();
		const launches: Array<{ agent: string; branch: string }> = [];
		const holder = {
			...target,
			agent: `${kind}-a`,
			lease: new Date(1000).toISOString(),
		};
		assert.equal((await claim(github, holder, 0, policy)).state, "won");
		launches.push({
			agent: holder.agent,
			branch: `durable/${holder.agent}/item`,
		});
		// SIGKILL/long sleep performs no release; only the fake clock advances.
		const takeover = {
			...target,
			agent: `${kind}-b`,
			lease: new Date(2200).toISOString(),
		};
		assert.equal((await claim(github, takeover, 1099, policy)).state, "lost");
		assert.equal((await claim(github, takeover, 1100, policy)).state, "won");
		launches.push({
			agent: takeover.agent,
			branch: `durable/${takeover.agent}/item`,
		});
		assert.equal((await readClaim(github, holder, 1100, policy)).state, "lost");
		assert.deepEqual(launches, [
			{ agent: holder.agent, branch: `durable/${holder.agent}/item` },
			{ agent: takeover.agent, branch: `durable/${takeover.agent}/item` },
		]);
	}
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
		[],
	);
});
test("spec threshold is inclusive and missing size is not eligible", () => {
	const candidate = {
		ref: "acme/repo#1",
		repo: "acme/repo",
		kind: "issue" as const,
		title: "x",
		author: "a",
		labels: [],
		updatedAt: new Date().toISOString(),
	};
	assert.equal(specEligible({ ...candidate, size: "small" }, "medium"), false);
	assert.equal(specEligible({ ...candidate, size: "medium" }, "medium"), true);
	assert.equal(specEligible({ ...candidate, size: "large" }, "medium"), true);
	assert.equal(specEligible(candidate, "medium"), undefined);
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
