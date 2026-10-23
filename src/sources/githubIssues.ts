import { execa } from "execa";
import type { Candidate, Source } from "./types.ts";

type GhIssue = {
	number: number;
	title: string;
	author?: { login?: string };
	authorAssociation?: string;
	labels?: Array<{ name: string }>;
	updatedAt: string;
	url: string;
	state: string;
};
type GhRunner = (args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;
const runGh: GhRunner = async (args, env) =>
	(await execa("gh", args, { env })).stdout;

export class GitHubIssuesSource implements Source {
	private nextPoll = 0;
	private failures = 0;
	private readonly options: {
		repo: string;
		labels?: string[];
		exclude?: string[];
		intervalMs?: number;
		env?: NodeJS.ProcessEnv;
		run?: GhRunner;
		onRateLimit?: (remaining: number) => void;
		now?: () => number;
		random?: () => number;
	};
	constructor(options: GitHubIssuesSource["options"]) {
		this.options = options;
	}
	async poll(): Promise<Candidate[]> {
		const interval = this.options.intervalMs ?? 30_000;
		const now = this.options.now?.() ?? Date.now();
		if (now < this.nextPoll) return [];
		const run = this.options.run ?? runGh;
		const args = [
			"issue",
			"list",
			"--repo",
			this.options.repo,
			"--state",
			"open",
			"--limit",
			"1000",
			"--json",
			"number,title,author,authorAssociation,labels,updatedAt,url,state",
			...(this.options.labels?.flatMap((label) => ["--label", label]) ?? []),
		];
		try {
			const [output, rateLimit] = await Promise.all([
				run(args, this.options.env),
				run(
					["api", "rate_limit", "--jq", ".resources.core.remaining"],
					this.options.env,
				).catch(() => ""),
			]);
			this.failures = 0;
			this.nextPoll = now + interval;
			const remaining = Number(rateLimit.trim());
			if (Number.isFinite(remaining)) this.options.onRateLimit?.(remaining);
			const excluded = new Set(
				(this.options.exclude ?? []).map((label) => label.toLowerCase()),
			);
			return (JSON.parse(output) as GhIssue[])
				.filter(
					(issue) =>
						!(issue.labels ?? []).some((label) =>
							excluded.has(label.name.toLowerCase()),
						),
				)
				.map((issue) => ({
					ref: `${this.options.repo}#${issue.number}`,
					kind: "issue",
					repo: this.options.repo,
					title: issue.title,
					author: issue.author?.login ?? "",
					authorAssociation: issue.authorAssociation,
					labels: (issue.labels ?? []).map((label) => label.name),
					updatedAt: issue.updatedAt,
					bodyRef: `github:${this.options.repo}#${issue.number}`,
					url: issue.url,
					state: issue.state,
				}));
		} catch (error) {
			this.failures++;
			const multiplier = 2 ** Math.min(this.failures, 6);
			const jitter = 0.8 + (this.options.random?.() ?? Math.random()) * 0.4;
			this.nextPoll = now + Math.round(interval * multiplier * jitter);
			throw error;
		}
	}
}
