import type { AgentDef, MachineCfg } from "../config/schema.ts";
import { monitorWorker } from "../dispatch/monitor.ts";
import type { AttachInfo, WorkerDispatcher } from "../dispatch/types.ts";
import { assembleWorkerBrief, createScoutBrief } from "../scout/brief.ts";
import { eligibility } from "../sources/eligibility.ts";
import { readLocalBody } from "../sources/localFiles.ts";
import type { WorkerHandle, WorkerKindRegistry } from "../workers/kind.ts";
import type { WorkerRegistry } from "../workers/registry.ts";
import { audit } from "./audit.ts";
import { claim } from "./claims.ts";
import { intakeNumber, prMarker, type WorkGithub } from "./github.ts";
import { quietHours } from "./killswitch.ts";
import { canDispatch, itemTimedOut } from "./limits.ts";
import type { ProcessManager } from "./procs.ts";
import type { Queue, QueueItem } from "./queue.ts";
import {
	emptyWorkItems,
	reconcilePrs,
	type WorkItem,
	type WorkItems,
} from "./workItems.ts";
import {
	advanceWorkItem,
	type TaskDependencies,
	type WorkItemTask,
} from "./workItemTask.ts";

export type WorkState = {
	work: WorkItems;
	tasks: Record<string, WorkItemTask>;
};
export const emptyWorkState = (): WorkState => ({
	work: emptyWorkItems(),
	tasks: {},
});
export type WorkRuntimeOptions = {
	agent: string;
	login: string;
	claimOwner?: string;
	definition: AgentDef;
	machine: MachineCfg;
	github: WorkGithub;
	dispatcher: WorkerDispatcher;
	workers: WorkerRegistry;
	kinds: WorkerKindRegistry;
	processes: ProcessManager;
	env: NodeJS.ProcessEnv;
	piDir?: string;
	skillsRoot?: string;
	checkoutFor: (repo: string) => string | undefined;
	trustedAuthors?: (repo: string) => string[] | undefined;
	scout: (item: WorkItem, body: string) => Promise<string>;
	notify: (event: "escalation" | "budget-stop", item: string) => Promise<void>;
	notifyApproval?: (item: string, sha: string) => Promise<void>;
	issueApproval?: (item: string, sha: string) => Promise<boolean>;
	check: () => Promise<void>;
	now?: () => number;
	drainMs?: number;
	durable?: Pick<
		import("../workers/durable/anchor.ts").NativeAnchorOptions,
		"git" | "github" | "shellEnv" | "verifyIdentity"
	>;
	recordCost?: (cost: number) => Promise<void>;
};
export type WorkStore = {
	load: () => Promise<WorkState>;
	save: (state: WorkState) => Promise<void>;
};

