import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import durableWorkerGuard, {
	shouldBlockDurableWorkerCommand,
} from "../../pi-extension/durable-worker-guard.ts";
import {
	blockedWorkerCommand,
	blockedWorkerCommandPatterns,
} from "../../src/guard/commands.ts";
import { createDerivedPiDir } from "../../src/identity/pidir.ts";

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

test("shared table and registered Pi tool_call handler cannot drift; holding and held block every tool", () => {
	const home = mkdtempSync(join(tmpdir(), "durable-guard-"));
	const previous = { ...process.env };
	try {
		Object.assign(process.env, {
			DURABLE_WORKER: "1",
			DURABLE_ITEM: "item",
			DURABLE_FENCE_FILE: join(home, "fences.json"),
		});
		writeFileSync(
			process.env.DURABLE_FENCE_FILE!,
			JSON.stringify({ holds: {} }),
		);
		let handler:
			| ((event: {
					toolName: string;
					input: Record<string, unknown>;
			  }) => unknown)
			| undefined;
		durableWorkerGuard({
			on: (name, callback) => {
				assert.equal(name, "tool_call");
				handler = callback;
			},
		});
		assert.equal(blockedWorkerCommandPatterns.length, 9);
		for (const command of [
			"gh pr merge 1",
			"gh repo edit --force",
			"git push origin durable/a/i",
			"git merge branch",
			"git rebase main",
			"git reset --hard HEAD",
			"git switch main",
			"git worktree add ../other",
			"cd /",
			"git status",
		]) {
			assert.equal(
				Boolean(handler!({ toolName: "bash", input: { command } })),
				blockedWorkerCommand(command),
			);
		}
		for (const state of ["holding", "held"]) {
			writeFileSync(
				process.env.DURABLE_FENCE_FILE!,
				JSON.stringify({ holds: { item: { state } } }),
			);
			for (const toolName of ["bash", "write", "edit", "read"])
				assert.ok(handler!({ toolName, input: {} }));
		}
	} finally {
		process.env = previous;
	}
});

test("generated Pi settings load the repository guard through the real offline extension loader", async () => {
	const home = mkdtempSync(join(tmpdir(), "durable-pi-load-"));
	const source = join(home, "source");
	mkdirSync(source);
	const target = join(home, "derived");
	createDerivedPiDir(target, source, {
		name: "fixture",
		authFile: "unused",
		secretsFile: "unused",
		manifestFile: "unused",
		isDefault: false,
	});
	const settings = JSON.parse(
		readFileSync(join(target, "settings.json"), "utf8"),
	);
	const previous = process.env.DURABLE_WORKER;
	try {
		process.env.DURABLE_WORKER = "1";
		const loaded = await discoverAndLoadExtensions(
			settings.extensions,
			home,
			target,
		);
		assert.deepEqual(loaded.errors, []);
		assert.ok(
			loaded.extensions.some((extension) =>
				extension.handlers.has("tool_call"),
			),
		);
	} finally {
		if (previous === undefined) delete process.env.DURABLE_WORKER;
		else process.env.DURABLE_WORKER = previous;
	}
});
