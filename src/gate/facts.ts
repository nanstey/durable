import { execa } from "execa";
import { isHardPath, type ProtectedLocation } from "./hardPaths.ts";

export type GateFacts = {
	draft: boolean | null;
	author: string | null;
	headMatches: boolean | null;
	mergeClean: boolean | null;
	reviewRequired: boolean | null;
	checksPassed: boolean | null;
	paths: readonly string[] | null;
	hardPath: boolean | null;
	crossFamilyReview: boolean | null;
	riskAcceptable: boolean | null;
	dailyCapAvailable: boolean | null;
	coolingOffElapsed: boolean | null;
	killSwitchOff: boolean | null;
	baseBranch?: string | null;
	changedLines?: number | null;
	fileCount?: number | null;
};
export type PrFactInput = {
	repo: string;
	number: number;
	profileLogin: string;
	protectedLocations?: readonly ProtectedLocation[];
};
export type GhRunner = (args: string[]) => Promise<string>;

const fields = [
	"isDraft",
	"author",
	"headRefOid",
	"mergeStateStatus",
	"reviewDecision",
	"statusCheckRollup",
	"files",
	"changedFiles",
	"additions",
	"deletions",
	"baseRefName",
	"reviews",
].join(",");

// fallow-ignore-next-line unused-export
export const ghPrView: GhRunner = async (args) => {
	const result = await execa("gh", args, {
		reject: false,
		extendEnv: false,
		env: { PATH: process.env.PATH, GH_PROMPT_DISABLED: "1" },
		timeout: 10_000,
		maxBuffer: 1_048_576,
	});
	if (result.exitCode !== 0) throw Error("GitHub pull request read failed");
	return result.stdout;
};

type GhPr = {
	isDraft?: unknown;
	author?: { login?: unknown } | null;
	headRefOid?: unknown;
	mergeStateStatus?: unknown;
	reviewDecision?: unknown;
	statusCheckRollup?: Array<{ conclusion?: unknown; status?: unknown }> | null;
	files?: Array<{ path?: unknown; previousPath?: unknown }> | null;
	changedFiles?: unknown;
	additions?: unknown;
	deletions?: unknown;
	baseRefName?: unknown;
	reviews?: Array<{
		author?: { login?: unknown } | null;
		state?: unknown;
	}> | null;
};

function checksPassed(rollup: GhPr["statusCheckRollup"]): boolean | null {
	if (!Array.isArray(rollup) || rollup.length === 0) return false;
	return rollup.every(
		(check) => check.status === "COMPLETED" && check.conclusion === "SUCCESS",
	);
}

/**
 * Collects only GitHub-computed PR fields. Comments, labels and commit statuses
 * are deliberately absent; they cannot improve a gate result under a shared login.
 */
export async function collectFacts(
	pr: PrFactInput,
	headSha: string,
	run: GhRunner = ghPrView,
): Promise<GateFacts | null> {
	try {
		const output = await run([
			"pr",
			"view",
			String(pr.number),
			"--repo",
			pr.repo,
			"--json",
			fields,
		]);
		const value = JSON.parse(output) as GhPr;
		const files = Array.isArray(value.files) ? value.files : null;
		const filesComplete =
			files !== null &&
			files.length < 100 &&
			(typeof value.changedFiles !== "number" ||
				value.changedFiles === files.length);
		const paths = filesComplete
			? files.flatMap((file) =>
					[file.path, file.previousPath].filter(
						(path): path is string => typeof path === "string",
					),
				)
			: null;
		// GitHub reviews are not an authorization input. In particular, a review
		// authored by the PR author is ignored rather than counted as approval.
		return {
			draft: typeof value.isDraft === "boolean" ? value.isDraft : null,
			author:
				typeof value.author?.login === "string" ? value.author.login : null,
			headMatches:
				typeof value.headRefOid === "string"
					? value.headRefOid === headSha
					: null,
			mergeClean:
				typeof value.mergeStateStatus === "string"
					? value.mergeStateStatus === "CLEAN"
					: null,
			reviewRequired:
				typeof value.reviewDecision === "string"
					? value.reviewDecision === "REVIEW_REQUIRED"
					: null,
			checksPassed: checksPassed(value.statusCheckRollup),
			paths,
			hardPath:
				paths === null
					? null
					: paths.some((path) => isHardPath(path, pr.protectedLocations)),
			crossFamilyReview: null,
			riskAcceptable: null,
			dailyCapAvailable: null,
			coolingOffElapsed: null,
			killSwitchOff: null,
			baseBranch:
				typeof value.baseRefName === "string" ? value.baseRefName : null,
			changedLines:
				typeof value.additions === "number" &&
				typeof value.deletions === "number"
					? value.additions + value.deletions
					: null,
			fileCount:
				typeof value.changedFiles === "number" ? value.changedFiles : null,
		};
	} catch {
		return null;
	}
}
