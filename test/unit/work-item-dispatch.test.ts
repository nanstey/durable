import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { holdItem, isHeld } from "../../src/dispatch/hold.ts";
import { monitorWorker } from "../../src/dispatch/monitor.ts";
import { FakeDispatcher } from "../../src/dispatch/fake.ts";
import { WorkerKindRegistry } from "../../src/workers/kind.ts";
import { PiSessionKind } from "../../src/workers/piSession.ts";
import { WorkerRegistry } from "../../src/workers/registry.ts";
import { advanceWorkItem } from "../../src/steward/workItemTask.ts";
import type { WorkItem } from "../../src/steward/workItems.ts";

const item = (): WorkItem => ({
	id: "item",
	intakeRef: "1",
	repo: "acme/repo",
	candidate: {
		ref: "1",
		kind: "issue" as const,
		repo: "acme/repo",
		title: "x",
		author: "a",
		labels: [],
		updatedAt: "",
	},
	attempts: [],
	prs: [],
	createdAt: 0,
	updatedAt: 0,
});
test("hold fences before waiting and stays holding without containment", async () => {
	const holds = {};
	const events: string[] = [];
	const held = await holdItem({
		holds,
		item: "i",
		by: "human",
		via: "cli",
		drainMs: 0,
		interrupt: async (mode) => {
			events.push(mode);
		},
		waitForEmpty: async () => false,
	});
	assert.equal(held.state, "holding");
	assert.ok(isHeld(holds, "i"));
	assert.deepEqual(events, ["soft", "hard"]);
});
test("monitor only resumes unintentional exit without a draft PR", async () => {
	let resumed = 0;
	const kind = {
		status: async () => "exited" as const,
		resume: async (value: unknown) => {
			resumed++;
			return value;
		},
	} as never;
	const work = item();
	work.attempts.push({ id: "a", startedAt: 0 });
	assert.equal(
		await monitorWorker({
			item: work,
			branch: "b",
			marker: "m",
			kind,
			handle: {} as never,
			maxAttempts: 2,
			github: {
				findDraftPr: async () => undefined,
				commentOnce: async () => {},
			},
		}),
		"resumed",
	);
	assert.equal(resumed, 1);
});
test("work-item task creates workspace before starting selected Pi worker", async () => {
	const skillsRoot = mkdtempSync(join(tmpdir(), "durable-skills-"));
	for (const skill of ["idea-to-pr", "pr", "build"]) {
		const path = join(skillsRoot, "skills", skill);
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "SKILL.md"), "# fixture\n");
	}
	const dispatcher = new FakeDispatcher();
	const registry = new WorkerKindRegistry();
	registry.register(new PiSessionKind(dispatcher, "/tmp/durable-launchers"));
	const workers = new WorkerRegistry();
	const work = item();
	const next = await advanceWorkItem(
		{ phase: "dispatch", itemId: work.id },
		work,
		{
			agent: "agent",
			lease: "lease",
			github: {
				addLabel: async () => {},
				removeLabel: async () => {},
				createComment: async () => ({ id: 1, body: "" }),
				listComments: async () => [],
			},
			brief: async () => "brief",
			dispatcher,
			workers,
			kinds: registry,
			definition: {
				profile: "profile",
				models: { worker: { provider: "faux", model: "model" } },
			},
			machine: { name: "machine", agents: ["agent"] },
			model: { provider: "faux", model: "model" },
			env: {},
			skillsRoot,
		},
	);
	assert.equal(next.phase, "await-pr");
	assert.equal((await dispatcher.listWorkspaces()).length, 1);
	rmSync(skillsRoot, { recursive: true, force: true });
});
