import type { AgentDef } from "../config/schema.ts";
import type { ConnectorProvider } from "./types.ts";

export class ConnectorProviders {
	private readonly providers: Map<string, ConnectorProvider>;
	constructor(providers: ConnectorProvider[]) {
		this.providers = new Map(
			providers.map((provider) => [provider.kind, provider]),
		);
	}
	get(kind: string): ConnectorProvider | undefined {
		return this.providers.get(kind);
	}
}

export function connectorFor(def: AgentDef, id: string) {
	const connector = def.connectors?.find((candidate) => candidate.id === id);
	if (!connector) throw Error("connector is not allowlisted");
	return connector;
}
