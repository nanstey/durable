import { randomUUID } from "node:crypto";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { ConsoleDevice } from "./registry.ts";

export type MuxFrame = {
	type:
		| "hello"
		| "snapshot"
		| "delta"
		| "tree"
		| "fault"
		| "disconnected"
		| "event";
	[key: string]: unknown;
};
type Tab = {
	id: string;
	subs: Set<string>;
	controllers: AbortController[];
	write: (frame: MuxFrame) => Promise<void>;
};

/** Fans daemon event streams into the single SSE connection owned by a browser tab. */
export class StreamMux {
	private readonly tabs = new Map<string, Tab>();
	private readonly devices: Map<string, ConsoleDevice>;
	private readonly fetcher: typeof fetch;
	constructor(
		devices = new Map<string, ConsoleDevice>(),
		fetcher: typeof fetch = fetch,
	) {
		this.devices = devices;
		this.fetcher = fetcher;
	}
	open(context: Context) {
		const id = randomUUID();
		return streamSSE(context, async (stream) => {
			const tab: Tab = {
				id,
				subs: new Set(),
				controllers: [],
				write: async (frame) =>
					stream.writeSSE({ event: frame.type, data: JSON.stringify(frame) }),
			};
			this.tabs.set(id, tab);
			await tab.write({ type: "hello", id });
			await new Promise<void>((resolve) => stream.onAbort(resolve));
			this.close(tab);
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
		this.closeSources(tab);
		tab.subs = new Set(keys);
		for (const key of tab.subs) void this.fanIn(tab, key);
		return true;
	}
	private closeSources(tab: Tab) {
		for (const controller of tab.controllers) controller.abort();
		tab.controllers = [];
	}
	private close(tab: Tab) {
		this.closeSources(tab);
		this.tabs.delete(tab.id);
	}
	private async fanIn(tab: Tab, key: string) {
		const [deviceId, scope, id] = key.split("/");
		const device = this.devices.get(deviceId);
		if (!device || !deviceId || !scope) {
			await tab.write({ type: "fault", key, detail: "unknown device" });
			return;
		}
		const path =
			scope === "worker"
				? `/v1/conversations/${encodeURIComponent(id ?? "")}/events`
				: "/v1/events";
		let delay = 1000;
		while (this.tabs.get(tab.id) === tab && tab.subs.has(key)) {
			const controller = new AbortController();
			tab.controllers.push(controller);
			try {
				const response = await this.fetcher(new URL(path, device.url), {
					headers: { authorization: `Bearer ${device.token}` },
					signal: controller.signal,
				});
				if (!response.ok || !response.body)
					throw Error(`daemon stream returned ${response.status}`);
				for await (const frame of sseFrames(response.body)) {
					if (this.tabs.get(tab.id) !== tab || !tab.subs.has(key)) return;
					await tab.write({
						...frame,
						type: String(frame.type ?? "delta") as MuxFrame["type"],
						key,
					});
				}
				delay = 1000;
			} catch (error) {
				if (controller.signal.aborted) return;
				await tab.write({ type: "disconnected", key, detail: String(error) });
			}
			tab.controllers = tab.controllers.filter((entry) => entry !== controller);
			await new Promise((resolve) => setTimeout(resolve, delay));
			delay = Math.min(delay * 2, 30_000);
		}
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
						this.close(tab);
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

async function* sseFrames(body: ReadableStream<Uint8Array>) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			buffered += decoder.decode(value, { stream: true });
			const parts = buffered.split("\n\n");
			buffered = parts.pop() ?? "";
			for (const part of parts) {
				const data = part
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trimStart())
					.join("\n");
				if (data) yield JSON.parse(data) as Record<string, unknown>;
			}
		}
	} finally {
		reader.releaseLock();
	}
}
