import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DeviceMonitor } from "../../src/console/monitor.ts";
import { StreamMux } from "../../src/console/mux.ts";
import { allowedDaemonRoute, proxyDaemon } from "../../src/console/proxy.ts";
import { createConsoleApp } from "../../src/console/routes.ts";

test("console guard adds CSP and refuses cross-origin writes", async () => {
	const { app } = createConsoleApp({ devices: [], csrf: "csrf" });
	const page = await app.request("http://127.0.0.1:4319/");
	assert.match(
		page.headers.get("content-security-policy") ?? "",
		/worker-src 'self'; manifest-src 'self'/,
	);
	const denied = await app.request("http://127.0.0.1:4319/api/push/test", {
		method: "POST",
		headers: {
			host: "127.0.0.1:4319",
			origin: "http://evil.invalid",
			"content-type": "application/json",
			"x-durable-csrf": "csrf",
		},
		body: "{}",
	});
	assert.equal(denied.status, 403);
});

test("Serve writes require the allowed Tailscale identity", async () => {
	const { app } = createConsoleApp({ devices: [], csrf: "csrf" });
	const denied = await app.request("http://127.0.0.1:4319/api/push/test", {
		method: "POST",
		headers: {
			host: "not-a-proxy",
			origin: "http://not-a-proxy",
			"content-type": "application/json",
			"x-durable-csrf": "csrf",
		},
		body: "{}",
	});
	assert.equal(denied.status, 421);
});

test("proxy allowlist excludes files, shells and arbitrary paths", () => {
	assert.equal(allowedDaemonRoute("GET", "/v1/conversations"), true);
	assert.equal(
		allowedDaemonRoute("POST", "/v1/conversations/a/messages"),
		true,
	);
	assert.equal(allowedDaemonRoute("GET", "/v1/files"), false);
	assert.equal(allowedDaemonRoute("POST", "/v1/shell"), false);
	assert.equal(allowedDaemonRoute("GET", "/v1/anything"), false);
});

test("proxy injects the daemon token and does not forward browser credentials", async () => {
	const original = globalThis.fetch;
	let authorization = "";
	globalThis.fetch = async (_input, init) => {
		authorization = new Headers(init?.headers).get("authorization") ?? "";
		return Response.json({ ok: true });
	};
	try {
		const response = await proxyDaemon(
			{ id: "local", url: "http://127.0.0.1:7330", token: "private" },
			new Request("http://127.0.0.1:4319/api/devices/local/v1/queue", {
				headers: { authorization: "Bearer browser" },
			}),
			"/v1/queue",
		);
		assert.equal(response.status, 200);
		assert.equal(authorization, "Bearer private");
	} finally {
		globalThis.fetch = original;
	}
});

test("monitor distinguishes daemon device states", async () => {
	const monitor = new DeviceMonitor(
		[
			{
				id: "a",
				url: "http://127.0.0.1:7330",
				token: "not-in-browser",
				uid: "expected",
			},
		],
		async (url) => {
			if (new URL(url.toString()).pathname === "/healthz")
				return Response.json({ ok: true });
			return Response.json({ uid: "other", apiVersion: "v1" });
		},
	);
	assert.equal((await monitor.checkAll())[0]?.status, "mismatch");
});

test("mux caps subscriptions", () => {
	const mux = new StreamMux();
	assert.throws(() =>
		mux.subscribe(
			"none",
			Array.from({ length: 21 }, (_, index) => `d/agent/${index}`),
		),
	);
});

test("vendored assets match checksums and static application is same-origin", () => {
	for (const line of readFileSync("web/SHA256SUMS", "utf8")
		.trim()
		.split("\n")) {
		const [digest, path] = line.trim().split(/\s+/);
		assert.equal(
			createHash("sha256").update(readFileSync(path)).digest("hex"),
			digest,
		);
	}
	for (const path of [
		"web/index.html",
		"web/app.js",
		"web/style.css",
		"web/views/dom.js",
		"web/views/chat.js",
	]) {
		const source = readFileSync(path, "utf8");
		assert.doesNotMatch(source, /https?:\/\//);
		assert.doesNotMatch(source, /innerHTML/);
		assert.doesNotMatch(source, /dur_[A-Za-z0-9_-]/);
	}
});
