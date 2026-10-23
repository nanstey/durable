import assert from "node:assert/strict";
import test from "node:test";
import { FakeDispatcher } from "../../src/dispatch/fake.ts";
import { launcherScript } from "../../src/dispatch/launcher.ts";
import { PiSessionKind } from "../../src/workers/piSession.ts";
import { WorkerRegistry } from "../../src/workers/registry.ts";

const workspace = {
	id: "item-1",
	path: "fixture/item-1",
	branch: "durable/a/item-1",
};
test("fake dispatcher is idempotent and exposes interactive capabilities", async () => {
	const dispatcher = new FakeDispatcher();
	assert.deepEqual(
		await dispatcher.createWorkspace({ ...workspace, repo: "fixture/repo" }),
		workspace,
	);
	assert.equal(
		(
			await dispatcher.hostProcess({
				id: "job",
				workspace,
				command: "pi",
				env: { PATH: "/bin" },
			})
		).handle,
		"fake:job",
	);
	assert.equal(
		await dispatcher.processStatus({
			id: "job",
			handle: "fake:job",
			workspace,
		}),
		"running",
	);
	const process = { id: "job", handle: "fake:job", workspace };
	await dispatcher.sendInput(process, "hello");
	assert.equal(await dispatcher.readOutput(process), "hello");
	assert.deepEqual(await dispatcher.workspaceTerminals(workspace), []);
	await dispatcher.interruptProcess(process, "soft");
	assert.equal(
		await dispatcher.processStatus({
			id: "job",
			handle: "fake:job",
			workspace,
		}),
		"exited",
	);
});
test("launcher separates provider and model and clears stdin for headless jobs", () => {
	const script = launcherScript({
		path: "fixture",
		briefPath: "fixture/brief",
		env: { PATH: "/bin", HOSTILE: undefined },
		model: { provider: "anthropic", model: "model" },
		headless: true,
		resume: true,
	});
	assert.match(script, /--continue --provider 'anthropic' --model 'model'/);
	assert.match(script, /< \/dev\/null/);
	assert.doesNotMatch(script, /HOSTILE/);
});
test("pi-session reports unsupported steering through git-process capability", () => {
	const kind = new PiSessionKind(new FakeDispatcher(), "fixture");
	assert.equal(kind.capabilities().steer, true);
	assert.equal(kind.capabilities().skills, "full");
	assert.equal(kind.capabilities().resumeAfterCrash, false);
	assert.equal(typeof kind.steer, "function");
	const registry = new WorkerRegistry();
	registry.register(kind, {
		id: "worker",
		job: {
			id: "worker",
			agent: "agent",
			item: "item",
			role: "worker",
			briefText: "brief",
			workspace,
			model: { provider: "faux", model: "model" },
			limits: {},
			env: {},
		},
		process: { id: "worker", handle: "fake:worker", workspace },
		startedAt: 0,
	});
});
