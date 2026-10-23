import { queueInbox } from "../../steward/inbox.ts";
import type { NotifyPayload } from "../types.ts";

export type InboxChannel = (event: NotifyPayload) => Promise<void> | void;

/** Console is an inbox view; both channel names write the same durable inbox. */
export function machineInbox(event: NotifyPayload): void {
	queueInbox(event.agent, event.event);
}
