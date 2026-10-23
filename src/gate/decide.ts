import type { GateFacts } from "./facts.ts";
import type { EffectivePolicy } from "./policy.ts";

export type GateAction = "merge" | "wait-human" | "block";
export type GateDecision = {
	action: GateAction;
	reasons: string[];
	shadow?: boolean;
};

const wait = (...reasons: string[]): GateDecision => ({
	action: "wait-human",
	reasons,
});

/** Pure gate decision. The caller owns auditing and any future merge executor. */
export function decide(
	policy: EffectivePolicy,
	facts: GateFacts | null,
): GateDecision {
	if (!facts) return wait("unknown-github-facts");
	if (facts.hardPath === true) return wait("policy-or-owner-file-change");
	if (facts.reviewRequired === true)
		return wait("github-requires-approval-from-other-account");
	if (policy.mode === "never") return wait("merge-disabled-by-definition");
	if (policy.mode === "human-approval") return wait("human-approval-required");
	if (facts.killSwitchOff === false)
		return { action: "block", reasons: ["kill-switch-on"] };
	if (Object.values(facts).some((value) => value == null))
		return wait("unknown-or-missing-gate-fact");
	if (facts.draft) return wait("pull-request-is-draft");
	if (!facts.headMatches) return wait("head-sha-changed");
	if (!facts.mergeClean) return wait("github-merge-state-not-clean");
	if (!facts.checksPassed) return wait("required-checks-not-passed");
	if (!facts.crossFamilyReview) return wait("cross-family-review-missing");
	if (!facts.riskAcceptable) return wait("review-risk-not-acceptable");
	if (!facts.dailyCapAvailable) return wait("daily-merge-cap-reached");
	if (!facts.coolingOffElapsed) return wait("cooling-off-not-elapsed");
	if (!facts.killSwitchOff)
		return { action: "block", reasons: ["kill-switch-on"] };
	if (!policy.enabled || policy.state !== "verified")
		return wait("no-verified-repo-policy");
	if (policy.requireHumanApproval)
		return wait("repository-policy-requires-human-approval");
	return {
		action: "merge",
		reasons: [],
		...(policy.shadow ? { shadow: true } : {}),
	};
}
