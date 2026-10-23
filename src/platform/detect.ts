import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

export type Probe = (command: string, args: string[]) => boolean;
export type Capabilities = {
	os: "linux" | "android";
	service: "systemd-user" | "termux-runit";
	serviceAvailable: boolean;
	tailscaleCli: boolean;
	sqlite: boolean;
	orca: boolean;
	containment: boolean;
	gh: boolean;
};
const probe: Probe = (command, args) =>
	spawnSync(command, args, { stdio: "ignore", timeout: 5000 }).status === 0;
export function detectCapabilities(
	run: Probe = probe,
	env = process.env,
): Capabilities {
	const android = Boolean(
		env.TERMUX_VERSION || env.PREFIX?.includes("com.termux"),
	);
	let sqlite = false;
	try {
		createRequire(import.meta.url)("node:sqlite");
		sqlite = true;
	} catch {
		/* JSONL is the fallback storage capability. */
	}
	return {
		os: android ? "android" : "linux",
		service: android ? "termux-runit" : "systemd-user",
		serviceAvailable: android
			? run("sv", ["--version"])
			: run("systemctl", ["--user", "show-environment"]),
		tailscaleCli: run("tailscale", ["version"]),
		sqlite,
		orca: run("orca-ide", ["status", "--json"]),
		containment:
			android || run("systemd-run", ["--user", "--scope", "--quiet", "true"]),
		gh: run("gh", ["--version"]),
	};
}
