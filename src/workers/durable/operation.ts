import { AsyncLocalStorage } from "node:async_hooks";
import type { ProcessManager } from "../../steward/procs.ts";
import type { JobSpec } from "../kind.ts";

const active = new AsyncLocalStorage<{ job: JobSpec; signal?: AbortSignal }>();

/** Execution-only context, never ownership/persistence. Backends recheck it before every subprocess. */
export function workerOperation() {
	const operation = active.getStore();
	operation?.signal?.throwIfAborted();
	return operation;
}

export async function withWorkerOperation<T>(
	job: JobSpec,
	processes: Pick<ProcessManager, "terminate">,
	signal: AbortSignal | undefined,
	run: () => Promise<T>,
): Promise<T> {
	signal?.throwIfAborted();
	const cancel = () => {
		void processes.terminate({ attemptId: job.id }).catch(() => {});
	};
	signal?.addEventListener("abort", cancel, { once: true });
	try {
		return await active.run({ job, signal }, run);
	} finally {
		signal?.removeEventListener("abort", cancel);
	}
}
