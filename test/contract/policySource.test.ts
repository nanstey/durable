import assert from "node:assert/strict";
import test from "node:test";
import { autoConstraintReasons } from "../../src/gate/auto.ts";
import { mergeWhenSafe } from "../../src/gate/merge.ts";
import { validateAutoMergePolicy } from "../../src/gate/policy.ts";
import {
	FixturePolicySource,
	NonePolicySource,
} from "../../src/gate/policySource.ts";
import { shadowReport } from "../../src/gate/shadow.ts";
import { effectivePolicy } from "../../src/gate/tighten.ts";

const policy = {
	enabled: true,
	authors: ["operator"],
	baseBranches: ["main"],
	pathAllow: ["src/*"],
	maxFiles: 2,
	maxChangedLines: 10,
	methods: ["squash" as const],
	requireHumanApproval: false,
};
const facts = {
	draft: false,
	author: "operator",
	headMatches: true,
	mergeClean: true,
	reviewRequired: false,
	checksPassed: true,
	paths: ["src/a.ts"],
	hardPath: false,
	crossFamilyReview: true,
	riskAcceptable: true,
	dailyCapAvailable: true,
	coolingOffElapsed: true,
	killSwitchOff: true,
	baseBranch: "main",
	changedLines: 2,
	fileCount: 1,
};

test("policy source contract: none remains unavailable for auto merge", async () => {
	const source = new NonePolicySource();
	const resolution = await source.resolve({ slug: "acme/repo" });
	assert.equal(resolution.state, "none");
	assert.equal(
		effectivePolicy(resolution, { mode: "auto-when-safe" }).enabled,
		false,
	);
});

test("policy source contract: fixture requires non-forgeable verification evidence", async () => {
	await assert.rejects(
		new FixturePolicySource({
			"acme/repo": {
				resolution: {
					state: "verified",
					policy,
					ref: "steward:fixture",
					fingerprint: "one",
				},
			},
		}).resolve({ slug: "acme/repo" }),
		/approval or GitHub evidence/,
	);
	const source = new FixturePolicySource({
		"acme/repo": {
			resolution: {
				state: "verified",
				policy,
				ref: "steward:fixture",
				fingerprint: "one",
			},
			verifiedBy: "approval",
			protectedLocations: ["policy/"],
		},
	});
	assert.equal(
		(await source.resolve({ slug: "acme/repo" })).ref,
		"steward:fixture",
	);
	assert.deepEqual(source.protectedLocations({ slug: "acme/repo" }), [
		"policy/",
	]);
});

test("policy source records the accepted fingerprint as passkey verification", async () => {
	const source = new FixturePolicySource({
		"acme/repo": {
			resolution: {
				state: "unverified",
				policy,
				ref: "steward:fixture",
				fingerprint: "pending",
			},
		},
	});
	await source.recordVerification({ slug: "acme/repo" }, "pending");
	assert.equal((await source.resolve({ slug: "acme/repo" })).state, "verified");
	await assert.rejects(
		source.recordVerification({ slug: "acme/repo" }, "stale"),
		/policy changed/,
	);
});

test("policy validator refuses unsafe policy shapes", () => {
	assert.throws(
		() =>
			validateAutoMergePolicy({ enabled: false, requireHumanApproval: false }),
		/requires enabled/,
	);
	assert.throws(
		() =>
			validateAutoMergePolicy({
				enabled: true,
				pathAllow: [".github/workflows/x"],
			}),
		/hard path/,
	);
	assert.throws(
		() => validateAutoMergePolicy({ enabled: true, pathAllow: ["*"] }),
		/hard path/,
	);
});

test("policy constraints block stale, hard, review-required and unprotected paths", () => {
	const effective = effectivePolicy(
		{ state: "verified", policy },
		{ mode: "auto-when-safe" },
	);
	assert.deepEqual(
		autoConstraintReasons(effective, facts, {
			profileLogin: "operator",
			baseBranch: "main",
			changedLines: 2,
			fileCount: 1,
			availableMethods: ["squash"],
			baseProtected: true,
		}),
		[],
	);
	assert.ok(
		autoConstraintReasons(
			effective,
			{ ...facts, headMatches: false },
			{
				profileLogin: "operator",
				baseBranch: "main",
				changedLines: 2,
				fileCount: 1,
				availableMethods: ["squash"],
				baseProtected: false,
			},
		).includes("base-branch-not-protected"),
	);
	const report = shadowReport(
		{ action: "merge", reasons: [] },
		{ ...facts, hardPath: true },
		{ state: "unverified", ref: "steward", fingerprint: "next" },
		"fixture",
	);
	assert.equal(report.outcome, "would-not-merge");
	assert.ok(report.reasons.includes("unverified"));
});

test("merge executor is SHA-pinned, idempotent, and confirms the result", async () => {
	let state: "open" | "merged" = "open";
	let calls = 0;
	const github = {
		readPr: async () => ({ state, headSha: "sha" }),
		runGh: async (args: string[]) => {
			calls++;
			assert.ok(args.includes("--match-head-commit"));
			assert.ok(args.includes("sha"));
			state = "merged";
		},
	};
	assert.equal(
		await mergeWhenSafe(github, {
			repo: "acme/repo",
			number: 1,
			sha: "sha",
			method: "squash",
			item: "item",
		}),
		"merged",
	);
	assert.equal(
		await mergeWhenSafe(github, {
			repo: "acme/repo",
			number: 1,
			sha: "sha",
			method: "squash",
			item: "item",
		}),
		"already-merged",
	);
	assert.equal(calls, 1);
	await assert.rejects(
		mergeWhenSafe(
			{
				...github,
				readPr: async () => ({ state: "open" as const, headSha: "new" }),
			},
			{
				repo: "acme/repo",
				number: 1,
				sha: "sha",
				method: "squash",
				item: "item",
			},
		),
		/changed/,
	);
});
