import type { GateDecision } from "./decide.ts";
import type { GateFacts } from "./facts.ts";
import type { PolicyResolution } from "./policySource.ts";

export type ShadowReport = {
	outcome: "would-merge" | "would-not-merge";
	reasons: string[];
	readiness: Record<string, boolean | null>;
	facts: Record<string, boolean | number | string | string[] | null>;
	policy: { kind: string; state: string; ref: string; fingerprint: string };
};

/** Produces a read-only readiness record; it has no GitHub write capability. */
export function shadowReport(
	decision: GateDecision,
	facts: GateFacts,
	resolution: PolicyResolution,
	kind: string,
): ShadowReport {
	const readiness: Record<string, boolean | null> = {
		checks: facts.checksPassed,
		crossFamilyReview: facts.crossFamilyReview,
		paths: facts.hardPath === null ? null : !facts.hardPath,
		mergeable: facts.mergeClean,
		coolingOff: facts.coolingOffElapsed,
	};
	const verified = resolution.state === "verified";
	return {
		outcome:
			verified && decision.action === "merge"
				? "would-merge"
				: "would-not-merge",
		reasons: verified
			? decision.reasons
			: [resolution.state, ...decision.reasons],
		readiness,
		facts: {
			draft: facts.draft,
			author: facts.author,
			headMatches: facts.headMatches,
			mergeClean: facts.mergeClean,
			reviewRequired: facts.reviewRequired,
			checksPassed: facts.checksPassed,
			paths: facts.paths ? [...facts.paths] : null,
			hardPath: facts.hardPath,
			crossFamilyReview: facts.crossFamilyReview,
			riskAcceptable: facts.riskAcceptable,
			dailyCapAvailable: facts.dailyCapAvailable,
			coolingOffElapsed: facts.coolingOffElapsed,
			killSwitchOff: facts.killSwitchOff,
			baseBranch: facts.baseBranch ?? null,
			changedLines: facts.changedLines ?? null,
			fileCount: facts.fileCount ?? null,
		},
		policy: {
			kind,
			state: resolution.state,
			ref: resolution.ref,
			fingerprint: resolution.fingerprint,
		},
	};
}
