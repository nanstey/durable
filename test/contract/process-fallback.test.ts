import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ProcessContainment } from "../../src/platform/processContainment.ts";
import { ProcessManager } from "../../src/steward/procs.ts";
import { eventually, isolate } from "../support/harness.ts";

test("process-group fallback kills marked descendants but cannot confirm an unmarked setsid escape", {
	timeout: 10000,
}, async () => {
	const home = isolate(),
		started = join(home, "started"),
		escaped = join(home, "escaped");
	const backend = new ProcessContainment();
	const manager = new ProcessManager("fallback", backend);
	const task = manager.launch(
		[
			"/bin/sh",
			"-c",
			'env -u DURABLE_INVOCATION setsid sh -c \'sleep 0.3; echo x > "$1"\' escape "$1" >/dev/null 2>&1 & sleep 300 & echo ready > "$2"; wait',
			"parent",
			escaped,
			started,
		],
		{ PATH: process.env.PATH },
		{ item: "item" },
	);
	await eventually(() => existsSync(started));
	assert.equal(await manager.terminate({ item: "item" }), false);
	await task;
	assert.ok(await backend.empty(manager.snapshot().invocations[0]));
	assert.ok(manager.fenced("item"));
	assert.equal(manager.snapshot().invocations.length, 1);
	await eventually(() => existsSync(escaped));
});
