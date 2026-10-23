import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { assertProfileName } from "../../config/schema.ts";
import type { ServiceManager, ServiceStatus } from "./types.ts";

export function unitText(home?: string): string {
	const environment = home
		? `Environment="DURABLE_HOME=${home.replace(/[%\\"\n\r]/g, (char) => (char === "%" ? "%%" : char === "\n" || char === "\r" ? "" : `\\${char}`))}"\n`
		: "";
	return `[Unit]\nDescription=Durable agent %i\nOnFailure=durable-agent-failure@%i.service\n\n[Service]\nType=simple\nExecStart=%h/.local/bin/durable run %i\nRestart=on-failure\nRestartSec=12\nKillMode=control-group\nTimeoutStopSec=30\nNoNewPrivileges=yes\n${environment}\n[Install]\nWantedBy=default.target\n`;
}
export type ServiceRunner = (
	command: string,
	args: string[],
) => Promise<{ exitCode: number; stdout: string; stderr?: string }>;
const execute: ServiceRunner = async (command, args) => {
	const result = await execa(command, args, { reject: false, timeout: 15000 });
	return {
		exitCode: result.exitCode ?? 1,
		stdout: result.stdout,
		stderr: result.stderr,
	};
};
export class SystemdUserServiceManager implements ServiceManager {
	private runner: ServiceRunner;
	private directory: string;
	private dryRun: boolean;
	private home?: string;
	constructor(
		options: {
			runner?: ServiceRunner;
			directory?: string;
			dryRun?: boolean;
			home?: string;
		} = {},
	) {
		this.runner = options.runner ?? execute;
		this.directory =
			options.directory ?? join(homedir(), ".config/systemd/user");
		this.dryRun = options.dryRun ?? false;
		this.home = options.home;
	}
	private unit(agent: string) {
		assertProfileName(agent);
		return `durable-agent@${agent}.service`;
	}
	private async call(command: string, args: string[], allowFailure = false) {
		if (this.dryRun) {
			console.log([command, ...args].join(" "));
			return { exitCode: 0, stdout: "dry-run" };
		}
		const result = await this.runner(command, args);
		if (!allowFailure && result.exitCode !== 0)
			throw Error(`${command} failed; inspect user service logs`);
		return result;
	}
	async install(agent: string) {
		this.unit(agent);
		if (!this.dryRun) {
			await mkdir(this.directory, { recursive: true });
			await writeFile(
				join(this.directory, "durable-agent@.service"),
				unitText(this.home),
				{ mode: 0o644 },
			);
			await writeFile(
				join(this.directory, "durable-agent-failure@.service"),
				await readFile(
					new URL(
						"../../../units/durable-agent-failure@.service",
						import.meta.url,
					),
					"utf8",
				),
				{ mode: 0o644 },
			);
		}
		await this.call("systemctl", ["--user", "daemon-reload"]);
	}
	async enable(agent: string) {
		await this.install(agent);
		await this.call("systemctl", [
			"--user",
			"enable",
			"--now",
			this.unit(agent),
		]);
	}
	async disable(agent: string) {
		await this.call("systemctl", [
			"--user",
			"disable",
			"--now",
			this.unit(agent),
		]);
	}
	async start(agent: string) {
		await this.call("systemctl", ["--user", "start", this.unit(agent)]);
	}
	async stop(agent: string) {
		await this.call("systemctl", ["--user", "stop", this.unit(agent)]);
	}
	async status(agent: string): Promise<ServiceStatus> {
		const result = await this.call(
			"systemctl",
			["--user", "is-active", this.unit(agent)],
			true,
		);
		return { active: result.exitCode === 0, text: result.stdout.trim() };
	}
	async *logs(agent: string) {
		yield (
			await this.call("journalctl", [
				"--user-unit",
				this.unit(agent),
				"-n",
				"100",
				"--no-pager",
			])
		).stdout;
	}
}
