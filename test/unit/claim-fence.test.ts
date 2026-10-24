import assert from "node:assert/strict";
import test from "node:test";
import { claimMarker } from "../../src/steward/claims.ts";
import { Github } from "../../src/steward/github.ts";
import { migrateEligible } from "../../src/steward/workItems.ts";
import {
	emptyWorkState,
	WorkRuntime,
	type WorkState,
} from "../../src/steward/workRuntime.ts";
import { isolate } from "../support/harness.ts";
import { candidate, workDependencies } from "../support/work.ts";

test("takeover fences a suspended holder at every supported external write, before any subprocess", async () => {
	const home = isolate();
	const deps = workDependencies(home);
	const state = emptyWorkState();
	const entry = {
		...candidate(),
		state: "eligible" as const,
		reasons: [],
		firstSeen: 0,
		lastSeen: 0,
	};
	migrateEligible({ items: { [entry.ref]: entry } }, state.work, 0);
	const item = Object.values(state.work.items)[0];
	const lease = new Date(Date.now() + 7200000).toISOString();
	item.claim = { agent: "agent", lease, commentId: 1 };
	deps.github.comments = [
		{
			id: 1,
			body: claimMarker("agent", lease, "old"),
			login: "operator-login",
		},
	];
	new WorkRuntime(
		{
			...deps,
			agent: "agent",
			login: "operator-login",
			claimOwner: "old",
			definition: { profile: "fixture" },
			machine: { name: "fixture", agents: ["agent"] },
			env: {},
			checkoutFor: () => "repo",
			scout: async () => "",
			notify: async () => {},
			check: async () => {},
		},
		{ load: async () => structuredClone(state), save: async () => {} },
	);
	// Same agent on another machine wins after the old lease expires.
	deps.github.comments = [
		{
			id: 2,
			body: claimMarker("agent", lease, "new"),
			login: "operator-login",
		},
	];
	const github = new Github({
		agent: "agent",
		login: "operator-login",
		env: process.env,
		processes: deps.processes,
		itemForIssue: () => item.id,
	});
	for (const write of [
		() =>
			deps.processes.launch(["git", "push", "origin", "HEAD"], process.env, {
				item: item.id,
			}),
		() => github.createComment(item.repo, 1, "late comment"),
		() => github.runGh(["pr", "create", "--draft"], item.id),
		() => github.runGh(["issue", "edit", "1", "--add-label", "late"], item.id),
		() => github.readyPr(item.repo, 1, item.id),
	])
		await assert.rejects(write, /claim lease lost/);
	// A new token with the same owner is not permission for the old attempt either.
	deps.github.comments[0].body = claimMarker("agent", lease, "old");
	await assert.rejects(
		() =>
			deps.processes.launch(["git", "push"], process.env, { item: item.id }),
		/claim lease lost/,
	);
});

test("same-agent takeover gets a new branch and immutable worker claim token", async () => {
	const home = isolate();
	const first = workDependencies(home);
	const entry = {
		...candidate(),
		state: "eligible" as const,
		reasons: [],
		firstSeen: 0,
		lastSeen: 0,
	};
	const branches: string[] = [];
	for (const [index, owner] of ["first", "takeover"].entries()) {
		const deps = index === 0 ? first : workDependencies(home, first.github);
		let state = emptyWorkState();
		migrateEligible({ items: { [entry.ref]: entry } }, state.work, 0);
		const id = Object.keys(state.work.items)[0];
		const runtime = new WorkRuntime(
			{
				...deps,
				agent: "agent",
				login: "operator-login",
				claimOwner: owner,
				definition: {
					profile: "fixture",
					models: { worker: { provider: "faux", model: "one" } },
					schedule: { leaseSeconds: 1, leaseGraceSeconds: 0 },
				},
				machine: { name: "fixture", agents: ["agent"] },
				now: () => index * 1100,
				env: {},
				checkoutFor: () => "repo",
				scout: async () => "brief",
				notify: async () => {},
				check: async () => {},
			},
			{
				load: async () => structuredClone(state),
				save: async (next: WorkState) => {
					state = structuredClone(next);
				},
			},
		);
		await runtime.tickItem(id, false, false);
		assert.equal(deps.dispatcher.launches.length, 1);
		const launch = deps.dispatcher.launches[0];
		branches.push(launch.workspace.branch);
		const token = JSON.parse(launch.env.DURABLE_CLAIM!);
		assert.equal(token.commentId, state.work.items[id].claim?.commentId);
		assert.equal(token.target.owner, owner);
		assert.ok(launch.workspace.branch.endsWith(`-claim-${token.commentId}`));
	}
	assert.notEqual(branches[0], branches[1]);
});
