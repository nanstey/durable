import type { AgentDef } from "../config/schema.ts";
import { audit } from "../steward/audit.ts";
import { disabled } from "../steward/killswitch.ts";
import { connectorFor, type ConnectorProviders } from "./select.ts";
import type { ConnectorCall, ConnectorResult } from "./types.ts";

const outputCap = 100_000;

/** The sole external connector invocation path. Workers only receive wrappers over this class. */
export class ConnectorMediator {
	private readonly calls = new Map<string, number>();
	private readonly cost = new Map<string, number>();
	private readonly def: AgentDef;
	private readonly providers: ConnectorProviders;
	private readonly options: { quietHours?: string };
	constructor(
		def: AgentDef,
		providers: ConnectorProviders,
		options: { quietHours?: string } = {},
	) {
		this.def = def;
		this.providers = providers;
		this.options = options;
	}

	async invoke(
		call: ConnectorCall,
		signal: AbortSignal,
	): Promise<ConnectorResult> {
		if (this.def.id && call.agent !== this.def.id)
			throw Error("connector agent mismatch");
		if (call.profile !== this.def.profile)
			throw Error("connector profile mismatch");
		if (disabled(call.agent, this.options.quietHours))
			throw Error("connector invocation stopped by kill switch");
		const connector = connectorFor(this.def, call.connector);
		const tool = connector.tools.find(
			(candidate) => candidate.id === call.tool,
		);
		if (!tool || tool.access !== call.access)
			throw Error("connector tool is not allowlisted");
		if (call.access === "write" && tool.write !== true)
			throw Error("connector write requires explicit allowlisting");
		if (bytes(call.input) > 100_000)
			throw Error("connector input exceeds 100 KB");
		const provider = this.providers.get(connector.provider);
		if (!provider?.available())
			throw Error("connector provider is unavailable");
		const key = `${call.agent}/${call.item}/${connector.id}`;
		const maxCalls = tool.maxCalls ?? connector.maxCalls;
		if (maxCalls !== undefined && (this.calls.get(key) ?? 0) >= maxCalls)
			throw Error("connector call budget exhausted");
		const maxCost = tool.maxCost ?? connector.maxCost;
		if (maxCost !== undefined && (this.cost.get(key) ?? 0) >= maxCost)
			throw Error("connector cost budget exhausted");
		const { input: _input, ...request } = call;
		const resolved = await provider.resolve(request);
		if (
			!resolved.tools.some(
				(candidate) =>
					candidate.name === call.tool && candidate.access === call.access,
			)
		)
			throw Error("connector provider does not expose allowlisted tool");
		audit(call.agent, {
			event: "connector.invoke.started",
			profile: call.profile,
			item: call.item,
			provider: provider.kind,
			connection: resolved.connectionAlias,
			tool: call.tool,
			access: call.access,
			inputBytes: bytes(call.input),
		});
		const started = Date.now();
		try {
			const result = await provider.invoke(call, signal);
			const normalized = {
				...result,
				content: result.content.slice(0, outputCap),
				untrusted: true as const,
			};
			const delta = normalized.usage?.cost ?? 0;
			if (maxCost !== undefined && (this.cost.get(key) ?? 0) + delta > maxCost)
				throw Error("connector cost budget exhausted");
			this.calls.set(key, (this.calls.get(key) ?? 0) + 1);
			this.cost.set(key, (this.cost.get(key) ?? 0) + delta);
			audit(call.agent, {
				event: "connector.invoke.finished",
				profile: call.profile,
				item: call.item,
				provider: provider.kind,
				connection: resolved.connectionAlias,
				tool: call.tool,
				access: call.access,
				outputBytes: Buffer.byteLength(normalized.content),
				outcome: "success",
				elapsedMs: Date.now() - started,
				budgetDelta: normalized.usage,
				providerRequestId: normalized.providerRequestId,
			});
			return normalized;
		} catch (error) {
			audit(call.agent, {
				event: "connector.invoke.finished",
				item: call.item,
				provider: provider.kind,
				tool: call.tool,
				access: call.access,
				outcome: "failed",
				elapsedMs: Date.now() - started,
			});
			throw error;
		}
	}
}
function bytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}
