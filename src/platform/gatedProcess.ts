import type { Readable, Writable } from "node:stream";
import { execa } from "execa";
import type { Identity, Launch } from "./containment.ts";

export function gatedProcess(
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	enrich: (identity: Identity) => Promise<Identity>,
	detached = false,
): Launch {
	const child = execa(command, args, {
		env,
		extendEnv: false,
		detached,
		stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
		reject: false,
		maxBuffer: 2 * 1024 * 1024,
	});
	const done = child.then((result) => ({
		exitCode: result.exitCode ?? 1,
		stdout: String(result.stdout ?? ""),
		stderr: String(result.stderr ?? ""),
	}));
	// Install rejection handlers immediately: a refused scope must never be an unhandled rejection.
	void done.catch(() => {});
	const identity = new Promise<Identity>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.stdio[3]?.destroy();
			reject(Error("containment gate did not register"));
		}, 10000);
		let text = "";
		const ready = child.stdio[4] as Readable;
		const fail = () => {
			clearTimeout(timer);
			child.stdio[3]?.destroy();
			reject(Error("containment gate exited before registration"));
		};
		ready.on("error", fail);
		ready.on("end", () => {
			if (!text.includes("\n")) fail();
		});
		ready.on("data", (chunk) => {
			text += chunk;
			if (text.length > 4096) return fail();
			if (!text.includes("\n")) return;
			clearTimeout(timer);
			try {
				resolve(enrich(JSON.parse(text.split("\n")[0]) as Identity));
			} catch {
				fail();
			}
		});
	});
	const release = child.stdio[3] as unknown as Writable;
	release.on("error", () => {});
	return { identity, release, output: child.stdout, done };
}
