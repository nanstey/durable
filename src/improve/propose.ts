import type { ImprovementPattern } from "./group.ts";

export type ProposalChange = {
	path: string;
	content: string;
	/** Agent-file changes must be limited to this semantic location. */
	location?: "scope.repos[].pipeline";
};
export type ProposalTarget = {
	repo: string;
	base: string;
	kind: "skills" | "durable-agent-file";
	repeatThreshold: number;
};
export type ImprovementGithub = {
	createDraftProposal(input: {
		repo: string;
		base: string;
		branch: string;
		title: string;
		body: string;
		changes: ProposalChange[];
		draft: true;
	}): Promise<{ number: number; url?: string; draft: boolean }>;
};
export type ProposalResult =
	| { state: "disabled" | "below-threshold"; reason: string }
	| { state: "opened"; number: number; url?: string };

const SKILL_PATH =
	/^(?:skills\/[^/]+\/(?:SKILL\.md|prompts\/[^/]+\.md)|prompts\/[^/]+\.md)$/;
const AGENT_FILE_PATH = /^(?:agents|definitions)\/[A-Za-z0-9._-]+\.ya?ml$/;

/** The proposal boundary is code-owned; callers cannot widen it with globs. */
export function assertProposalChanges(
	target: Pick<ProposalTarget, "kind">,
	changes: readonly ProposalChange[],
): void {
	if (changes.length === 0) throw Error("proposal requires a change");
	for (const change of changes) {
		if (
			!change.path ||
			change.path.includes("..") ||
			change.path.startsWith("/")
		)
			throw Error("proposal path is invalid");
		const allowed =
			target.kind === "skills"
				? SKILL_PATH.test(change.path)
				: AGENT_FILE_PATH.test(change.path) &&
					change.location === "scope.repos[].pipeline";
		if (!allowed)
			throw Error(`proposal path is not allowlisted: ${change.path}`);
	}
}

function body(pattern: ImprovementPattern): string {
	return [
		"<!-- durable-improvement: proposal only; human review and merge required -->",
		`Pattern: ${pattern.summary}`,
		`Evidence: ${pattern.evidence.join(", ")}`,
		`Metrics: opened=${pattern.metrics.prsOpened}, merged=${pattern.metrics.prsMerged}, autonomy=${pattern.metrics.autonomy}`,
		"This draft is advice only. It does not alter dispatch, gates, approvals, or merge policy.",
	].join("\n\n");
}

/** Opens one draft PR. It has no merge, dispatch, gate, or state-mutation path. */
export async function proposeImprovement(input: {
	enabled: boolean;
	disabled?: boolean;
	target: ProposalTarget;
	pattern: ImprovementPattern;
	changes: ProposalChange[];
	github: ImprovementGithub;
}): Promise<ProposalResult> {
	if (input.disabled)
		return { state: "disabled", reason: "kill-switch-active" };
	if (!input.enabled)
		return { state: "disabled", reason: "repo-opt-in-disabled" };
	if (input.pattern.count < input.target.repeatThreshold)
		return { state: "below-threshold", reason: "repeat-threshold-not-met" };
	assertProposalChanges(input.target, input.changes);
	const pr = await input.github.createDraftProposal({
		repo: input.target.repo,
		base: input.target.base,
		branch: `durable/improve-${input.pattern.repo.replaceAll("/", "-")}-${input.pattern.kind}`,
		title: `durable: propose improvement for repeated ${input.pattern.kind} runs`,
		body: body(input.pattern),
		changes: input.changes,
		draft: true,
	});
	if (!pr.draft)
		throw Error("improvement proposal must be a draft pull request");
	return { state: "opened", number: pr.number, url: pr.url };
}
