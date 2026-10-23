import assert from "node:assert/strict";
import test from "node:test";
import { DurableClient } from "../../src/client/client.ts";
import {
	isStartableConversationKind,
	startableConversationKinds,
} from "../../src/steward/conversations.ts";

test("operator conversation kinds are fixed and may only be tightened", () => {
	assert.deepEqual(startableConversationKinds, ["chat", "scout"]);
	assert.equal(isStartableConversationKind("chat", undefined), true);
	assert.equal(isStartableConversationKind("worker-durable", undefined), false);
	assert.equal(isStartableConversationKind("scout", ["chat"]), false);
});

test("typed client sends bearer authentication and message contract", async () => {
	let request: Request | undefined;
	const client = new DurableClient("http://daemon.invalid", "local-token", {
		fetcher: async (input, init) => {
			request = new Request(input, init);
			return Response.json({ id: "submission" });
		},
	});
	assert.deepEqual(await client.message("conversation", "hello"), {
		id: "submission",
	});
	assert.ok(request);
	assert.equal(request.headers.get("authorization"), "Bearer local-token");
	assert.match(await request.text(), /"body":"hello"/);
});
