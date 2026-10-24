import { accessSync, constants, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { durableHome } from "../config/paths.ts";
import { agentDir } from "../steward/files.ts";

/** Worker CLI shims enforce attribution and audit writes made through the supported tools. */
export function workerToolEnv(
	agent: string,
	profile: string,
	login: string,
	env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const directory = join(agentDir(agent), "worker-tools");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const entry = fileURLToPath(
		new URL("../../bin/durable-worker-tool.ts", import.meta.url),
	);
	let realGh: string | undefined;
	for (const tool of ["gh", "git"]) {
		const executable = (env.PATH ?? "")
			.split(":")
			.map((path) => join(path, tool))
			.find((path) => {
				if (path === join(directory, tool)) return false;
				try {
					accessSync(path, constants.X_OK);
					return true;
				} catch {
					return false;
				}
			});
		if (!executable) throw Error(`worker tool missing: ${tool}`);
		if (tool === "gh") realGh = executable;
		const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
		writeFileSync(
			join(directory, tool),
			`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} ${quote(tool)} ${quote(executable)} "$@"\n`,
			{ mode: 0o700 },
		);
	}
	return {
		...env,
		PATH: `${directory}:${env.PATH ?? ""}`,
		DURABLE_AGENT: agent,
		DURABLE_PROFILE: profile,
		DURABLE_LOGIN: login,
		DURABLE_REAL_GH: realGh,
		DURABLE_HOME: durableHome(),
		DURABLE_FENCE_FILE: join(agentDir(agent), "procs.json"),
	};
}
