import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import type { Containment } from "../../src/platform/containment.ts";
import { pauseFile } from "../../src/steward/killswitch.ts";
import { ProcessManager } from "../../src/steward/procs.ts";
import { isolate } from "../support/harness.ts";

for (const boundary of [
	"before:intent",
	"after:intent",
	"after:spawn",
	"after:registered",
	"after:releasing",
	"before:token-write",
])
	test(`pause during ${boundary} cannot release an untracked target`, async () => {
		isolate();
		let executed = false;
		const backend: Containment = {
			confirmed: true,
			spawn: () => ({
				identity: Promise.resolve({ pid: 123, pgid: 123, startTime: "one" }),
				release: new Writable({
					write(_chunk, _encoding, callback) {
						executed = true;
						callback();
					},
				}),
				output: new PassThrough(),
				done: Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
			}),
			kill: async () => true,
			empty: async () => true,
		};
		let manager: ProcessManager;
		manager = new ProcessManager("race", backend, async (point) => {
			if (point !== boundary) return;
			pauseFile("race");
			await manager.terminate();
		});
		await assert.rejects(
			manager.launch(["/usr/bin/true"], { PATH: process.env.PATH }),
			/cancelled|disabled/,
		);
		assert.equal(executed, false);
		assert.equal(manager.snapshot().invocations.length, 0);
		await assert.rejects(
			manager.launch(["/usr/bin/true"], { PATH: process.env.PATH }),
			/disabled/,
		);
	});
