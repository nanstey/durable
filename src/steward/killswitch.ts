import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { durableHome } from "../config/paths.ts";
import { audit } from "./audit.ts";
import { agentDir, loadJson, saveJson } from "./files.ts";

export function quietHours(
	spec: string | undefined,
	now = Date.now(),
): boolean {
	if (!spec) return false;
	const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})(?: (UTC|local))?$/.exec(spec);
	if (!match) throw Error("quietHours must be HH:MM-HH:MM [UTC|local]");
	const [, ah, am, bh, bm, zone] = match;
	const [a, b] = [minutes(ah, am), minutes(bh, bm)];
	const date = new Date(now);
	const current =
		zone === "UTC"
			? date.getUTCHours() * 60 + date.getUTCMinutes()
			: date.getHours() * 60 + date.getMinutes();
	return insideWindow(a, b, current);
}
function minutes(hour: string, minute: string) {
	if (Number(hour) > 23 || Number(minute) > 59)
		throw Error("invalid quietHours time");
	return Number(hour) * 60 + Number(minute);
}
function insideWindow(start: number, end: number, current: number) {
	if (start === end) return true;
	return start < end
		? current >= start && current < end
		: current >= start || current < end;
}
function organizationPausePath(organization: string) {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(organization))
		throw Error("organization must be a simple name");
	return join(durableHome(), "organizations", organization, "paused");
}
export function pauseOrganization(organization: string) {
	const path = organizationPausePath(organization);
	mkdirSync(join(durableHome(), "organizations", organization), {
		recursive: true,
		mode: 0o700,
	});
	writeFileSync(path, "paused\n", { mode: 0o600 });
}
export function resumeOrganization(organization: string) {
	const path = organizationPausePath(organization);
	if (existsSync(path)) unlinkSync(path);
}
export function disabled(
	agent: string,
	quiet?: string,
	now = Date.now(),
	env = process.env,
	organization?: string,
) {
	return (
		env.DURABLE_DISABLED === "1" ||
		existsSync(join(durableHome(), "disabled")) ||
		existsSync(join(agentDir(agent), "disabled")) ||
		(Boolean(organization) &&
			existsSync(organizationPausePath(organization ?? "default"))) ||
		quietHours(quiet, now)
	);
}
export function pauseFile(agent: string) {
	writeFileSync(join(agentDir(agent), "disabled"), "paused\n", { mode: 0o600 });
}
export function resumeRequest(agent: string) {
	return loadJson<{ id: string } | undefined>(
		join(agentDir(agent), "resume-request.json"),
		() => undefined,
	)?.id;
}
export function resumeApproved(agent: string, via: "tty" | "passkey") {
	const path = join(agentDir(agent), "disabled");
	if (existsSync(path)) unlinkSync(path);
	saveJson(join(agentDir(agent), "resume-request.json"), { id: randomUUID() });
	audit(agent, { event: "resumed", actor: "human", via });
}
export function resumeLocal(agent: string, tty = Boolean(process.stdin.isTTY)) {
	if (!tty)
		throw Error(
			"resume requires a local TTY; bearer tokens cannot resume an agent",
		);
	resumeApproved(agent, "tty");
}
