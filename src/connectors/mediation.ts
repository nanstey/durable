import { existsSync, writeFileSync } from "node:fs";
import lockfile from "proper-lockfile";
import type { AgentDef } from "../config/schema.ts";
import { audit } from "../steward/audit.ts";
import { agentDir, loadJson, saveJson } from "../steward/files.ts";
import { disabled } from "../steward/killswitch.ts";
import { connectorFor, type ConnectorProviders } from "./select.ts";
import type { ConnectorCall, ConnectorResult } from "./types.ts";

const outputCap = 100_000;
const timeoutMs = 30_000;
type Budgets = Record<string, { calls: number; cost: number }>;

/** The sole external connector invocation path. Workers only receive wrappers over this class. */
export class ConnectorMediator {
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
		const started = Date.now();
		const inputBytes = bytes(call.input);
		let provider: string | undefined;
		let connection: string | undefined;
		audit(call.agent, {
			event: "connector.invoke.started",
			profile: call.profile,
			item: call.item,
			tool: call.tool,
			access: call.access,
			inputBytes,
		});
		try {
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
			if (inputBytes > 100_000) throw Error("connector input exceeds 100 KB");
			const selected = this.providers.get(connector.provider);
			if (!selected?.available())
				throw Error("connector provider is unavailable");
			provider = selected.kind;
			const key = `${call.agent}/${connector.id}`;
			const maxCalls = minimum(tool.maxCalls, connector.maxCalls);
			const maxCost = minimum(tool.maxCost, connector.maxCost);
			await this.reserve(key, maxCalls, maxCost);
			const { input: _input, ...request } = call;
			const resolved = await selected.resolve(request);
			connection = resolved.connectionAlias;
			if (
				!resolved.tools.some(
					(candidate) =>
						candidate.name === call.tool && candidate.access === call.access,
				)
			)
				throw Error("connector provider does not expose allowlisted tool");
			const combined = AbortSignal.any([
				signal,
				AbortSignal.timeout(timeoutMs),
			]);
			const result = await selected.invoke(call, combined);
			const normalized = {
				...result,
				content: truncate(result.content),
				untrusted: true as const,
			};
			await this.settle(key, normalized.usage?.cost ?? 0, maxCost);
			audit(call.agent, {
				event: "connector.invoke.finished",
				profile: call.profile,
				item: call.item,
				provider,
				connection,
				tool: call.tool,
				access: call.access,
				inputBytes,
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
				profile: call.profile,
				item: call.item,
				provider,
				connection,
				tool: call.tool,
				access: call.access,
				inputBytes,
				outcome: "denied-or-failed",
				reason: error instanceof Error ? error.message : "connector failed",
				elapsedMs: Date.now() - started,
			});
			throw error;
		}
	}

	private budgetPath() {
		return `${agentDir(this.def.id ?? "default")}/connector-budgets.json`;
	}
	private async updateBudget<T>(update: (budgets: Budgets) => T): Promise<T> {
		const path = this.budgetPath();
		if (!existsSync(path)) writeFileSync(path, "{}\n", { mode: 0o600 });
		const release = await lockfile.lock(path, {
			retries: { retries: 20, minTimeout: 5, maxTimeout: 50 },
		});
		try {
			const budgets = loadJson<Budgets>(path, () => ({}));
			const result = update(budgets);
			saveJson(path, budgets);
			return result;
		} finally {
			await release();
		}
	}
	private async reserve(key: string, maxCalls?: number, maxCost?: number) {
		await this.updateBudget((budgets) => {
			let budget = budgets[key];
			if (!budget) {
				budget = { calls: 0, cost: 0 };
				budgets[key] = budget;
			}
			if (maxCalls !== undefined && budget.calls >= maxCalls)
				throw Error("connector call budget exhausted");
			if (maxCost !== undefined && budget.cost >= maxCost)
				throw Error("connector cost budget exhausted");
			// Reserve before the provider call. Failed writes stay counted to prevent retries.
			budget.calls++;
		});
	}
	private async settle(key: string, delta: number, maxCost?: number) {
		await this.updateBudget((budgets) => {
			let budget = budgets[key];
			if (!budget) {
				budget = { calls: 0, cost: 0 };
				budgets[key] = budget;
			}
			if (maxCost !== undefined && budget.cost + delta > maxCost)
				throw Error("connector cost budget exhausted");
			budget.cost += delta;
		});
	}
}
function minimum(first: number | undefined, second: number | undefined) {
	if (first === undefined) return second;
	if (second === undefined) return first;
	return Math.min(first, second);
}
function truncate(content: string) {
	const encoded = Buffer.from(content);
	return encoded.byteLength <= outputCap
		? content
		: encoded.subarray(0, outputCap).toString("utf8");
}
function bytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}
