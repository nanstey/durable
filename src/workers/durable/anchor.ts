import type { JobSpec } from "../kind.ts";

export type DurableConversation = {
	id: string;
	ownerTaskId: string;
	job: JobSpec;
	state: "running" | "waiting" | "done" | "aborted";
};

/** Adapter over pi-durable's task ownership index; the harness owns persistence. */
export interface DurableAnchor {
	find(ownerTaskId: string): Promise<DurableConversation | undefined>;
	create(input: {
		ownerTaskId: string;
		job: JobSpec;
	}): Promise<DurableConversation>;
	abort(ownerTaskId: string): Promise<void>;
	steer(conversationId: string, text: string): Promise<void>;
	transcript(conversationId: string): AsyncIterable<string>;
}

/** Test adapter; production must provide a transaction-backed task ownership index. */
export class MemoryDurableAnchor implements DurableAnchor {
	private readonly conversations = new Map<string, DurableConversation>();
	async find(ownerTaskId: string) {
		return this.conversations.get(ownerTaskId);
	}
	async create(input: { ownerTaskId: string; job: JobSpec }) {
		const existing = await this.find(input.ownerTaskId);
		if (existing) return existing;
		const conversation = {
			id: `durable-${input.ownerTaskId}`,
			ownerTaskId: input.ownerTaskId,
			job: input.job,
			state: "running" as const,
		};
		this.conversations.set(input.ownerTaskId, conversation);
		return conversation;
	}
	async abort(ownerTaskId: string) {
		const conversation = this.conversations.get(ownerTaskId);
		if (conversation) conversation.state = "aborted";
	}
	async steer(_conversationId: string, _text: string) {}
	async *transcript(_conversationId: string): AsyncIterable<string> {}
}
