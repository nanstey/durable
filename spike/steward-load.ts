// Offline faux-model responsiveness probe. No profiles or credentials are read.
import assert from "node:assert/strict";
import { once } from "node:events";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { startApi } from "../src/api/server.ts";
import { createToken } from "../src/api/tokens.ts";
import { fixture, eventually, isolate } from "../test/support/harness.ts";

for (const count of [1, 2, 4]) {
	isolate(); let busy = 0;
	const slow = defineTool({ name: "busy", description: "faux asynchronous load", parameters: Type.Object({}), execute: async (_args, _api, context) => {
		busy++;
		await new Promise<void>((resolve) => context.abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
		return { output: [] };
	} });
	const { harness, faux } = await fixture({ extensions: [defineExtension({ name: "probe.load", tools: [slow] })] });
	faux.setResponses(Array.from({ length: count }, () => fauxAssistantMessage(fauxToolCall("busy", {}), { stopReason: "toolUse" })));
	const token = createToken("agent", "load", ["read"]);
	const server = startApi({ agent: "agent", machine: "fixture", profile: "fixture", definition: { profile: "fixture" }, harness, port: 0 });
	await once(server, "listening");
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const headers = { authorization: `Bearer ${token}` };
	try {
		for (let n = 0; n < count; n++) {
			const id = await harness.create("chat");
			const key = Object.entries((await harness.snapshot()).conversations).find(([, meta]) => meta.id === id)![0];
			await (await harness.native.conversation(Number(key) as typeof harness.root.id, harness.context))!.configure({ tools: [slow] }, harness.context);
			await harness.submit(id, "load", `load-${n}`, "followUp", "hash");
		}
		await eventually(() => busy === count);
		const sseStart = performance.now();
		const stream = await fetch(`${base}/v1/events`, { headers });
		const reader = stream.body!.getReader();
		const heartbeat = (async () => {
			let data = "";
			while (!data.includes(": ping")) data += new TextDecoder().decode((await reader.read()).value);
			return performance.now() - sseStart - 15000;
		})();
		const measurements: number[] = [];
		const until = performance.now() + 15200;
		while (performance.now() < until) {
			const start = performance.now();
			const response = await fetch(`${base}/v1/conversations?tree=true`, { headers });
			assert.equal(response.status, 200); await response.json();
			measurements.push(performance.now() - start);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		const lateness = await heartbeat; await reader.cancel();
		measurements.sort((a, b) => a - b);
		const p95 = measurements[Math.floor(measurements.length * .95)], p99 = measurements[Math.floor(measurements.length * .99)];
		console.log(JSON.stringify({ children: count, samples: measurements.length, p95Ms: +p95.toFixed(2), p99Ms: +p99.toFixed(2), heartbeatLatenessMs: +lateness.toFixed(2) }));
		assert.ok(p95 < 250 && p99 < 1000 && lateness < 2000);
	} finally {
		await harness.root.abort(harness.context, { background: true });
		await harness.close(); server.close(); if ("closeAllConnections" in server) server.closeAllConnections();
	}
}
