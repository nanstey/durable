import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { validateMessage } from "../api/chat.ts";
import { agentDir, loadJson, saveJson } from "./files.ts";

export type InboxEvent = {
	id: string;
	type: string;
	agent: string;
	target: string;
	created: number;
	acked: boolean;
};
export function inboxEvent(
	agent: string,
	type: string,
	target = "",
	now = Date.now(),
): InboxEvent {
	if (!/^[a-z-]+$/.test(type) || target.length > 2048)
		throw Error("invalid inbox event");
	if (target) validateMessage({ body: target });
	return { id: randomUUID(), type, agent, target, created: now, acked: false };
}
/** Startup failures cannot open a credentialed harness; transfer these on the next healthy start. */
export function queueInbox(agent: string, type: string) {
	const path = join(agentDir(agent), "pending-inbox.json");
	const events = loadJson<InboxEvent[]>(path, () => []);
	events.push(inboxEvent(agent, type));
	saveJson(path, events);
}
export async function drainInbox(
	agent: string,
	commit: (events: InboxEvent[]) => Promise<void>,
) {
	const path = join(agentDir(agent), "pending-inbox.json");
	const events = loadJson<InboxEvent[]>(path, () => []);
	if (!events.length) return;
	await commit(events);
	saveJson(path, []);
}
export function acknowledge(events: InboxEvent[], id: string) {
	const event = events.find((item) => item.id === id);
	if (!event) return false;
	event.acked = true;
	return true;
}
