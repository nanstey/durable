import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { durableRig } from "../support/durable.ts";
import { eventually } from "../support/harness.ts";

// Lifecycle row 8, with no in-flight subprocess: the mid-bash escape/cleanup matrix is item 6.
const rig = await durableRig();
rig.faux.setResponses([
	fauxAssistantMessage("Waiting for a follow-up before the crash."),
]);
rig.harness.start();
await eventually(async () =>
	Boolean((await rig.items())[0]?.attempts[0]?.worker),
);
const item = (await rig.items())[0];
const worker = await rig.config.work.workers.get(item.attempts[0].id);
const node = (await rig.harness.tree()).find(
	(entry) => entry.kind === "worker-durable",
)!;
await eventually(async () =>
	JSON.stringify(await rig.harness.transcript(node.id)).includes(
		"Waiting for a follow-up",
	),
);
process.send?.({
	home: rig.home,
	handle: worker.handle,
	conversationId: node.id,
});
