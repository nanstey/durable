import assert from "node:assert/strict";
import test from "node:test";
import { defineTask } from "@earendil-works/pi-durable";
import { fixture, isolate } from "../support/harness.ts";

function inertTask(name: string) {
	return defineTask<null, { phase: "tick" }, null>({
		name,
		version: 1,
		initial: () => ({ phase: "tick" }),
		phases: {
			tick: async (_task, runtime, context) => {
				await runtime.commit(
					() => ({
						status: "sleeping",
						until: Date.now() + 60000,
						checkpoint: { phase: "tick" },
					}),
					context,
				);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "aborted" } }),
				context,
			);
		},
	});
}
test("loop idempotency scans beyond a page of terminal loop history", async () => {
	isolate();
	let { harness } = await fixture();
	const loop = inertTask("steward-loop");
	await harness.root.commit(async (tx) => {
		for (let n = 0; n < 110; n++)
			await tx.createTask(loop, null, {
				ownership: { kind: "conversation" },
				background: true,
			});
	}, harness.context);
	await harness.root.abort(harness.context, { background: true });
	await harness.close();
	({ harness } = await fixture());
	await harness.close();
	({ harness } = await fixture());
	try {
		assert.equal(
			(await harness.native.inspect(harness.context)).tasks.filter(
				(task) => task.record.kind === "steward-loop",
			).length,
			1,
		);
	} finally {
		await harness.close();
	}
});
test("ownership index and top-level enumeration both paginate beyond 200 conversations", async () => {
	isolate();
	const { harness } = await fixture();
	try {
		await harness.root.commit(async (tx) => {
			const owner = await tx.createTask(inertTask("test.many-children"), null, {
				ownership: { kind: "conversation" },
				background: true,
			});
			for (let n = 0; n < 210; n++)
				await tx.createConversation({
					ownership: { kind: "task", taskId: owner },
				});
		}, harness.context);
		const tree = await harness.tree();
		assert.equal(tree.length, 211);
		assert.ok(
			tree
				.slice(1)
				.every((node) => node.parentId === tree[0].id && node.ownerTaskId),
		);
	} finally {
		await harness.close();
	}
});
