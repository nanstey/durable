import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ApprovalWebAuthn } from "../../src/approval/webauthn.ts";
import { agentDir, saveJson } from "../../src/steward/files.ts";
import { isolate } from "../support/harness.ts";

isolate();

const config = { rpId: "console.test", origin: "https://console.test" };

test("first passkey enrollment consumes a TTY code, while another key starts with an existing-key assertion", async () => {
	let now = 1;
	const approval = new ApprovalWebAuthn("agent", config, () => now);
	await assert.rejects(
		approval.options("enroll", "agent", "enroll"),
		/enrollment code/,
	);
	const code = approval.issueEnrollmentCode();
	assert.equal(
		(await approval.options("enroll", "agent", "enroll", code)).kind,
		"registration",
	);

	mkdirSync(join(agentDir("agent"), "approval"), { recursive: true });
	saveJson(join(agentDir("agent"), "approval", "webauthn.json"), {
		keys: [{ id: "existing", publicKey: "AA", counter: 0 }],
		challenges: {},
	});
	const second = await approval.options("enroll", "agent", "enroll");
	assert.equal(second.kind, "assertion");
	assert.deepEqual(
		second.options.allowCredentials?.map((key) => key.id),
		["existing"],
	);
	now += 1;
});

test("WebAuthn options preserve the stored challenge bytes", async () => {
	const approval = new ApprovalWebAuthn("bytes", config);
	const issued = await approval.options("resume", "bytes", "resume");
	const stored = JSON.parse(
		readFileSync(join(agentDir("bytes"), "approval", "webauthn.json"), "utf8"),
	) as { challenges: Record<string, { challenge: string }> };
	assert.equal(
		issued.options.challenge,
		stored.challenges[issued.id]?.challenge,
	);
});
