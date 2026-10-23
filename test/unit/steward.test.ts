import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { credentialLike, validateMessage } from "../../src/api/chat.ts";
import {
	authenticate,
	authorize,
	createToken,
	listTokens,
	localToken,
	revokeToken,
} from "../../src/api/tokens.ts";
import { audit, readAudit, redact } from "../../src/steward/audit.ts";
import { inboxEvent } from "../../src/steward/inbox.ts";
import {
	disabled,
	pauseFile,
	quietHours,
	resumeLocal,
} from "../../src/steward/killswitch.ts";
import { exhausted, rollover } from "../../src/steward/limits.ts";
import { tick } from "../../src/steward/loop.ts";
import { acquireAgentLock } from "../../src/steward/main.ts";
import { fixture, isolate } from "../support/harness.ts";

const home = isolate();
const secret = (prefix: string) => prefix + "AbCdEf0123456789".repeat(4);
for (const prefix of ["ghp_", "gho_", "github_pat_", "sk-", "sk-ant-"])
	test(`screens ${prefix} credentials`, () =>
		assert.throws(
			() => validateMessage({ body: secret(prefix) }),
			/credential-like-content/,
		));
for (const body of [
	["-----BEGIN", " PRIVATE KEY-----"].join(""),
	["-----BEGIN RSA", " PRIVATE KEY-----"].join(""),
	`AKIA${"A".repeat(16)}`,
	`ASIA${"B".repeat(16)}`,
	`AIza${"c".repeat(35)}`,
	"AccountKey=" + "a".repeat(40),
	"AbcDEfGHiJKLmNOPqrSTuvWXYZ0123456789zyxwvutsrqponm",
])
	test(`credential screen ${body.slice(0, 12)}`, () =>
		assert.equal(credentialLike(body), true));
for (const body of [
	"hello",
	"Please explain git status",
	"https://example.invalid/docs/a-long-path-with-ordinary-words",
	"x".repeat(1048576),
	"こんにちは",
])
	test(`accepts ordinary content ${body.slice(0, 15)}`, () =>
		assert.equal(validateMessage({ body }), body));
for (const field of [
	"role",
	"attachment",
	"html",
	"tool_call",
	"conversationId",
])
	test(`rejects unexpected ${field} field`, () =>
		assert.throws(() => validateMessage({ body: "hello", [field]: "x" })));
for (const body of ["", " ", 12, null])
	test(`rejects invalid body ${body}`, () =>
		assert.throws(() => validateMessage({ body })));
test("ceiling counts UTF8 bytes rather than characters", () =>
	assert.throws(() => validateMessage({ body: "€".repeat(400000) })));
test("one byte over sanity ceiling is refused", () =>
	assert.throws(() => validateMessage({ body: "x".repeat(1048577) })));
test("token disk contains hashes only and mode 0600", () => {
	const token = createToken("token", "viewer", ["read"]);
	const path = join(home, "agents/token/tokens.json");
	assert.equal(readFileSync(path, "utf8").includes(token), false);
	assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.ok(authorize("token", token, "read"));
	assert.equal(authorize("token", token, "chat"), undefined);
	assert.equal("hash" in listTokens("token")[0], false);
});
test("expiry and revocation refuse tokens", () => {
	const expired = createToken(
		"token",
		"expired",
		["read"],
		1,
		Date.now() - 2 * 86400000,
	);
	assert.equal(authenticate("token", expired), undefined);
	const token = createToken("token", "revoke", ["pause"]);
	revokeToken("token", "revoke");
	assert.equal(authenticate("token", token), undefined);
});
for (const scope of ["approve", "resume", "enroll", "release", "verify-policy"])
	test(`token cannot gain ${scope}`, () =>
		assert.throws(() => createToken("token", "bad", [scope as "read"])));
