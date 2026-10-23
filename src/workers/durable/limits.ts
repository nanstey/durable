export type DurableLimitInput = {
	disabled: boolean;
	held: boolean;
	startedAt: number;
	now: number;
	itemMinutes?: number;
	maxTurns?: number;
	turns: number;
	maxToolCalls?: number;
	toolCalls: number;
	tokenBudget?: number;
	tokens: number;
};
export type DurableStop = "paused" | "held" | "limit";

/** Shared by the tool hook and WorkItemTask so background work cannot evade a stop. */
export function durableLimitStop(
	input: DurableLimitInput,
): DurableStop | undefined {
	if (input.disabled) return "paused";
	if (input.held) return "held";
	if (
		(input.itemMinutes !== undefined &&
			input.now - input.startedAt >= input.itemMinutes * 60_000) ||
		(input.maxTurns !== undefined && input.turns >= input.maxTurns) ||
		(input.maxToolCalls !== undefined &&
			input.toolCalls >= input.maxToolCalls) ||
		(input.tokenBudget !== undefined && input.tokens >= input.tokenBudget)
	)
		return "limit";
}

// fallow-ignore-next-line unused-export
export function assertDurableToolAllowed(input: DurableLimitInput): void {
	const stop = durableLimitStop(input);
	if (stop)
		throw Object.assign(Error(`durable worker ${stop}`), { code: stop });
}
