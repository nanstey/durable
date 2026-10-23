import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { loopbackBind } from "../../src/api/net.ts";
import { createApi } from "../../src/api/routes.ts";
import { ViewerQueue } from "../../src/api/sse.ts";
import { createToken, type Scope } from "../../src/api/tokens.ts";
import type { MessageRequest, MessageResponse } from "../../src/api/types.ts";
import { readAudit } from "../../src/steward/audit.ts";
import { fixture, isolate } from "../support/harness.ts";

isolate();
let h: Awaited<ReturnType<typeof fixture>>["harness"];
let api: ReturnType<typeof createApi>;
let id: string;
const tokens: Record<string, string> = {};
before(async () => {
	({ harness: h } = await fixture());
	id = (await h.tree())[0].id;
	for (const scope of ["read", "chat", "pause"] as const)
		tokens[scope] = createToken("agent", scope, [scope]);
	api = createApi({
		agent: "agent",
		machine: "fixture",
		profile: "fixture",
		harness: h,
		definition: { profile: "fixture" },
	});
});
after(async () => {
	await h.close();
});
const routes = [
	["GET", "/v1/device", "read"],
	["GET", "/v1/sessions", "read"],
	["GET", "/v1/conversations?tree=true", "read"],
	["GET", "/v1/conversations/ID", "read"],
	["GET", "/v1/sessions/ID", "read"],
	["GET", "/v1/events", "read"],
	["GET", "/v1/conversations/ID/events", "read"],
	["GET", "/v1/sessions/ID/events", "read"],
	["GET", "/v1/conversations/ID/tasks", "read"],
	["GET", "/v1/conversations/ID/transcript", "read"],
	["GET", "/v1/sessions/ID/transcript?format=markdown", "read"],
	["GET", "/v1/transcript", "read"],
	["GET", "/v1/tasks", "read"],
	["GET", "/v1/sessions/ID/tasks", "read"],
	["GET", "/v1/budget", "read"],
	["GET", "/v1/inbox", "read"],
	["GET", "/v1/audit", "read"],
	["POST", "/v1/conversations/ID/messages", "chat"],
	["POST", "/v1/sessions/ID/messages", "chat"],
	["POST", "/v1/messages", "chat"],
	["POST", "/v1/conversations/ID/abort", "chat"],
	["POST", "/v1/sessions/ID/abort", "chat"],
	["POST", "/v1/pause", "pause"],
	["POST", "/v1/inbox/missing/ack", "read"],
] as const;
for (const [method, path, required] of routes)
	for (const scope of ["read", "chat", "pause"] as Scope[])
		test(`${scope} token ${method} ${path}: requires ${required}`, async () => {
			const result = await api.request(path.replace("ID", id), {
				method,
				headers: {
					authorization: `Bearer ${tokens[scope]}`,
					"content-type": "application/json",
				},
				...(method === "POST"
					? {
							body: JSON.stringify({
								body: "hi",
								requestId: `${path}:${scope}`,
								whenBusy: "followUp",
							}),
						}
					: {}),
			});
			if (scope !== required) assert.equal(result.status, 403);
			else {
				const expected = path.endsWith("/ack")
					? 404
					: path.endsWith("/messages") || path.endsWith("/abort")
						? 202
						: 200;
				assert.equal(result.status, expected);
			}
			if (result.headers.get("content-type")?.includes("text/event-stream"))
				await result.body?.cancel();
		});
for (const action of [
	"approve",
	"resume",
	"enroll",
	"verify-policy",
	"items/item/release",
])
	test(`no bearer authorizes ${action}`, async () => {
		const token = createToken("agent", "all", ["read", "chat", "pause"]);
		assert.equal(
			(
				await api.request(`/v1/${action}`, {
					method: "POST",
					headers: { authorization: `Bearer ${token}` },
				})
			).status,
			403,
		);
	});
