import type { Candidate } from "../sources/types.ts";

/** The judge/source size is advisory only: it can add a gate, never remove one. */
export function specEligible(
	candidate: Candidate,
	threshold: "medium" | "large" | undefined,
): boolean | undefined {
	const size = candidate.size;
	if (!threshold || typeof size !== "string") return undefined;
	return (
		(["small", "medium", "large"] as const).indexOf(size) >=
		(["small", "medium", "large"] as const).indexOf(threshold)
	);
}

export function specBranch(agent: string, item: string) {
	return `durable/${agent}/spec/${item}`;
}