test("local token is private and renews revoked credentials", () => {
	const first = localToken("local");
	assert.equal(localToken("local"), first);
	assert.equal(statSync(join(home, "agents/local/token")).mode & 0o777, 0o600);
	revokeToken("local", "local-cli");
	assert.notEqual(localToken("local"), first);
});
test("corrupt token store fails closed", () => {
	createToken("corrupt", "x", ["read"]);
	writeFileSync(join(home, "agents/corrupt/tokens.json"), "not JSON");
	assert.throws(() => authenticate("corrupt", "anything"));
});
test("redaction recursively removes token values and secret fields", () => {
	const result = JSON.stringify(
		redact({ token: "foo", nested: { password: "bar", info: secret("ghp_") } }),
	);
	assert.ok(
		!result.includes("foo") &&
			!result.includes("bar") &&
			!result.includes("ghp_"),
	);
});
test("audit append is ordered and content-free", async () => {
	await Promise.all(
		Array.from({ length: 50 }, (_, n) =>
			Promise.resolve().then(() =>
				audit("audit", { event: "test", n, body: "do not log" }),
			),
		),
	);
	const events = readAudit("audit");
	assert.equal(events.length, 50);
	assert.equal(events[49].n, 49);
	assert.equal(JSON.stringify(events).includes("do not log"), false);
	assert.equal(readAudit("audit", Date.now() + 10000).length, 0);
});
test("inbox rejects credentials and has no content fields", () => {
	assert.throws(() => inboxEvent("a", "paused", secret("ghp_")));
	assert.deepEqual(Object.keys(inboxEvent("a", "paused")).sort(), [
		"acked",
		"agent",
		"created",
		"id",
		"target",
		"type",
	]);
});
for (const [clock, expected] of [
	["01:00", true],
	["12:00", false],
	["23:00", true],
	["06:00", false],
] as const)
	test(`overnight quiet hours ${clock}`, () =>
		assert.equal(
			quietHours("22:00-06:00 UTC", Date.parse(`2026-01-01T${clock}:00Z`)),
			expected,
		));
test("quiet parser rejects invalid config", () => {
	for (const value of ["25:00-06:00", "22:90-23:00", "night"])
		assert.throws(() => quietHours(value));
});
test("kill switches are independent and local resume requires TTY", () => {
	assert.equal(disabled("kill"), false);
	pauseFile("kill");
	assert.ok(disabled("kill"));
	assert.throws(() => resumeLocal("kill", false));
	resumeLocal("kill", true);
	assert.equal(disabled("kill"), false);
	assert.ok(disabled("kill", undefined, Date.now(), { DURABLE_DISABLED: "1" }));
	writeFileSync(join(home, "disabled"), "1");
	assert.ok(disabled("kill"));
});
test("budget rollover and exhaustion", () => {
	const b = { day: "2026-01-01", spent: 5, tokens: 100, stopped: false };
	assert.ok(exhausted(b, { dailyDollars: 5 }));
	assert.ok(exhausted(b, { dailyTokens: 100 }));
	assert.equal(rollover(b, Date.parse("2026-01-01")), b);
	assert.equal(rollover(b, Date.parse("2026-01-02")).spent, 0);
});
test("loop ticks twice and pause stops heartbeat", () => {
	const state = {
		heartbeat: 0,
		ticks: 0,
		paused: false,
		budget: { day: "", spent: 0, tokens: 0, stopped: false },
	};
	assert.equal(
		tick(state, { now: 1000, disabled: false, pollSeconds: 1 }).again.nextAt,
		2000,
	);
	tick(state, { now: 2000, disabled: false, pollSeconds: 1 });
	assert.equal(state.ticks, 2);
	tick(state, { now: 3000, disabled: true, pollSeconds: 1 });
	assert.equal(state.heartbeat, 2000);
});
test("agent lock excludes a second instance", async () => {
	const release = await acquireAgentLock("locked");
	try {
		await assert.rejects(acquireAgentLock("locked"), /already running/);
	} finally {
		await release();
	}
});
for (const storage of ["sqlite", "jsonl"] as const)
	test(`${storage} commits, closes and reopens native transcript and inbox`, async () => {
		isolate();
		let { harness } = await fixture({ storage });
		const uid = (await harness.snapshot()).uid;
		await harness.root.submit(
			{
				type: "write",
				entry: { kind: "test.entry", data: { text: "persisted" } },
			},
			harness.context,
		);
		await harness.addInbox("paused");
		const event = (await harness.snapshot()).inbox[0];
		await harness.close();
		({ harness } = await fixture({ storage }));
		try {
			assert.equal((await harness.snapshot()).uid, uid);
			assert.equal((await harness.snapshot()).inbox[0].id, event.id);
			assert.ok(await harness.ack(event.id));
			assert.equal((await harness.snapshot()).inbox[0].acked, true);
			assert.ok(
				(await harness.transcript((await harness.tree())[0].id)).some(
					(e) => e.kind === "test.entry",
				),
			);
			assert.equal(
				(await harness.native.inspect(harness.context)).tasks.filter(
					(t) => t.record.kind === "steward-loop",
				).length,
				1,
			);
			assert.deepEqual(
				(await harness.root.agent(harness.context)).tools
					.map((t) => t.name)
					.sort(),
				[
					"explain_item",
					"list_queue",
					"pause",
					"request_merge",
					"request_work",
					"set_priority",
					"status",
				],
			);
		} finally {
			await harness.close();
		}
	});
test("test files remain machine-local", () =>
	assert.equal(existsSync(join("src", "state.sqlite")), false));
