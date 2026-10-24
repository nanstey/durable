import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { AgentDef, MachineCfg } from "../config/schema.ts";
import { monitorWorker } from "../dispatch/monitor.ts";
import type { AttachInfo, WorkerDispatcher } from "../dispatch/types.ts";
import { autoConstraintReasons, selectedMergeMethod } from "../gate/auto.ts";
import { decide } from "../gate/decide.ts";
import { collectFacts, type GateFacts } from "../gate/facts.ts";
import { mergeWhenSafe } from "../gate/merge.ts";
import { effectivePolicy } from "../gate/tighten.ts";
import type { EffectivePolicy, Risk } from "../gate/policy.ts";
import { sourceFor, type FixturePolicyScript } from "../gate/policySource.ts";
import { shadowReport } from "../gate/shadow.ts";
import {
	collectReview,
	launchReviewer,
	type RunningReview,
} from "../gate/review.ts";
import { assembleWorkerBrief, createScoutBrief } from "../scout/brief.ts";
import { specBranch, specEligible } from "../pipeline/spec.ts";
import { pipelineFor } from "../pipeline/select.ts";
import { eligibility } from "../sources/eligibility.ts";
import { readLocalBody } from "../sources/localFiles.ts";
import type { WorkerHandle, WorkerKindRegistry } from "../workers/kind.ts";
import type { WorkerRegistry } from "../workers/registry.ts";
import { audit } from "./audit.ts";
import { claim, defaultClaimLeasePolicy, readClaim } from "./claims.ts";
import { agentDir } from "./files.ts";
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
	issueSpecApproval?: (
		item: string,
		pr: number,
		sha: string,
	) => Promise<boolean>;
	check: () => Promise<void>;
	now?: () => number;
	drainMs?: number;
	durable?: Pick<
		import("../workers/durable/anchor.ts").NativeAnchorOptions,
		"git" | "github" | "shellEnv" | "prDiff" | "verifyIdentity"
	>;
	recordCost?: (cost: number) => Promise<void>;
	/** In-process test seam only; fixture scripts are never loaded from definitions. */
	fixturePolicies?: Record<string, FixturePolicyScript>;
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
	private policySource(repo: string) {
		const definition = this.options.definition.scope?.repos?.find(
			(candidate) => candidate.slug === repo,
		);
		if (!definition)
			throw Object.assign(Error("repository not found"), { code: "not_found" });
		const reference = { slug: definition.slug, base: definition.base };
		return {
			reference,
			source: sourceFor(
				definition.policySource?.kind ?? "none",
				this.options.fixturePolicies,
			),
		};
	}
	// fallow-ignore-next-line unused-class-member -- invoked by the HTTP approval route.
	async policyVerification(repo: string) {
		const { reference, source } = this.policySource(repo);
		const resolution = await source.resolve(reference);
		return {
			fingerprint: resolution.fingerprint,
			change: await source.describeChange(reference),
		};
	}
	// fallow-ignore-next-line unused-class-member -- invoked by the HTTP approval route.
	async verifyPolicy(repo: string, fingerprint: string) {
		const { reference, source } = this.policySource(repo);
		const current = await source.resolve(reference);
		if (current.fingerprint !== fingerprint)
			throw Object.assign(Error("policy changed before verification"), {
				code: "conflict",
			});
		await source.recordVerification(reference, fingerprint);
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
			} catch (error) {
				// Keep the committed intent. The next invocation re-reads the external world.
				audit(this.options.agent, {
					event:
						(error as { code?: string }).code === "capacity_exceeded"
							? "work-item-queued-capacity"
							: "work-item-reconcile-failed",
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
		if (o.processes.fenced(item.id)) {
			await this.renew(state, item);
			return;
		}
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
			if (primary.headSha) await this.reviewAndGate(state, item, task, primary);
			else item.stage = "review";
			if ((await kind.status(handle)) !== "running")
				attempt.endedAt ??= this.now();
		}
		await this.store.save(state);
		if (result === "needs-human")
			await o
				.notify("escalation", item.id)
				.catch(() => audit(o.agent, { event: "notify-failed", item: item.id }));
	}
	/** Review is SHA-bound: a moved head discards the old result and launches anew. */
	private async reviewAndGate(
		state: WorkState,
		item: WorkItem,
		task: WorkItemTask,
		pr: { number: number; headSha?: string },
	) {
		const sha = pr.headSha;
		if (!sha) return;
		if (task.review?.headSha !== sha) delete task.review;
		if (item.review?.sha !== sha) delete item.review;
		if (!item.review) {
			item.stage = "review";
			if (!task.review) {
				const model = this.options.definition.models?.worker;
				if (!model) throw Error("models.worker required for review");
				const id = `durable-${this.options.agent}-${item.id}-review-${sha.slice(0, 12)}`;
				const checkout = this.options.checkoutFor(item.repo) ?? item.repo;
				const reviewDir = mkdtempSync(
					join(agentDir(this.options.agent), "review-"),
				);
				const launched = await launchReviewer(
					this.options.definition,
					this.options.machine,
					this.options.workers,
					this.options.dispatcher,
					this.options.kinds,
					{
						id,
						agent: this.options.agent,
						item: item.id,
						repo: item.repo,
						baseRef:
							this.options.definition.scope?.repos?.find(
								(repo) => repo.slug === item.repo,
							)?.base ?? "main",
						headSha: sha,
						pr: pr.number,
						producer: model,
						workspace: { id, repo: checkout, branch: this.branch(item) },
						briefText: `Review draft PR #${pr.number} at ${sha}. Use pr_diff, then report_verdict with this exact head SHA.`,
						outputFile: join(reviewDir, "verdict.json"),
						env: { ...this.options.env, DURABLE_ITEM: item.id },
						limits: this.options.definition.limits ?? {},
					},
					this.options.skillsRoot,
				);
				task.review = {
					id: launched.id,
					kind: launched.kind,
					headSha: launched.headSha,
					pr: launched.pr,
					producer: launched.producer,
					outputFile: launched.outputFile,
				};
				await this.store.save(state);
				return;
			}
			try {
				const registered = await this.options.workers.get(task.review.id);
				if ((await registered.kind.status(registered.handle)) === "running")
					return;
				item.review = {
					...(await collectReview(
						task.review as unknown as RunningReview,
						this.options.workers,
						this.options.definition,
					)),
					reviewedAt: this.now(),
				};
			} catch (error) {
				const failures = (task.reviewFailures?.[sha] ?? 0) + 1;
				task.reviewFailures ??= {};
				task.reviewFailures[sha] = failures;
				delete task.review;
				if (failures < 2) {
					audit(this.options.agent, {
						event: "reviewer-retry",
						item: item.id,
						sha,
						failures,
					});
					await this.store.save(state);
					return;
				}
				item.review = {
					sha,
					failed: true,
					reason: error instanceof Error ? error.message : "reviewer failed",
				};
				item.gate = {
					pr: pr.number,
					sha,
					state: "wait-human",
					reasons: ["review-failed"],
				};
				await this.store.save(state);
				await this.options.notify("escalation", item.id).catch(() =>
					audit(this.options.agent, {
						event: "notify-failed",
						item: item.id,
					}),
				);
				return;
			}
			delete task.review;
		}
		if (!item.review || item.review.failed) return;
		const review = item.review;
		if (item.gate?.mergeFailure) return;
		if (review.result.verdict !== "approve") {
			// A reviewer verdict is feedback, not a terminal approval state. Requeue
			// the producer with the SHA-bound review text and review the new head.
			task.phase = "dispatch";
			task.resume = true;
			task.briefText = `${task.briefText ?? ""}\n\nReviewer feedback for ${sha}:\n${review.result.summary}`;
			delete item.review;
			delete item.gate;
			await this.store.save(state);
			return;
		}
		const repoDefinition = this.options.definition.scope?.repos?.find(
			(repo) => repo.slug === item.repo,
		);
		const source = sourceFor(
			repoDefinition?.policySource?.kind ?? "none",
			this.options.fixturePolicies,
		);
		const resolution = await source.resolve({
			slug: item.repo,
			base: repoDefinition?.base,
		});
		const policy = effectivePolicy(resolution, {
			...this.options.definition.merge,
			...repoDefinition?.merge,
			tighten: {
				...this.options.definition.merge?.tighten,
				...repoDefinition?.merge?.tighten,
			},
		});
		const githubFacts = await collectFacts(
			{
				repo: item.repo,
				number: pr.number,
				profileLogin: this.options.login,
				protectedLocations: source.protectedLocations({
					slug: item.repo,
					base: repoDefinition?.base,
				}),
			},
			sha,
		);
		const facts =
			githubFacts &&
			(await this.gateFacts(
				githubFacts,
				policy,
				review.result.risk,
				review.reviewedAt,
			));
		let decision = decide(policy, facts);
		if (facts && decision.action === "merge") {
			const constraints = autoConstraintReasons(policy, facts, {
				profileLogin: this.options.login,
				baseBranch: facts.baseBranch,
				changedLines: facts.changedLines,
				fileCount: facts.fileCount,
				availableMethods:
					(await this.options.github.allowedMergeMethods?.(item.repo)) ?? null,
				baseProtected: await this.options.github.baseProtected?.(
					item.repo,
					facts.baseBranch ?? "",
				),
			});
			if (constraints.length)
				decision = { action: "wait-human", reasons: constraints };
		}
		item.stage = "gate";
		const approvalRequired = decision.reasons.includes(
			"human-approval-required",
		);
		item.gate = {
			pr: pr.number,
			sha,
			state: approvalRequired ? "waiting-approval" : "wait-human",
			reasons: decision.reasons,
			...(policy.shadow && facts
				? { report: shadowReport(decision, facts, resolution, source.kind) }
				: {}),
		};
		if (policy.shadow && item.gate.report)
			audit(this.options.agent, {
				event: "gate-shadow",
				item: item.id,
				sha,
				outcome: item.gate.report.outcome,
			});
		if (
			decision.action === "merge" &&
			!policy.shadow &&
			this.options.github.runGh
		) {
			// P6: resolve again immediately before the only merge executor call.
			const finalResolution = await source.resolve({
				slug: item.repo,
				base: repoDefinition?.base,
			});
			if (
				finalResolution.state !== "verified" ||
				finalResolution.policy?.enabled !== true ||
				finalResolution.fingerprint !== resolution.fingerprint
			)
				return this.recordMergeFailure(
					state,
					item,
					"policy changed before merge",
				);
			// Re-read all GitHub-computed facts immediately before merge; head pinning
			// alone does not protect against a changed base, draft state or checks.
			const finalGithubFacts = await collectFacts(
				{
					repo: item.repo,
					number: pr.number,
					profileLogin: this.options.login,
					protectedLocations: source.protectedLocations({
						slug: item.repo,
						base: repoDefinition?.base,
					}),
				},
				sha,
			);
			if (!finalGithubFacts)
				return this.recordMergeFailure(
					state,
					item,
					"unable to refresh merge facts",
				);
			const finalFacts = await this.gateFacts(
				finalGithubFacts,
				policy,
				review.result.risk,
				review.reviewedAt,
			);
			let finalDecision = decide(policy, finalFacts);
			const availableMethods =
				(await this.options.github.allowedMergeMethods?.(item.repo)) ?? [];
			if (finalDecision.action === "merge") {
				const constraints = autoConstraintReasons(policy, finalFacts, {
					profileLogin: this.options.login,
					baseBranch: finalFacts.baseBranch,
					changedLines: finalFacts.changedLines,
					fileCount: finalFacts.fileCount,
					availableMethods,
					baseProtected: await this.options.github.baseProtected?.(
						item.repo,
						finalFacts.baseBranch ?? "",
					),
				});
				if (constraints.length)
					finalDecision = { action: "wait-human", reasons: constraints };
			}
			if (finalDecision.action !== "merge")
				return this.recordMergeFailure(
					state,
					item,
					finalDecision.reasons.join(", "),
				);
			const method = selectedMergeMethod(policy, availableMethods);
			if (!method)
				return this.recordMergeFailure(
					state,
					item,
					"no allowed merge method before merge",
				);
			try {
				await mergeWhenSafe(
					this.options.github as Required<
						Pick<import("../gate/merge.ts").MergeGithub, "readPr" | "runGh">
					>,
					{
						repo: item.repo,
						number: pr.number,
						sha,
						method,
						item: item.id,
					},
				);
			} catch (error) {
				return this.recordMergeFailure(
					state,
					item,
					error instanceof Error ? error.message : "merge failed",
				);
			}
			item.gate.state = "wait-human";
			item.gate.reasons = ["merge-requested"];
			audit(this.options.agent, { event: "gate-merged", item: item.id, sha });
			await this.store.save(state);
			return;
		}
		if (item.gate.state !== "waiting-approval" || item.gate.notified) return;
		await this.store.save(state);
		await this.options.github.readyPr?.(item.repo, pr.number, item.id);
		await this.options.github.mirrorGate?.(
			item.repo,
			pr.number,
			sha,
			`| Fact | Value |\n| --- | --- |\n| Head SHA | \`${sha}\` |\n| Review verdict | ${review.result.verdict} |\n| Risk | ${review.result.risk} |\n| Gate reasons | ${decision.reasons.join(", ")} |\n\nAction: human approval required.`,
			item.id,
		);
		// Persist delivery intent before side effects, so a restart cannot replace an
		// already delivered nonce.
		item.gate.notified = true;
		await this.store.save(state);
		await this.options.notifyApproval?.(item.id, sha);
		if (!(await this.options.issueApproval?.(item.id, sha)))
			audit(this.options.agent, {
				event: "approval-nonce-unavailable",
				item: item.id,
			});
		audit(this.options.agent, {
			event: "gate-decision",
			item: item.id,
			sha,
			action: decision.action,
		});
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
			if (task.phase === "spec") {
				await this.progressSpec(state, item, task);
				return;
			}
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
			if (task.phase === "finish" && item.outcome === "parked")
				audit(o.agent, { event: "claim-lost", item: item.id });
			await this.store.save(state);
		}
	}
	private async progressSpec(
		state: WorkState,
		item: WorkItem,
		task: WorkItemTask,
	) {
		const pipeline = pipelineFor(this.options.definition, item.repo);
		const approval = pipeline.gates.specApproval === true;
		if (item.spec && item.spec.pr) {
			const current = await this.options.github.readPr(item.repo, item.spec.pr);
			if (current.state === "closed") {
				item.spec.state = "needs-human";
				item.outcome = "needs-human";
				await this.store.save(state);
				return;
			}
			if (!current.headSha) throw Error("spec PR head SHA is required");
			if (current.headSha !== item.spec.sha) {
				item.spec.sha = current.headSha;
				item.spec.state = approval ? "waiting-spec-approval" : "opened";
				delete item.spec.notified;
			}
		}
		const eligible = specEligible(
			item.candidate,
			pipeline.gates.complexityThreshold,
		);
		if (eligible !== true) {
			if (approval) {
				item.spec = { pr: 0, sha: "", state: "needs-human" };
				item.outcome = "needs-human";
				await this.store.save(state);
				return;
			}
			item.stage = "build";
			task.phase = "dispatch";
			await this.store.save(state);
			return;
		}
		if (!item.spec) {
			if (!this.options.github.createSpecPr)
				throw Error("GitHub spec PR creation is unavailable");
			const spec = await this.options.github.createSpecPr({
				repo: item.repo,
				item: item.id,
				branch: specBranch(this.options.agent, item.id),
				base:
					this.options.definition.scope?.repos?.find(
						(repo) => repo.slug === item.repo,
					)?.base ?? "main",
				title: `Draft spec: ${item.candidate.title}`,
				body: task.briefText ?? "",
			});
			if (!spec.headSha) throw Error("spec PR head SHA is required");
			item.spec = {
				pr: spec.number,
				sha: spec.headSha,
				state: approval ? "waiting-spec-approval" : "opened",
			};
			await this.store.save(state);
		}
		if (item.spec.state === "waiting-spec-approval") {
			if (!item.spec.notified) {
				if (
					!(await this.options.issueSpecApproval?.(
						item.id,
						item.spec.pr,
						item.spec.sha,
					))
				)
					audit(this.options.agent, {
						event: "spec-approval-nonce-unavailable",
						item: item.id,
					});
				item.spec.notified = true;
				await this.store.save(state);
			}
			return;
		}
		item.stage = "build";
		task.phase = "dispatch";
		await this.store.save(state);
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
			lease: new Date(this.now() + this.leasePolicy().durationMs).toISOString(),
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
			claimLeasePolicy: this.leasePolicy(),
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
	private async gateFacts(
		githubFacts: GateFacts,
		policy: EffectivePolicy,
		risk: Risk,
		reviewedAt: number,
	): Promise<GateFacts> {
		const riskRank = { low: 0, medium: 1, high: 2 } as const;
		return {
			...githubFacts,
			// collectReview verifies the reviewer provenance before this point.
			crossFamilyReview: true,
			riskAcceptable:
				policy.maxRisk === undefined ||
				riskRank[risk] <= riskRank[policy.maxRisk],
			// No daily-cap policy exists in the accepted policy schema.
			dailyCapAvailable: true,
			coolingOffElapsed:
				policy.coolingOffMinutes === undefined ||
				this.now() - reviewedAt >= policy.coolingOffMinutes * 60_000,
			// check() is the single kill-switch authority. Probe it so decide emits
			// its fail-closed reason instead of fabricating an affirmative fact.
			killSwitchOff: await this.killSwitchOff(),
		};
	}
	private async killSwitchOff() {
		try {
			await this.options.check();
			return true;
		} catch {
			return false;
		}
	}
	private async recordMergeFailure(
		state: WorkState,
		item: WorkItem,
		reason: string,
	) {
		if (!item.gate) return;
		item.gate.state = "wait-human";
		item.gate.reasons = ["merge-failed", reason];
		item.gate.mergeFailure = {
			count: (item.gate.mergeFailure?.count ?? 0) + 1,
			reason,
			failedAt: this.now(),
		};
		audit(this.options.agent, { event: "gate-merge-failed", item: item.id });
		await this.store.save(state);
	}
	private leasePolicy() {
		return {
			durationMs:
				(this.options.definition.schedule?.leaseSeconds ??
					defaultClaimLeasePolicy.durationMs / 1000) * 1000,
			graceMs:
				(this.options.definition.schedule?.leaseGraceSeconds ??
					defaultClaimLeasePolicy.graceMs / 1000) * 1000,
		};
	}
	private async renew(state: WorkState, item: WorkItem) {
		const o = this.options;
		if (!item.claim?.commentId || item.candidate.kind === "file") return;
		const now = this.now();
		const target = {
			repo: item.repo,
			issue: intakeNumber(item.candidate.ref),
			agent: o.agent,
			lease: item.claim.lease,
			item: item.id,
			owner: o.claimOwner,
			login: o.login,
		};
		const observed = await readClaim(o.github, target, now, this.leasePolicy());
		const expiredWithoutWinner = observed.state === "lost" && !observed.winner;
		if (!expiredWithoutWinner && observed.state === "lost") {
			await o.github.deleteComment?.(item.repo, item.claim.commentId, item.id);
			audit(o.agent, { event: "claim-lost", item: item.id });
			await this.cancel(state, item, "interrupted");
			throw Error("claim lease lost");
		}
		if (
			!expiredWithoutWinner &&
			Date.parse(item.claim.lease) - now >= this.leasePolicy().durationMs / 2
		)
			return;
		const lease = new Date(now + this.leasePolicy().durationMs).toISOString();
		const result = await claim(
			o.github,
			{ ...target, lease },
			now,
			this.leasePolicy(),
		);
		if (result.state === "lost") {
			await this.cancel(state, item, "interrupted");
			throw Error("claim lease lost");
		}
		if (expiredWithoutWinner)
			await o.github.deleteComment?.(item.repo, item.claim.commentId, item.id);
		item.claim.commentId = result.commentId;
		item.claim.lease = lease;
		await this.store.save(state);
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
			const target = {
				repo: item.repo,
				issue,
				agent: this.options.agent,
				lease: item.claim.lease,
				owner: this.options.claimOwner,
				login: this.options.login,
			};
			const held = await readClaim(
				this.options.github,
				target,
				this.now(),
				this.leasePolicy(),
			);
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
			if (held.state === "won")
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
	// fallow-ignore-next-line unused-class-member -- invoked by the HTTP approval route.
	async approveSpec(id: string, pr: number, sha: string) {
		return this.enqueue(async () => {
			const state = await this.store.load();
			const item = state.work.items[id];
			if (!item?.spec || item.spec.pr !== pr || item.spec.sha !== sha)
				throw Object.assign(Error("approval does not match the current spec"), {
					code: "conflict",
				});
			item.spec.state = "approved";
			item.updatedAt = this.now();
			await this.store.save(state);
			audit(this.options.agent, {
				event: "spec-approved-nonce",
				item: id,
				sha,
			});
		});
	}
	// fallow-ignore-next-line unused-class-member -- invoked by the HTTP approval route.
	async approveGate(id: string, sha: string) {
		return this.enqueue(async () => {
			const state = await this.store.load();
			const item = state.work.items[id];
			if (
				!item?.gate ||
				item.gate.sha !== sha ||
				item.gate.state !== "waiting-approval"
			)
				throw Object.assign(
					Error("approval does not match an active approval gate"),
					{
						code: "conflict",
					},
				);
			const live = await this.options.github.readPr(item.repo, item.gate.pr);
			if (live.headSha !== sha)
				throw Object.assign(
					Error("approval does not match the live pull request head"),
					{
						code: "conflict",
					},
				);
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
				if (item.attempts.at(-1) && !item.attempts.at(-1)?.endedAt)
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
