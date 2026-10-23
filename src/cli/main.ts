import { createToken, revokeToken, type Scope } from "../api/tokens.ts";
import { SystemdUserServiceManager } from "../platform/service/systemdUser.ts";
import { run } from "../steward/main.ts";
import { doctorCommand, formatDoctor } from "./doctor.ts";

import { profileCommand } from "./profile.ts";

function usage() {
	console.log(
		"durable doctor <id> | profile ... | enable|disable|status|stop|logs <id> | token create|revoke <id> | run <id>",
	);
}
const [cmd, sub, ...rest] = process.argv.slice(2);
if (cmd === "run" && sub) run(sub);
else if (["enable", "disable", "status", "stop", "logs"].includes(cmd) && sub) {
	const svc = new SystemdUserServiceManager();
	if (cmd === "enable") await svc.enable(sub);
	else if (cmd === "disable") await svc.disable(sub);
	else if (cmd === "stop") await svc.stop(sub);
	else if (cmd === "status") console.log((await svc.status(sub)).text);
	else for await (const x of svc.logs(sub)) process.stdout.write(x);
} else if (cmd === "token" && sub) {
	const agent = rest[0];
	if (!agent) throw Error("agent required");
	if (sub === "create") {
		const client = rest[rest.indexOf("--client") + 1],
			scopes = rest[rest.indexOf("--scopes") + 1]?.split(",") as Scope[];
		const e = rest.indexOf("--expires");
		console.log(
			createToken(
				agent,
				client,
				scopes,
				e >= 0 ? Number(rest[e + 1]) : undefined,
			),
		);
	} else if (sub === "revoke")
		revokeToken(agent, rest[rest.indexOf("--client") + 1]);
	else usage();
} else if (cmd === "doctor" && sub) {
	const r = doctorCommand(sub);
	if (rest.includes("--json")) console.log(JSON.stringify(r, null, 2));
	else console.log(formatDoctor(r));
	process.exitCode = r.ok ? 0 : 1;
} else if (cmd === "profile" && sub) {
	console.log(
		profileCommand(
			sub,
			rest.find((arg) => !arg.startsWith("--")),
			{ dryRun: rest.includes("--dry-run") },
		),
	);
} else usage();
