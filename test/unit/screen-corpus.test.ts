import assert from "node:assert/strict";
import test from "node:test";
import { credentialLike } from "../../src/api/chat.ts";

// Retained normal corpus from the feasibility spike, including its one intentional false positive.
const normal = [
	"please rebase onto main and rerun the tests",
	"why did the gate say wait-human on PR #42?",
	"pause the scout for an hour, I'm reviewing the queue",
	"commit 9f3c2a1b7e4d5c6f8a9b0c1d2e3f4a5b6c7d8e9f broke the build",
	"the head sha is 2580b1a, approve after CI is green",
	"run id 01a16786-f24b-7211-abe6-1b6ba0beb405 is stuck",
	"lockfile has integrity sha512-q2xs3FqV0nYk1pQe7cR8ZbH9tW4uL5mN6oP7aB8cD9eF0gH1iJ2kL3mN4oP5qR6sT7uV8wX9yZ0aB1cD2eF3gH4iJ==",
	"docker image digest sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
	"see https://github.com/acme/api/pull/17/files#diff-3a7b1c9e2f4d6a8b0c2e4f6a8b0c2d4e6f8a0b2c",
	"move src/console/approval/webauthnChallengeStore.ts next to src/console/approval/index.ts",
	"set GH_TOKEN with pi-secret, never paste it here",
	"the token budget for the reviewer is 200k per day",
	"password reset flow needs a test for expired links",
	"use the bearer token from the console registry file, not the env",
	"rename getAuthorizationHeaderForProviderRequest to authHeader",
	"base64 of hello world is aGVsbG8gd29ybGQ=",
	"explain item acme/api#118 and why it is ineligible",
	"set priority high on the flaky-test issue",
	"try `node --experimental-strip-types test/examples/14-chat.ts`",
	"CSP: default-src 'self'; script-src 'self'; frame-ancestors 'none'",
	"the npm package is @earendil-works/pi-durable@1.4.0 pinned with pi-ai 1.4.0",
	"abort the current turn, it's looping on the same grep",
	"ok",
	"can you compare MTIzNDU2Nzg5MGFiY2RlZg and the other fixture id?",
	"the VAPID subject should be mailto:operator@example.invalid",
	"steer: focus on the failing test in test/gate/merge.test.ts only",
	"this function is O(n^2), refactor with a Map keyed by repo slug",
	"rotate tokens every 90 days; the expiry field is expiresAt",
	"the trace id is 4bf92f3577b34da6a3ce929d0e0e4736 from the logs",
	"AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 is the alphabet I want for ids",
];
test("spike normal corpus preserves 29 accepted cases and the documented alphabet false-positive", () => {
	assert.equal(normal.length, 30);
	assert.deepEqual(
		normal.map(credentialLike),
		normal.map((_, index) => index === 29),
	);
});
const key = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const positive: Record<string, string> = {
	github: ["ghp_", key].join(""),
	fineGrained: ["github_pat_", key, "_", key].join(""),
	anthropic: ["sk-ant-api03-", key.repeat(3)].join(""),
	openai: ["sk-proj-", key.repeat(2)].join(""),
	privateKey: ["-----BEGIN ", "OPENSSH PRIVATE KEY-----\n", key].join(""),
	aws: ["AKIA", "ABCDEF234567ABCD"].join(""),
	google: ["AIza", key.slice(0, 35)].join(""),
	slack: ["xoxb-", "123456789012-", key].join(""),
	jwt: ["eyJ", key, ".eyJ", key, ".", key].join(""),
	assignment: `api_key=${key.slice(0, 10)}9${key.slice(10, 20)}`,
	password: `password: Tr0ub4dor${key.slice(0, 6)}`,
	entropy: `random secret ${key}`,
};
for (const [name, body] of Object.entries(positive))
	test(`spike credential corpus detects ${name}`, () =>
		assert.equal(credentialLike(body), true));
