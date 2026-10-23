import type { IndexedConversation, IndexedTask, TreeNode } from "./nodes.ts";

export function buildTree(
	conversations: IndexedConversation[],
	tasks: IndexedTask[],
	fences: Record<string, { state: string }> = {},
): TreeNode[] {
	return conversations.map((conversation) => {
		const owner = tasks.find((task) => task.key === conversation.ownerTask);
		const parentKey = owner?.conversation ?? conversation.ownerConversation;
		const parent = conversations.find(
			(candidate) => candidate.key === parentKey,
		);
		const running = tasks.filter(
			(task) =>
				task.conversation === conversation.key &&
				task.kind !== "steward-loop" &&
				task.kind !== "steward.conversation-anchor",
		);
		const fence = conversation.item && fences[conversation.item];
		const status = fence
			? fence.state === "held"
				? "held"
				: "holding"
			: running.some(
						(task) => task.status === "running" || task.status === "pending",
					)
				? "running"
				: running.length || conversation.turnAborted
					? "waiting"
					: "idle";
		const steer = !conversation.kind.startsWith("reviewer");
		return {
			id: conversation.id,
			parentId: parent?.id ?? null,
			kind: conversation.kind,
			status,
			...(conversation.item ? { item: conversation.item } : {}),
			...(conversation.ownerTask !== undefined
				? { ownerTaskId: String(conversation.ownerTask) }
				: {}),
			source: "durable",
			startedAt: conversation.startedAt,
			capabilities: {
				attach: "interactive",
				steer,
				transcript: true,
				interrupt: true,
				resumeAfterCrash: true,
			},
		};
	});
}
