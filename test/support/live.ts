import { existsSync, readFileSync } from "node:fs";
import { execaSync } from "execa";

function readableCgroup(): boolean {
	try {
		readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf8");
		return true;
	} catch {
		return false;
	}
}
export const liveContainment =
	existsSync("/sys/fs/cgroup/cgroup.controllers") &&
	readableCgroup() &&
	execaSync("systemctl", ["--user", "show-environment"], {
		reject: false,
		timeout: 3000,
	}).exitCode === 0;
