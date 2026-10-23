import { SystemdContainment } from "../../src/platform/systemdContainment.ts";
import { ProcessManager } from "../../src/steward/procs.ts";

const [boundary, marker] = process.argv.slice(2);
let manager: ProcessManager;
manager = new ProcessManager(
	"fault",
	new SystemdContainment(undefined, undefined, 20),
	async (point) => {
		if (point === boundary) process.kill(process.pid, "SIGKILL");
		if (point === "after:running" && boundary.endsWith(":kill"))
			setTimeout(() => {
				void manager.terminate();
			}, 20);
	},
);
await manager.launch(
	[
		"/bin/sh",
		"-c",
		boundary.endsWith(":delete") ? "true" : `printf x > "$1"; sleep 300`,
		"probe",
		marker,
	],
	{ PATH: process.env.PATH },
	{ item: "item", attemptId: "one" },
);
