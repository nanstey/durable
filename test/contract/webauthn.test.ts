import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { auth } from "../../src/api/auth.ts";
import { createApi } from "../../src/api/routes.ts";
import { createToken } from "../../src/api/tokens.ts";
import { ApprovalWebAuthn } from "../../src/approval/webauthn.ts";
import { readAudit } from "../../src/steward/audit.ts";
import { pauseFile } from "../../src/steward/killswitch.ts";
import { authenticator } from "../support/authenticator.ts";
import { fixture, isolate } from "../support/harness.ts";

const approvalRoutes = [
	"/v1/approvals/challenge",
	"/v1/approvals/assert",
	"/v1/approvals/nonce",
	"/v1/resume",
	"/v1/items/item/release",
	"/v1/policy/repo/verify",
];
test("approval route versus scope/header matrix never accepts bearer authority", async () => {
	isolate();
	const app = new Hono();
	app.use("*", auth("agent"));
	app.post("*", (c) => c.json({ delegatedToActionCredential: true }));
	for (const route of approvalRoutes) {
		assert.equal((await app.request(route, { method: "POST" })).status, 200);
		for (const scope of ["read", "chat", "pause", "sync"] as const) {
			const token = createToken("agent", scope, [scope]);
			for (const header of ["authorization", "x-durable-token"])
				assert.equal(
					(
						await app.request(route, {
							method: "POST",
							headers: {
								[header]:
									header === "authorization" ? `Bearer ${token}` : token,
							},
						})
					).status,
					403,
					`${scope} ${header} ${route}`,
				);
		}
	}
});

test("unauthenticated challenge route cannot enroll a second key without an existing-key signature; audit redacts credentials", async (t) => {
	isolate();
	const { harness } = await fixture();
	t.after(() => harness.close());
	const service = new ApprovalWebAuthn("agent", {
		rpId: "console.test",
		origin: "https://console.test",
	});
	const api = createApi({
		agent: "agent",
		machine: "fixture",
		profile: "fixture",
		harness,
		definition: { profile: "fixture" },
		webauthn: service,
	});
	const request = (route: string, body: unknown) =>
		api.request(
			`/v1/approvals/${route}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			},
			{ incoming: { socket: { remoteAddress: "127.0.0.1" } } },
		);
	const key = authenticator();
	const code = service.issueEnrollmentCode();
	const first = await (
		await request("challenge", {
			action: "enroll",
			item: "agent",
			enrollmentCode: code,
		})
	).json();
	const registration = key.registration(first.publicKey.challenge);
	assert.equal(
		(await request("assert", { ...first, response: registration })).status,
		200,
	);
	const second = authenticator();
	const issued = await (
		await request("challenge", { action: "enroll", item: "agent" })
	).json();
	assert.equal(issued.kind, "assertion");
	assert.equal(
		(
			await request("assert", {
				...issued,
				kind: "registration",
				response: second.registration(issued.publicKey.challenge),
			})
		).status,
		403,
	);
	const retry = await (
		await request("challenge", { action: "enroll", item: "agent" })
	).json();
	const assertion = key.assertion(retry.publicKey.challenge);
	const nextResponse = await request("assert", {
		...retry,
		response: assertion,
	});
	assert.equal(nextResponse.status, 200);
	const next = await nextResponse.json();
	assert.equal(next.kind, "registration");
	assert.equal(
		(
			await request("assert", {
				...next,
				response: second.registration(next.publicKey.challenge),
			})
		).status,
		200,
	);
	assert.equal(service.list().length, 2);
	pauseFile("agent");
	const resume = await (
		await request("challenge", { action: "resume", item: "agent" })
	).json();
	const resumeAssertion = second.assertion(resume.publicKey.challenge);
	assert.equal(
		(await request("assert", { ...resume, response: resumeAssertion })).status,
		200,
	);
	const audit = readAudit("agent");
	assert.ok(audit.some((entry) => entry.event === "passkey-approved"));
	assert.equal(
		audit.filter((entry) => entry.event === "passkey-enrolled").length,
		2,
	);
	assert.ok(audit.some((entry) => entry.event === "passkey-refused"));
	const text = JSON.stringify(audit);
	for (const secret of [
		code,
		first.publicKey.challenge,
		retry.publicKey.challenge,
		registration.response.attestationObject,
		assertion.response.signature,
		assertion.response.clientDataJSON,
		resume.publicKey.challenge,
		resumeAssertion.response.signature,
	])
		assert.ok(!text.includes(secret));
});
