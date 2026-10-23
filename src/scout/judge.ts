import type { Candidate } from "../sources/types.ts";
import type { QueueState } from "../steward/queue.ts";

export type Judgment = {
	actionable: "yes" | "no" | "unclear";
	risk: "low" | "medium" | "high";
	size: "small" | "medium" | "large";
};
export type Judge = (
	candidate: Pick<Candidate, "ref" | "title" | "labels" | "updatedAt">,
) => Promise<Judgment>;

/** A judge only tightens code-owned eligibility; it never sees an untrusted body. */
export async function applyJudgment(
	candidate: Candidate,
	state: QueueState,
	reasons: string[],
	judge?: Judge,
): Promise<{ state: QueueState; reasons: string[] }> {
	if (!judge || state !== "eligible") return { state, reasons };
	try {
		const result = await judge({
			ref: candidate.ref,
			title: candidate.title,
			labels: candidate.labels,
			updatedAt: candidate.updatedAt,
		});
		if (result.actionable !== "yes")
			return {
				state: "needs-human",
				reasons: [...reasons, "judge:not-actionable"],
			};
		candidate.size = result.size;

		if (result.risk === "high")
			return { state: "needs-human", reasons: [...reasons, "judge:high-risk"] };
	} catch {
		// Model failures leave code-owned decisions unchanged.
	}
	return { state, reasons };
}
