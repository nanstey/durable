import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { confinedPath } from "../../src/workers/durable/confine.ts";
import {
	type OperationIntent,
	reconcilePush,
} from "../../src/workers/durable/gitops.ts";
import { durableLimitStop } from "../../src/workers/durable/limits.ts";
import { DurableFileTools } from "../../src/workers/durable/tools.ts";

const root = () => mkdtempSync(join(tmpdir(), "durable-worker-"));
test("file tools refuse traversal, .git, and symlink escapes", async () => {
	const worktree = root();
	mkdirSync(join(worktree, ".git"));
	writeFileSync(join(worktree, "file.txt"), "before");
	symlinkSync(tmpdir(), join(worktree, "outside"));
	const tools = new DurableFileTools(worktree);
	assert.equal(await tools.read("file.txt"), "before");
	await assert.rejects(() => confinedPath(worktree, "../outside"));
	await assert.rejects(() => confinedPath(worktree, ".git/config"));
	await assert.rejects(() => tools.read("outside"));
	rmSync(worktree, { recursive: true, force: true });
});
test("durable limits give kill switch and holds precedence", () => {
	const base = { startedAt: 0, now: 0, turns: 0, toolCalls: 0, tokens: 0 };
	assert.equal(
		durableLimitStop({ ...base, disabled: true, held: true }),
		"paused",
	);
	assert.equal(
		durableLimitStop({ ...base, disabled: false, held: true }),
		"held",
	);
	assert.equal(
		durableLimitStop({
			...base,
			disabled: false,
			held: false,
			maxToolCalls: 0,
		}),
		"limit",
	);
});
test("ambiguous push reconciliation confirms only the exact commit", async () => {
	const records = new Map();
	const store = {
		read: async (attemptId: string, op: string) =>
			records.get(`${attemptId}/${op}`),
		write: async (record: { attemptId: string; op: string }) => {
			records.set(`${record.attemptId}/${record.op}`, record);
		},
	};
	const intent: OperationIntent = {
		attemptId: "a",
		op: "push_branch",
		repo: "acme/repo",
		branch: "durable/a/item",
		commitSha: "sha",
		base: "main",
		expectedRemoteHead: "old",
		state: "intent",
	};
	await store.write(intent);
	assert.equal(
		await reconcilePush(store, intent, async () => "sha"),
		"confirmed",
	);
});
