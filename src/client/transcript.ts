export type TranscriptEntry = {
	kind: string;
	model?: unknown;
	data?: unknown;
};

export function transcriptLines(entries: readonly TranscriptEntry[]): string[] {
	return entries.map((entry) => {
		const value = entry.model ?? entry.data;
		return `${entry.kind}${value === undefined ? "" : `: ${JSON.stringify(value)}`}`;
	});
}
