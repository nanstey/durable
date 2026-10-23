import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import type { Containment, Invocation } from "./containment.ts";
import { gatedProcess } from "./gatedProcess.ts";

export type CommandRunner = (
	command: string,
	args: string[],
) => Promise<{ stdout: string; exitCode: number }>;
const run: CommandRunner = async (command, args) => {
	const result = await execa(command, args, { reject: false, timeout: 10000 });
	return { stdout: result.stdout, exitCode: result.exitCode ?? 1 };
};
export function recursivelyEmpty(events: string) {
	return /^populated 0$/m.test(events) && !/^populated 1$/m.test(events);
}
export class SystemdContainment implements Containment {
	readonly confirmed = true;
	private command: CommandRunner;
	private mount: string;
	private graceMs: number;
	constructor(
		command: CommandRunner = run,
		mount = "/sys/fs/cgroup",
		graceMs = 5000,
	) {
		this.command = command;
		this.mount = mount;
		this.graceMs = graceMs;
	}
	hostedEnv(env: NodeJS.ProcessEnv) {
		return {
			...env,
			XDG_RUNTIME_DIR:
				process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`,
		};
	}
	hostedArgv(record: Invocation, argv: string[]) {
		return [
			"systemd-run",
			"--user",
			"--scope",
			"--collect",
			"--quiet",
			"--slice",
			record.slice,
			"--unit",
			record.unit,
			"--",
			...argv,
		];
	}
	spawn(
		record: Invocation,
		hash: string,
		argv: string[],
		env: NodeJS.ProcessEnv,
	) {
		return gatedProcess(
			"systemd-run",
			[
				"--user",
				"--scope",
				"--collect",
				"--quiet",
				"--slice",
				record.slice,
				"--unit",
				record.unit,
				"--",
				process.execPath,
				fileURLToPath(new URL("../../bin/durable-gate", import.meta.url)),
				hash,
				...argv,
			],
			{
				...env,
				XDG_RUNTIME_DIR:
					process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`,
			},
			async (identity) => ({
				...identity,
				cgroup: await this.group(record.slice),
			}),
		);
	}
	private async group(unit: string) {
		const result = await this.command("systemctl", [
			"--user",
			"show",
			unit,
			"--property=ControlGroup",
			"--property=LoadState",
			"--property=ActiveState",
		]);
		if (result.exitCode !== 0) throw Error("cannot inspect containment unit");
		if (/^LoadState=not-found$/m.test(result.stdout)) return "";
		const group = /^ControlGroup=(.*)$/m.exec(result.stdout)?.[1];
		if (group === "" && /^ActiveState=inactive$/m.test(result.stdout))
			return "";
		if (!group?.startsWith("/") || group === "/")
			throw Error("containment cgroup missing");
		return group;
	}
	async empty(record: Invocation) {
		try {
			const current = await this.group(record.slice);
			// A collected/forgotten unit is not evidence that its recorded kernel subtree is empty.
			for (const group of new Set(
				[current, record.cgroup].filter((path): path is string =>
					Boolean(path),
				),
			)) {
				const path = resolve(this.mount, `.${group}`);
				if (!path.startsWith(`${resolve(this.mount)}/`)) return false;
				try {
					if (
						!recursivelyEmpty(
							await readFile(join(path, "cgroup.events"), "utf8"),
						)
					)
						return false;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
				}
			}
			return true;
		} catch {
			return false;
		}
	}
	async kill(record: Invocation) {
		if (await this.empty(record)) return true;
		await this.command("systemctl", [
			"--user",
			"kill",
			"--signal=TERM",
			record.slice,
		]);
		const until = Date.now() + this.graceMs;
		while (Date.now() < until) {
			if (await this.empty(record)) return true;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		await this.command("systemctl", [
			"--user",
			"kill",
			"--signal=KILL",
			record.slice,
		]);
		for (let i = 0; i < 100; i++) {
			if (await this.empty(record)) return true;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return false;
	}
}
