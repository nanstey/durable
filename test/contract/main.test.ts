import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { readAudit } from "../../src/steward/audit.ts";
import { identityProbe, run } from "../../src/steward/main.ts";
import { fauxModels, isolate } from "../support/harness.ts";

async function config() {
	const home = isolate();
	const definitions = join(home, "definitions");
	mkdirSync(definitions);
	const socket = createServer();
	await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
	const address = socket.address();
	assert.ok(address && typeof address !== "string");
	const port = address.port;
	await new Promise<void>((resolve) => socket.close(() => resolve()));
	const machine = join(home, "machine.yaml");
	writeFileSync(
		machine,
		`name: fixture\nagents:\n  - id: agent\n    port: ${port}\n`,
	);
	writeFileSync(
		join(definitions, "agent.yaml"),
		"profile: fixture\nmodels:\n  steward:\n    provider: faux\n    model: one\n",
	);
	process.env.DURABLE_AGENTS_DIR = definitions;
	process.env.DURABLE_MACHINE_FILE = machine;
	return { port, home };
}
test("identity probe deadline terminates exactly its contained invocation", async () => {
	let task: string | undefined;
	let terminated: string | undefined;
	await assert.rejects(
		identityProbe(
			{
				launch: async (_argv, _env, options) => {
					task = options?.task;
					return new Promise(() => {});
				},
				terminate: async (filter) => {
					terminated = filter?.task;
					return true;
				},
			},
			["gh", "api", "user"],
			{},
			5,
		),
		/identity probe timed out/,
	);
	assert.ok(task);
	assert.equal(terminated, task);
	let cleanup = false;
	assert.equal(
		(
			await identityProbe(
				{
					launch: async () => ({ exitCode: 0, stdout: "okay", stderr: "" }),
					terminate: async () => {
						cleanup = true;
						return true;
					},
				},
				["gh"],
				{},
				5,
			)
		).stdout,
		"okay",
	);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(cleanup, false);
});
test("process entry refuses unhealthy identity, audits fix text and queues an inbox event", async () => {
	await config();
	const { models } = fauxModels();
	await assert.rejects(
		run("agent", {
			models,
			preflight: async () => ({
				ok: false,
				checks: [
					{
						name: "profile",
						ok: false,
						detail: "missing",
						fix: "initialize the named profile",
					},
				],
			}),
		}),
		/Fix: initialize the named profile/,
	);
	assert.ok(
		readAudit("agent").some(
			(event) =>
				event.event === "identity-failure" &&
				event.fix === "initialize the named profile",
		),
	);
});
test("full process entry rejects a second instance and closes gracefully without cancelling the loop", async () => {
	const { port } = await config();
	const { models } = fauxModels();
	const dependencies = {
		models,
		preflight: async () => ({ ok: true, checks: [] }),
	};
	const first = await run("agent", dependencies);
	try {
		assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
		await assert.rejects(run("agent", dependencies), /already running/);
	} finally {
		await first.close();
	}
	const second = await run("agent", dependencies);
	try {
		assert.equal(
			(
				await second.harness.native.inspect(second.harness.context)
			).tasks.filter((task) => task.record.kind === "steward-loop").length,
			1,
		);
	} finally {
		await second.close();
	}
});
