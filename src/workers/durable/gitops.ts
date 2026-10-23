export type GitOperation =
	| "commit"
	| "push_branch"
	| "open_draft_pr"
	| "report";
export type OperationIntent = {
	attemptId: string;
	op: GitOperation;
	repo: string;
	branch: string;
	commitSha: string;
	expectedRemoteHead?: string;
	state: "intent" | "confirmed" | "conflict";
};

/** Persist this interface in the steward document store before an external effect. */
export interface OperationStore {
	read(
		attemptId: string,
		op: GitOperation,
	): Promise<OperationIntent | undefined>;
	write(intent: OperationIntent): Promise<void>;
}
export type RemoteHead = (
	repo: string,
	branch: string,
) => Promise<string | undefined>;

export async function beginOperation(
	store: OperationStore,
	intent: Omit<OperationIntent, "state">,
): Promise<OperationIntent | "busy"> {
	const existing = await store.read(intent.attemptId, intent.op);
	if (existing?.state === "intent") return "busy";
	if (existing) return existing;
	const next: OperationIntent = { ...intent, state: "intent" };
	await store.write(next);
	return next;
}

/** Reconciliation never overwrites a remote branch moved by another writer. */
export async function reconcilePush(
	store: OperationStore,
	intent: OperationIntent,
	remoteHead: RemoteHead,
): Promise<"confirmed" | "retry" | "conflict"> {
	const head = await remoteHead(intent.repo, intent.branch);
	const state =
		head === intent.commitSha
			? "confirmed"
			: head === intent.expectedRemoteHead
				? "retry"
				: "conflict";
	if (state !== "retry") await store.write({ ...intent, state });
	return state;
}

// fallow-ignore-next-line unused-export
export function gitInvocation(argv: string[]): string[] {
	return [
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"core.fsmonitor=false",
		...argv,
	];
}
