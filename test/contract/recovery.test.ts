import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { execa } from "execa";
import { authenticate } from "../../src/api/tokens.ts";
import { eventually, isolate } from "../support/harness.ts";
import { liveContainment } from "../support/live.ts";

test("SIGKILL interrupted owned-child tool recovers once and startup removes old children", {
	timeout: 20000,
	skip: !liveContainment,
}, async () => {
	const home = isolate();
	const child = execa(
		process.execPath,
		["test/fixtures/recovery-agent.ts", "start"],
		{ env: { DURABLE_HOME: home }, reject: false },
	);
	try {
		await eventually(() => existsSync(join(home, "started")), 10000);
		const journal = JSON.parse(
			readFileSync(join(home, "agents/recover/procs.json"), "utf8"),
		);
		assert.equal(journal.invocations.length, 1);
		const pid = journal.invocations[0].pid;
		const token = readFileSync(
			join(home, "agents/recover/token"),
			"utf8",
		).trim();
		child.kill("SIGKILL");
		assert.equal((await child).signal, "SIGKILL");
		const resumed = await execa(
			process.execPath,
			["test/fixtures/recovery-agent.ts", "resume"],
			{ env: { DURABLE_HOME: home }, reject: false, timeout: 10000 },
		);
		assert.equal(resumed.exitCode, 0, resumed.stderr);
		const result = JSON.parse(
			readFileSync(join(home, "recovered.json"), "utf8"),
		);
		assert.equal(result.child, readFileSync(join(home, "child"), "utf8"));
		assert.ok(result.interrupted);
		assert.equal(result.loopTasks, 1);
		assert.ok(result.heartbeat > 0);
		assert.equal(result.inbox, 1);
		assert.equal(result.procs, 0);
		assert.ok(authenticate("recover", token));
		assert.equal(existsSync(`/proc/${pid}`), false);
		assert.equal(result.tree.length, 2);
		assert.equal(result.tree[1].parentId, result.tree[0].id);
	} finally {
		child.kill("SIGKILL");
	}
});
