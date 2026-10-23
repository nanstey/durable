import {
	reconcilePrs,
	recordPrimaryPr,
	type WorkItem,
} from "../steward/workItems.ts";
import type { WorkerKind } from "../workers/kind.ts";

export interface PrMonitorGithub {
	findDraftPr(input: {
		repo: string;
		branch: string;
		marker: string;
	}): Promise<
		{ number: number; state: "open" | "merged" | "closed" } | undefined
	>;
	commentOnce(input: {
		repo: string;
		item: string;
		body: string;
	}): Promise<void>;
}

/** Reconcile GitHub before retrying a dead session. Intentional cancellations never resume. */
export async function monitorWorker(input: {
	item: WorkItem;
	branch: string;
	marker: string;
	kind: WorkerKind;
	handle: Parameters<WorkerKind["status"]>[0];
	github: PrMonitorGithub;
	maxAttempts: number;
	fenced?: boolean;
	resume?: () => Promise<void>;
}): Promise<"waiting" | "resumed" | "needs-human" | "complete"> {
	const pr = await input.github.findDraftPr({
		repo: input.item.repo,
		branch: input.branch,
		marker: input.marker,
	});
	if (pr) {
		recordPrimaryPr(input.item, pr, Date.now());
		reconcilePrs(input.item, [pr], Date.now());
		if (input.item.outcome === "merged" || input.item.outcome === "parked")
			return "complete";
		return "waiting";
	}
	const status = await input.kind.status(input.handle);
	if (status === "running") return "waiting";
	const attempt = input.item.attempts.at(-1);
	if (
		input.fenced ||
		attempt?.cancelledBy ||
		input.item.outcome === "held" ||
		input.item.outcome === "paused"
	)
		return "waiting";
	if (input.item.attempts.length >= input.maxAttempts) {
		input.item.outcome = "needs-human";
		await input.github.commentOnce({
			repo: input.item.repo,
			item: input.item.id,
			body: "<!-- durable-escalation -->\nWorker exited without a draft PR.",
		});
		return "needs-human";
	}
	if (input.resume) await input.resume();
	else {
		const handle = await input.kind.resume(input.handle);
		if (attempt) attempt.endedAt = Date.now();
		input.item.attempts.push({
			id: handle.id,
			startedAt: Date.now(),
			worker: { kind: input.kind.name, process: handle.process },
		});
	}
	return "resumed";
}
