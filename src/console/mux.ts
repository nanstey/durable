import { randomUUID } from "node:crypto";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";

export type MuxFrame = {
	type: "hello" | "fault" | "disconnected" | "event";
	[key: string]: unknown;
};
type Tab = {
	id: string;
	subs: Set<string>;
	write: (frame: MuxFrame) => Promise<void>;
};

export class StreamMux {
	private readonly tabs = new Map<string, Tab>();
	open(context: Context) {
		const id = randomUUID();
		return streamSSE(context, async (stream) => {
			const tab: Tab = {
				id,
				subs: new Set(),
				write: async (frame) =>
					stream.writeSSE({ event: frame.type, data: JSON.stringify(frame) }),
			};
			this.tabs.set(id, tab);
			await tab.write({ type: "hello", id });
			await new Promise<void>((resolve) => {
				stream.onAbort(() => resolve());
			});
			this.tabs.delete(id);
		});
	}
	subscribe(id: string, keys: unknown) {
		if (
			!Array.isArray(keys) ||
			keys.length > 20 ||
			keys.some(
				(key) =>
					typeof key !== "string" ||
					!/^[A-Za-z0-9._-]+\/(?:agent\/[A-Za-z0-9._-]+|steward|worker\/[A-Za-z0-9._-]+)$/.test(
						key,
					),
			)
		)
			throw Error("subscriptions must be at most 20 valid stream keys");
		const tab = this.tabs.get(id);
		if (!tab) return false;
		tab.subs = new Set(keys);
		return true;
	}
	// fallow-ignore-next-line unused-class-member
	async publish(key: string, frame: MuxFrame) {
		await Promise.all(
			[...this.tabs.values()]
				.filter((tab) => tab.subs.has(key))
				.map(async (tab) => {
					try {
						await tab.write({ ...frame, type: "event", key });
					} catch {
						this.tabs.delete(tab.id);
					}
				}),
		);
	}
	// fallow-ignore-next-line unused-class-member
	fault(id: string, detail: string) {
		return this.tabs.get(id)?.write({ type: "fault", detail });
	}
	// fallow-ignore-next-line unused-class-member
	disconnected(id: string, detail: string) {
		return this.tabs.get(id)?.write({ type: "disconnected", detail });
	}
}
