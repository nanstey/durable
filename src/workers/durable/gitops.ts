import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prFooter, prMarker } from "../../steward/github.ts";
import type { ProcessManager } from "../../steward/procs.ts";
import type { JobSpec } from "../kind.ts";
import { workerOperation } from "./operation.ts";

export type GitOperation = "push_branch" | "open_draft_pr";
export type OperationIntent = {
	attemptId: string;
	op: GitOperation;
	repo: string;
	branch: string;
	base: string;
	commitSha: string;
	expectedRemoteHead?: string;
	state: "intent" | "confirmed" | "conflict";
	pr?: number;
};
export interface OperationStore {
	read(
		attemptId: string,
		op: GitOperation,
	): Promise<OperationIntent | undefined>;
	write(intent: OperationIntent): Promise<void>;
}
export type RemoteHead = (
	repo: string,
	branch: string,
) => Promise<string | undefined>;

export async function reconcilePush(
	store: OperationStore,
	intent: OperationIntent,
	remoteHead: RemoteHead,
): Promise<"confirmed" | "retry" | "conflict"> {
	const head = await remoteHead(intent.repo, intent.branch);
	const state =
		head === intent.commitSha
			? "confirmed"
			: head === intent.expectedRemoteHead
				? "retry"
				: "conflict";
	if (state !== "retry") await store.write({ ...intent, state });
	return state;
}

function gitInvocation(argv: string[]): string[] {
	return [
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"core.fsmonitor=false",
		...argv,
	];
}
export type DraftPr = {
	number: number;
	headSha: string;
	body: string;
	draft: boolean;
};
export interface WorkerGithub {
	remoteHead: RemoteHead;
	findPr(repo: string, branch: string): Promise<DraftPr[]>;
	createPr(input: {
		repo: string;
		branch: string;
		base: string;
		title: string;
		body: string;
		item: string;
		attemptId: string;
	}): Promise<DraftPr>;
}
export interface WorkerGit {
	commit(job: JobSpec, message: string): Promise<string>;
	head(job: JobSpec): Promise<string>;
	push(job: JobSpec, intent: OperationIntent): Promise<void>;
}

/** One flight per item/op. Persisted intent is reusable after interruption, never a permanent busy fence. */
export class GitOperations {
	private readonly flights = new Map<
		string,
		Promise<OperationIntent | undefined>
	>();
	private readonly options: {
		store: OperationStore;
		git: WorkerGit;
		github: WorkerGithub;
		login: string;
		check(job: JobSpec): Promise<void>;
		conflict(job: JobSpec): Promise<void>;
	};
	constructor(options: GitOperations["options"]) {
		this.options = options;
	}
	async commit(job: JobSpec, message: string) {
		await this.options.check(job);
		return this.options.git.commit(job, message);
	}
	async run(job: JobSpec, op: GitOperation, title = "Durable work") {
		const key = `${job.item}:${op}`;
		const active = this.flights.get(key);
		if (active) return { state: "busy", intent: (await active) ?? null };
		let publish!: (intent: OperationIntent | undefined) => void;
		this.flights.set(
			key,
			new Promise((resolve) => {
				publish = resolve;
			}),
		);
		try {
			await this.options.check(job);
			let intent = await this.options.store.read(job.id, op);
			const commitSha = await this.options.git.head(job);
			if (intent?.state === "confirmed" && intent.commitSha !== commitSha) {
				intent = {
					...intent,
					commitSha,
					expectedRemoteHead:
						op === "push_branch"
							? intent.commitSha
							: await this.options.github.remoteHead(
									intent.repo,
									intent.branch,
								),
					state: "intent",
					pr: undefined,
				};
				await this.options.store.write(intent);
			}
			if (!intent) {
				const repo = job.repo;
				if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo))
					throw Error("definition repository slug required");
				intent = {
					attemptId: job.id,
					op,
					repo,
					branch: `durable/${job.agent}/${job.item}`,
					base: job.baseRef ?? "main",
					commitSha,
					expectedRemoteHead: await this.options.github.remoteHead(
						repo,
						job.workspace.branch,
					),
					state: "intent",
				};
				await this.options.store.write(intent);
			}
			publish(intent);
			if (intent.state === "conflict") return intent;
			// Even confirmed operations are re-read; another writer may have moved the branch.
			const state =
				op === "push_branch"
					? await this.push(job, intent)
					: await this.pr(job, intent, title);
			if (state.state === "conflict") await this.options.conflict(job);
			return state;
		} finally {
			publish(undefined);
			this.flights.delete(key);
		}
	}
	private async push(job: JobSpec, intent: OperationIntent) {
		let state = await reconcilePush(
			this.options.store,
			intent,
			this.options.github.remoteHead,
		);
		if (state === "retry") {
			await this.options.check(job);
			try {
				await this.options.git.push(job, intent);
			} catch {
				/* Reconcile an ambiguous network outcome, never blindly retry. */
			}
			state = await reconcilePush(
				this.options.store,
				intent,
				this.options.github.remoteHead,
			);
		}
		return {
			...intent,
			state: state === "retry" ? ("intent" as const) : state,
		};
	}
	private async pr(job: JobSpec, intent: OperationIntent, title: string) {
		const github = this.options.github;
		if (
			(await github.remoteHead(intent.repo, intent.branch)) !== intent.commitSha
		) {
			const conflict = { ...intent, state: "conflict" as const };
			await this.options.store.write(conflict);
			return conflict;
		}
		const marker = prMarker(job.agent, job.item);
		const find = async () => {
			const prs = await github.findPr(intent.repo, intent.branch);
			return prs.find((pr) => pr.body.includes(marker)) ?? prs[0];
		};
		let pr = await find();
		if (!pr) {
			await this.options.check(job);
			try {
				pr = await github.createPr({
					...intent,
					title,
					item: job.item,
					body: `${job.briefText}\n\n${prFooter(job.agent, this.options.login)}\n${marker}`,
				});
			} catch {
				pr = await find();
			}
		}
		if (!pr) return intent;
		const state =
			pr.headSha === intent.commitSha && pr.draft && pr.body.includes(marker)
				? "confirmed"
				: "conflict";
		const record = { ...intent, state, pr: pr.number } as OperationIntent;
		await this.options.store.write(record);
		return record;
	}
}

