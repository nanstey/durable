import assert from "node:assert/strict";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { createModelsFor } from "../../src/identity/modelAuth.ts";
import { resolveProfile } from "../../src/identity/profiles.ts";

// The runtime intentionally has no public mutation API. Inspect its actual backing
// store in this regression test rather than importing an unsupported deep module.
function backingStore(runtime: unknown): CredentialStore {
	return (runtime as { credentials: CredentialStore }).credentials;
}
test("ModelRuntime directory symlinks share serialized in-place credential writes", {
	timeout: 30000,
}, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "durable-model-auth-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const canonical = join(root, "canonical");
	const derived = join(root, "derived");
	mkdirSync(join(canonical, "auth-profiles"), { recursive: true });
	mkdirSync(derived);
	symlinkSync(
		join(canonical, "auth-profiles"),
		join(derived, "auth-profiles"),
		"dir",
	);
	const profile = resolveProfile("work", canonical);
	writeFileSync(
		profile.authFile,
		JSON.stringify({ fabricated: { type: "api_key", key: "0" } }),
		{ mode: 0o600 },
	);
	const stores = await Promise.all(
		[canonical, derived].map(async (path) =>
			backingStore(await createModelsFor(resolveProfile("work", path))),
		),
	);
	const count = 25;
	await Promise.all(
		stores.map(async (store) => {
			for (let i = 0; i < count; i++)
				await store.modify("fabricated", async (current) => {
					assert.equal(current?.type, "api_key");
					const key = current?.type === "api_key" ? current.key : "0";
					await new Promise((resolve) => setTimeout(resolve, 1));
					return { type: "api_key", key: String(Number(key) + 1) };
				});
		}),
	);
	assert.equal(
		JSON.parse(readFileSync(profile.authFile, "utf8")).fabricated.key,
		String(count * 2),
	);
	assert.equal(
		lstatSync(join(derived, "auth-profiles")).isSymbolicLink(),
		true,
	);
	assert.equal(lstatSync(profile.authFile).mode & 0o777, 0o600);
});
test("OAuth refresh uses one locked rotation against a fabricated token endpoint", {
	timeout: 10000,
}, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "durable-rotation-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "auth-profiles"));
	const profile = resolveProfile("work", root);
	writeFileSync(
		profile.authFile,
		JSON.stringify({
			fabricated: {
				type: "oauth",
				access: "expired-fabricated",
				refresh: "refresh-fabricated",
				expires: Date.now() - 1000,
			},
		}),
		{ mode: 0o600 },
	);
	let calls = 0;
	const endpoint = createServer((_request, response) => {
		calls++;
		response.setHeader("content-type", "application/json");
		response.end(
			JSON.stringify({
				access: "rotated-fabricated",
				refresh: "rotated-refresh-fabricated",
				expires: Date.now() + 3600000,
			}),
		);
	});
	await new Promise<void>((resolve) =>
		endpoint.listen(0, "127.0.0.1", resolve),
	);
	t.after(() => endpoint.close());
	const address = endpoint.address();
	assert.ok(address && typeof address !== "string");
	const runtime = await createModelsFor(profile, ["fabricated"]);
	runtime.registerProvider("fabricated", {
		baseUrl: `http://127.0.0.1:${address.port}`,
		api: "openai-completions",
		oauth: {
			name: "Fabricated",
			login: async () => {
				throw new Error("login is not used in this test");
			},
			getApiKey: (credential) => credential.access,
			refreshToken: async (credential, signal) => {
				assert.equal(credential.refresh, "refresh-fabricated");
				const response = await fetch(`http://127.0.0.1:${address.port}/token`, {
					method: "POST",
					signal,
				});
				return (await response.json()) as {
					access: string;
					refresh: string;
					expires: number;
				};
			},
		},
		models: [
			{
				id: "fabricated",
				name: "Fabricated",
				input: ["text"],
				reasoning: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000,
				maxTokens: 100,
			},
		],
	});
	await Promise.all([
		runtime.getAuth("fabricated"),
		runtime.getAuth("fabricated"),
	]);
	assert.equal(calls, 1);
	const stored = JSON.parse(readFileSync(profile.authFile, "utf8")).fabricated;
	assert.equal(stored.access, "rotated-fabricated");
	assert.equal(stored.refresh, "rotated-refresh-fabricated");
});

test("plain runtime uses the selected API-key profile", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "durable-apikey-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "auth-profiles"));
	const profile = resolveProfile("work", root);
	writeFileSync(
		profile.authFile,
		JSON.stringify({
			openrouter: { type: "api_key", key: "fabricated-profile-key" },
		}),
		{ mode: 0o600 },
	);
	const runtime = await createModelsFor(profile, ["openrouter"]);
	const auth = await runtime.getAuth("openrouter", { env: {} });
	assert.ok(auth);
	assert.equal(auth.auth.apiKey, "fabricated-profile-key");
	assert.throws(
		() => createModelsFor(profile, ["missing"]),
		/missing configured providers/,
	);
});

test("Anthropic OAuth requires explicit durable model-auth opt-in", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "durable-anthropic-oauth-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "auth-profiles"));
	const profile = resolveProfile("work", root);
	writeFileSync(
		profile.authFile,
		JSON.stringify({ anthropic: { type: "oauth", access: "fabricated" } }),
	);
	assert.throws(
		() => createModelsFor(profile, ["anthropic"]),
		/modelAuth: true/,
	);
	await createModelsFor(profile, ["anthropic"], "plain", {
		allowAnthropicOAuth: true,
	});
});

test("Anthropic shaped variant fails explicitly until configured", () =>
	assert.throws(
		() =>
			createModelsFor(resolveProfile("work", "fixture"), [], "anthropicShaped"),
		/not-configured/,
	));
