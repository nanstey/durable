import assert from "node:assert/strict";
import test from "node:test";
import { execa } from "execa";
import { readAudit } from "../../src/steward/audit.ts";
import { isolate } from "../support/harness.ts";

test("four OS processes concurrently append complete fsynced JSONL audit lines", async () => {
	const home = isolate();
	await Promise.all(
		["one", "two", "three", "four"].map((actor) =>
			execa(process.execPath, ["test/fixtures/audit-writer.ts", actor], {
				env: { DURABLE_HOME: home },
				timeout: 10000,
			}),
		),
	);
	const events = readAudit("concurrent");
	assert.equal(events.length, 120);
	assert.equal(new Set(events.map((event) => event.target)).size, 120);
	for (const event of events) {
		assert.equal(event.actor, "code");
		assert.equal(event.action, "append");
		assert.ok(Number(event.ts) > 0);
	}
});
