import type {
	ConnectorCall,
	ConnectorProvider,
	ConnectorResult,
	ResolvedConnection,
} from "./types.ts";

export type FakeConnector = {
	connection: string;
	tools: Array<{ name: string; access: "read" | "write" }>;
	result?: string;
	delayMs?: number;
};

/** Deterministic provider used only by contract tests and local operator checks. */
export class FakeConnectorProvider implements ConnectorProvider {
	readonly kind = "fake";
	readonly calls: ConnectorCall[] = [];
	private readonly connectors: Map<string, FakeConnector>;

	constructor(connectors: Record<string, FakeConnector> = {}) {
		this.connectors = new Map(Object.entries(connectors));
	}
	available(): boolean {
		return true;
	}
	async resolve(
		call: Omit<ConnectorCall, "input">,
	): Promise<ResolvedConnection> {
		const connector = this.connectors.get(call.connector);
		if (!connector) throw Error("connector connection is unavailable");
		return { connectionAlias: connector.connection, tools: connector.tools };
	}
	async invoke(
		call: ConnectorCall,
		signal: AbortSignal,
	): Promise<ConnectorResult> {
		const connector = this.connectors.get(call.connector);
		if (!connector) throw Error("connector connection is unavailable");
		if (connector.delayMs) await delay(connector.delayMs, signal);
		signal.throwIfAborted();
		this.calls.push(call);
		return {
			content: connector.result ?? `fake:${call.connector}:${call.tool}`,
			untrusted: true,
			providerRequestId: `fake-${this.calls.length}`,
			usage: { calls: 1, cost: 0 },
		};
	}
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}