/** No worktree config is loaded for staging, committing or pushing. */
export class HardenedWorkerGit implements WorkerGit {
	private readonly options: {
		root: string;
		identity: { name: string; email: string };
		token: string;
		env: NodeJS.ProcessEnv;
		processes: Pick<ProcessManager, "launch">;
		/** Local bare remotes in contract tests only; production always uses the explicit GitHub URL. */
		url?: (repo: string) => string;
	};
	constructor(options: HardenedWorkerGit["options"]) {
		this.options = options;
	}
	private directory(job: JobSpec) {
		return join(
			this.options.root,
			`${createHash("sha256").update(`${job.repo}:${job.id}`).digest("hex")}.git`,
		);
	}
	private async execute(
		job: JobSpec,
		args: string[],
		extra: NodeJS.ProcessEnv = {},
	) {
		const scope = workerOperation();
		if (scope && scope.job.id !== job.id)
			throw Error("worker invocation scope mismatch");
		const result = await this.options.processes.launch(
			["git", ...gitInvocation(args)],
			{
				PATH: this.options.env.PATH,
				HOME: this.options.root,
				LANG: "C",
				GIT_CONFIG_SYSTEM: "/dev/null",
				GIT_CONFIG_GLOBAL: join(this.options.root, "gitconfig"),
				GIT_TERMINAL_PROMPT: "0",
				...extra,
			},
			{ item: job.item, attemptId: job.id },
		);
		workerOperation();
		if (result.exitCode !== 0)
			throw Error(
				result.stderr.trim() ||
					"code-owned git operation failed; no changes may be staged; inspect git status before retrying",
			);
		return result.stdout.trim();
	}
	private config() {
		return `[core]\n\tbare = true\n\thooksPath = /dev/null\n\tfsmonitor = false\n[user]\n\tname = ${JSON.stringify(this.options.identity.name)}\n\temail = ${JSON.stringify(this.options.identity.email)}\n`;
	}
	private async prepare(job: JobSpec) {
		await mkdir(this.options.root, { recursive: true, mode: 0o700 });
		await writeFile(
			join(this.options.root, "gitconfig"),
			"# Durable credential-free global config\n",
			{ mode: 0o600 },
		);
		const dir = this.directory(job);
		await this.execute(job, ["init", "--bare", dir]);
		const config = this.config();
		await writeFile(join(dir, "config"), config, { mode: 0o600 });
		return dir;
	}
	async head(job: JobSpec) {
		const dir = await this.prepare(job);
		try {
			return await this.execute(job, [
				"--git-dir",
				dir,
				"rev-parse",
				"--verify",
				"HEAD^{commit}",
			]);
		} catch {
			if (job.baseSha) return this.seedRemote(job, dir);
			// The source is a dispatcher-created local worktree, never a model-provided URL/refspec.
			await this.execute(job, [
				"--git-dir",
				dir,
				"-c",
				"protocol.file.allow=always",
				"fetch",
				"--no-tags",
				"--",
				job.workspace.path,
				"HEAD",
			]);
			const sha = await this.execute(job, [
				"--git-dir",
				dir,
				"rev-parse",
				"FETCH_HEAD^{commit}",
			]);
			await this.execute(job, ["--git-dir", dir, "update-ref", "HEAD", sha]);
			return sha;
		}
	}
	private remoteUrl(repo: string) {
		return this.options.url?.(repo) ?? `https://github.com/${repo}.git`;
	}
	private async network(job: JobSpec, args: string[]) {
		const config = await readFile(join(this.directory(job), "config"));
		if (
			createHash("sha256").update(config).digest("hex") !==
			createHash("sha256").update(this.config()).digest("hex")
		)
			throw Error("trusted git config changed");
		return this.execute(
			job,
			[
				"--git-dir",
				this.directory(job),
				"-c",
				"credential.helper=",
				"-c",
				'credential.helper=!f() { printf "username=x-access-token\\npassword=%s\\n" "$DURABLE_PUSH_TOKEN"; }; f',
				...args,
			],
			{ DURABLE_PUSH_TOKEN: this.options.token },
		);
	}
	private async seedRemote(job: JobSpec, dir: string) {
		if (!job.repo || !job.baseSha || !/^[0-9a-f]{40,64}$/.test(job.baseSha))
			throw Error("invalid starting head");
		await this.network(job, [
			"fetch",
			"--no-tags",
			"--",
			this.remoteUrl(job.repo),
			job.baseSha,
		]);
		await this.execute(job, [
			"--git-dir",
			dir,
			"update-ref",
			"HEAD",
			job.baseSha,
		]);
		return job.baseSha;
	}
	async commit(job: JobSpec, message: string) {
		if (
			!message.trim() ||
			/(^|[\r\n])[ \t]*Durable-Agent[ \t]*:/i.test(message)
		)
			throw Error("invalid commit message");
		const head = await this.head(job);
		const dir = this.directory(job);
		const git = [
			"-C",
			job.workspace.path,
			"--git-dir",
			dir,
			"--work-tree",
			job.workspace.path,
		];
		await this.execute(job, [...git, "read-tree", head]);
		await this.execute(job, [...git, "add", "--all", "--", "."]);
		const identity = this.options.identity;
		await this.execute(
			job,
			[...git, "commit", "-m", `${message}\n\nDurable-Agent: ${job.agent}`],
			{
				GIT_AUTHOR_NAME: identity.name,
				GIT_AUTHOR_EMAIL: identity.email,
				GIT_COMMITTER_NAME: identity.name,
				GIT_COMMITTER_EMAIL: identity.email,
			},
		);
		return this.head(job);
	}
	async push(job: JobSpec, intent: OperationIntent) {
		await this.prepare(job);
		if (
			!/^[0-9a-f]{40,64}$/.test(intent.commitSha) ||
			intent.branch !== `durable/${job.agent}/${job.item}`
		)
			throw Error("invalid push intent");
		// Token is supplied to this invocation only; never in config or argv.
		await this.network(job, [
			"push",
			"--",
			this.remoteUrl(intent.repo),
			`${intent.commitSha}:refs/heads/${intent.branch}`,
		]);
	}
}

