import assert from "node:assert/strict";
import test from "node:test";
import { migrateEligible } from "../../src/steward/workItems.ts";
import {
	emptyWorkState,
	WorkRuntime,
	type WorkState,
} from "../../src/steward/workRuntime.ts";
import { isolate } from "../support/harness.ts";
import { candidate, workDependencies } from "../support/work.ts";

for (const phase of ["brief", "dispatch", "await-pr"])
	test(`replay after ${phase} effect-before-commit reuses claim, workspace and deterministic job`, async () => {
		const home = isolate();
		const deps = workDependencies(home);
		let saved = emptyWorkState();
		let failed = false;
		const store = {
			load: async () => structuredClone(saved),
			save: async (state: WorkState) => {
				if (
					!failed &&
					Object.values(state.tasks).some((task) => task.phase === phase)
				) {
					failed = true;
					throw Error("simulated process loss before commit");
				}
				saved = structuredClone(state);
			},
		};
		const options = {
			...deps,
			agent: "agent",
			login: "operator-login",
			definition: {
				profile: "fixture",
				models: { worker: { provider: "faux", model: "one" } },
			},
			machine: { name: "fixture", agents: ["agent"] },
			env: {},
			checkoutFor: () => "fixture/repo",
			scout: async () => "Read-only brief",
			check: async () => {},
			notify: async () => {},
		};
		const entry = {
			...candidate(),
			state: "eligible" as const,
			reasons: [],
			firstSeen: Date.now(),
			lastSeen: Date.now(),
		};
		const queue = {
			items: {
				[entry.ref]: entry,
				skipped: {
					...entry,
					ref: "skipped",
					state: "skipped" as const,
					reasons: ["author:not-trusted"],
				},
			},
		};
		migrateEligible(queue, saved.work, Date.now());
		const id = Object.keys(saved.work.items)[0];
		await new WorkRuntime(options, store).tickItem(id, false, false);
		await new WorkRuntime(options, store).tickItem(id, false, false);
		assert.equal(failed, true);
		assert.equal(deps.github.comments.length, 1);
		assert.equal(Object.keys(saved.work.items).length, 1);
		assert.equal((await deps.dispatcher.listWorkspaces()).length, 1);
		assert.equal(
			new Set(deps.dispatcher.launches.map((launch) => launch.id)).size,
			1,
		);
		assert.equal(Object.values(saved.tasks)[0].phase, "await-pr");
	});
