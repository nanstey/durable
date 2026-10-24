import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDef } from "../../src/config/schema.ts";
import type { FixturePolicyScript } from "../../src/gate/policySource.ts";
import { migrateEligible } from "../../src/steward/workItems.ts";
import {
	emptyWorkState,
	WorkRuntime,
	type WorkState,
} from "../../src/steward/workRuntime.ts";
import { isolate } from "../support/harness.ts";
import { candidate, workDependencies } from "../support/work.ts";

for (const variant of [
	"verified",
	"unverified",
	"kill-switch",
	"stale-SHA",
	"red-check",
	"hard-path",
	"shadow",
	"policy-changed",
	"refresh-red",
])
	test(`WorkRuntime fixturePolicies merge path: ${variant}`, async () => {
		const deps = workDependencies(isolate());
		deps.dispatcher.autoReport = true;
		let saved = emptyWorkState();
		const entry = {
			...candidate(),
			state: "eligible" as const,
			reasons: [],
			firstSeen: 0,
			lastSeen: 0,
		};
		migrateEligible({ items: { [entry.ref]: entry } }, saved.work, 0);
		const id = Object.keys(saved.work.items)[0];
		const script: FixturePolicyScript = {
			verifiedBy: "github",
			resolution: {
				state: variant === "unverified" ? "unverified" : "verified",
				fingerprint: "policy-v1",
				ref: "trusted:main",
				policy: {
					enabled: true,
					requireHumanApproval: false,
					authors: ["operator-login"],
					baseBranches: ["main"],
					pathAllow: ["src/*"],
					methods: ["squash"],
				},
			},
		};
		const merges: string[][] = [];
		let factReads = 0;
		const github = Object.assign(deps.github, {
			prView: async () => {
				factReads++;
				if (variant === "policy-changed")
					script.resolution.fingerprint = "policy-v2";
				return JSON.stringify({
					isDraft: false,
					author: { login: "operator-login" },
					headRefOid: variant === "stale-SHA" ? "other-sha" : "reviewed-sha",
					mergeStateStatus: "CLEAN",
					reviewDecision: "APPROVED",
					statusCheckRollup: [
						{
							status: "COMPLETED",
							conclusion:
								variant === "red-check" ||
								(variant === "refresh-red" && factReads > 1)
									? "FAILURE"
									: "SUCCESS",
						},
					],
					files: [
						{
							path:
								variant === "hard-path"
									? ".github/workflows/ci.yml"
									: "src/fix.ts",
						},
					],
					changedFiles: 1,
					additions: 1,
					deletions: 0,
					baseRefName: "main",
				});
			},
			allowedMergeMethods: async () => ["squash" as const],
			baseProtected: async () => true,
			runGh: async (args: string[]) => {
				merges.push(args);
				github.pulls[0].state = "merged";
			},
		});
		let killed = false;
		const definition: AgentDef = {
			profile: "fixture",
			models: { worker: { provider: "faux", model: "one" } },
			scope: {
				repos: [
					{
						slug: "acme/repo",
						base: "main",
						policySource: { kind: "fixture" },
					},
				],
			},
			merge: { mode: "auto-when-safe", shadow: variant === "shadow" },
		};
		const runtime = new WorkRuntime(
			{
				...deps,
				github,
				agent: "agent",
				login: "operator-login",
				definition,
				machine: { name: "fixture", agents: ["agent"] },
				fixturePolicies: { "acme/repo": script },
				env: {},
				checkoutFor: () => "repo",
				scout: async () => "brief",
				notify: async () => {},
				check: async () => {
					if (killed) throw Error("kill switch");
				},
			},
			{
				load: async () => structuredClone(saved),
				save: async (state: WorkState) => {
					saved = structuredClone(state);
				},
			},
		);
		await runtime.tickItem(id, false, false);
		assert.equal(github.pulls.length, 1);
		github.pulls[0].headSha = "reviewed-sha";
		saved.work.items[id].review = {
			sha: "reviewed-sha",
			result: {
				verdict: "approve",
				risk: "low",
				summary: "Reviewed",
				headSha: "reviewed-sha",
			},
			provenance: {
				provider: "anthropic",
				model: "reviewer",
				family: "anthropic",
				entries: 1,
				source: "pi-session-log",
			},
			reviewedAt: Date.now(),
		};
		killed = variant === "kill-switch";
		await runtime.tickItem(id, false, false);
		if (variant === "verified") {
			assert.equal(merges.length, 1);
			assert.ok(merges[0].includes("--squash"));
			assert.equal(
				merges[0][merges[0].indexOf("--match-head-commit") + 1],
				"reviewed-sha",
			);
			assert.equal(factReads, 2);
			assert.equal(saved.work.items[id].gate?.reasons[0], "merge-requested");
		} else {
			assert.equal(merges.length, 0);
			assert.ok(
				saved.work.items[id].gate,
				"must reach runtime gate, not silently fail reconciliation",
			);
			const expectedReason: Record<string, string> = {
				unverified: "no-verified-repo-policy",
				"kill-switch": "kill-switch-on",
				"stale-SHA": "head-sha-changed",
				"red-check": "required-checks-not-passed",
				"hard-path": "policy-or-owner-file-change",
			};
			if (expectedReason[variant])
				assert.ok(
					saved.work.items[id].gate?.reasons.includes(expectedReason[variant]),
				);
			assert.ok(factReads >= 1);
			if (variant === "shadow") assert.ok(saved.work.items[id].gate?.report);
			if (["policy-changed", "refresh-red"].includes(variant))
				assert.ok(saved.work.items[id].gate?.mergeFailure);
		}
	});
