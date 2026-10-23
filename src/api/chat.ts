import { createHash } from "node:crypto";

export class ApiError extends Error {
	code: string;
	status: number;
	constructor(code: string, message: string, status = 400) {
		super(message);
		this.code = code;
		this.status = status;
	}
}
const credentialPatterns = [
	/(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-(?:ant-)?[A-Za-z0-9_-]{16,})/,
	/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
	/\bAIza[0-9A-Za-z_-]{35}\b/,
	/AccountKey=[A-Za-z0-9+/=]{32,}/,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/,
	/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
	/\b(?:api[_-]?key|secret|token|passw(?:or)?d|bearer)\b["']?\s*[:=]\s*["']?(?=[^\s"']{12,})(?=[^\s"']*\d)(?=[^\s"']*[A-Za-z])[^\s"']+/i,
];
const benignShapes = [
	/^[0-9a-f]{32,128}$/i,
	/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/,
	/^[0-9a-f]{8}-[0-9a-f]{4}-/i,
	/^[A-Za-z]+(?:[-_/][A-Za-z]+){3,}$/,
];
function entropy(word: string) {
	const counts = new Map<string, number>();
	for (const char of word) counts.set(char, (counts.get(char) ?? 0) + 1);
	return [...counts.values()].reduce(
		(sum, n) => sum - (n / word.length) * Math.log2(n / word.length),
		0,
	);
}
export function credentialLike(body: string) {
	if (credentialPatterns.some((pattern) => pattern.test(body))) return true;
	return (body.match(/[A-Za-z0-9_+/=-]{32,}/g) ?? []).some(
		(word) =>
			/[A-Z]/.test(word) &&
			/[a-z]/.test(word) &&
			/\d/.test(word) &&
			!benignShapes.some((pattern) => pattern.test(word)) &&
			!word.includes("/") &&
			entropy(word) >= 4,
	);
}
export function validateMessage(value: unknown, max = 1048576): string {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		typeof (value as { body?: unknown }).body !== "string" ||
		Object.keys(value).some(
			(k) => !["body", "requestId", "whenBusy"].includes(k),
		)
	)
		throw new ApiError(
			"invalid",
			"plain-text body required; role, attachment, HTML and tool-call fields are not accepted",
		);
	const body = (value as { body: string }).body;
	if (!body.trim() || Buffer.byteLength(body) > max)
		throw new ApiError(
			"invalid",
			"empty message or message exceeds byte ceiling",
		);
	if (credentialLike(body))
		throw new ApiError("invalid", "credential-like-content");
	return body;
}
export const bodyHash = (body: string) =>
	createHash("sha256").update(body).digest("hex");
