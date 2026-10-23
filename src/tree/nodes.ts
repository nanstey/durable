export type NodeKind =
	| "steward"
	| "chat"
	| "scout"
	| "worker-durable"
	| "reviewer-durable"
	| "worker-pi"
	| "reviewer-pi"
	| "subagent";
export type TreeNode = {
	id: string;
	parentId: string | null;
	kind: NodeKind;
	status:
		| "idle"
		| "running"
		| "waiting"
		| "done"
		| "failed"
		| "aborted"
		| "holding"
		| "held";
	item?: string;
	ownerTaskId?: string;
	source: "durable" | "dispatcher";
	workspace?: string;
	startedAt: number;
	capabilities: {
		attach: string;
		steer: boolean;
		transcript: boolean;
		interrupt: boolean;
		resumeAfterCrash: boolean;
	};
};
export type IndexedConversation = {
	key: number;
	id: string;
	kind: NodeKind;
	startedAt: number;
	ownerTask?: number;
	ownerConversation?: number;
	item?: string;
	turnAborted?: boolean;
};
export type IndexedTask = {
	key: number;
	conversation: number;
	status: string;
	kind: string;
	owner?: number;
};
