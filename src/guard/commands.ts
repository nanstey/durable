/** Shared command policy for durable workers. This is a guardrail, not a sandbox. */
export const blockedWorkerCommandPatterns: ReadonlyArray<RegExp> = [
	/\bgh\s+pr\s+merge\b/i,
	/\bgh\s+api\b.*\bmerge\b/i,
	/\bgh\b.*\s--admin\b/i,
	/\b(?:gh|git)\b.*\s--force(?:-with-lease)?\b/i,
	/\bgit\s+push\b/i,
	/\bgit\s+(?:merge|rebase|worktree)\b/i,
	/\bgit\s+reset\s+--hard\b/i,
	/\bgit\s+(?:switch|checkout)\b/i,
	/(?:^|[;&|]\s*)cd\s+(?:--\s+)?(?:['"]?(?:\/|~|\.\.(?:\/|\s|$)))/i,
];
export function blockedWorkerCommand(command: string): boolean {
	return blockedWorkerCommandPatterns.some((pattern) => pattern.test(command));
}
