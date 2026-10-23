import { existsSync } from "node:fs";
import { execaSync } from "execa";

export const liveContainment =
	existsSync("/sys/fs/cgroup/cgroup.controllers") &&
	execaSync("systemctl", ["--user", "show-environment"], {
		reject: false,
		timeout: 3000,
	}).exitCode === 0;
