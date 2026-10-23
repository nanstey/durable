import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { treeDelta } from "../tree/frames.ts";
import type { TreeNode } from "../tree/nodes.ts";
import type { StreamFrame } from "./types.ts";

/** Counts in-flight writes too: a blocked transport must not retain unbounded frames. */
export class ViewerQueue {
	private bytes = 0;
	private chain = Promise.resolve();
	closed = false;
	private write: (frame: string) => Promise<unknown>;
	private disconnect: () => void;
	readonly maxBytes: number;
	constructor(
		write: (frame: string) => Promise<unknown>,
		disconnect: () => void,
		maxBytes = 2 * 1024 * 1024,
	) {
		this.write = write;
		this.disconnect = disconnect;
		this.maxBytes = maxBytes;
	}
	send(frame: string) {
		if (this.closed) return;
		const bytes = Buffer.byteLength(frame);
		if (this.bytes + bytes > this.maxBytes) {
			this.close();
			return;
		}
		this.bytes += bytes;
		this.chain = this.chain
			.then(async () => {
				if (!this.closed) await this.write(frame);
			})
			.catch(() => this.close())
			.finally(() => {
				this.bytes -= bytes;
			});
	}
	close() {
		if (!this.closed) {
			this.closed = true;
			this.disconnect();
		}
	}
}
export type StreamSnapshot = { nodes: TreeNode[]; [key: string]: unknown };
export function events(
	c: Context,
	scope: string,
	snapshot: () => Promise<StreamSnapshot>,
	options: { pingMs?: number; pollMs?: number; now?: () => number } = {},
) {
	return streamSSE(c, async (stream) => {
		let finish: () => void = () => {};
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const queue = new ViewerQueue(
			(frame) => stream.write(frame),
			() => {
				stream.abort();
				void stream.close();
				finish();
			},
		);
		const send = (frame: StreamFrame) =>
			queue.send(`data: ${JSON.stringify(frame)}\n\n`);
		stream.onAbort(() => queue.close());
		send({
			type: "hello",
			apiVersion: "v1",
			scope,
			serverTime: (options.now ?? Date.now)(),
		});
		let previous = await snapshot();
		send({ type: "snapshot", state: previous });
		let reading = false;
		const poll = setInterval(async () => {
			if (reading || queue.closed) return;
			reading = true;
			try {
				const current = await snapshot();
				const delta = treeDelta(previous.nodes, current.nodes);
				if (delta.upsert.length || delta.remove.length)
					send({ type: "tree", ...delta });
				if (JSON.stringify(current) !== JSON.stringify(previous))
					send({ type: "delta", state: current });
				previous = current;
			} catch {
				queue.close();
			} finally {
				reading = false;
			}
		}, options.pollMs ?? 250);
		const ping = setInterval(
			() => queue.send(": ping\n\n"),
			options.pingMs ?? 15000,
		);
		try {
			await done;
		} finally {
			clearInterval(ping);
			clearInterval(poll);
		}
	});
}
