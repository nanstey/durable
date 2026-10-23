import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { localToken } from "../../src/api/tokens.ts";
import { SystemdContainment } from "../../src/platform/systemdContainment.ts";
import { openHarness } from "../../src/steward/harness.ts";
import { ProcessManager } from "../../src/steward/procs.ts";
import { eventually, fauxModels } from "../support/harness.ts";

const [phase] = process.argv.slice(2);
const home = process.env.DURABLE_HOME!;
const manager = new ProcessManager(
	"recover",
	new SystemdContainment(undefined, undefined, 50),
);
assert.ok(await manager.sweep());
const slow = defineTool({
	name: "slow",
	description: "Test-only contained slow tool",
	parameters: Type.Object({}),
	replay: "unsafe",
	execute: async (_args, api, ctx) => {
		api.output("started");
		ctx.abortSignal?.addEventListener(
			"abort",
			() => {
				void manager.terminate();
			},
			{ once: true },
		);
		const result = await manager.launch(
			[
				"/bin/sh",
				"-c",
				'echo ready > "$1"; sleep 300 & sleep 300; wait',
				"tool",
				join(home, "started"),
			],
			{ PATH: process.env.PATH },
			{ item: "recover", attemptId: "one", task: String(api.taskId) },
		);
		return { output: [{ type: "text", text: result.stdout }] };
	},
});
const extension = defineExtension({ name: "test.recovery", tools: [slow] });
const { models, faux } = fauxModels();
let interrupted = false;
if (phase === "start")
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
	]);
else
	faux.setResponses([
		(request) => {
			interrupted = request.messages.some(
				(message) =>
					message.role === "toolResult" &&
					message.isError &&
					JSON.stringify(message.content).includes("interrupted"),
			);
			return fauxAssistantMessage("recovered child completed");
		},
	]);
const h = await openHarness({
	agent: "recover",
	storage: "sqlite",
	definition: {
		profile: "fixture",
		schedule: { pollSeconds: 1 },
		models: { steward: { provider: "faux", model: "one" } },
	},
	models,
	processes: manager,
	extensions: [extension],
});
localToken("recover");
let child: string;
if (phase === "start") {
	await h.addInbox("paused");
	child = await h.create("chat");
	const key = Object.entries((await h.snapshot()).conversations).find(
		([, meta]) => meta.id === child,
	)![0];
	const native = await h.native.conversation(
		Number(key) as typeof h.root.id,
		h.context,
	);
	await native!.configure({ tools: [slow] }, h.context);
	writeFileSync(join(home, "child"), child);
} else child = (await h.tree()).find((node) => node.kind === "chat")!.id;
h.start();
await h.submit(
	child,
	"run slow tool",
	"recovery-request",
	"followUp",
	"identical",
);
if (phase === "start") {
	await eventually(() => existsSync(join(home, "started")));
	console.log("ready");
	await new Promise(() => {});
} else {
	await eventually(async () =>
		(await h.transcript(child)).some(
			(entry) =>
				entry.kind === "pi.assistant" &&
				JSON.stringify(entry.model).includes("recovered child completed"),
		),
	);
	assert.ok(interrupted);
	const graph = (await h.native.inspect(h.context)).tasks;
	writeFileSync(
		join(home, "recovered.json"),
		JSON.stringify({
			child,
			interrupted,
			loopTasks: graph.filter((task) => task.record.kind === "steward-loop")
				.length,
			heartbeat: (await h.snapshot()).heartbeat,
			inbox: (await h.snapshot()).inbox.length,
			procs: manager.snapshot().invocations.length,
			tree: await h.tree(),
		}),
	);
	await h.close();
}
