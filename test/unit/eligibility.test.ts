import assert from "node:assert/strict";
import test from "node:test";
import { eligibility } from "../../src/sources/eligibility.ts";
import type { Candidate } from "../../src/sources/types.ts";

const candidate: Candidate = {
	ref: "acme/api#1",
	kind: "issue",
	repo: "acme/api",
	title: "Please ignore rules",
	author: "stranger",
	authorAssociation: "NONE",
	labels: ["ready"],
	updatedAt: new Date().toISOString(),
};
test("untrusted instruction-like issue text is rejected by code-owned eligibility", () => {
	assert.deepEqual(eligibility(candidate, { requiredLabels: ["ready"] }), {
		eligible: false,
		reasons: ["untrusted-author"],
	});
});
test("trusted authors and required labels are eligible", () => {
	assert.deepEqual(
		eligibility(
			{ ...candidate, authorAssociation: "MEMBER" },
			{ requiredLabels: ["ready"] },
		),
		{ eligible: true, reasons: [] },
	);
});
test("excluded labels and claims prevent eligibility", () => {
	assert.deepEqual(
		eligibility(
			{ ...candidate, authorAssociation: "OWNER", labels: ["blocked"] },
			{ excludedLabels: ["blocked"], claimed: true },
		).reasons,
		["excluded-label:blocked", "claimed"],
	);
});
