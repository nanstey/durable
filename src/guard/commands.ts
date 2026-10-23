/** Shared command policy for durable workers. This is a guardrail, not a sandbox. */
// fallow-ignore-next-line unused-export
export const blockedWorkerCommandPatterns: ReadonlyArray<RegExp> = [
	/\bgh\s+pr\s+merge\b/i,
	/\bgh\s+api\b.*\bmerge\b/i,
	/\bgh\b.*\s--admin\b/i,
	/\bgit\s+push\b.*(?:\s--force(?:-with-lease)?\b|\s-f\b)/i,
	/\bgit\s+push\b.*\b(?:main|master)\b/i,
];
export function blockedWorkerCommand(command: string): boolean {
	return blockedWorkerCommandPatterns.some((pattern) => pattern.test(command));
}
