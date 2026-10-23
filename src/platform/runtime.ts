import { existsSync } from "node:fs";
import type { Capabilities } from "./detect.ts";
import { ProcessContainment } from "./processContainment.ts";
import { SystemdContainment } from "./systemdContainment.ts";
export function containmentFor(capabilities: Capabilities) {
	return capabilities.os === "linux" &&
		existsSync("/sys/fs/cgroup/cgroup.controllers")
		? new SystemdContainment()
		: new ProcessContainment();
}
