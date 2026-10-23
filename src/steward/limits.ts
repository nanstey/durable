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
