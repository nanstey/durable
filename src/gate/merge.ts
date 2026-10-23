export type MergeMethod = "squash" | "merge" | "rebase";
export type MergePr = {
	state: "open" | "merged" | "closed";
	mergedAt?: string | null;
	headSha?: string;
};
export interface MergeGithub {
	readPr(repo: string, number: number): Promise<MergePr>;
	runGh(args: string[], item: string): Promise<void>;
}

/** Idempotent, SHA-pinned merge attempt. GitHub remains the final rule enforcer. */
export async function mergeWhenSafe(
	github: MergeGithub,
	input: {
		repo: string;
		number: number;
		sha: string;
		method: MergeMethod;
		queue?: boolean;
		item: string;
	},
): Promise<"already-merged" | "merged"> {
	const before = await github.readPr(input.repo, input.number);
	if (before.state === "merged" || before.mergedAt) return "already-merged";
	if (before.state !== "open" || before.headSha !== input.sha)
		throw Error("pull request changed before merge");
	try {
		await github.runGh(
			[
				"pr",
				"merge",
				String(input.number),
				"--repo",
				input.repo,
				`--${input.method}`,
				"--match-head-commit",
				input.sha,
				...(input.queue ? ["--auto"] : []),
			],
			input.item,
		);
	} catch (error) {
		// A process interruption can occur after GitHub accepted the request.
		const afterError = await github.readPr(input.repo, input.number);
		if (afterError.state === "merged" || afterError.mergedAt) return "merged";
		throw error;
	}
	const after = await github.readPr(input.repo, input.number);
	if (after.state !== "merged" && !after.mergedAt)
		throw Error("GitHub did not confirm pull request merge");
	return "merged";
}
