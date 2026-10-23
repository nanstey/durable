import type { AgentDef } from "../config/schema.ts";

export type ConnectorAccess = "read" | "write";
export type ConnectorTool = {
	name: string;
	access: ConnectorAccess;
};
export type ConnectorCall = {
	agent: string;
	profile: string;
	item: string;
	connector: string;
	tool: string;
	access: ConnectorAccess;
	input: unknown;
};
export type ConnectorResult = {
	content: string;
	untrusted: true;
	providerRequestId?: string;
	usage?: { calls: number; cost?: number };
};
export type ResolvedConnection = {
	connectionAlias: string;
	tools: ConnectorTool[];
};

/** A provider receives a profile-bound call, never worker credentials or a raw client. */
export interface ConnectorProvider {
	readonly kind: string;
	available(): boolean;
	resolve(call: Omit<ConnectorCall, "input">): Promise<ResolvedConnection>;
	invoke(call: ConnectorCall, signal: AbortSignal): Promise<ConnectorResult>;
}

export type ConnectorDefinition = NonNullable<AgentDef["connectors"]>[number];
export type ConnectorToolDefinition = ConnectorDefinition["tools"][number];
