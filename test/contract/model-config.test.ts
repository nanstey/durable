import assert from "node:assert/strict";
import test from "node:test";
import { fixture, isolate } from "../support/harness.ts";

test("reopen applies the definition model through configure without replacing the main conversation", async () => {
	isolate();
	let { harness } = await fixture();
	const id = harness.root.id;
	await harness.root.configure(
		{ model: { provider: "faux", modelId: "previous" }, thinkingLevel: "high" },
		harness.context,
	);
	await harness.close();
	({ harness } = await fixture({
		definition: {
			profile: "fixture",
			models: { steward: { provider: "faux", model: "one", thinking: "low" } },
		},
	}));
	try {
		assert.equal(harness.root.id, id);
		const agent = await harness.root.agent(harness.context);
		assert.equal(agent.model?.modelId, "one");
		assert.equal(agent.thinkingLevel, "low");
	} finally {
		await harness.close();
	}
});
