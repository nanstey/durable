import type { PrMonitorGithub } from "../dispatch/monitor.ts";
import { audit } from "./audit.ts";
import type { ClaimComment, ClaimGithub } from "./claims.ts";
import type { ProcessManager } from "./procs.ts";

export type PullRequest = {
	number: number;
	state: "open" | "merged" | "closed";
	url?: string;
	headSha?: string;
	mergedAt?: string | null;
	/** GitHub commit author logins; omitted means the fact is unavailable. */
	commitAuthors?: string[];
};
export interface WorkGithub extends ClaimGithub, PrMonitorGithub {
	readPr(repo: string, number: number): Promise<PullRequest>;
	runGh?(args: string[], item: string): Promise<void>;
	allowedMergeMethods?(
		repo: string,
	): Promise<Array<"squash" | "merge" | "rebase">>;
	baseProtected?(repo: string, branch: string): Promise<boolean>;
	readIntake(
		repo: string,
		ref: string,
		kind: "issue" | "pull-request",
	): Promise<string>;
	attributePr(repo: string, number: number, item: string): Promise<void>;
	readyPr?(repo: string, number: number, item: string): Promise<void>;
	mirrorGate?(
		repo: string,
		number: number,
		sha: string,
		report: string,
		item: string,
	): Promise<void>;
	createSpecPr?(input: {
		repo: string;
		item: string;
		branch: string;
		base: string;
		title: string;
		body: string;
	}): Promise<PullRequest>;
}
export const prMarker = (agent: string, item: string) =>
	`<!-- durable-item agent=${agent} item=${item} -->`;
export const prFooter = (agent: string, login: string) =>
	`Opened by durable agent ${agent} for ${login}; not yet reviewed by a human.`;

