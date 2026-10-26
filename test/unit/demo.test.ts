import assert from "node:assert/strict";
import test from "node:test";
import { DurableClient } from "../../src/client/client.ts";
import { runDemo } from "../../src/demo.ts";
import { localToken } from "../../src/api/tokens.ts";

test("demo boots a seeded agent visible through durable status", async () => {
	const demo = await runDemo();
	try {
		const status = await new DurableClient(
			demo.url,
			localToken(demo.agent),
		).request<{
			agent: string;
			profile: string;
		}>("/v1/device");
		assert.equal(status.agent, demo.agent);
		assert.equal(status.profile, "demo");
	} finally {
		await demo.close();
	}
});
