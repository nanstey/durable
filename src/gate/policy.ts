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

export const noPolicy = (
	definition: MergeDefinition = {},
): EffectivePolicy => ({
	enabled: false,
	mode: definition.mode ?? "human-approval",
	shadow: definition.shadow ?? false,
	state: "none",
	warnings: [],
});
