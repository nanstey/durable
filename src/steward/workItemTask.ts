import type { AgentDef, MachineCfg, ModelDef } from "../config/schema.ts";
import type { ClaimGithub } from "./claims.ts";
import { claim } from "./claims.ts";
import type { WorkItem } from "./workItems.ts";
import type { WorkerRegistry } from "../workers/registry.ts";
import type { WorkerKindRegistry } from "../workers/kind.ts";
import { selectWorkerKind } from "../workers/select.ts";
import type { WorkerDispatcher } from "../dispatch/types.ts";

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
};

/** Intent-first, deterministic work-item progression. Persist task before invoking each effect. */
export async function advanceWorkItem(
	task: WorkItemTask,
	item: WorkItem,
	deps: {
		agent: string;
		lease: string;
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
	},
): Promise<WorkItemTask> {
	if (item.outcome) return { ...task, phase: "finish" };
	if (task.phase === "claim") {
		const issue = Number(item.candidate.ref.replace(/^.*?(\d+)$/, "$1"));
		if (!Number.isSafeInteger(issue))
			throw Error("GitHub claim requires numeric intake ref");
		const result = await claim(deps.github, {
			repo: item.repo,
			issue,
			agent: deps.agent,
			lease: deps.lease,
		});
		if (result.state === "lost") {
			item.outcome = "parked";
			return { ...task, phase: "finish" };
		}
		item.claim = {
			agent: deps.agent,
			lease: deps.lease,
			commentId: result.commentId,
		};
		return { ...task, phase: "brief" };
	}
	if (task.phase === "brief") return { ...task, phase: "dispatch" };
	if (task.phase === "dispatch") {
		const kind = selectWorkerKind(
			deps.kinds,
			deps.definition,
			deps.machine,
			"worker",
		);
		const id = `durable-${deps.agent}-${item.id}`;
		await deps.workers.launch(deps.dispatcher, kind, {
			id,
			agent: deps.agent,
			item: item.id,
			role: "worker",
			briefText: await deps.brief(),
			workspace: {
				id,
				repo: item.repo,
				branch: `durable/${deps.agent}/${item.id}`,
			},
			model: deps.model,
			limits: deps.definition.limits ?? {},
			env: deps.env,
			piDir: deps.piDir,
		});
		item.attempts.push({ id, startedAt: Date.now() });
		return { ...task, phase: "await-pr", workerId: id };
	}
	return task;
}
