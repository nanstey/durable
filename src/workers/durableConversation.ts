import type { HostedProcess } from "../dispatch/types.ts";
import type { DurableAnchor } from "./durable/anchor.ts";
import type {
	JobSpec,
	WorkerCapabilities,
	WorkerHandle,
	WorkerKind,
} from "./kind.ts";

/** In-process pi-durable worker. Its background anchor, not the steward main turn, owns the child. */
export class DurableConversationKind implements WorkerKind {
	readonly name = "durable-conversation" as const;
	private readonly anchor: DurableAnchor;
	constructor(anchor: DurableAnchor) {
		this.anchor = anchor;
	}
	async start(job: JobSpec): Promise<WorkerHandle> {
		const existing = await this.anchor.find(job.id);
		const conversation = existing ?? (await this.anchor.create(job));
		const process: HostedProcess = {
			id: job.id,
			handle: `durable:${conversation.id}`,
			workspace: job.workspace,
		};
		return { id: job.id, job, process, startedAt: Date.now() };
	}
	async status(handle: WorkerHandle) {
		const conversation = await this.anchor.find(handle.id);
		return conversation?.state === "running" ||
			conversation?.state === "waiting"
			? "running"
			: conversation
				? "exited"
				: "unknown";
	}
	async result(handle: WorkerHandle) {
		const conversation = await this.anchor.find(handle.id);
		return {
			status: await this.status(handle),
			outcome: conversation?.outcome,
			review: conversation?.review?.result,
			provenance: conversation?.review?.provenance,
		};
	}
	async interrupt(
		handle: WorkerHandle,
		mode: "soft" | "hard",
		reason?: import("./durable/anchor.ts").WorkerStop,
	) {
		if (mode === "hard") await this.anchor.abort(handle.id, reason);
		else await this.anchor.soft(handle.id);
	}
	// Invoked through WorkerKind by WorkerRegistry.
	// fallow-ignore-next-line unused-class-member
	async steer(handle: WorkerHandle, text: string) {
		const conversation = await this.anchor.find(handle.id);
		if (!conversation)
			throw Object.assign(Error("worker not found"), { code: "not_found" });
		await this.anchor.steer(conversation.id, text);
	}
	async *transcript(handle: WorkerHandle): AsyncIterable<string> {
		const conversation = await this.anchor.find(handle.id);
		if (conversation) yield* this.anchor.transcript(conversation.id);
	}
	async resume(handle: WorkerHandle) {
		return this.start(handle.job);
	}
	describe(handle: WorkerHandle) {
		return {
			id: handle.id,
			item: handle.job.item,
			workspace: handle.job.workspace.path,
			startedAt: handle.startedAt,
		};
	}
	capabilities(): WorkerCapabilities {
		return {
			attach: "interactive",
			steer: true,
			transcript: true,
			interrupt: true,
			resumeAfterCrash: true,
			skills: "allowlisted-text",
			extensions: false,
			anthropicOAuth: "modelAuth-option",
			headless: true,
			processIsolated: false,
			tokenInShell: false,
			viewable: "durable-attach",
		};
	}
}
