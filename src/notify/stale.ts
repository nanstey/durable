import type { NotifyEvent } from "./types.ts";

export type StaleItem = {
	id: string;
	updatedAt: number;
	target?: string;
	title?: string;
};
export type StaleActions = {
	park(item: StaleItem): Promise<void>;
	releaseClaim(item: StaleItem): Promise<void>;
	stopWorkers(item: StaleItem): Promise<void>;
	comment(item: StaleItem): Promise<void>;
	notify(event: NotifyEvent): Promise<unknown>;
};
/** Idempotence belongs to the item store: call only for unresolved, unparked items. */
export async function parkStale(
	agent: string,
	item: StaleItem,
	staleDays: number,
	actions: StaleActions,
	now = Date.now(),
): Promise<boolean> {
	if (now - item.updatedAt < staleDays * 86400000) return false;
	await actions.stopWorkers(item);
	await actions.releaseClaim(item);
	await actions.park(item);
	await actions.comment(item);
	await actions.notify({
		agent,
		event: "escalation",
		target: item.target,
		title: item.title,
		priority: "high",
	});
	return true;
}
