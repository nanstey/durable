import type {
	AutoMergePolicy,
	EffectivePolicy,
	MergeDefinition,
	PolicyState,
} from "./policy.ts";

const riskRank = { low: 0, medium: 1, high: 2 } as const;
const setIntersection = (left: string[], right: string[]) =>
	left.filter((value) => right.includes(value));
const setUnion = (left: string[], right: string[]) => [
	...new Set([...left, ...right]),
];

/**
 * Applies agent-definition restrictions to a source policy. This function never
 * enables auto-merge: an absent or unverified source remains disabled.
 */
export function effectivePolicy(
	resolved: { state: PolicyState; policy?: AutoMergePolicy },
	definition: MergeDefinition = {},
): EffectivePolicy {
	const base = resolved.policy ?? { enabled: false };
	const tighten = definition.tighten ?? {};
	const warnings: string[] = [];
	const minimum = (
		key: "maxChangedLines" | "maxFiles" | "coolingOffMinutes" | "dailyCap",
	) => {
		const policyValue = base[key];
		const definitionValue = tighten[key];
		if (definitionValue === undefined) return policyValue;
		if (policyValue === undefined) return definitionValue;
		if (key === "coolingOffMinutes") {
			if (definitionValue < policyValue)
				warnings.push(`tighten.${key} was clamped to the repository policy`);
			return Math.max(policyValue, definitionValue);
		}
		if (definitionValue > policyValue)
			warnings.push(`tighten.${key} was clamped to the repository policy`);
		return Math.min(policyValue, definitionValue);
	};
	const intersect = <T extends string>(
		key: "authors" | "baseBranches" | "pathAllow" | "methods",
		policyValue: T[] | undefined,
		definitionValue: T[] | undefined,
	) => {
		if (!policyValue) return definitionValue;
		if (!definitionValue) return policyValue;
		const result = setIntersection(policyValue, definitionValue) as T[];
		if (result.length < definitionValue.length)
			warnings.push(`tighten.${key} was clamped to the repository policy`);
		return result;
	};
	const policyRisk = base.maxRisk;
	const definitionRisk = tighten.maxRisk;
	let maxRisk = definitionRisk ?? policyRisk;
	if (
		policyRisk &&
		definitionRisk &&
		riskRank[definitionRisk] > riskRank[policyRisk]
	) {
		warnings.push("tighten.maxRisk was clamped to the repository policy");
		maxRisk = policyRisk;
	}
	return {
		...base,
		enabled: resolved.state === "verified" && base.enabled === true,
		mode: definition.mode ?? "human-approval",
		shadow: definition.shadow ?? definition.mode === "auto-when-safe",
		state: resolved.state,
		warnings,
		authors: intersect("authors", base.authors, tighten.authors),
		baseBranches: intersect(
			"baseBranches",
			base.baseBranches,
			tighten.baseBranches,
		),
		pathAllow: intersect("pathAllow", base.pathAllow, tighten.pathAllow),
		pathDeny: setUnion(base.pathDeny ?? [], tighten.pathDeny ?? []),
		methods: intersect("methods", base.methods, tighten.methods),
		maxChangedLines: minimum("maxChangedLines"),
		maxFiles: minimum("maxFiles"),
		coolingOffMinutes: minimum("coolingOffMinutes"),
		dailyCap: minimum("dailyCap"),
		maxRisk,
		requireCrossFamilyReview:
			base.requireCrossFamilyReview === true ||
			tighten.requireCrossFamilyReview === true,
		requireHumanApproval:
			base.requireHumanApproval !== false ||
			tighten.requireHumanApproval === true,
	};
}