/** Code-owned orchestration; durable documents are committed before every external effect. */
export class WorkRuntime {
	private readonly now: () => number;
	private serial = Promise.resolve();
	private readonly options: WorkRuntimeOptions;
	private readonly store: WorkStore;
	constructor(options: WorkRuntimeOptions, store: WorkStore) {
		this.options = options;
		this.store = store;
		this.now = options.now ?? Date.now;
	}
	private enqueue<T>(run: () => Promise<T>): Promise<T> {
		const result = this.serial.then(run);
		this.serial = result.then(
			() => {},
			() => {},
		);
		return result;
	}
	async tickItem(
		id: string,
		paused: boolean,
		budgetStopped: boolean,
		queueItem?: QueueItem,
	) {
		return this.enqueue(async () => {
			const state = await this.store.load();
			const item = state.work.items[id];
			if (!item) throw Error("work item missing");
			try {
				await this.progress(state, item, paused, budgetStopped, queueItem);
			} catch {
				// Keep the committed intent. The next invocation re-reads the external world.
				audit(this.options.agent, {
					event: "work-item-reconcile-failed",
					item: id,
				});
			}
			return (await this.store.load()).work.items[id].outcome;
		});
	}
	private async progress(
		state: WorkState,
		item: WorkItem,
		paused: boolean,
		budgetStopped: boolean,
		queueItem?: QueueItem,
	) {
		const o = this.options;
		for (const pr of item.prs)
			reconcilePrs(
				item,
				[await o.github.readPr(item.repo, pr.number)],
				this.now(),
			);
		let task = state.tasks[item.id] ?? {
			itemId: item.id,
			phase: "claim" as const,
		};
		state.tasks[item.id] = task;
		if (await this.restoreOutcome(state, item, task)) return;
		if (item.outcome === "merged" || item.outcome === "parked") {
			if (!o.processes.fenced(item.id) && !paused)
				await this.finish(state, item, task);
			else await this.store.save(state);
			return;
		}
		if (o.processes.fenced(item.id)) return;
		if (!(await this.refreshCandidate(state, item, queueItem))) return;
		if (await this.stopIfLimited(state, item, paused, budgetStopped)) return;
		if (this.inactive(item, task, paused)) return;
		await this.renew(state, item);
		if (task.phase === "await-pr") await this.monitor(state, item, task);
		task = state.tasks[item.id];
		if (task.phase !== "await-pr") await this.runPhases(state, item, task);
	}
	private async refreshCandidate(
		state: WorkState,
		item: WorkItem,
		candidate?: QueueItem,
	) {
		if (!candidate) return true;
		if (candidate.state !== "eligible") {
			item.outcome = "needs-human";
			await this.store.save(state);
			return false;
		}
		item.candidate = candidate;
		return true;
	}
	private async restoreOutcome(
		state: WorkState,
		item: WorkItem,
		task: WorkItemTask,
	) {
		const attempt = item.attempts.at(-1);
		if (!attempt?.worker) return false;
		this.restore(item, task);
		const worker = await this.options.workers.get(attempt.id);
		const result = await worker.kind.result(worker.handle);
		if (!result.outcome || attempt.endedAt) return false;
		if (result.outcome !== "held")
			await this.cancel(
				state,
				item,
				result.outcome === "failed" ? "interrupted" : result.outcome,
			);
		return true;
	}
	private inactive(item: WorkItem, task: WorkItemTask, paused: boolean) {
		return (
			paused ||
			Boolean(item.outcome) ||
			Boolean(item.attempts.at(-1)?.cancelledBy && task.phase !== "dispatch")
		);
	}
	private async stopIfLimited(
		state: WorkState,
		item: WorkItem,
		paused: boolean,
		budgetStopped: boolean,
	) {
		const attempt = item.attempts.at(-1);
		if (!attempt || attempt.endedAt) return false;
		if (
			!paused &&
			!itemTimedOut(
				attempt.startedAt,
				this.options.definition.limits?.itemMinutes,
				this.now(),
			)
		)
			return false;
		await this.cancel(
			state,
			item,
			paused && !budgetStopped ? "paused" : "limit",
		);
		return true;
	}
	private async monitor(state: WorkState, item: WorkItem, task: WorkItemTask) {
		const o = this.options;
		const attempt = item.attempts.at(-1);
		if (!attempt?.worker) throw Error("await-pr has no worker record");
		const { kind, handle } = await o.workers.get(attempt.id);
		const result = await monitorWorker({
			item,
			branch: this.branch(item),
			marker: prMarker(o.agent, item.id),
			kind,
			handle,
			github: {
				findDraftPr: (input) => o.github.findDraftPr(input),
				commentOnce: (input) =>
					o.github.commentOnce({ ...input, item: item.candidate.ref }),
			},
			maxAttempts: o.definition.limits?.maxAttemptsPerItem ?? 3,
			fenced: o.processes.fenced(item.id),
			resume: async () => {
				attempt.endedAt = this.now();
				task.phase = "dispatch";
				task.resume = true;
				await this.store.save(state);
			},
		});
		if (
			attempt.cost === undefined &&
			(await kind.status(handle)) !== "running"
		) {
			const result = await kind.result(handle);
			if (typeof result.cost === "number") {
				attempt.cost = result.cost;
				await o.recordCost?.(result.cost);
			}
		}
		if (item.prs.length && !item.outcome) {
			const primary = item.prs.find((pr) => pr.primary);
			if (!primary) throw Error("primary PR missing");
			await o.github.attributePr(item.repo, primary.number, item.id);
			// A SHA is the durable boundary for review, reports and approval. Older
			// adapters without it remain safely parked at review.
			const observed = await o.github.readPr(item.repo, primary.number);
			Object.assign(primary, observed);
			if (primary.headSha && item.gate?.sha !== primary.headSha) {
				item.stage = "gate";
				item.gate = {
					pr: primary.number,
					sha: primary.headSha,
					state: "waiting-approval",
					reasons: ["human-approval-required"],
				};
				// Commit the task before external delivery so a restart never makes a
				// second task for the same item/SHA.
				await this.store.save(state);
			}
			if (primary.headSha && item.gate && !item.gate.notified) {
				await o.github.readyPr?.(item.repo, primary.number, item.id);
				await o.github.mirrorGate?.(
					item.repo,
					primary.number,
					primary.headSha,
					"| Fact | Value |\n| --- | --- |\n| Head SHA | current |\n\nAction: human approval required.",
					item.id,
				);
				await o.notifyApproval?.(item.id, primary.headSha);
				if (!(await o.issueApproval?.(item.id, primary.headSha)))
					audit(o.agent, {
						event: "approval-nonce-unavailable",
						item: item.id,
					});
				item.gate.notified = true;
				audit(o.agent, {
					event: "gate-decision",
					item: item.id,
					sha: primary.headSha,
					action: "wait-human",
				});
			} else if (!primary.headSha) item.stage = "review";
			if ((await kind.status(handle)) !== "running")
				attempt.endedAt ??= this.now();
		}
		await this.store.save(state);
		if (result === "needs-human")
			await o
				.notify("escalation", item.id)
				.catch(() => audit(o.agent, { event: "notify-failed", item: item.id }));
	}
	private async runPhases(
		state: WorkState,
		item: WorkItem,
		task: WorkItemTask,
	) {
		const o = this.options;
		for (
			let step = 0;
			step < 3 && task.phase !== "await-pr" && task.phase !== "finish";
			step++
		) {
			if (task.phase === "dispatch" && !this.capacity(state, item)) return;
			await o.check();
			if (o.processes.fenced(item.id)) return;
			await this.store.save(state); // phase intent precedes claim, scout and start
			task = await advanceWorkItem(
				task,
				item,
				this.taskDependencies(state, item),
			);
			state.tasks[item.id] = task;
			await this.store.save(state);
		}
	}
	private async brief(item: WorkItem) {
		const o = this.options;
		const body =
			item.candidate.kind === "file"
				? await readLocalBody(item.candidate, o.checkoutFor(item.repo) ?? "")
				: await o.github.readIntake(
						item.repo,
						item.candidate.ref,
						item.candidate.kind,
					);
		return assembleWorkerBrief({
			brief: createScoutBrief(
				item.candidate,
				!eligibility(item.candidate, {
					trustedAuthors: o.trustedAuthors?.(item.repo),
				}).reasons.includes("untrusted-author"),
				await o.scout(item, body),
			),
			branch: this.branch(item),
			agent: o.agent,
			login: o.login,
			item: item.id,
		});
	}
	private taskDependencies(state: WorkState, item: WorkItem): TaskDependencies {
		const o = this.options;
		const model = o.definition.models?.worker;
		if (!model) throw Error("models.worker required for dispatch");
		return {
			agent: o.agent,
			lease: new Date(this.now() + 2 * 3600000).toISOString(),
			claimOwner: o.claimOwner,
			login: o.login,
			github: o.github,
			brief: () => this.brief(item),
			dispatcher: o.dispatcher,
			workers: o.workers,
			kinds: o.kinds,
			definition: o.definition,
			machine: o.machine,
			model,
			env: { ...o.env, DURABLE_ITEM: item.id },
			piDir: o.piDir,
			skillsRoot: o.skillsRoot,
			checkout: o.checkoutFor(item.repo),
			now: this.now,
			check: async () => {
				await o.check();
				if (o.processes.fenced(item.id)) throw Error("item held");
			},
			persist: async (intent) => {
				state.tasks[item.id] = intent;
				await this.store.save(state);
			},
		};
	}
	private async renew(state: WorkState, item: WorkItem) {
		const o = this.options;
		if (
			item.claim?.commentId &&
			item.candidate.kind !== "file" &&
			Date.parse(item.claim.lease) - this.now() < 3600000
		) {
			const lease = new Date(this.now() + 2 * 3600000).toISOString();
			const result = await claim(
				o.github,
				{
					repo: item.repo,
					issue: intakeNumber(item.candidate.ref),
					agent: o.agent,
					lease,
					item: item.id,
					owner: o.claimOwner,
					login: o.login,
				},
				this.now(),
			);
			if (result.state === "lost") {
				await this.cancel(state, item, "interrupted");
				throw Error("claim lease lost");
			}
			item.claim.lease = lease;
			await this.store.save(state);
		}
	}
	private async finish(state: WorkState, item: WorkItem, task: WorkItemTask) {
		if (task.finished) return;
		task.phase = "finish";
		const attempt = item.attempts.at(-1);
		if (attempt) attempt.endedAt ??= this.now();
		await this.store.save(state);
		if (attempt?.worker) {
			this.restore(item, task);
			await this.options.workers.interrupt(attempt.id, "hard");
			await this.options.processes.terminate({ item: item.id });
		}
		if (item.claim && item.candidate.kind !== "file") {
			const issue = intakeNumber(item.candidate.ref);
			if (
				item.claim.commentId &&
				(await this.options.github.listComments(item.repo, issue)).some(
					(comment) =>
						comment.id === item.claim?.commentId &&
						comment.login?.toLowerCase() === this.options.login.toLowerCase(),
				)
			)
				await this.options.github.deleteComment?.(
					item.repo,
					item.claim.commentId,
					item.id,
				);
			await this.options.github.removeLabel(
				item.repo,
				issue,
				"durable/claimed",
			);
		}
		task.finished = true;
		await this.store.save(state);
	}
	private capacity(state: WorkState, item: WorkItem) {
		const attempts = Object.values(state.work.items).flatMap(
			(item) => item.attempts,
		);
		const day = new Date(this.now()).toISOString().slice(0, 10);
		const pending = item.attempts.at(-1);
		const ownIntent = pending && !pending.endedAt && !pending.worker ? 1 : 0;
		return canDispatch({
			running:
				attempts.filter((attempt) => !attempt.endedAt).length - ownIntent,
			startedToday:
				attempts.filter((attempt) =>
					new Date(attempt.startedAt).toISOString().startsWith(day),
				).length - ownIntent,
			limits: this.options.definition.limits,
			quiet: quietHours(
				this.options.definition.schedule?.quietHours,
				this.now(),
			),
			paused: false,
		});
	}
	private restore(item: WorkItem, task: WorkItemTask) {
		const o = this.options;
		const attempt = item.attempts.at(-1);
		const model = o.definition.models?.worker;
		if (!attempt?.worker || !model) return;
		const handle: WorkerHandle = {
			id: attempt.id,
			process: attempt.worker.process,
			startedAt: attempt.startedAt,
			job: {
				id: attempt.id,
				item: item.id,
				repo: item.repo,
				baseRef: o.definition.scope?.repos?.find(
					(repo) => repo.slug === item.repo,
				)?.base,
				agent: o.agent,
				role: "worker",
				briefText: task.briefText ?? "",
				workspace: attempt.worker.process.workspace,
				model,
				limits: o.definition.limits ?? {},
				env: o.env,
				piDir: o.piDir,
			},
		};
		o.workers.register(o.kinds.get(attempt.worker.kind), handle, o.dispatcher);
	}
	private branch(item: WorkItem) {
		return `durable/${this.options.agent}/${item.id}`;
	}
	private async cancel(
		state: WorkState,
		item: WorkItem,
		reason: "paused" | "limit" | "stopped" | "interrupted" | "soft",
	) {
		const attempt = item.attempts.at(-1);
		if (!attempt) return;
		// Native soft cancellation belongs to the open turn, not the attempt.
		if (reason !== "soft" || attempt.worker?.kind !== "durable-conversation")
			attempt.cancelledBy = reason;
		if (reason !== "soft") {
			attempt.endedAt = this.now();
			attempt.outcome = reason;
			item.outcome = this.terminalOutcome(
				reason,
				attempt.worker?.kind === "durable-conversation",
			);
		}
		await this.store.save(state);
		if (attempt.worker) {
			this.restore(item, state.tasks[item.id]);
			await this.options.workers
				.interrupt(
					attempt.id,
					reason === "soft" ? "soft" : "hard",
					reason === "soft" ? undefined : reason,
				)
				.catch(() =>
					audit(this.options.agent, {
						event: "worker-interrupt-failed",
						item: item.id,
					}),
				);
		}
		if (reason !== "soft")
			await this.options.processes.terminate({ item: item.id });
		if (reason === "limit")
			await this.options
				.notify("budget-stop", item.id)
				.catch(() =>
					audit(this.options.agent, { event: "notify-failed", item: item.id }),
				);
	}
	private terminalOutcome(
		reason: "paused" | "limit" | "stopped" | "interrupted",
		durable: boolean,
	) {
		if (
			reason === "stopped" ||
			reason === "interrupted" ||
			(reason === "limit" && durable)
		)
			return "needs-human";
		return reason;
	}
	/** Records a SHA-bound human approval; the gate re-runs before any future merge executor. */
	async approveGate(id: string, sha: string) {
		return this.enqueue(async () => {
			const state = await this.store.load();
			const item = state.work.items[id];
			if (!item?.gate || item.gate.sha !== sha)
				throw Object.assign(Error("approval does not match the current gate"), {
					code: "conflict",
				});
			item.gate.state = "approved";
			item.gate.approvedAt = this.now();
			item.updatedAt = this.now();
			await this.store.save(state);
			audit(this.options.agent, {
				event: "gate-approved-nonce",
				item: id,
				sha,
			});
		});
	}
	async requestWork(id: string, queue: Queue, modelRequested = false) {
		return this.enqueue(async () => {
			await this.options.check();
			const state = await this.store.load();
			const item = state.work.items[id];
			if (!item || queue.items[item.intakeRef]?.state !== "eligible")
				throw Error("work request requires a currently eligible item");
			if (
				this.options.processes.fenced(id) ||
				item.outcome === "paused" ||
				["merged", "cancelled", "parked"].includes(item.outcome ?? "")
			)
				throw Error("work request refused by lifecycle fence");
			const previous = item.attempts.at(-1);
			if (
				modelRequested &&
				(previous?.cancelledBy ||
					["needs-human", "limit"].includes(item.outcome ?? ""))
			)
				throw Error("work request refused for intentionally stopped work");
			if (previous && !previous.endedAt && !previous.cancelledBy) return;
			if (previous) previous.endedAt = this.now();
			delete item.outcome;
			item.stage = "build";
			state.tasks[id] = {
				...state.tasks[id],
				itemId: id,
				phase: "dispatch",
				resume: true,
			};
			await this.store.save(state);
		});
	}
	async interrupt(id: string, mode: "soft" | "hard") {
		return this.enqueue(async () => {
			const state = await this.store.load();
			const item = Object.values(state.work.items).find(
				(item) => item.attempts.at(-1)?.id === id,
			);
			if (!item)
				throw Object.assign(Error("worker not found"), { code: "not_found" });
			await this.cancel(state, item, mode === "soft" ? "soft" : "interrupted");
		});
	}
	async stop(reason: "paused" | "stopped") {
		return this.enqueue(async () => {
			const state = await this.store.load();
			for (const item of Object.values(state.work.items))
				if (item.attempts.at(-1) && !item.attempts.at(-1)!.endedAt)
					await this.cancel(state, item, reason);
		});
	}
	private async requireWork(item: string) {
		const state = await this.store.load();
		const work = state.work.items[item];
		if (!work)
			throw Object.assign(Error("item not found"), { code: "not_found" });
		return { state, work };
	}
	async hold(item: string, by: string, via: string) {
		// The synchronous journal commit is deliberately outside the queue: it fences an in-flight start.
		this.options.processes.beginHold(item, by, via);
		return this.enqueue(async () => {
			const { state, work } = await this.requireWork(item);
			const attempt = work.attempts.at(-1);
			if (attempt) {
				attempt.cancelledBy = "hold";
				attempt.outcome = "held";
				attempt.endedAt = this.now();
			}
			work.outcome = "held";
			await this.store.save(state);
			if (attempt?.worker) {
				this.restore(work, state.tasks[item]);
				await this.options.workers
					.interrupt(attempt.id, "soft")
					.catch(() => {});
				await new Promise((resolve) =>
					setTimeout(resolve, this.options.drainMs ?? 10000),
				);
				await this.options.workers
					.interrupt(attempt.id, "hard", "held")
					.catch(() => {});
			}
			const result = await this.options.processes.finishHold(item);
			audit(this.options.agent, {
				event: result.state,
				item,
				holdEpoch: result.holdEpoch,
			});
			if (result.state === "holding")
				await this.options
					.notify("escalation", item)
					.catch(() =>
						audit(this.options.agent, { event: "notify-failed", item }),
					);
			return result;
		});
	}
	async resumePaused() {
		return this.enqueue(async () => {
			await this.options.check();
			const state = await this.store.load();
			for (const work of Object.values(state.work.items))
				if (
					work.outcome === "paused" &&
					!this.options.processes.fenced(work.id)
				)
					await this.resetForAttempt(state, work);
			await this.store.save(state);
		});
	}
	private async resetForAttempt(state: WorkState, work: WorkItem) {
		delete work.outcome;
		for (const pr of work.prs)
			reconcilePrs(
				work,
				[await this.options.github.readPr(work.repo, pr.number)],
				this.now(),
			);
		work.stage = work.prs.length ? "review" : "build";
		state.tasks[work.id] = {
			...state.tasks[work.id],
			itemId: work.id,
			phase: work.prs.length ? "await-pr" : "dispatch",
			resume: true,
		};
	}
	async release(item: string, epoch: number) {
		return this.enqueue(async () => {
			const { state, work } = await this.requireWork(item);
			// Keep the fence through the durable state reset. A crash before removal cannot dispatch.
			await this.resetForAttempt(state, work);
			await this.store.save(state);
			this.options.processes.releaseHold(item, epoch);
			audit(this.options.agent, { event: "released", item, holdEpoch: epoch });
		});
	}
	async open(
		conversation: string,
		workspace?: WorkerHandle["job"]["workspace"],
	): Promise<AttachInfo> {
		const command = `durable attach ${this.options.agent}/${conversation}`;
		if (!workspace) {
			const repo = this.options.definition.scope?.repos?.[0]?.slug;
			const path = repo && this.options.checkoutFor(repo);
			if (!path) return { kind: "command", command };
			workspace = { id: "viewer", path, branch: "" };
		}
		return this.options.dispatcher.openViewer(workspace, {
			title: `durable:${this.options.agent}/${conversation}`,
			command,
		});
	}
}
