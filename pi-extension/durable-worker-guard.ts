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
	const env = process.env;
	pi.on("tool_call", (event) => {
		if (workerFenced(env)) return { block: true, reason: "Durable item is fenced or its fence cannot be read" };
		if (env.DURABLE_REVIEWER === "1") {
			const resultFile = env.DURABLE_REVIEW_RESULT_FILE;
			if (event.toolName === "write" && event.input.path === resultFile)
				return undefined;
			if (!["read", "search"].includes(event.toolName))
				return { block: true, reason: "Durable reviewer is read-only" };
		}
		if (event.toolName === "bash" && typeof event.input.command === "string" && blockedWorkerCommand(event.input.command))
			return { block: true, reason: "Durable worker guard blocked a protected git or GitHub command" };
		return undefined;
	});
}
