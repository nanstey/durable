export type MergeMode = "never" | "human-approval" | "auto-when-safe";
export type PolicyState =
	| "verified"
	| "unverified"
	| "invalid"
	| "unavailable"
	| "none";
export type Risk = "low" | "medium" | "high";
export type AutoMergePolicy = {
	enabled: boolean;
	authors?: string[];
	baseBranches?: string[];
	pathAllow?: string[];
	pathDeny?: string[];
	maxChangedLines?: number;
	maxFiles?: number;
	maxRisk?: Risk;
	requiredChecks?: "github-required" | string[];
	methods?: Array<"squash" | "merge" | "rebase">;
	requireCrossFamilyReview?: boolean;
	requireHumanApproval?: boolean;
	coolingOffMinutes?: number;
	dailyCap?: number;
};
export type MergeDefinition = {
	mode?: MergeMode;
	shadow?: boolean;
	tighten?: Partial<AutoMergePolicy>;
};
export type EffectivePolicy = AutoMergePolicy & {
	mode: MergeMode;
	shadow: boolean;
	state: PolicyState;
	warnings: string[];
};

const HARD_PATH = /^(?:CODEOWNERS|\.github\/|docs\/CODEOWNERS$)/;

/** Validates the neutral gate input, not any source-specific storage format. */
export function validateAutoMergePolicy(value: unknown): AutoMergePolicy {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("policy must be an object");
	const policy = value as AutoMergePolicy;
	if (typeof policy.enabled !== "boolean")
		throw Error("policy.enabled must be boolean");
	if (policy.requireHumanApproval === false && policy.enabled !== true)
		throw Error("requireHumanApproval: false requires enabled: true");
	for (const path of policy.pathAllow ?? []) {
		const expression = path
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replaceAll("*", "[^/]*");
		const matchesHardPath = [
			"CODEOWNERS",
			".github/CODEOWNERS",
			".github/workflows/ci.yml",
			"docs/CODEOWNERS",
		].some((candidate) => new RegExp(`^${expression}$`).test(candidate));
		if (HARD_PATH.test(path) || matchesHardPath)
			throw Error("pathAllow cannot match a hard path");
	}
	for (const key of [
		"authors",
		"baseBranches",
		"pathAllow",
		"pathDeny",
		"methods",
	] as const)
		if (policy[key] !== undefined && !Array.isArray(policy[key]))
			throw Error(`policy.${key} must be an array`);
	for (const key of [
		"maxChangedLines",
		"maxFiles",
		"coolingOffMinutes",
		"dailyCap",
	] as const) {
		const limit = policy[key];
		if (
			limit !== undefined &&
			(!Number.isFinite(limit) || limit < (key === "dailyCap" ? 1 : 0))
		)
			throw Error(
				`policy.${key} must be a ${key === "dailyCap" ? "positive" : "non-negative"} number`,
			);
	}
	return policy;
}

export const noPolicy = (
	definition: MergeDefinition = {},
): EffectivePolicy => ({
	enabled: false,
	mode: definition.mode ?? "human-approval",
	shadow: definition.shadow ?? false,
	state: "none",
	warnings: [],
});
