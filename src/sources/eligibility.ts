import type { Candidate } from "./types.ts";

export type EligibilityOptions = {
	trustedAuthors?: string[];
	requiredLabels?: string[];
	excludedLabels?: string[];
	blockedAuthors?: string[];
	claimed?: boolean;
	attempts?: number;
	maxAttempts?: number;
	size?: number;
	maxSize?: number;
	updatedBefore?: number;
	maxAgeMs?: number;
};
export type Eligibility = { eligible: boolean; reasons: string[] };

export function eligibility(
	candidate: Candidate,
	options: EligibilityOptions = {},
	now = Date.now(),
): Eligibility {
	const reasons: string[] = [];
	const association = candidate.authorAssociation?.toUpperCase();
	const trusted =
		["OWNER", "MEMBER", "COLLABORATOR"].includes(association ?? "") ||
		(options.trustedAuthors ?? []).some(
			(author) => author.toLowerCase() === candidate.author.toLowerCase(),
		);
	if (!trusted) reasons.push("untrusted-author");
	const labels = new Set(candidate.labels.map((label) => label.toLowerCase()));
	for (const label of options.requiredLabels ?? [])
		if (!labels.has(label.toLowerCase()))
			reasons.push(`missing-label:${label}`);
	for (const label of options.excludedLabels ?? [])
		if (labels.has(label.toLowerCase()))
			reasons.push(`excluded-label:${label}`);
	if (
		options.blockedAuthors?.some(
			(author) => author.toLowerCase() === candidate.author.toLowerCase(),
		)
	)
		reasons.push("blocked-author");
	if (options.claimed) reasons.push("claimed");
	if (
		(options.attempts ?? candidate.attempts ?? 0) >=
		(options.maxAttempts ?? Number.POSITIVE_INFINITY)
	)
		reasons.push("attempts-exhausted");
	if (
		(options.size ?? candidate.size ?? 0) >
		(options.maxSize ?? Number.POSITIVE_INFINITY)
	)
		reasons.push("too-big");
	const updatedAt = Date.parse(candidate.updatedAt);
	if (!Number.isFinite(updatedAt)) reasons.push("invalid-updated-at");
	const age = now - updatedAt;
	if (options.maxAgeMs !== undefined && age > options.maxAgeMs)
		reasons.push("too-old");
	if (options.updatedBefore !== undefined && updatedAt > options.updatedBefore)
		reasons.push("not-yet-old-enough");
	return { eligible: reasons.length === 0, reasons };
}
