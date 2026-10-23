import type { ModelDef } from "../config/schema.ts";
import type { HostedProcess, Workspace } from "../dispatch/types.ts";

export type JobSpec = {
	id: string;
	agent: string;
	item: string;
	repo?: string;
	baseRef?: string;
	baseSha?: string;
	reviewedHeadSha?: string;
	reviewedFamily?: string;
	viewer?: "on-start" | "on-demand" | "never";
	role: "worker" | "reviewer";
	briefText: string;
	workspace: Workspace;
	model: ModelDef;
	limits: Record<string, number>;
	skills?: string[];
	env: Record<string, string | undefined>;
	piDir?: string;
	resume?: boolean;
};
export type WorkerCapabilities = {
	attach: "interactive" | "read";
	steer: boolean;
	transcript: boolean;
	interrupt: boolean;
	resumeAfterCrash: boolean;
	skills: "full" | "allowlisted-text";
	extensions: boolean;
	anthropicOAuth: "extension" | "modelAuth-option";
	headless: boolean;
	processIsolated: boolean;
	tokenInShell: boolean;
	viewable: "terminal" | "durable-attach";
};
export type WorkerHandle = {
	id: string;
	job: JobSpec;
	process: HostedProcess;
	startedAt: number;
};
export interface WorkerKind {
	readonly name: "pi-session" | "durable-conversation";
	start(job: JobSpec): Promise<WorkerHandle>;
	status(handle: WorkerHandle): Promise<"running" | "exited" | "unknown">;
	result(handle: WorkerHandle): Promise<{
		status: string;
		cost?: number;
		outcome?: import("./durable/anchor.ts").WorkerStop;
		review?: import("./durable/review.ts").ReviewResult;
		provenance?: import("./durable/review.ts").ModelProvenance;
	}>;
	interrupt(
		handle: WorkerHandle,
		mode: "soft" | "hard",
		reason?: import("./durable/anchor.ts").WorkerStop,
	): Promise<void>;
	steer?(handle: WorkerHandle, text: string): Promise<void>;
	transcript(handle: WorkerHandle): AsyncIterable<string>;
	resume(handle: WorkerHandle): Promise<WorkerHandle>;
	describe(handle: WorkerHandle): {
		id: string;
		item: string;
		workspace: string;
		startedAt: number;
	};
	capabilities(): WorkerCapabilities;
}
export class WorkerKindRegistry {
	private readonly kinds = new Map<string, WorkerKind>();
	register(kind: WorkerKind): void {
		this.kinds.set(kind.name, kind);
	}
	get(name: "pi-session" | "durable-conversation"): WorkerKind {
		const kind = this.kinds.get(name);
		if (!kind) throw Error(`worker kind not registered: ${name}`);
		return kind;
	}
}
