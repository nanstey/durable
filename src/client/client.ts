import type { Device, MessageResponse, StreamFrame } from "../api/types.ts";
import type { TreeNode } from "../tree/nodes.ts";
import { readEventStream } from "./stream.ts";

type ConversationList = { nodes: TreeNode[] };
export type ClientOptions = {
	fetcher?: typeof fetch;
	deadSocketMs?: number;
};

export class DurableClient {
	private readonly fetcher: typeof fetch;
	readonly deadSocketMs: number;
	readonly baseUrl: string;
	readonly token: string;

	constructor(baseUrl: string, token: string, options: ClientOptions = {}) {
		this.baseUrl = baseUrl;
		this.token = token;
		this.fetcher = options.fetcher ?? fetch;
		this.deadSocketMs = options.deadSocketMs ?? 45_000;
	}

	async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const response = await this.fetcher(new URL(path, this.baseUrl), {
			...init,
			headers: {
				authorization: `Bearer ${this.token}`,
				...(init.body ? { "content-type": "application/json" } : {}),
				...init.headers,
			},
			signal: init.signal ?? AbortSignal.timeout(this.deadSocketMs),
		});
		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as {
				error?: { code?: string; message?: string };
			} | null;
			throw new Error(
				body?.error?.message ?? `daemon returned ${response.status}`,
			);
		}
		return (await response.json()) as T;
	}

	device() {
		return this.request<Device>("/v1/device");
	}

	conversations(query = "") {
		return this.request<ConversationList>(`/v1/conversations${query}`);
	}

	createConversation(
		kind: "chat" | "scout",
		options: { item?: string; name?: string } = {},
	) {
		return this.request<{ id: string; kind: "chat" | "scout" }>(
			"/v1/conversations",
			{
				method: "POST",
				headers: { "idempotency-key": crypto.randomUUID() },
				body: JSON.stringify({ kind, ...options }),
			},
		);
	}

	transcript(id: string) {
		return this.request<unknown[]>(
			`/v1/conversations/${encodeURIComponent(id)}/transcript`,
		);
	}

	message(
		id: string,
		body: string,
		whenBusy: "steer" | "followUp" = "followUp",
	) {
		return this.request<MessageResponse>(
			`/v1/conversations/${encodeURIComponent(id)}/messages`,
			{
				method: "POST",
				body: JSON.stringify({
					body,
					whenBusy,
					requestId: crypto.randomUUID(),
				}),
			},
		);
	}

	abort(id: string) {
		return this.request<{ aborted: true }>(
			`/v1/conversations/${encodeURIComponent(id)}/abort`,
			{
				method: "POST",
				body: "{}",
			},
		);
	}

	events(signal?: AbortSignal): AsyncGenerator<StreamFrame> {
		return readEventStream<StreamFrame>(
			new URL("/v1/events", this.baseUrl).toString(),
			this.token,
			{
				fetcher: this.fetcher,
				signal,
				deadSocketMs: this.deadSocketMs,
			},
		);
	}
}
