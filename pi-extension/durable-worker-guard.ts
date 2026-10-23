// fallow-ignore-file unused-file
import { blockedWorkerCommand } from "../src/guard/commands.ts";

/** Pi extension entrypoint; registration is intentionally inert outside durable workers. */
export function shouldBlockDurableWorkerCommand(command: string, env = process.env): boolean {
	return env.DURABLE_WORKER === "1" && blockedWorkerCommand(command);
}

export default function durableWorkerGuard(pi: {
	on?: (event: string, handler: (event: { command?: string }) => unknown) => void;
}) {
	if (process.env.DURABLE_WORKER !== "1") return;
	pi.on?.("beforeTool", (event) => {
		if (event.command && blockedWorkerCommand(event.command))
			throw Error("durable worker guard blocked a protected git or GitHub command");
	});
}
