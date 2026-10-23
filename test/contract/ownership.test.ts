import assert from "node:assert/strict";
import test from "node:test";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	defineExtension,
	defineTask,
	defineTool,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { pauseFile } from "../../src/steward/killswitch.ts";
import { treeDelta } from "../../src/tree/frames.ts";
import { eventually, fixture, isolate } from "../support/harness.ts";

async function slowChild() {
	isolate();
	let executing = false;
	const slow = defineTool({
		name: "slow",
		description: "faux wait",
		parameters: Type.Object({}),
		execute: async (_args, _api, ctx) => {
			executing = true;
			await new Promise<void>((_resolve, reject) =>
				ctx.abortSignal?.addEventListener(
					"abort",
					() => reject(Error("cancelled")),
					{ once: true },
				),
			);
			return { output: [{ type: "text", text: "done" }] };
		},
	});
	const extension = defineExtension({ name: "test.slow", tools: [slow] });
	const { harness, faux } = await fixture({ extensions: [extension] });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
	]);
	const id = await harness.create("chat");
	const key = Object.entries((await harness.snapshot()).conversations).find(
		([, m]) => m.id === id,
	)![0];
	await (await harness.native.conversation(
		Number(key) as typeof harness.root.id,
		harness.context,
	))!.configure({ tools: [slow] }, harness.context);
	await harness.submit(id, "start", "request", "followUp", "hash");
	await eventually(() => executing);
	return { harness, id, key: Number(key), extension };
}
test("main abort preserves background-owned child; per-node abort only ends its turn", async () => {
	const { harness, id } = await slowChild();
	try {
		await harness.root.abort(harness.context);
		assert.equal(
			(await harness.tree()).find((node) => node.id === id)!.status,
			"running",
		);
		await harness.abort(id);
		assert.equal(
			(await harness.tree()).find((node) => node.id === id)!.status,
			"waiting",
		);
		assert.ok(
			(await harness.native.inspect(harness.context)).tasks.some(
				(task) => task.record.kind === "steward.conversation-anchor",
			),
		);
	} finally {
		await harness.close();
	}
});
test("explicit background anchor abort crosses ownership boundary and writes terminal receipt", async () => {
	const { harness, id } = await slowChild();
	try {
		const owner = (await harness.tree()).find((node) => node.id === id)!
			.ownerTaskId!;
		const tasks = (await harness.native.inspect(harness.context)).tasks;
		const anchor = tasks.find((task) => String(task.record.id) === owner)!
			.record.id;
		await harness.native.abortTask(anchor, harness.context);
		await harness.native.waitForTask(anchor, harness.context);
		assert.equal(
			(await harness.native.getTask(anchor, harness.context))!.state.status,
			"terminal",
		);
		assert.equal(
			(await harness.tree()).find((node) => node.id === id)!.status,
			"idle",
		);
	} finally {
		await harness.close();
	}
});
test("abort background true stops all owned children", async () => {
	const { harness } = await slowChild();
	await harness.root.abort(harness.context, { background: true });
	assert.equal((await harness.native.inspect(harness.context)).tasks.length, 0);
	await harness.close();
});
test("close preserves the owned attempt without an outcome and reopen reports interrupted tool", async () => {
	const { harness, id, extension } = await slowChild();
	const before = (await harness.native.inspect(harness.context)).tasks;
	const owner = before.find(
		(task) => task.record.kind === "steward.conversation-anchor",
	)!.record.id;
	await harness.close();
	const reopened = await fixture({ extensions: [extension] });
	try {
		assert.notEqual(
			(await reopened.harness.native.getTask(owner, reopened.harness.context))!
				.state.status,
			"terminal",
		);
		reopened.harness.start();
		await eventually(async () =>
			(await reopened.harness.transcript(id)).some(
				(entry) =>
					entry.kind === "pi.tool-result" &&
					JSON.stringify(entry).includes("interrupted"),
			),
		);
		assert.equal((await reopened.harness.tree()).length, 2);
	} finally {
		await reopened.harness.close();
	}
});

test("beforeTool blocks a tool when kill switch changes during generation", async () => {
	isolate();
	let calls = 0;
	const dangerous = defineTool({
		name: "probe",
		description: "test pretool block",
		parameters: Type.Object({}),
		execute: async () => {
			calls++;
			return { output: [] };
		},
	});
	const extension = defineExtension({
		name: "test.pretool",
		tools: [dangerous],
	});
	const { harness, faux } = await fixture({ extensions: [extension] });
	try {
		await harness.root.configure({ tools: [dangerous] }, harness.context);
		faux.setResponses([
			() => {
				pauseFile("agent");
				return fauxAssistantMessage(fauxToolCall("probe", {}), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("done"),
		]);
		const submission = await harness.root.submit(
			{ type: "input", content: "test" },
			harness.context,
		);
		await submission.wait(harness.context);
		assert.equal(calls, 0);
		const transcript = await harness.transcript((await harness.tree())[0].id);
		assert.ok(
			transcript.some(
				(entry) =>
					entry.kind === "pi.tool-result" &&
					JSON.stringify(entry).includes("blocked"),
			),
		);
	} finally {
		await harness.close();
	}
});
test("native taskGraph and ownership index enumerate nested conversations; tree delta is shared", async () => {
	isolate();
	const { harness } = await fixture();
	try {
		const initial = await harness.tree();
		const chat = await harness.create("chat");
		const scout = await harness.create("scout");
		const key = Object.entries((await harness.snapshot()).conversations).find(
			([, m]) => m.id === chat,
		)![0];
		const Anchor = defineTask<null, { phase: "wait" }, null>({
			name: "test.anchor",
			version: 1,
			initial: () => ({ phase: "wait" }),
			phases: {
				wait: async (_task, runtime, ctx) => {
					await runtime.commit(
						() => ({
							status: "sleeping",
							until: Date.now() + 60000,
							checkpoint: { phase: "wait" },
						}),
						ctx,
					);
				},
			},
			abort: async (_task, runtime, ctx) => {
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "aborted" } }),
					ctx,
				);
			},
		});
		await harness.native.commit(async (tx) => {
			const task = await tx.createTask(Anchor, null, {
				conversationId: Number(key) as typeof harness.root.id,
				ownership: { kind: "conversation" },
				background: true,
			});
			await tx.createConversation({
				ownership: { kind: "task", taskId: task },
			});
		}, harness.context);
		const tree = await harness.tree();
		assert.equal(tree.length, 4);
		assert.equal(tree.find((node) => node.kind === "subagent")!.parentId, chat);
		assert.equal(
			tree.find((node) => node.id === scout)!.parentId,
			initial[0].id,
		);
		assert.equal(treeDelta(initial, tree).upsert.length, 3);
		assert.ok(tree.every((node) => /^[a-f0-9-]{36}$/.test(node.id)));
	} finally {
		await harness.close();
	}
});
