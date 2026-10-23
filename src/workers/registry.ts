import type { WorkerDispatcher, WorkspaceSpec } from "../dispatch/types.ts";
import type { TreeNode } from "../tree/nodes.ts";
import type { JobSpec, WorkerHandle, WorkerKind } from "./kind.ts";

/** A job is registered only after its dispatcher-created workspace launches. */
export type PendingJobSpec = Omit<JobSpec, "workspace"> & {
	workspace: WorkspaceSpec;
};

export class WorkerRegistry {
	private readonly workers = new Map<
		string,
		{ kind: WorkerKind; handle: WorkerHandle }
	>();
	register(kind: WorkerKind, handle: WorkerHandle): void {
		this.workers.set(handle.id, { kind, handle });
	}
	async launch(
		dispatcher: WorkerDispatcher,
		kind: WorkerKind,
		job: PendingJobSpec,
	): Promise<WorkerHandle> {
		const workspace = await dispatcher.createWorkspace(job.workspace);
		const handle = await kind.start({ ...job, workspace });
		this.register(kind, handle);
		return handle;
	}
	async list() {
		return Promise.all(
			[...this.workers.values()].map(async ({ kind, handle }) => ({
				...kind.describe(handle),
				kind: kind.name,
				status: await kind.status(handle),
				capabilities: kind.capabilities(),
			})),
		);
	}
	async get(id: string) {
		const worker = this.workers.get(id);
		if (!worker)
			throw Object.assign(Error("worker not found"), { code: "not_found" });
		return worker;
	}
	async transcript(id: string): Promise<string[]> {
		const worker = await this.get(id);
		const lines: string[] = [];
		for await (const line of worker.kind.transcript(worker.handle))
			lines.push(line);
		return lines;
	}
	async steer(id: string, text: string): Promise<void> {
		const worker = await this.get(id);
		if (!worker.kind.capabilities().steer || !worker.kind.steer)
			throw Object.assign(Error("steer not supported"), {
				code: "not_supported",
			});
		await worker.kind.steer(worker.handle, text);
	}
	async interrupt(id: string, mode: "soft" | "hard"): Promise<void> {
		const worker = await this.get(id);
		await worker.kind.interrupt(worker.handle, mode);
	}
	async tree(parentId: string | null): Promise<TreeNode[]> {
		return (await this.list()).map((worker) => ({
			id: worker.id,
			parentId,
			kind: worker.kind === "pi-session" ? "worker-pi" : "worker-durable",
			status:
				worker.status === "running"
					? "running"
					: worker.status === "exited"
						? "done"
						: "waiting",
			item: worker.item,
			source: "dispatcher",
			workspace: worker.workspace,
			startedAt: worker.startedAt,
			capabilities: worker.capabilities,
		}));
	}
}
