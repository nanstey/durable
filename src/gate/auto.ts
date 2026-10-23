import type { GateFacts } from "./facts.ts";
import type { EffectivePolicy } from "./policy.ts";

export type AutoContext = {
	profileLogin: string;
	baseBranch?: string | null;
	changedLines?: number | null;
	fileCount?: number | null;
	availableMethods?: readonly ("squash" | "merge" | "rebase")[] | null;
	baseProtected?: boolean | null;
};

/** Policy-specific checks that cannot be represented by forgeable GitHub data. */
export function autoConstraintReasons(
	policy: EffectivePolicy,
	facts: GateFacts,
	context: AutoContext,
): string[] {
	const reasons: string[] = [];
	if (facts.author !== context.profileLogin)
		reasons.push("pull-request-author-mismatch");
	if (!policy.authors?.includes(context.profileLogin))
		reasons.push("author-not-allowed");
	if (!policy.baseBranches?.includes(context.baseBranch ?? ""))
		reasons.push("base-branch-not-allowed");
	if (!facts.paths) reasons.push("unknown-changed-paths");
	else {
		for (const path of facts.paths) {
			if (policy.pathDeny?.some((entry) => pathMatches(entry, path)))
				reasons.push("path-denied");
			if (
				policy.pathAllow &&
				!policy.pathAllow.some((entry) => pathMatches(entry, path))
			)
				reasons.push("path-not-allowed");
		}
	}
	if (
		policy.maxChangedLines !== undefined &&
		(context.changedLines === null ||
			context.changedLines === undefined ||
			context.changedLines > policy.maxChangedLines)
	)
		reasons.push("changed-lines-limit");
	if (
		policy.maxFiles !== undefined &&
		(context.fileCount === null ||
			context.fileCount === undefined ||
			context.fileCount > policy.maxFiles)
	)
		reasons.push("file-limit");
	if (
		!policy.methods?.some((method) =>
			context.availableMethods?.includes(method),
		)
	)
		reasons.push("no-allowed-merge-method");
	if (context.baseProtected !== true) reasons.push("base-branch-not-protected");
	return [...new Set(reasons)];
}

export function selectedMergeMethod(
	policy: EffectivePolicy,
	available: readonly ("squash" | "merge" | "rebase")[],
): "squash" | "merge" | "rebase" | undefined {
	return policy.methods?.find((method) => available.includes(method));
}

function pathMatches(pattern: string, path: string) {
	const expression = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replaceAll("*", "[^/]*");
	return new RegExp(`^${expression}$`).test(path);
}
