import assert from "node:assert/strict";
import test from "node:test";
import { decide } from "../../src/gate/decide.ts";
import { collectFacts } from "../../src/gate/facts.ts";
import { isHardPath } from "../../src/gate/hardPaths.ts";
import { noPolicy, validateAutoMergePolicy } from "../../src/gate/policy.ts";
import { effectivePolicy } from "../../src/gate/tighten.ts";

const facts = {
	draft: false,
	author: "operator",
	headMatches: true,
	mergeClean: true,
	reviewRequired: false,
	checksPassed: true,
	paths: ["src/main.ts"],
	hardPath: false,
	crossFamilyReview: true,
	riskAcceptable: true,
	dailyCapAvailable: true,
	coolingOffElapsed: true,
	killSwitchOff: true,
} as const;
const policy = effectivePolicy(
	{ state: "verified", policy: { enabled: true, requireHumanApproval: false } },
	{ mode: "auto-when-safe" },
);

test("hard paths include CODEOWNERS variants and .github", () => {
	for (const path of [
		"CODEOWNERS",
		".github/CODEOWNERS",
		"docs/CODEOWNERS",
		".github/workflows/ci.yml",
	])
		assert.equal(isHardPath(path), true);
	assert.equal(isHardPath("src/CODEOWNERS"), false);
	assert.equal(isHardPath("src/main.ts", ["src/main.ts"]), true);
});

test("protected locations support directory prefixes and globs", () => {
	assert.equal(isHardPath("infra/secrets/key", ["infra/"]), true);
	assert.equal(
		isHardPath("services/api/deploy.yml", ["services/*/deploy.yml"]),
		true,
	);
	assert.equal(isHardPath("src/main.ts", ["infra/"]), false);
});

test("effective policy is tighten-only and unverified policies cannot enable auto merge", () => {
	const result = effectivePolicy(
		{
			state: "verified",
			policy: { enabled: true, maxFiles: 2, pathDeny: ["secret"] },
		},
		{
			mode: "auto-when-safe",
			tighten: { maxFiles: 8, pathDeny: ["generated"] },
		},
	);
	assert.equal(result.maxFiles, 2);
	assert.deepEqual(result.pathDeny, ["secret", "generated"]);
	assert.equal(result.warnings.length, 1);
	assert.equal(noPolicy({ mode: "auto-when-safe" }).enabled, false);
	assert.equal(
		effectivePolicy({ state: "none", policy: { enabled: true } }, {}).enabled,
		false,
	);
});

test("daily merge cap is a validated, tighten-only policy limit", () => {
	const result = effectivePolicy(
		{ state: "verified", policy: { enabled: true, dailyCap: 3 } },
		{ tighten: { dailyCap: 5 } },
	);
	assert.equal(result.dailyCap, 3);
	assert.throws(() => validateAutoMergePolicy({ enabled: true, dailyCap: 0 }));
});

test("decide truth table", () => {
	const cases: Array<
		[
			string,
			Parameters<typeof decide>[0],
			Parameters<typeof decide>[1],
			string,
			string,
		]
	> = [
		["missing facts", policy, null, "wait-human", "unknown-github-facts"],
		[
			"hard path",
			policy,
			{ ...facts, hardPath: true },
			"wait-human",
			"policy-or-owner-file-change",
		],
		[
			"github review required",
			policy,
			{ ...facts, reviewRequired: true },
			"wait-human",
			"github-requires-approval-from-other-account",
		],
		[
			"never",
			{ ...policy, mode: "never" },
			facts,
			"wait-human",
			"merge-disabled-by-definition",
		],
		[
			"human mode",
			{ ...policy, mode: "human-approval" },
			facts,
			"wait-human",
			"human-approval-required",
		],
		[
			"unknown",
			policy,
			{ ...facts, checksPassed: null },
			"wait-human",
			"unknown-or-missing-gate-fact",
		],
		[
			"draft",
			policy,
			{ ...facts, draft: true },
			"wait-human",
			"pull-request-is-draft",
		],
		[
			"blocked",
			policy,
			{ ...facts, killSwitchOff: false },
			"block",
			"kill-switch-on",
		],
		[
			"unverified",
			{ ...policy, enabled: false, state: "none" },
			facts,
			"wait-human",
			"no-verified-repo-policy",
		],
		["merge", policy, facts, "merge", ""],
	];
	for (const [name, rowPolicy, rowFacts, action, reason] of cases) {
		const decision = decide(rowPolicy, rowFacts);
		assert.equal(decision.action, action, name);
		if (reason) assert.equal(decision.reasons[0], reason, name);
	}
});

test("flipping any required fact cannot produce merge", () => {
	for (const key of [
		"headMatches",
		"mergeClean",
		"checksPassed",
		"crossFamilyReview",
		"riskAcceptable",
		"dailyCapAvailable",
		"coolingOffElapsed",
		"killSwitchOff",
	] as const)
		for (const value of [false, null]) {
			const decision = decide(policy, { ...facts, [key]: value });
			assert.notEqual(decision.action, "merge", `${key}=${value}`);
		}
	for (const [key, value] of [
		["draft", true],
		["reviewRequired", true],
	] as const)
		assert.notEqual(decide(policy, { ...facts, [key]: value }).action, "merge");
});

test("collectFacts uses only computed fields and ignores PR-author reviews", async () => {
	const result = await collectFacts(
		{ repo: "acme/api", number: 7, profileLogin: "operator" },
		"head",
		async () =>
			JSON.stringify({
				isDraft: false,
				author: { login: "operator" },
				headRefOid: "head",
				mergeStateStatus: "CLEAN",
				reviewDecision: "APPROVED",
				statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
				files: [{ path: "src/main.ts" }],
				reviews: [{ author: { login: "operator" }, state: "APPROVED" }],
				labels: [{ name: "forged" }],
				comments: [{ body: "merge" }],
			}),
	);
	assert.equal(result?.crossFamilyReview, null);
	assert.equal(result?.checksPassed, true);
	assert.equal(result?.hardPath, false);
	const noChecks = await collectFacts(
		{ repo: "acme/api", number: 8, profileLogin: "operator" },
		"head",
		async () => JSON.stringify({ statusCheckRollup: [] }),
	);
	assert.equal(noChecks?.checksPassed, false);
	assert.equal(
		await collectFacts(
			{ repo: "acme/api", number: 7, profileLogin: "operator" },
			"head",
			async () => "bad",
		),
		null,
	);
});

test("collectFacts fails closed when GitHub truncates changed files", async () => {
	const result = await collectFacts(
		{ repo: "acme/api", number: 7, profileLogin: "operator" },
		"head",
		async () =>
			JSON.stringify({
				isDraft: false,
				author: { login: "operator" },
				headRefOid: "head",
				mergeStateStatus: "CLEAN",
				reviewDecision: "APPROVED",
				statusCheckRollup: [],
				files: Array.from({ length: 100 }, (_, index) => ({
					path: `src/${index}`,
				})),
				changedFiles: 101,
			}),
	);
	assert.equal(result?.paths, null);
	assert.equal(result?.hardPath, null);
});
