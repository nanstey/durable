import assert from "node:assert/strict";
import test from "node:test";
import {
	ApprovalWebAuthn,
	type ApprovalAction,
} from "../../src/approval/webauthn.ts";
import { authenticator } from "../support/authenticator.ts";
import { isolate } from "../support/harness.ts";

const config = { rpId: "console.test", origin: "https://console.test" };
async function enrolled(now: () => number = Date.now) {
	isolate();
	const service = new ApprovalWebAuthn("agent", config, now);
	const key = authenticator();
	const code = service.issueEnrollmentCode();
	const registration = await service.options("enroll", "agent", "enroll", code);
	await service.verifyEnrollment(
		registration.id,
		key.registration(registration.options.challenge),
	);
	return { service, key, code };
}

test("real ES256 enrollment, code single use/expiry, second-key assertion and revocation", async () => {
	let now = 0;
	const { service, key, code } = await enrolled(() => now);
	assert.equal(service.list()[0].id, key.id);
	service.revoke(key.id);
	await assert.rejects(service.options("enroll", "agent", "enroll", code));
	const expired = service.issueEnrollmentCode();
	now += 300001;
	await assert.rejects(service.options("enroll", "agent", "enroll", expired));
});

test("second key requires a real existing-key assertion; registration cannot bypass it", async () => {
	const { service, key } = await enrolled();
	const second = authenticator();
	const issued = await service.options("enroll", "agent", "enroll");
	assert.equal(issued.kind, "assertion");
	await assert.rejects(
		service.verifyEnrollment(
			issued.id,
			second.registration(issued.options.challenge),
		),
	);
	const retry = await service.options("enroll", "agent", "enroll");
	const registration = await service.verifyEnrollmentAssertion(
		retry.id,
		key.assertion(retry.options.challenge),
	);
	await service.verifyEnrollment(
		registration.id,
		second.registration(registration.options.challenge),
	);
	assert.equal(service.list().length, 2);
	await assert.rejects(
		service.verifyEnrollmentAssertion(
			retry.id,
			key.assertion(retry.options.challenge),
		),
	);
});

for (const variant of [
	"valid",
	"wrong-origin",
	"wrong-rpId",
	"replayed-counter",
	"synced-zero",
	"reused",
	"expired",
	"stale-SHA",
	"stale-policy-fingerprint",
	"wrong-item",
	"revoked",
	"cross-action",
	"older-holdEpoch",
])
	test(`real WebAuthn assertion: ${variant}`, async () => {
		let now = 0;
		const { service, key } = await enrolled(() => now);
		const action: ApprovalAction =
			variant === "older-holdEpoch"
				? "release"
				: variant === "stale-policy-fingerprint"
					? "verify-policy"
					: "approve";
		const binding = variant === "older-holdEpoch" ? 2 : "head-sha";
		const issued = await service.options(action, "item", binding);
		const response = key.assertion(
			issued.options.challenge,
			variant === "replayed-counter" ? 1 : 0,
			{
				...(variant === "wrong-origin"
					? { origin: "https://attacker.test" }
					: {}),
				...(variant === "wrong-rpId" ? { rpId: "attacker.test" } : {}),
			},
		);
		if (variant === "revoked") service.revoke(key.id);
		if (variant === "expired") now += 120001;
		if (variant === "reused" || variant === "replayed-counter") {
			await service.verifyAssertion(
				issued.id,
				action,
				"item",
				binding,
				response,
			);
			if (variant === "replayed-counter") {
				const retry = await service.options(action, "item", binding);
				await assert.rejects(
					service.verifyAssertion(
						retry.id,
						action,
						"item",
						binding,
						key.assertion(retry.options.challenge, 1),
					),
				);
				return;
			}
		}
		const verify = () =>
			service.verifyAssertion(
				issued.id,
				variant === "cross-action" ? "resume" : action,
				variant === "wrong-item" ? "other-item" : "item",
				variant === "stale-SHA" || variant === "stale-policy-fingerprint"
					? "new-sha"
					: variant === "older-holdEpoch"
						? 3
						: binding,
				response,
			);
		if (["valid", "synced-zero"].includes(variant)) {
			await verify();
			const retry = await service.options(action, "item", binding);
			await service.verifyAssertion(
				retry.id,
				action,
				"item",
				binding,
				key.assertion(retry.options.challenge),
			);
		} else await assert.rejects(verify);
	});

for (const [from, to, otherItem] of [
	["release", "release", true],
	["release", "approve", false],
	["release", "resume", false],
	["approve", "release", false],
] as const)
	test(`signed ${from} cannot be reused for ${to}${otherItem ? " on another item" : ""}`, async () => {
		const { service, key } = await enrolled();
		const issued = await service.options(from, "item-a", 1);
		await assert.rejects(
			service.verifyAssertion(
				issued.id,
				to,
				otherItem ? "item-b" : "item-a",
				1,
				key.assertion(issued.options.challenge),
			),
		);
	});
