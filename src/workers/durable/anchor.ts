import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	type Cursor,
	configure,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	GenerationTask,
	type Harness,
	hook,
	ProviderDoc,
	type TaskId,
	ToolTask,
	type Tx,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { familyFor, providerFor } from "../../config/agent.ts";
import type { ProcessManager } from "../../steward/procs.ts";
import type { JobSpec } from "../kind.ts";
import {
	GitOperations,
	type OperationIntent,
	type WorkerGit,
	type WorkerGithub,
} from "./gitops.ts";
import { durableLimitStop } from "./limits.ts";
import { withWorkerOperation } from "./operation.ts";
import { interruptedToolPlaybook } from "./playbook.ts";
import {
	parseReviewResult,
	ReviewResultSchema,
	type ModelProvenance,
	type ReviewResult,
} from "./review.ts";
import { durableSkillSections } from "./skills.ts";
import {
	assertCommand,
	durableBash,
	fileTools,
	screenToolOutput,
} from "./tools.ts";

export type WorkerStop =
	| "paused"
	| "held"
	| "stopped"
	| "limit"
	| "interrupted"
	| "failed";
type StoredJob = Omit<JobSpec, "env">;
type WorkerRecord = {
	job: StoredJob;
	owner: number;
	conversation: number;
	startedAt: number;
	turns: number;
	toolCalls: number;
	assistantEntries: Array<{ provider: string; model: string; family: string }>;
	outcome?: WorkerStop;
	reported?: string;
	review?: { result: ReviewResult; provenance: ModelProvenance };
};
const WorkersDoc = defineDoc<{
	workers: Record<string, WorkerRecord>;
	operations: Record<string, OperationIntent>;
}>({
	kind: "steward.durable-workers",
	version: 1,
	scope: "session",
	initial: () => ({ workers: {}, operations: {} }),
	checkpointWhen: () => true,
});
export type DurableConversation = {
	id: string;
	ownerTaskId: string;
	state: "running" | "waiting" | "done" | "aborted";
	outcome?: WorkerStop;
	review?: { result: ReviewResult; provenance: ModelProvenance };
};
export interface DurableAnchor {
	find(attemptId: string): Promise<DurableConversation | undefined>;
	create(job: JobSpec): Promise<DurableConversation>;
	abort(attemptId: string, reason?: WorkerStop): Promise<void>;
	soft(attemptId: string): Promise<void>;
	steer(conversationId: string, text: string): Promise<void>;
	transcript(conversationId: string): AsyncIterable<string>;
}
export type NativeAnchorOptions = {
	harness: () => Harness;
	owner: (tx: Tx, item: string) => Promise<TaskId>;
	mark: (tx: Tx, id: ConversationId, job: JobSpec) => Promise<void>;
	turn: (tx: Tx, id: ConversationId, waiting: boolean) => Promise<void>;
	processes: Pick<ProcessManager, "launch" | "terminate" | "fenced">;
	shellEnv: (job: JobSpec) => NodeJS.ProcessEnv;
	git: WorkerGit;
	github: WorkerGithub;
	login: string;
	disabled: () => boolean;
	now: () => number;
	check: () => Promise<void>;
	budgetStopped: () => Promise<boolean>;
	account: (usage: Usage) => Promise<void>;
	prDiff?: (job: JobSpec) => Promise<string>;
	verifyIdentity?: () => Promise<void>;
	/** All durable children share this harness storage and must be admitted here. */
	maxConcurrent?: number;
};

