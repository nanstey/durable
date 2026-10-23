import type { Candidate } from "../sources/types.ts";
import type { Queue, QueueItem } from "./queue.ts";

export type WorkItemOutcome =
	| "merged"
	| "cancelled"
	| "parked"
	| "needs-human"
	| "limit"
	| "paused"
	| "held";
export type WorkAttempt = {
	id: string;
	startedAt: number;
	endedAt?: number;
	cost?: number;
	cancelledBy?: string;
};
export type WorkItem = {
	id: string;
	intakeRef: string;
	repo: string;
	candidate: Candidate;
	claim?: { agent: string; lease: string; commentId?: number };
	attempts: WorkAttempt[];
	prs: Array<{
		number: number;
		url?: string;
		primary: boolean;
		state?: "open" | "merged" | "closed";
	}>;
	outcome?: WorkItemOutcome;
	createdAt: number;
	updatedAt: number;
};
export type WorkItems = {
	items: Record<string, WorkItem>;
	byIntakeRef: Record<string, string>;
};

export function emptyWorkItems(): WorkItems {
	return { items: {}, byIntakeRef: {} };
}
/** Stable, filesystem-safe id. The intake ref remains the authoritative external identity. */
// fallow-ignore-next-line unused-export
export function workItemId(candidate: Pick<Candidate, "repo" | "ref">): string {
	return `${candidate.repo}:${candidate.ref}`.replace(/[^A-Za-z0-9._:-]/g, "_");
}

/** The only mutation entry point for named work items. Ineligible queue entries never migrate. */
export function migrateEligible(
	queue: Queue,
	workItems: WorkItems,
	now: number,
): WorkItems {
	for (const item of Object.values(queue.items)) {
		if (item.state !== "eligible") continue;
		const id = workItems.byIntakeRef[item.ref] ?? workItemId(item);
		if (!workItems.items[id])
			workItems.items[id] = {
				id,
				intakeRef: item.ref,
				repo: item.repo,
				candidate: item,
				attempts: [],
				prs: [],
				createdAt: now,
				updatedAt: now,
			};
		workItems.byIntakeRef[item.ref] = id;
	}
	return workItems;
}

/** Queue is a projection: it retains eligibility reasons and adds migrated work state without owning it. */
// fallow-ignore-next-line unused-export
export function projectQueue(queue: Queue, workItems: WorkItems): Queue {
	const items: Record<string, QueueItem> = {};
	for (const [ref, entry] of Object.entries(queue.items)) {
		const item = workItems.items[workItems.byIntakeRef[ref]];
		items[ref] = item
			? { ...entry, reasons: [...entry.reasons, `work-item:${item.id}`] }
			: { ...entry, reasons: [...entry.reasons] };
	}
	return { items };
}

// fallow-ignore-next-line unused-export
export function recordPrimaryPr(
	item: WorkItem,
	pr: { number: number; url?: string; state?: "open" | "merged" | "closed" },
	now: number,
): void {
	const existing = item.prs.find((entry) => entry.number === pr.number);
	if (existing) Object.assign(existing, pr);
	else
		item.prs.push({ ...pr, primary: !item.prs.some((entry) => entry.primary) });
	item.updatedAt = now;
}

/** Only GitHub-confirmed terminal states complete work. A handoff is deliberately not an outcome. */
export function reconcilePrs(
	item: WorkItem,
	prs: Array<{ number: number; state: "open" | "merged" | "closed" }>,
	now: number,
): void {
	for (const observed of prs) {
		const known = item.prs.find((entry) => entry.number === observed.number);
		if (known) known.state = observed.state;
	}
	const primary = item.prs.find((entry) => entry.primary);
	if (primary?.state === "merged") item.outcome = "merged";
	else if (primary?.state === "closed") item.outcome = "parked";
	item.updatedAt = now;
}

// fallow-ignore-next-line unused-export
export function complete(
	item: WorkItem,
	outcome: Extract<WorkItemOutcome, "cancelled" | "parked">,
	now: number,
): void {
	item.outcome = outcome;
	item.updatedAt = now;
}
