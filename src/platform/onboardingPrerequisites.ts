import { existsSync } from "node:fs";
import { execaSync } from "execa";

export type Prerequisite = { name: string; ok: boolean; detail: string };

function installed(command: string): boolean {
	try {
		return (
			execaSync(command, ["--version"], {
				reject: false,
				stdin: "ignore",
				timeout: 2_000,
			}).exitCode === 0
		);
	} catch {
		return false;
	}
}

/** Reports setup readiness without blocking the credential-free manifest step. */
export function checkPrerequisites(piRoot?: string): Prerequisite[] {
	const [major, minor] = process.versions.node.split(".").map(Number);
	const nodeOk = major > 22 || (major === 22 && minor >= 19);
	const termux = Boolean(
		process.env.TERMUX_VERSION || process.env.PREFIX?.includes("com.termux"),
	);
	return [
		{
			name: "Node",
			ok: nodeOk,
			detail: nodeOk ? process.versions.node : "Node >=22.19.0 is required",
		},
		{ name: "Git", ok: installed("git"), detail: "required for repositories" },
		{
			name: "gh",
			ok: installed("gh"),
			detail: "needed to bind the GitHub identity",
		},
		{
			name: "systemd --user",
			ok: termux ? true : installed("systemctl"),
			detail: termux
				? "not required on Android/Termux"
				: "needed only when enabling a Linux service",
		},
		{
			name: "Pi",
			ok: piRoot ? existsSync(piRoot) : installed("pi"),
			detail: "select the named profile in Pi before /login",
		},
	];
}

export function formatPrerequisites(checks: Prerequisite[]): string {
	return checks
		.map(
			(check) => `${check.ok ? "PASS" : "WARN"} ${check.name}: ${check.detail}`,
		)
		.join("\n");
}
