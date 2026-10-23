import type { AgentDef, MachineCfg, WorkerKindName } from "../config/schema.ts";
import { assertRoleDispatchReady, effectiveKind } from "../identity/skills.ts";
import type { WorkerKind, WorkerKindRegistry } from "./kind.ts";

/** Selects the configured kind after enforcing the no-silent-fallback rule. */
export function selectWorkerKind(
	registry: WorkerKindRegistry,
	definition: AgentDef,
	machine: MachineCfg,
	role: "worker" | "reviewer",
): WorkerKind {
	assertRoleDispatchReady(definition, machine, role);
	return registry.get(effectiveKind(definition, machine, role));
}

// fallow-ignore-next-line unused-export
export function selectedWorkerKind(
	definition: AgentDef,
	machine: MachineCfg,
	role: "worker" | "reviewer",
): WorkerKindName {
	return effectiveKind(definition, machine, role);
}
