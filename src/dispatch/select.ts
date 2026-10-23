import { execaSync } from "execa";
import type { AgentDef, MachineCfg } from "../config/schema.ts";
import { GitProcessDispatcher } from "./gitProcess.ts";
import { OrcaDispatcher, resolveOrcaCommand } from "./orca.ts";
import type { WorkerDispatcher } from "./types.ts";

export function selectDispatcher(options: {
	definition: AgentDef;
	machine: MachineCfg;
	root: string;
	orcaAvailable?: boolean;
}): WorkerDispatcher {
	const selected =
		options.machine.workers?.dispatcher ??
		options.definition.workers?.dispatcher;
	if (selected === "orca")
		return new OrcaDispatcher(
			resolveOrcaCommand(options.machine.orca?.command),
		);
	if (selected === "git-process") return new GitProcessDispatcher(options.root);
	const command = resolveOrcaCommand(options.machine.orca?.command);
	const available =
		options.orcaAvailable ??
		execaSync(command, ["--help"], { reject: false }).exitCode === 0;
	return available
		? new OrcaDispatcher(resolveOrcaCommand(options.machine.orca?.command))
		: new GitProcessDispatcher(options.root);
}
