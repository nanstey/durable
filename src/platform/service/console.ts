import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

export class ConsoleServiceManager {
	async enable() {
		const directory = join(homedir(), ".config", "systemd", "user");
		await mkdir(directory, { recursive: true });
		await copyFile(
			new URL("../../../units/durable-console.service", import.meta.url),
			join(directory, "durable-console.service"),
		);
		for (const args of [
			["--user", "daemon-reload"],
			["--user", "enable", "--now", "durable-console.service"],
		]) {
			const result = await execa("systemctl", args, {
				reject: false,
				timeout: 15_000,
			});
			if (result.exitCode !== 0)
				throw Error(
					"console service operation failed; inspect console service status",
				);
		}
	}
	async disable() {
		await execa(
			"systemctl",
			["--user", "disable", "--now", "durable-console.service"],
			{ timeout: 15_000 },
		);
	}
	async status() {
		const result = await execa(
			"systemctl",
			["--user", "is-active", "durable-console.service"],
			{ reject: false, timeout: 15_000 },
		);
		return result.stdout || "inactive";
	}
}
