import { Type } from "typebox";

export const ReviewResultSchema = Type.Object({
	verdict: Type.Union([
		Type.Literal("approve"),
		Type.Literal("changes"),
		Type.Literal("blocked"),
	]),
	risk: Type.Union([
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high"),
	]),
	summary: Type.String({ minLength: 1, maxLength: 20_000 }),
	headSha: Type.String({ minLength: 1, maxLength: 200 }),
});

export type ReviewResult = {
	verdict: "approve" | "changes" | "blocked";
	risk: "low" | "medium" | "high";
	summary: string;
	headSha: string;
};

export type ModelProvenance = {
	provider: string;
	model: string;
	family: string;
	entries: number;
	source: "durable-entries";
};

export function parseReviewResult(value: unknown): ReviewResult {
	if (
		!value ||
		typeof value !== "object" ||
		!["approve", "changes", "blocked"].includes(
			(value as ReviewResult).verdict,
		) ||
		!["low", "medium", "high"].includes((value as ReviewResult).risk) ||
		typeof (value as ReviewResult).summary !== "string" ||
		!(value as ReviewResult).summary.trim() ||
		(value as ReviewResult).summary.length > 20_000 ||
		typeof (value as ReviewResult).headSha !== "string" ||
		!(value as ReviewResult).headSha
	)
		throw Error("invalid reviewer verdict");
	return value as ReviewResult;
}
