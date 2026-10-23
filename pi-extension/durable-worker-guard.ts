import { readFileSync } from "node:fs";
import { blockedWorkerCommand } from "../src/guard/commands.ts";

/** Pi guardrail, not a sandbox. Shared command policy is exercised by the drift test. */
export function shouldBlockDurableWorkerCommand(command: string, env = process.env): boolean {
	return env.DURABLE_WORKER === "1" && blockedWorkerCommand(command);
}
export function workerFenced(env = process.env): boolean {
	if (env.DURABLE_WORKER !== "1") return false;
	if (!env.DURABLE_FENCE_FILE || !env.DURABLE_ITEM) return true;
	try {
		const journal = JSON.parse(readFileSync(env.DURABLE_FENCE_FILE, "utf8")) as { holds: Record<string, unknown> };
		return Boolean(journal.holds[env.DURABLE_ITEM]);
	} catch { return true; }
}
export default function durableWorkerGuard(pi: {
	on: (event: "tool_call", handler: (event: { toolName: string; input: Record<string, unknown> }) => { block: true; reason: string } | undefined) => unknown;
}) {
	if (process.env.DURABLE_WORKER !== "1") return;
	pi.on("tool_call", (event) => {
		if (workerFenced()) return { block: true, reason: "Durable item is fenced or its fence cannot be read" };
		if (event.toolName === "bash" && typeof event.input.command === "string" && blockedWorkerCommand(event.input.command))
			return { block: true, reason: "Durable worker guard blocked a protected git or GitHub command" };
		return undefined;
	});
}