export class WorkerGithubCli implements WorkerGithub {
	private readonly options: {
		env: NodeJS.ProcessEnv;
		processes: Pick<ProcessManager, "launch">;
	};
	constructor(options: WorkerGithubCli["options"]) {
		this.options = options;
	}
	private async request<T>(
		path: string,
		method = "GET",
		fields: Record<string, string | boolean> = {},
		item?: string,
		attemptId?: string,
	): Promise<T> {
		const scope = workerOperation();
		const args = ["gh", "api", path, "--method", method];
		for (const [key, value] of Object.entries(fields))
			args.push(typeof value === "boolean" ? "-F" : "-f", `${key}=${value}`);
		const result = await this.options.processes.launch(args, this.options.env, {
			item: item ?? scope?.job.item,
			attemptId: attemptId ?? scope?.job.id,
		});
		workerOperation();
		if (result.exitCode !== 0) throw Error("GitHub worker request failed");
		return JSON.parse(result.stdout) as T;
	}
	async remoteHead(repo: string, branch: string) {
		// A failed API read is not evidence of an absent ref. Listing refs handles absence without swallowing errors.
		const refs = await this.request<
			Array<{ ref: string; object: { sha: string } }>
		>(`repos/${repo}/git/matching-refs/heads/${branch}`);
		return refs.find((ref) => ref.ref === `refs/heads/${branch}`)?.object.sha;
	}
	async findPr(repo: string, branch: string) {
		const results: DraftPr[] = [];
		for (let page = 1; ; page++) {
			const prs = await this.request<
				Array<{
					number: number;
					head: { sha: string };
					body: string;
					draft: boolean;
				}>
			>(
				`repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${repo.split("/")[0]}:${branch}`)}&per_page=100&page=${page}`,
			);
			results.push(
				...prs.map((pr) => ({
					number: pr.number,
					headSha: pr.head.sha,
					body: pr.body ?? "",
					draft: pr.draft,
				})),
			);
			if (prs.length < 100) return results;
		}
	}
	async createPr(input: {
		repo: string;
		branch: string;
		base: string;
		title: string;
		body: string;
		item: string;
		attemptId: string;
	}) {
		const pr = await this.request<{
			number: number;
			head: { sha: string };
			body: string;
			draft: boolean;
		}>(
			`repos/${input.repo}/pulls`,
			"POST",
			{
				head: input.branch,
				base: input.base,
				title: input.title,
				body: input.body,
				draft: true,
			},
			input.item,
			input.attemptId,
		);
		return {
			number: pr.number,
			headSha: pr.head.sha,
			body: pr.body,
			draft: pr.draft,
		};
	}
}
