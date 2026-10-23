import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { agentsDir, machinePath } from "./paths.ts";
import {
	type AgentDef,
	type MachineCfg,
	validateAgent,
	validateMachine,
} from "./schema.ts";
export function loadYaml(path: string): unknown {
	return parse(readFileSync(path, "utf8"), { uniqueKeys: true });
}
export function loadAgent(id: string): AgentDef {
	return validateAgent(loadYaml(join(agentsDir(), `${id}.yaml`)));
}
export function loadMachine(): MachineCfg {
	return validateMachine(loadYaml(machinePath()));
}