/** Native storage is the only owner index. No in-memory worker or task identity is authoritative. */
export class NativeDurableAnchor implements DurableAnchor {
	readonly extension;
	private readonly runWorker;
	private readonly operations: GitOperations;
	private readonly blockedSessions = new Set<string>();
	private readonly options: NativeAnchorOptions;
	constructor(options: NativeAnchorOptions) {
		this.options = options;
		const o = options;
		this.operations = new GitOperations({
			git: o.git,
			github: o.github,
			login: o.login,
			store: {
				read: async (id, op) =>
					(await this.snapshot()).operations[`${id}/${op}`],
				write: async (intent) => {
					await o.harness().commit(async (tx) => {
						(await tx.doc(WorkersDoc)).operations[
							`${intent.attemptId}/${intent.op}`
						] = JSON.parse(JSON.stringify(intent));
					}, context);
				},
			},
			check: (job) => this.check(job, true),
			conflict: async (job) => {
				await this.stopRecord(job.id, "interrupted");
			},
		});
		this.runWorker = this.createRunWorker();
		this.extension = defineExtension({
			name: "durable.worker",
			tools: this.createTools(),
			tasks: [this.runWorker],
			hooks: this.createHooks(),
		});
	}
	private createRunWorker() {
		const o = this.options;
		return defineTask<{ attempt: string }, { phase: "watch" }, null>({
			name: "durable.run-worker",
			version: 1,
			initial: () => ({ phase: "watch" }),
			phases: {
				watch: async (task, runtime, ctx) => {
					const record = (await this.snapshot()).workers[task.input.attempt];
					const stop = record.outcome ?? (await this.limit(record));
					if (stop) {
						await this.stopRecord(record.job.id, stop);
						await o.processes.terminate({ attemptId: record.job.id });
						await runtime.commit(
							() => ({ status: "terminal", outcome: { status: "aborted" } }),
							ctx,
						);
						return;
					}
					if (record.reported !== undefined || record.review !== undefined) {
						await runtime.commit(
							() => ({
								status: "terminal",
								outcome: { status: "completed", result: null },
							}),
							ctx,
						);
						return;
					}
					const child = (await runtime.conversation(
						record.conversation as ConversationId,
						ctx,
					))!;
					// Idempotent admission repairs a crash between child creation and first submit.
					await child.submit(
						{
							type: "input",
							requestId: `worker:${record.job.id}`,
							content: record.job.briefText,
						},
						ctx,
					);
					await runtime.sleepUntil(o.now() + 1000, { phase: "watch" }, ctx);
				},
			},
			abort: async (task, runtime, ctx) => {
				await this.stopRecord(task.input.attempt, "interrupted");
				await o.processes.terminate({ attemptId: task.input.attempt });
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "aborted" } }),
					ctx,
				);
			},
		});
	}
	private createTools() {
		const o = this.options;
		const text = (value: unknown) => ({
			output: [
				{
					type: "text" as const,
					text: screenToolOutput(
						typeof value === "string" ? value : JSON.stringify(value),
					),
				},
			],
		});
		return [
			...fileTools((id) => this.jobFor(id)),
			defineTool({
				name: "bash",
				description:
					"Run an advisory-guarded shell in the worktree. Not a sandbox.",
				parameters: Type.Object({ command: Type.String() }),
				execute: async ({ command }, api, ctx) => {
					const job = await this.jobFor(api.conversationId);
					return text(
						await durableBash({
							command,
							job,
							env: o.shellEnv(job),
							processes: o.processes,
							signal: ctx.abortSignal,
						}),
					);
				},
			}),
			defineTool({
				name: "commit",
				description:
					"Commit worktree changes with the manifest identity and Durable-Agent trailer.",
				parameters: Type.Object({ message: Type.String() }),
				execute: async ({ message }, api, ctx) =>
					text(
						await this.runOperation(
							api.conversationId,
							ctx.abortSignal,
							(job) => this.operations.commit(job, message),
						),
					),
			}),
			defineTool({
				name: "push_branch",
				description:
					"Push the exact committed SHA to the fixed durable branch. Reconcile interrupted calls by invoking again.",
				parameters: Type.Object({}),
				execute: async (_args, api, ctx) =>
					text(
						await this.runOperation(
							api.conversationId,
							ctx.abortSignal,
							(job) => this.operations.run(job, "push_branch"),
						),
					),
			}),
			defineTool({
				name: "open_draft_pr",
				description:
					"Open or reconcile the item draft PR at the committed SHA.",
				parameters: Type.Object({ title: Type.String() }),
				execute: async ({ title }, api, ctx) =>
					text(
						await this.runOperation(
							api.conversationId,
							ctx.abortSignal,
							(job) => this.operations.run(job, "open_draft_pr", title),
						),
					),
			}),
			defineTool({
				name: "report",
				description: "Finish the worker after its draft PR is confirmed.",
				parameters: Type.Object({ summary: Type.String() }),
				execute: async ({ summary }, api, ctx) => {
					const job = await this.jobFor(api.conversationId);
					await api.details({ conversationId: api.conversationId }, ctx);
					await api.commit(async (tx) => {
						const doc = await tx.doc(WorkersDoc);
						if (
							doc.operations[`${job.id}/open_draft_pr`]?.state !== "confirmed"
						)
							throw Error("confirmed draft PR required before report");
						doc.workers[job.id].reported = screenToolOutput(summary);
					}, ctx);
					return { ...text("reported"), control: { terminate: true } };
				},
			}),
			defineTool({
				name: "pr_diff",
				description: "Read the code-owned diff for the reviewed pull request.",
				parameters: Type.Object({}),
				replay: "safe",
				execute: async (_args, api) => {
					const job = await this.jobFor(api.conversationId);
					if (job.role !== "reviewer") throw Error("reviewer tool required");
					if (!o.prDiff) throw Error("review diff source is unavailable");
					return text(await o.prDiff(job));
				},
			}),
			defineTool({
				name: "report_verdict",
				description:
					"Record one final structured verdict for the reviewed head.",
				parameters: ReviewResultSchema,
				execute: async (value, api, ctx) => {
					const job = await this.jobFor(api.conversationId);
					if (job.role !== "reviewer") throw Error("reviewer tool required");
					const result = parseReviewResult(value);
					if (result.headSha !== job.reviewedHeadSha)
						throw Error("review verdict head SHA does not match reviewed head");
					await api.commit(async (tx) => {
						const record = (await tx.doc(WorkersDoc)).workers[job.id];
						if (record.review) throw Error("review verdict already reported");
						const entries = record.assistantEntries;
						if (entries.length === 0)
							throw Error("reviewer has no assistant provenance");
						const [first] = entries;
						const family = first.family;
						if (
							!job.reviewedFamily ||
							family === job.reviewedFamily ||
							entries.some((entry) => entry.family !== family)
						)
							throw Error("reviewer model family is not independent");
						record.review = {
							result,
							provenance: {
								provider: first.provider,
								model: first.model,
								family,
								entries: entries.length,
								source: "durable-entries",
							},
						};
					}, ctx);
					return { ...text("verdict recorded"), control: { terminate: true } };
				},
			}),
		];
	}
	private async runOperation<T>(
		id: ConversationId,
		signal: AbortSignal | undefined,
		run: (job: JobSpec) => Promise<T>,
	) {
		const job = await this.jobFor(id);
		return withWorkerOperation(job, this.options.processes, signal, () =>
			run(job),
		);
	}
	private createHooks() {
		const o = this.options;
		return [
			hook(ToolTask, {
				beforeTool: async (call, api, ctx) => {
					const job = await this.jobFor(api.conversationId);
					try {
						await this.check(job);
						if (call.name === "bash")
							assertCommand(
								String((call.arguments as { command?: string }).command ?? ""),
							);
					} catch {
						return {
							block: "worker stopped, limited, held, or command refused",
						};
					}
					const allowed = await o.harness().commit(async (tx) => {
						const record = (await tx.doc(WorkersDoc)).workers[job.id];
						const usage = await tx.doc(UsageDoc, api.conversationId);
						const tokens = Object.values(usage.models).reduce(
							(n, u) => n + u.totalTokens,
							0,
						);
						const stop = record.outcome ?? this.stopFor(record, tokens);
						if (stop) {
							record.outcome ??= stop;
							return false;
						}
						record.toolCalls++;
						return true;
					}, ctx);
					if (!allowed) return { block: "worker budget or lifecycle fence" };
				},
			}),
			hook(GenerationTask, {
				beforeRequest: async (_request, api) => {
					const record = Object.values((await this.snapshot()).workers).find(
						(r) => r.conversation === api.conversationId,
					);
					if (!record) throw Error("worker conversation not indexed");
					const provider = await o
						.harness()
						.snapshot(ProviderDoc, api.conversationId, context);
					if (!provider) throw Error("worker provider session missing");
					const stop = record.outcome ?? (await this.limit(record));
					if (
						stop ||
						record.reported !== undefined ||
						record.review !== undefined
					) {
						this.blockedSessions.add(provider.sessionId);
						if (stop) await this.stopRecord(record.job.id, stop);
					} else this.blockedSessions.delete(provider.sessionId);
				},
				afterResponse: async (message, api, ctx) => {
					await o.account(message.usage);
					await o.harness().commit(async (tx) => {
						const doc = await tx.doc(WorkersDoc);
						const record = Object.values(doc.workers).find(
							(r) => r.conversation === api.conversationId,
						);
						if (record) {
							record.turns++;
							const model = message.responseModel ?? message.model;
							record.assistantEntries.push({
								provider: message.provider,
								model,
								family:
									message.provider === providerFor(record.job.model) &&
									model === record.job.model.model
										? familyFor(record.job.model)
										: familyFor({ provider: message.provider, model }),
							});
							if (
								!record.review &&
								!record.reported &&
								!message.content.some((part) => part.type === "toolCall")
							)
								record.outcome = "failed";
						}
					}, ctx);
				},
			}),
		];
	}
	/** beforeRequest is advisory upstream; the Models proxy enforces this per-session decision. */
	allowsRequest(sessionId?: string) {
		return !sessionId || !this.blockedSessions.has(sessionId);
	}
	private async snapshot() {
		return (
			(await this.options.harness().snapshot(WorkersDoc, context)) ?? {
				workers: {},
				operations: {},
			}
		);
	}
	private async jobFor(id: ConversationId): Promise<JobSpec> {
		const record = Object.values((await this.snapshot()).workers).find(
			(r) => r.conversation === id,
		);
		if (!record) throw Error("worker conversation not indexed");
		return { ...record.job, env: {} };
	}
	private async limit(record: WorkerRecord, reservedTool = false) {
		const usage = await this.options
			.harness()
			.snapshot(UsageDoc, record.conversation as ConversationId, context);
		return (
			this.stopFor(
				{ ...record, toolCalls: record.toolCalls - Number(reservedTool) },
				Object.values(usage?.models ?? {}).reduce(
					(n, u) => n + u.totalTokens,
					0,
				),
			) ?? ((await this.options.budgetStopped()) ? "limit" : undefined)
		);
	}
	private stopFor(record: WorkerRecord, tokens: number) {
		return durableLimitStop({
			...record.job.limits,
			disabled: this.options.disabled(),
			held: this.options.processes.fenced(record.job.item),
			startedAt: record.startedAt,
			now: this.options.now(),
			turns: record.turns,
			toolCalls: record.toolCalls,
			tokens,
		});
	}
	private async check(job: JobSpec, reservedTool = false) {
		await this.options.check();
		const record = (await this.snapshot()).workers[job.id];
		const stop = record.outcome ?? (await this.limit(record, reservedTool));
		if (stop || record.reported !== undefined || record.review !== undefined) {
			if (stop) await this.stopRecord(job.id, stop);
			throw Error("worker lifecycle fence");
		}
	}
	private async stopRecord(id: string, reason: WorkerStop) {
		await this.options.harness().commit(async (tx) => {
			const record = (await tx.doc(WorkersDoc)).workers[id];
			if (record) record.outcome ??= reason;
		}, context);
	}
	async find(attemptId: string): Promise<DurableConversation | undefined> {
		const record = (await this.snapshot()).workers[attemptId];
		if (!record) return;
		const conversation = await this.options
			.harness()
			.commit(
				async (tx) =>
					(
						await tx.scanConversations(
							{ ownerTaskId: record.owner as TaskId },
							1,
						)
					).items[0],
				context,
			);
		if (!conversation || conversation.id !== record.conversation)
			throw Error("worker ownership index inconsistent");
		return {
			id: String(conversation.id),
			ownerTaskId: String(record.owner),
			state: record.outcome
				? "aborted"
				: record.reported !== undefined || record.review !== undefined
					? "done"
					: "running",
			outcome: record.outcome,
			review: record.review,
		};
	}
	async create(job: JobSpec) {
		if (
			job.role === "reviewer" &&
			(!job.reviewedHeadSha ||
				!job.reviewedFamily ||
				familyFor(job.model) === job.reviewedFamily)
		)
			throw Error(
				"durable reviewer requires an opposite-family model and reviewed head",
			);
		await this.options.check();
		await this.options.verifyIdentity?.();
		if (this.options.disabled() || this.options.processes.fenced(job.item))
			throw Error("worker launch fenced");
		const baseSha = job.repo
			? await withWorkerOperation(job, this.options.processes, undefined, () =>
					this.options.github.remoteHead(job.repo!, job.workspace.branch),
				)
			: undefined;
		const skillSections = await durableSkillSections(job.piDir, job.skills);
		await this.options.harness().commit(async (tx) => {
			const doc = await tx.doc(WorkersDoc);
			if (doc.workers[job.id]) return;
			const active = Object.values(doc.workers).filter(
				(record) =>
					!record.outcome &&
					record.reported === undefined &&
					record.review === undefined,
			).length;
			if (active >= (this.options.maxConcurrent ?? 2))
				throw Object.assign(Error("durable worker concurrency limit reached"), {
					code: "capacity_exceeded",
				});
			if (this.options.disabled() || this.options.processes.fenced(job.item))
				throw Error("worker launch fenced");
			const owner = await this.options.owner(tx, job.item);
			const task = await tx.createTask(
				this.runWorker,
				{ attempt: job.id },
				{ ownership: { kind: "task", taskId: owner } },
			);
			const child = await tx.createConversation({
				ownership: { kind: "task", taskId: task },
			});
			await tx.doc(ProviderDoc, child.id);
			const provider = providerFor(job.model);
			await configure(tx, child.id, {
				cwd: job.workspace.path,
				extensions: [this.extension],
				tools: this.extension.tools!.filter((tool) =>
					job.role === "reviewer"
						? ["read", "search", "pr_diff", "report_verdict"].includes(
								tool.name,
							)
						: !["pr_diff", "report_verdict"].includes(tool.name),
				),
				model: {
					provider,
					modelId: job.model.provider
						? job.model.model
						: job.model.model.split("/").slice(1).join("/"),
				},
				thinkingLevel: job.model.thinking as ModelThinkingLevel | undefined,
				instructions:
					job.role === "reviewer"
						? "Use only read, search, pr_diff, and report_verdict. Review the requested head and make exactly one final verdict. No shell or write tools are available."
						: "Use only the fixed code-owned tools. Commit, push_branch, open_draft_pr, then report. Bash is not a sandbox. No user skills, extensions, prompts, or packages are loaded." +
							interruptedToolPlaybook +
							skillSections,
			});
			const { env: _env, ...stored } = job;
			doc.workers[job.id] = {
				job: JSON.parse(JSON.stringify({ ...stored, baseSha })),
				owner: task,
				conversation: child.id,
				startedAt: this.options.now(),
				turns: 0,
				toolCalls: 0,
				assistantEntries: [],
			};
			await this.options.mark(tx, child.id, job);
		}, context);
		this.options.harness().resume();
		return (await this.find(job.id))!;
	}
	async abort(id: string, reason: WorkerStop = "interrupted") {
		const record = (await this.snapshot()).workers[id];
		if (!record) return;
		await this.stopRecord(id, reason);
		const child = (await this.options
			.harness()
			.conversation(record.conversation as ConversationId, context))!;
		await child.abort(context, { background: true });
		await this.options.harness().abortTask(record.owner as TaskId, context);
		await this.options.processes.terminate({ attemptId: id });
	}
	async soft(id: string) {
		const record = (await this.snapshot()).workers[id];
		if (!record) return;
		await (await this.options
			.harness()
			.conversation(record.conversation as ConversationId, context))!.abort(
			context,
		);
		await this.options
			.harness()
			.commit(
				(tx) =>
					this.options.turn(tx, record.conversation as ConversationId, true),
				context,
			);
	}
	async assertSubmission(id: ConversationId) {
		await this.check(await this.jobFor(id));
	}
	async steer(id: string, text: string) {
		await this.assertSubmission(Number(id) as ConversationId);
		await this.options
			.harness()
			.commit(
				(tx) => this.options.turn(tx, Number(id) as ConversationId, false),
				context,
			);
		await (await this.options
			.harness()
			.conversation(Number(id) as ConversationId, context))!.submit(
			{ type: "input", content: text, whenBusy: "steer" },
			context,
		);
	}
	async *transcript(id: string) {
		const child = (await this.options
			.harness()
			.conversation(Number(id) as ConversationId, context))!;
		let cursor: Cursor | undefined;
		do {
			const page = await child.entries(
				{ order: "ascending" },
				200,
				cursor,
				context,
			);
			for (const entry of page.items) yield JSON.stringify(entry);
			cursor = page.next;
		} while (cursor);
	}
}