test("health public; missing and invalid token return 401 not 403", async () => {
	assert.equal((await api.request("/healthz")).status, 200);
	assert.equal((await api.request("/v1/device")).status, 401);
	assert.equal(
		(
			await api.request("/v1/device", {
				headers: { authorization: "Bearer bogus" },
			})
		).status,
		401,
	);
});
test("proxy token header uses the same scopes and ambiguous credentials are refused", async () => {
	assert.equal(
		(
			await api.request("/v1/device", {
				headers: { "X-Durable-Token": tokens.read },
			})
		).status,
		200,
	);
	assert.equal(
		(
			await api.request("/v1/device", {
				headers: { "X-Durable-Token": tokens.chat },
			})
		).status,
		403,
	);
	assert.equal(
		(
			await api.request("/v1/device", {
				headers: {
					"X-Durable-Token": tokens.read,
					authorization: `Bearer ${tokens.read}`,
				},
			})
		).status,
		401,
	);
});
test("chat and scout conversations are durable, filtered, and idempotent", async () => {
	const token = tokens.chat;
	const request = (kind: string, key: string, item?: string) =>
		api.request("/v1/conversations", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				"idempotency-key": key,
			},
			body: JSON.stringify({ kind, item }),
		});
	const first = await request("chat", "chat-one");
	assert.equal(first.status, 201);
	const conversation = await first.json();
	assert.deepEqual(
		await (await request("chat", "chat-one")).json(),
		conversation,
	);
	assert.equal((await request("worker-durable", "worker")).status, 400);
	assert.equal((await request("scout", "scout-one", "issue-1")).status, 201);
	const listed = await api.request(
		"/v1/conversations?kind=scout&item=issue-1",
		{
			headers: { authorization: `Bearer ${tokens.read}` },
		},
	);
	assert.equal((await listed.json()).nodes.length, 1);
});
test("unknown node cannot read another transcript", async () => {
	for (const path of [
		"/v1/conversations/missing",
		"/v1/conversations/missing/transcript",
		"/v1/conversations/missing/events",
	])
		assert.equal(
			(
				await api.request(path, {
					headers: { authorization: `Bearer ${tokens.read}` },
				})
			).status,
			404,
		);
});
test("device identity contains names and granted scopes, never credentials", async () => {
	const response = await api.request("/v1/device", {
		headers: { authorization: `Bearer ${tokens.read}` },
	});
	const device = await response.json();
	assert.equal(device.apiVersion, "v1");
	assert.deepEqual(device.scopeSummary, ["read"]);
	assert.equal(device.profile, "fixture");
	assert.deepEqual(device.organization, {
		id: "default",
		bundleHash: "default",
		versionState: "current",
	});
	assert.match(device.uid, /^[a-f0-9-]{36}$/);
	assert.equal(JSON.stringify(device).includes(tokens.read), false);
});
for (const bind of ["0.0.0.0", "192.0.2.1", "localhost"])
	test(`listener refuses ${bind}`, () =>
		assert.throws(() => loopbackBind(bind), /loopback or tailnet/));
test("loopback binds only literal loopback interfaces", () => {
	assert.equal(loopbackBind(), "127.0.0.1");
	assert.equal(loopbackBind("::1"), "::1");
});
test("SSE queue drops a viewer over 2 MiB behind without stopping work", () => {
	let disconnected = false;
	const queue = new ViewerQueue(
		() => new Promise(() => {}),
		() => {
			disconnected = true;
		},
	);
	queue.send("x".repeat(2 * 1024 * 1024));
	queue.send("x");
	assert.ok(disconnected);
	assert.ok(queue.closed);
});
test("SSE write failure disconnects only that viewer", async () => {
	const queue = new ViewerQueue(
		async () => {
			throw Error("closed");
		},
		() => {},
	);
	queue.send("hello");
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(queue.closed);
});
test("chat endpoint validates, audits and deduplicates typed submissions", async () => {
	isolate();
	const { harness } = await fixture();
	try {
		const token = createToken("agent", "chat-test", ["read", "chat"]);
		const app = createApi({
			agent: "agent",
			machine: "fixture",
			profile: "fixture",
			harness,
			definition: { profile: "fixture" },
		});
		const conversation = (await harness.tree())[0].id;
		const post = (body: unknown) =>
			app.request(`/v1/conversations/${conversation}/messages`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			});
		const input: MessageRequest = {
			body: "hello",
			requestId: "one",
			whenBusy: "followUp",
		};
		const first = await post(input);
		assert.equal(first.status, 202);
		const result: MessageResponse = await first.json();
		assert.deepEqual(await (await post(input)).json(), result);
		assert.equal((await post({ ...input, body: "different" })).status, 409);
		assert.equal(
			(await post({ ...input, requestId: "other", role: "system" })).status,
			400,
		);
		assert.equal((await post({ body: "hi" })).status, 400);
		assert.equal(
			(
				await post({
					...input,
					body: ["ghp_", "AbCdEf0123456789".repeat(4)].join(""),
				})
			).status,
			400,
		);
		assert.equal(
			(await post({ ...input, body: "x".repeat(1048577) })).status,
			400,
		);
		const record = readAudit("agent").find((item) => item.event === "message")!;
		assert.equal(record.actor, "human");
		assert.equal(record.client, "chat-test");
		assert.equal(record.bytes, 5);
		assert.match(String(record.sha256), /^[a-f0-9]{64}$/);
		assert.equal(JSON.stringify(record).includes("hello"), false);
	} finally {
		await harness.close();
	}
});
test("no default chat rate limit; opt-in windows persist and reset with fake clock", async () => {
	isolate();
	const { harness } = await fixture();
	try {
		for (let n = 0; n < 200; n++) assert.equal(await harness.rate("client"), 0);
	} finally {
		await harness.close();
	}
	isolate();
	let now = 1000;
	const limited = await fixture({
		now: () => now,
		definition: {
			profile: "fixture",
			models: { steward: { provider: "faux", model: "one" } },
			chat: { rateLimit: { perMinute: 1, perDay: 2 } },
		},
	});
	try {
		assert.equal(await limited.harness.rate("client"), 0);
		assert.equal(await limited.harness.rate("client"), 59);
		now = 61000;
		assert.equal(await limited.harness.rate("client"), 0);
		now = 121000;
		assert.ok((await limited.harness.rate("client")) > 60);
		now = 86401000;
		assert.equal(await limited.harness.rate("client"), 0);
	} finally {
		await limited.harness.close();
	}
});
