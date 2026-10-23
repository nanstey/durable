import assert from "node:assert/strict";
import test from "node:test";
import { createApi } from "../../src/api/routes.ts";
import { createToken } from "../../src/api/tokens.ts";
import { fixture, isolate } from "../support/harness.ts";

test("opt-in HTTP rate limit returns 429 with Retry-After; duplicate receipts bypass quota", async () => {
	isolate();
	const definition = {
		profile: "fixture",
		models: { steward: { provider: "faux", model: "one" } },
		chat: { rateLimit: { perMinute: 1 } },
	};
	const { harness } = await fixture({ definition, now: () => 1000 });
	try {
		const token = createToken("agent", "limited", ["chat", "read"]);
		const api = createApi({
			agent: "agent",
			machine: "fixture",
			profile: "fixture",
			definition,
			harness,
		});
		const id = (await harness.tree())[0].id;
		const post = (requestId: string) =>
			api.request(`/v1/conversations/${id}/messages`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ body: "hi", requestId, whenBusy: "followUp" }),
			});
		assert.equal((await post("first")).status, 202);
		const limited = await post("second");
		assert.equal(limited.status, 429);
		assert.equal(limited.headers.get("Retry-After"), "59");
		assert.equal((await post("first")).status, 202);
		await harness.addInbox("paused");
		const event = (await harness.snapshot()).inbox[0];
		assert.equal(
			(
				await api.request(`/v1/inbox/${event.id}/ack`, {
					method: "POST",
					headers: { authorization: `Bearer ${token}` },
				})
			).status,
			200,
		);
		assert.equal((await harness.snapshot()).inbox[0].acked, true);
	} finally {
		await harness.close();
	}
});
