import type { WorkerKind } from "../workers/kind.ts";
import type { WorkItem } from "../steward/workItems.ts";

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
}): Promise<"waiting" | "resumed" | "needs-human" | "complete"> {
	const pr = await input.github.findDraftPr({
		repo: input.item.repo,
		branch: input.branch,
		marker: input.marker,
	});
	if (pr) {
		const known = input.item.prs.find((entry) => entry.number === pr.number);
		if (known) known.state = pr.state;
		else
			input.item.prs.push({
				number: pr.number,
				primary: input.item.prs.length === 0,
				state: pr.state,
			});
		if (pr.state === "merged") {
			input.item.outcome = "merged";
			return "complete";
		}
		if (pr.state === "closed") input.item.outcome = "parked";
		return "waiting";
	}
	const status = await input.kind.status(input.handle);
	if (status === "running") return "waiting";
	const attempt = input.item.attempts.at(-1);
	if (
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
	await input.kind.resume(input.handle);
	return "resumed";
}
