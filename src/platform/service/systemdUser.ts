import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServiceManager, ServiceStatus } from "./types.ts";
export function unitText(): string {
	return `[Unit]\nDescription=Durable agent %i\nOnFailure=durable-agent-failure@%i.service\n\n[Service]\nType=simple\nExecStart=%h/.local/bin/durable run %i\nRestart=on-failure\nKillMode=control-group\nTimeoutStopSec=30\nNoNewPrivileges=yes\n\n[Install]\nWantedBy=default.target\n`;
}
function call(args: string[]): void {
	const r = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
	if (r.status !== 0)
		throw new Error(r.stderr.trim() || `systemctl ${args.join(" ")} failed`);
}
export class SystemdUserServiceManager implements ServiceManager {
	async install(_agent: string) {
		const d = join(homedir(), ".config/systemd/user");
		mkdirSync(d, { recursive: true });
		writeFileSync(join(d, "durable-agent@.service"), unitText(), {
			mode: 0o644,
		});
		writeFileSync(
			join(d, "durable-agent-failure@.service"),
			"[Service]\nType=oneshot\nExecStart=/usr/bin/true\n",
			{ mode: 0o644 },
		);
		call(["daemon-reload"]);
	}
	async enable(agent: string) {
		await this.install(agent);
		call(["enable", "--now", `durable-agent@${agent}`]);
	}
	async disable(agent: string) {
		call(["disable", "--now", `durable-agent@${agent}`]);
	}
	async start(agent: string) {
		call(["start", `durable-agent@${agent}`]);
	}
	async stop(agent: string) {
		call(["stop", `durable-agent@${agent}`]);
	}
	async status(agent: string): Promise<ServiceStatus> {
		const r = spawnSync(
			"systemctl",
			["--user", "is-active", `durable-agent@${agent}`],
			{ encoding: "utf8" },
		);
		return { active: r.status === 0, text: r.stdout.trim() };
	}
	async *logs(agent: string) {
		const r = spawnSync(
			"journalctl",
			["--user-unit", `durable-agent@${agent}`, "-n", "100", "--no-pager"],
			{ encoding: "utf8" },
		);
		yield r.stdout;
	}
}
