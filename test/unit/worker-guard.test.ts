import assert from "node:assert/strict";
import test from "node:test";
import { blockedWorkerCommand } from "../../src/guard/commands.ts";
import { shouldBlockDurableWorkerCommand } from "../../pi-extension/durable-worker-guard.ts";

for (const command of [
	"gh pr merge 1",
	"gh api repos/a/b/pulls/1/merge",
	"gh pr merge 1 --admin",
	"git push --force origin branch",
	"git push origin main",
])
	test(`worker guard blocks ${command}`, () => {
		assert.equal(blockedWorkerCommand(command), true);
		assert.equal(
			shouldBlockDurableWorkerCommand(command, { DURABLE_WORKER: "1" }),
			true,
		);
	});
test("worker guard is inactive outside durable workers", () =>
	assert.equal(shouldBlockDurableWorkerCommand("gh pr merge 1", {}), false));
