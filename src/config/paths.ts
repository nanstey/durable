import { homedir } from "node:os";
import { join } from "node:path";
export const durableHome = () =>
	process.env.DURABLE_HOME || join(homedir(), ".pi", "durable");
export const agentsDir = () =>
	process.env.DURABLE_AGENTS_DIR ||
	join(homedir(), ".config", "durable", "agents");
export const machinePath = () =>
	process.env.DURABLE_MACHINE_FILE ||
	join(homedir(), ".config", "durable", "machine.yaml");
export const piAgentDir = () =>
	process.env.PI_CODING_AGENT_DIR ||
	process.env.PI_AGENT_DIR ||
	join(homedir(), ".pi", "agent");