/** Profile-owned gh adapter. Writes are fenced and audited before and after the effect. */
export class Github implements WorkGithub {
	private readonly options: {
		agent: string;
		login: string;
		env: NodeJS.ProcessEnv;
		processes: Pick<ProcessManager, "launch">;
		itemForIssue: (repo: string, issue: number) => string | undefined;
	};
	constructor(options: Github["options"]) {
		this.options = options;
	}
	private readonly commentItems = new Map<number, string>();
	private async request<T>(
		repo: string,
		path: string,
		method = "GET",
		fields: Record<string, unknown> = {},
		item?: string,
	): Promise<T> {
		const args = ["gh", "api", path, "--method", method];
		for (const [key, value] of Object.entries(fields)) {
			if (Array.isArray(value))
				for (const entry of value) args.push("-f", `${key}[]=${entry}`);
			else
				args.push(typeof value === "boolean" ? "-F" : "-f", `${key}=${value}`);
		}
		const write = method !== "GET";
		if (write && !item) throw Error("GitHub write requires a work-item fence");
		if (write)
			audit(this.options.agent, {
				event: "github-write-intent",
				repo,
				path,
				method,
				item,
			});
		const result = await this.options.processes.launch(args, this.options.env, {
			item,
			allowWhenDisabled: !write,
		});
		if (write)
			audit(this.options.agent, {
				event: "github-write",
				repo,
				path,
				method,
				item,
				ok: result.exitCode === 0,
			});
		if (result.exitCode !== 0)
			throw Error(
				"GitHub request failed; inspect connectivity and repository permissions",
			);
		return (result.stdout.trim() ? JSON.parse(result.stdout) : undefined) as T;
	}
	private issueItem(repo: string, issue: number) {
		return this.options.itemForIssue(repo, issue);
	}
	private async ensureLabel(repo: string, label: string, item?: string) {
		const path = `repos/${repo}/labels/${encodeURIComponent(label)}`;
		try {
			await this.request(repo, path);
			return;
		} catch {
			/* Missing label or failed read: a write must still be confirmed. */
		}
		try {
			await this.request(
				repo,
				`repos/${repo}/labels`,
				"POST",
				{ name: label, color: "5319e7" },
				item,
			);
		} catch {
			await this.request(repo, path);
		}
	}
	async addLabel(repo: string, issue: number, label: string) {
		await this.ensureLabel(repo, label, this.issueItem(repo, issue));
		await this.ensureLabel(
			repo,
			`durable/agent:${this.options.agent}`,
			this.issueItem(repo, issue),
		);
		await this.request(
			repo,
			`repos/${repo}/issues/${issue}/labels`,
			"POST",
			{ labels: [label] },
			this.issueItem(repo, issue),
		);
	}
	async removeLabel(repo: string, issue: number, label: string) {
		const labels = await this.request<Array<{ name: string }>>(
			repo,
			`repos/${repo}/issues/${issue}/labels`,
		);
		if (!labels.some((entry) => entry.name === label)) return;
		await this.request(
			repo,
			`repos/${repo}/issues/${issue}/labels/${encodeURIComponent(label)}`,
			"DELETE",
			{},
			this.issueItem(repo, issue),
		);
	}
	async createComment(repo: string, issue: number, body: string) {
		return this.request<ClaimComment>(
			repo,
			`repos/${repo}/issues/${issue}/comments`,
			"POST",
			{ body },
			this.issueItem(repo, issue),
		);
	}
	async listComments(repo: string, issue: number) {
		const comments: ClaimComment[] = [];
		for (let page = 1; ; page++) {
			const batch = await this.request<
				Array<{
					id: number;
					body: string;
					user?: { login?: string };
					author_association?: string;
					updated_at?: string;
				}>
			>(
				repo,
				`repos/${repo}/issues/${issue}/comments?per_page=100&page=${page}`,
			);
			comments.push(
				...batch.map((comment) => ({
					id: comment.id,
					body: comment.body,
					login: comment.user?.login,
					authorAssociation: comment.author_association,
					updatedAt: comment.updated_at,
				})),
			);
			const item = this.issueItem(repo, issue);
			if (item)
				for (const comment of batch) this.commentItems.set(comment.id, item);
			if (batch.length < 100) return comments;
		}
	}
	async deleteComment(repo: string, id: number, item?: string) {
		await this.request(
			repo,
			`repos/${repo}/issues/comments/${id}`,
			"DELETE",
			{},
			item ?? this.commentItems.get(id),
		);
	}
	async updateComment(repo: string, id: number, body: string, item?: string) {
		await this.request(
			repo,
			`repos/${repo}/issues/comments/${id}`,
			"PATCH",
			{ body },
			item ?? this.commentItems.get(id),
		);
	}
	async readPr(repo: string, number: number): Promise<PullRequest> {
		const pr = await this.request<{
			number: number;
			state: string;
			merged_at: string | null;
			html_url: string;
			head?: { sha?: string };
		}>(repo, `repos/${repo}/pulls/${number}`);
		const commits = await this.request<
			Array<{ author?: { login?: string } | null }>
		>(repo, `repos/${repo}/pulls/${number}/commits?per_page=100`)
			.then((entries) => entries)
			.catch(() => undefined);
		const authors = commits
			?.map((commit) => commit.author?.login)
			.filter((login): login is string => typeof login === "string");
		return {
			number: pr.number,
			state: pr.merged_at
				? "merged"
				: pr.state === "closed"
					? "closed"
					: "open",
			url: pr.html_url,
			headSha: pr.head?.sha,
			mergedAt: pr.merged_at,
			...(authors && authors.length === commits?.length && commits.length < 100
				? { commitAuthors: authors }
				: {}),
		};
	}
	async allowedMergeMethods(
		repo: string,
	): Promise<Array<"squash" | "merge" | "rebase">> {
		const settings = await this.request<{
			squash_merge_allowed?: boolean;
			merge_commit_allowed?: boolean;
			rebase_merge_allowed?: boolean;
		}>(repo, `repos/${repo}`);
		return [
			...(settings.squash_merge_allowed ? ["squash" as const] : []),
			...(settings.merge_commit_allowed ? ["merge" as const] : []),
			...(settings.rebase_merge_allowed ? ["rebase" as const] : []),
		];
	}
	async baseProtected(repo: string, branch: string): Promise<boolean> {
		try {
			return (
				(
					await this.request<{ protected?: boolean }>(
						repo,
						`repos/${repo}/branches/${encodeURIComponent(branch)}`,
					)
				).protected === true
			);
		} catch {
			return false;
		}
	}
	async runGh(args: string[], item: string) {
		const result = await this.options.processes.launch(
			["gh", ...args],
			this.options.env,
			{ item },
		);
		if (result.exitCode !== 0) throw Error("GitHub command failed");
	}
	async findDraftPr(input: { repo: string; branch: string; marker: string }) {
		const pulls = await this.request<
			Array<{ number: number; body: string; labels: Array<{ name: string }> }>
		>(
			input.repo,
			`repos/${input.repo}/pulls?state=all&head=${encodeURIComponent(`${input.repo.split("/")[0]}:${input.branch}`)}&per_page=100`,
		);
		const found = pulls.find(
			(pr) =>
				pr.body?.includes(input.marker) &&
				pr.labels.some(
					(label) => label.name === `durable/agent:${this.options.agent}`,
				),
		);
		return found ? this.readPr(input.repo, found.number) : undefined;
	}
	async readIntake(repo: string, ref: string, kind: "issue" | "pull-request") {
		const number = intakeNumber(ref);
		const data = await this.request<{ body?: string }>(
			repo,
			`repos/${repo}/${kind === "issue" ? "issues" : "pulls"}/${number}`,
		);
		return data.body ?? "";
	}
	async attributePr(repo: string, number: number, item: string) {
		const pr = await this.request<{
			body: string;
			draft: boolean;
			labels: Array<{ name: string }>;
		}>(repo, `repos/${repo}/pulls/${number}`);
		if (!pr.draft)
			throw Error("worker PR is not a draft; human review required");
		const footer = prFooter(this.options.agent, this.options.login);
		const marker = prMarker(this.options.agent, item);
		if (!pr.body?.includes(footer) || !pr.body?.includes(marker))
			await this.request(
				repo,
				`repos/${repo}/pulls/${number}`,
				"PATCH",
				{ body: `${pr.body ?? ""}\n\n${footer}\n${marker}` },
				item,
			);
		if (
			!pr.labels.some(
				(label) => label.name === `durable/agent:${this.options.agent}`,
			)
		)
			await this.request(
				repo,
				`repos/${repo}/issues/${number}/labels`,
				"POST",
				{ labels: [`durable/agent:${this.options.agent}`] },
				item,
			);
	}
	async createSpecPr(input: {
		repo: string;
		item: string;
		branch: string;
		base: string;
		title: string;
		body: string;
	}): Promise<PullRequest> {
		const owner = input.repo.split("/", 1)[0];
		const pulls = await this.request<Array<{ number: number; body?: string }>>(
			input.repo,
			`repos/${input.repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${input.branch}`)}`,
		);
		const marker = `<!-- durable-spec agent=${this.options.agent} item=${input.item} -->`;
		const existing = pulls.find((pull) => pull.body?.includes(marker));
		if (existing) return this.readPr(input.repo, existing.number);
		const base = await this.request<{ object: { sha: string } }>(
			input.repo,
			`repos/${input.repo}/git/ref/heads/${encodeURIComponent(input.base)}`,
		);
		const blob = await this.request<{ sha: string }>(
			input.repo,
			`repos/${input.repo}/git/blobs`,
			"POST",
			{ content: input.body, encoding: "utf-8" },
			input.item,
		);
		const tree = await this.request<{ sha: string }>(
			input.repo,
			`repos/${input.repo}/git/trees`,
			"POST",
			{
				base_tree: base.object.sha,
				"tree[0][path]": `.durable/specs/${input.item}.md`,
				"tree[0][mode]": "100644",
				"tree[0][type]": "blob",
				"tree[0][sha]": blob.sha,
			},
			input.item,
		);
		const commit = await this.request<{ sha: string }>(
			input.repo,
			`repos/${input.repo}/git/commits`,
			"POST",
			{
				message: `durable: draft spec for ${input.item}`,
				tree: tree.sha,
				parents: base.object.sha,
			},
			input.item,
		);
		await this.request(
			input.repo,
			`repos/${input.repo}/git/refs`,
			"POST",
			{ ref: `refs/heads/${input.branch}`, sha: commit.sha },
			input.item,
		);
		const pr = await this.request<{
			number: number;
			html_url: string;
			head: { sha: string };
		}>(
			input.repo,
			`repos/${input.repo}/pulls`,
			"POST",
			{
				title: input.title,
				head: input.branch,
				base: input.base,
				draft: true,
				body: `${marker}\n\n${input.body}`,
			},
			input.item,
		);
		return {
			number: pr.number,
			url: pr.html_url,
			headSha: pr.head.sha,
			state: "open",
		};
	}
	async readyPr(repo: string, number: number, item: string) {
		const [owner, name] = repo.split("/");
		const query = `mutation($owner: String!, $name: String!, $number: Int!) {
			repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
		}`;
		const lookup = await this.options.processes.launch(
			[
				"gh",
				"api",
				"graphql",
				"-f",
				`query=${query}`,
				"-F",
				`owner=${owner}`,
				"-F",
				`name=${name}`,
				"-F",
				`number=${number}`,
			],
			this.options.env,
			{ item },
		);
		if (lookup.exitCode !== 0) throw Error("GitHub pull request lookup failed");
		const id = (
			JSON.parse(lookup.stdout) as {
				data?: { repository?: { pullRequest?: { id?: string } } };
			}
		).data?.repository?.pullRequest?.id;
		if (!id) throw Error("GitHub pull request node ID is unavailable");
		const mutation =
			"mutation($pullRequestId: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) { pullRequest { isDraft } } }";
		const result = await this.options.processes.launch(
			[
				"gh",
				"api",
				"graphql",
				"-f",
				`query=${mutation}`,
				"-f",
				`pullRequestId=${id}`,
			],
			this.options.env,
			{ item },
		);
		if (result.exitCode !== 0)
			throw Error("GitHub could not mark pull request ready");
		const draft = (
			JSON.parse(result.stdout) as {
				data?: {
					markPullRequestReadyForReview?: {
						pullRequest?: { isDraft?: boolean };
					};
				};
			}
		).data?.markPullRequestReadyForReview?.pullRequest?.isDraft;
		if (draft !== false) throw Error("GitHub pull request is still draft");
	}
	async mirrorGate(
		repo: string,
		number: number,
		sha: string,
		report: string,
		item: string,
	) {
		const marker = `<!-- durable-gate sha=${sha} -->`;
		const comments = await this.listComments(repo, number);
		if (
			!comments.some(
				(comment) =>
					comment.body.includes(marker) &&
					comment.login?.toLowerCase() === this.options.login.toLowerCase(),
			)
		)
			await this.createComment(repo, number, `${marker}\n${report}`);
		try {
			await this.request(
				repo,
				`repos/${repo}/statuses/${sha}`,
				"POST",
				{
					state: "pending",
					context: "durable/review",
					description: "Durable review awaits human approval",
				},
				item,
			);
		} catch {
			audit(this.options.agent, { event: "gate-status-skipped", item, sha });
		}
	}
	async commentOnce(input: { repo: string; item: string; body: string }) {
		const issue = Number(input.item.match(/\d+$/)?.[0]);
		if (!Number.isSafeInteger(issue))
			throw Error("comment target requires an intake number");
		const marker = input.body.split("\n")[0];
		if (
			!(await this.listComments(input.repo, issue)).some((comment) =>
				comment.body.includes(marker),
			)
		)
			await this.createComment(input.repo, issue, input.body);
	}
}
export function intakeNumber(ref: string): number {
	const number = Number(ref.match(/(?:^|[#/])([0-9]+)$/)?.[1]);
	if (!Number.isSafeInteger(number) || number <= 0)
		throw Error("intake reference requires an issue or PR number");
	return number;
}
