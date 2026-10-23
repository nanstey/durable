import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { durableHome } from "../config/paths.ts";
import { audit } from "./audit.ts";
import { agentDir } from "./files.ts";

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
export function disabled(
	agent: string,
	quiet?: string,
	now = Date.now(),
	env = process.env,
) {
	return (
		env.DURABLE_DISABLED === "1" ||
		existsSync(join(durableHome(), "disabled")) ||
		existsSync(join(agentDir(agent), "disabled")) ||
		quietHours(quiet, now)
	);
}
export function pauseFile(agent: string) {
	writeFileSync(join(agentDir(agent), "disabled"), "paused\n", { mode: 0o600 });
}
export function resumeLocal(agent: string, tty = Boolean(process.stdin.isTTY)) {
	if (!tty)
		throw Error(
			"resume requires a local TTY; bearer tokens cannot resume an agent",
		);
	const path = join(agentDir(agent), "disabled");
	if (existsSync(path)) unlinkSync(path);
	audit(agent, { event: "resumed", actor: "human", via: "tty" });
}
