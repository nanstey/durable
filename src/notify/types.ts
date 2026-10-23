export const eventNames = [
	"approval-needed",
	"escalation",
	"budget-stop",
	"identity-failure",
	"agent-down",
	"merged",
	"digest",
] as const;
export type NotifyEventName = (typeof eventNames)[number];
export type NotifyPriority = "low" | "normal" | "high";

/** Input can carry the approval nonce, but it is never persisted or sent to unsafe channels. */
export type NotifyEvent = {
	agent: string;
	event: NotifyEventName;
	target?: string;
	sha?: string;
	priority?: NotifyPriority;
	title?: string;
	nonce?: string;
};
export type NotifyPayload = Omit<NotifyEvent, "nonce">;
export type ReminderPolicy = {
	afterMinutes: number;
	everyMinutes: number;
	max: number;
};
export type NotifyRule = {
	channels: string[];
	priority: NotifyPriority;
	reminders?: ReminderPolicy;
};

export function redactedPayload(event: NotifyEvent): NotifyPayload {
	return {
		agent: event.agent,
		event: event.event,
		...(event.target ? { target: event.target } : {}),
		...(event.sha ? { sha: event.sha } : {}),
		priority: event.priority ?? "normal",
		...(event.title ? { title: event.title } : {}),
	};
}
export function dedupKey(event: NotifyPayload): string {
	return [event.agent, event.event, event.target ?? "", event.sha ?? ""].join(
		"+",
	);
}
