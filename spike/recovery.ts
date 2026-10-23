// Spike (throwaway): pi-durable kill -9 recovery with a faux model and a slow bash tool.
// Usage (in a temp dir with pi-durable 1.4.0 + pi-ai 1.4.0 + chord 1.4.0 installed):
//   node recovery.ts start <db>   # model calls bash "sleep 30"; parent kill -9s this process
//   node recovery.ts resume <db>  # reopen, resume, print the interrupted tool result and the final answer
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const [phase, db] = process.argv.slice(2);
const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
const models = createModels();
models.setProvider(faux.provider);
if (phase === "start") {
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("bash", {
				command: "echo started; sleep 30; echo finished",
			}),
			{ stopReason: "toolUse" },
		),
	]);
} else {
	faux.setResponses([
		(context) => {
			const last = context.messages.at(-1) as any;
			console.log(
				"MODEL SEES LAST MESSAGE:",
				JSON.stringify({
					role: last.role,
					isError: last.isError,
					content: last.content,
				}).slice(0, 600),
			);
			return fauxAssistantMessage("turn finished after restart");
		},
	]);
}
const registry = createRegistry();
registry.install(CodingTools);
const harness = await Harness.open(
	await openNodeSqliteStorage(db),
	{
		models,
		registry,
		env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
	},
	ctx,
);
const root = await harness.root(ctx, {
	agent: { model: { provider: "faux", modelId: "faux-1" } },
});
if (phase === "resume") harness.resume();
const sub = await root.submit(
	{ type: "input", content: "run the slow command", requestId: "spike-1" },
	ctx,
);
console.log(phase, "pid", process.pid, "submission", sub.id);
const settled = await sub.wait(ctx);
console.log(
	"SETTLED:",
	JSON.stringify({
		status: settled.status,
		type: settled.type,
		answer: (settled as any).answer?.content ?? (settled as any).reason,
	}).slice(0, 400),
);
await harness.close(ctx);
