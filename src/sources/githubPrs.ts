import { execa } from "execa";
import type { Candidate, Source } from "./types.ts";

type GhRunner = (args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;
const runGh: GhRunner = async (args, env) =>
	(await execa("gh", args, { env })).stdout;
type GhPr = {
	number: number;
	title: string;
	author?: { login?: string };
	authorAssociation?: string;
	labels?: Array<{ name: string }>;
	updatedAt: string;
	url: string;
	state: string;
	isDraft?: boolean;
	mergeStateStatus?: string;
	reviewDecision?: string;
	statusCheckRollup?: Array<{ conclusion?: string | null }>;
};

function needs(pr: GhPr) {
	const reasons: string[] = [];
	if (
		pr.statusCheckRollup?.some((check) =>
			["FAILURE", "TIMED_OUT", "CANCELLED"].includes(check.conclusion ?? ""),
		)
	)
		reasons.push("failing-checks");
	if (pr.reviewDecision === "CHANGES_REQUESTED")
		reasons.push("changes-requested");
	if (pr.mergeStateStatus === "BEHIND") reasons.push("behind-base");
	if (pr.mergeStateStatus === "DIRTY") reasons.push("conflicts");
	return reasons;
}

export class GitHubPrsSource implements Source {
	private readonly options: {
		repo: string;
		login: string;
		agentId: string;
		env?: NodeJS.ProcessEnv;
		run?: GhRunner;
	};
	constructor(options: GitHubPrsSource["options"]) {
		this.options = options;
	}
	async poll(): Promise<Candidate[]> {
		const run = this.options.run ?? runGh;
		const output = await run(
			[
				"pr",
				"list",
				"--repo",
				this.options.repo,
				"--state",
				"open",
				"--author",
				this.options.login,
				"--limit",
				"1000",
				"--json",
				"number,title,author,authorAssociation,labels,updatedAt,url,state,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup",
			],
			this.options.env,
		);
		const required = `durable/agent:${this.options.agentId}`;
		return (JSON.parse(output) as GhPr[])
			.filter((pr) =>
				(pr.labels ?? []).some((label) => label.name === required),
			)
			.map((pr) => ({
				ref: `${this.options.repo}#${pr.number}`,
				kind: "pull-request",
				repo: this.options.repo,
				title: pr.title,
				author: pr.author?.login ?? "",
				authorAssociation: pr.authorAssociation,
				labels: [
					...(pr.labels ?? []).map((label) => label.name),
					...needs(pr).map((need) => `durable/needs:${need}`),
				],
				updatedAt: pr.updatedAt,
				bodyRef: `github:${this.options.repo}#${pr.number}`,
				url: pr.url,
				state: pr.state,
			}));
	}
}
