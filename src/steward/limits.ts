export type Budget = {
	day: string;
	spent: number;
	tokens: number;
	stopped: boolean;
};
export function rollover(budget: Budget, now: number): Budget {
	const day = new Date(now).toISOString().slice(0, 10);
	return budget.day === day
		? budget
		: { day, spent: 0, tokens: 0, stopped: false };
}
export function exhausted(budget: Budget, limits: Record<string, number> = {}) {
	return (
		(limits.dailyDollars !== undefined &&
			budget.spent >= limits.dailyDollars) ||
		(limits.dailyTokens !== undefined && budget.tokens >= limits.dailyTokens)
	);
}

export function canDispatch(options: {
	running: number;
	startedToday: number;
	limits?: Record<string, number>;
	quiet: boolean;
	paused: boolean;
}): boolean {
	const limits = options.limits ?? {};
	return (
		!options.quiet &&
		!options.paused &&
		(limits.maxConcurrentWorkers === undefined ||
			options.running < limits.maxConcurrentWorkers) &&
		(limits.maxWorkersPerDay === undefined ||
			options.startedToday < limits.maxWorkersPerDay)
	);
}

export function itemTimedOut(
	startedAt: number,
	itemMinutes: number | undefined,
	now = Date.now(),
): boolean {
	return itemMinutes !== undefined && now - startedAt >= itemMinutes * 60_000;
}
