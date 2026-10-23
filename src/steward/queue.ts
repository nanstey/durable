import type { Candidate } from "../sources/types.ts";

export type QueueState =
	| "candidate"
	| "eligible"
	| "skipped"
	| "needs-human"
	| "too-big";
export type QueueItem = Candidate & {
	state: QueueState;
	reasons: string[];
	firstSeen: number;
	lastSeen: number;
	workItem?: string;
};
export type Queue = { items: Record<string, QueueItem> };

export function updateQueue(
	queue: Queue,
	entries: Array<{
		candidate: Candidate;
		state: QueueState;
		reasons: string[];
	}>,
	now: number,
	staleMs: number,
): Queue {
	const seen = new Set<string>();
	for (const entry of entries) {
		seen.add(entry.candidate.ref);
		const previous = queue.items[entry.candidate.ref];
		queue.items[entry.candidate.ref] = {
			...entry.candidate,
			state: entry.state,
			reasons: entry.reasons,
			firstSeen: previous?.firstSeen ?? now,
			lastSeen: now,
		};
	}
	for (const [ref, item] of Object.entries(queue.items))
		if (!seen.has(ref) && now - item.lastSeen > staleMs)
			delete queue.items[ref];
	return queue;
}

export function ranked(queue: Queue) {
	return Object.values(queue.items).sort(
		(a, b) =>
			Number(b.state === "eligible") - Number(a.state === "eligible") ||
			b.lastSeen - a.lastSeen ||
			a.ref.localeCompare(b.ref),
	);
}
