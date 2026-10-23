import type { AgentDef, MachineCfg, ModelDef } from "../config/schema.ts";
import type { WorkerDispatcher } from "../dispatch/types.ts";
import {
	nextStage,
	pipelineDoctorErrors,
	pipelineFor,
} from "../pipeline/select.ts";
import type { WorkerKindRegistry } from "../workers/kind.ts";
import type { WorkerRegistry } from "../workers/registry.ts";
import { selectWorkerKind } from "../workers/select.ts";
import { type ClaimGithub, claim } from "./claims.ts";
import { intakeNumber } from "./github.ts";
import type { WorkItem } from "./workItems.ts";

export type WorkItemPhase =
	| "claim"
	| "brief"
	| "dispatch"
	| "await-pr"
	| "finish";
export type WorkItemTask = {
	phase: WorkItemPhase;
	itemId: string;
	workerId?: string;
	briefText?: string;
	resume?: boolean;
	finished?: boolean;
};
export type TaskDependencies = {
	agent: string;
	lease: string;
	claimOwner?: string;
	github: ClaimGithub;
	brief: () => Promise<string>;
	dispatcher: WorkerDispatcher;
	workers: WorkerRegistry;
	kinds: WorkerKindRegistry;
	definition: AgentDef;
	machine: MachineCfg;
	model: ModelDef;
	env: Record<string, string | undefined>;
	piDir?: string;
	skillsRoot?: string;
	checkout?: string;
	check?: () => Promise<void>;
	persist?: (task: WorkItemTask) => Promise<void>;
	now?: () => number;
};

async function claimItem(
	task: WorkItemTask,
	item: WorkItem,
	deps: TaskDependencies,
): Promise<WorkItemTask> {
	if (item.candidate.kind === "file")
		item.claim = { agent: deps.agent, lease: deps.lease };
	else {
		const result = await claim(
			deps.github,
			{
				repo: item.repo,
				issue: intakeNumber(item.candidate.ref),
				agent: deps.agent,
				lease: deps.lease,
				item: item.id,
				owner: deps.claimOwner,
			},
			(deps.now ?? Date.now)(),
		);
		if (result.state === "lost") {
			item.outcome = "parked";
			return { ...task, phase: "finish" };
		}
		item.claim = {
			agent: deps.agent,
			lease: deps.lease,
			commentId: result.commentId,
		};
	}
	item.stage = nextStage(pipelineFor(deps.definition, item.repo));
	return { ...task, phase: "brief" };
}

async function dispatchItem(
	task: WorkItemTask,
	item: WorkItem,
	deps: TaskDependencies,
): Promise<WorkItemTask> {
	if (item.stage && item.stage !== "build")
		throw Error("pipeline refuses dispatch outside build");
	const kind = selectWorkerKind(
		deps.kinds,
		deps.definition,
		deps.machine,
		"worker",
		deps.skillsRoot,
	);
	let attempt = item.attempts.at(-1);
	if (!attempt || attempt.endedAt) {
		attempt = {
			id: `durable-${deps.agent}-${item.id}-${item.attempts.length + 1}`,
			startedAt: (deps.now ?? Date.now)(),
		};
		item.attempts.push(attempt);
	}
	const intent = { ...task, workerId: attempt.id };
	await deps.persist?.(intent);
	await deps.check?.();
	const handle = await deps.workers.launch(deps.dispatcher, kind, {
		id: attempt.id,
		agent: deps.agent,
		item: item.id,
		repo: item.repo,
		baseRef: deps.definition.scope?.repos?.find(
			(repo) => repo.slug === item.repo,
		)?.base,
		role: "worker",
		briefText: task.briefText ?? (await deps.brief()),
		workspace: {
			id: `durable-${deps.agent}-${item.id}`,
			repo: deps.checkout ?? item.repo,
			branch: `durable/${deps.agent}/${item.id}`,
		},
		model: deps.model,
		limits: deps.definition.limits ?? {},
		env: deps.env,
		piDir: deps.piDir,
		resume: task.resume,
	});
	attempt.worker = { kind: kind.name, process: handle.process };
	return { ...intent, phase: "await-pr" };
}

/** Each persisted phase is an intent. Replays re-read claims and reuse workspace/job ids. */
export async function advanceWorkItem(
	task: WorkItemTask,
	item: WorkItem,
	deps: TaskDependencies,
): Promise<WorkItemTask> {
	if (item.outcome) return { ...task, phase: "finish" };
	await deps.check?.();
	const pipeline = pipelineFor(deps.definition, item.repo);
	const errors = pipelineDoctorErrors(pipeline);
	if (errors.length) throw Error(errors.join("; "));
	if (task.phase === "claim") return claimItem(task, item, deps);
	if (task.phase === "dispatch") return dispatchItem(task, item, deps);
	if (task.phase !== "brief") return task;
	const briefText = await deps.brief();
	item.stage = pipeline.stages.includes("scout")
		? nextStage(pipeline, "scout")
		: nextStage(pipeline);
	if (item.stage !== "build") throw Error("pipeline refuses build transition");
	return { ...task, phase: "dispatch", briefText };
}
