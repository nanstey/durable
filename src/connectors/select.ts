import { loadOrganization } from "../config/organizations.ts";
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
	if (def.organization) {
		const organization = loadOrganization(def.organization);
		const allowed = organization.connectors?.find(
			(candidate) => candidate.id === id,
		);
		if (!allowed)
			throw Error("connector is not allowed by organization policy");
		for (const tool of connector.tools) {
			const ceiling = allowed.tools.find(
				(candidate) => candidate.id === tool.id,
			);
			if (
				!ceiling ||
				ceiling.access !== tool.access ||
				(tool.access === "write" && ceiling.write !== true)
			)
				throw Error("connector tool is not allowed by organization policy");
		}
	}
	return connector;
}
