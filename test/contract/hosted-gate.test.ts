import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { GitProcessDispatcher } from "../../src/dispatch/gitProcess.ts";
import { ProcessContainment } from "../../src/platform/processContainment.ts";
import { SystemdContainment } from "../../src/platform/systemdContainment.ts";
import { ProcessManager } from "../../src/steward/procs.ts";
import { eventually, isolate } from "../support/harness.ts";
import { liveContainment } from "../support/live.ts";

for (const boundary of ["registered", "releasing", "running"])
	test(`terminal-hosted invocation is gated through persisted ${boundary} and cleans up on a failed release`, async () => {
		const home = isolate();
		const workspace = {
			id: "durable-agent-item",
			path: join(home, "workspace"),
			branch: "durable/agent/item",
		};
		mkdirSync(workspace.path);
		const wrote = join(workspace.path, "effect");
		const launcher = join(home, "launcher");
		writeFileSync(
			launcher,
			`#!/bin/sh\nprintf started > '${wrote}'\nsleep 30\n`,
			{ mode: 0o700 },
		);
		const dispatcher = new GitProcessDispatcher(join(home, "workspaces"));
		const manager = new ProcessManager(
			"agent",
			new ProcessContainment(),
			(point) => {
				if (point === `before:${boundary}`) {
					if (boundary !== "running") {
						assert.equal(existsSync(wrote), false);
						throw Error("injected crash boundary");
					}
				}
			},
		);
		const launch = manager.host(
			launcher,
			{ PATH: process.env.PATH },
			{ item: "item", attemptId: "attempt" },
			(argv, env) =>
				dispatcher.hostProcess({
					id: "job",
					workspace,
					command: argv[0],
					args: argv.slice(1),
					env,
					headless: true,
				}),
		);
		try {
			if (boundary !== "running") {
				await assert.rejects(launch, /injected crash boundary/);
				assert.equal(existsSync(wrote), false);
				assert.equal(
					manager.snapshot().invocations.length,
					1,
					"unconfirmed cleanup retains its record",
				);
			} else {
				await launch;
				await eventually(() => existsSync(wrote));
				assert.equal(manager.snapshot().invocations[0].state, "running");
				assert.equal(readFileSync(wrote, "utf8"), "started");
			}
		} finally {
			await manager.terminate();
		}
	});

test("Linux hosted Pi containment kills background, nohup and setsid delayed writers before held", {
	skip: !liveContainment,
	timeout: 30000,
}, async () => {
	const home = isolate();
	const workspace = {
		id: "durable-agent-item",
		path: join(home, "workspace"),
		branch: "durable/agent/item",
	};
	mkdirSync(workspace.path);
	const launcher = join(home, "launcher");
	writeFileSync(
		launcher,
		`#!/bin/sh\ncd '${workspace.path}'\n(sleep 10; echo group >> group) &\nnohup sh -c 'sleep 10; echo nohup >> nohup-write' >/dev/null 2>&1 &\nsetsid sh -c 'sleep 10; echo escaped >> escaped' &\necho ready > ready\nwait\n`,
		{ mode: 0o700 },
	);
	const dispatcher = new GitProcessDispatcher(join(home, "workspaces"));
	const manager = new ProcessManager("agent", new SystemdContainment());
	try {
		await manager.host(
			launcher,
			{ PATH: process.env.PATH },
			{ item: "item", attemptId: "attempt" },
			(argv, env) =>
				dispatcher.hostProcess({
					id: "job",
					workspace,
					command: argv[0],
					args: argv.slice(1),
					env,
					headless: true,
				}),
		);
		await eventually(() => existsSync(join(workspace.path, "ready")));
		manager.beginHold("item", "operator", "test");
		assert.equal((await manager.finishHold("item")).state, "held");
		await new Promise((resolve) => setTimeout(resolve, 15000));
		for (const file of ["group", "nohup-write", "escaped"])
			assert.equal(existsSync(join(workspace.path, file)), false);
	} finally {
		await manager.terminate();
	}
});
