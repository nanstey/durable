import type { Budget } from "./limits.ts";
import { exhausted, rollover } from "./limits.ts";

export type LoopState = {
	heartbeat: number;
	ticks: number;
	paused: boolean;
	budget: Budget;
};
export function tick(
	state: LoopState,
	opts: {
		now: number;
		disabled: boolean;
		pollSeconds: number;
		limits?: Record<string, number>;
	},
) {
	state.budget = rollover(state.budget, opts.now);
	state.budget.stopped = exhausted(state.budget, opts.limits);
	state.paused = opts.disabled || state.budget.stopped;
	if (!state.paused) {
		state.heartbeat = opts.now;
		state.ticks++;
	}
	return {
		again: { nextAt: opts.now + opts.pollSeconds * 1000 },
		event: state.paused
			? state.budget.stopped
				? "budget-stop"
				: "paused"
			: "tick",
	};
}
