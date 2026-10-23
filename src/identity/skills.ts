import { existsSync } from "node:fs";
import { join } from "node:path";
import { piAgentDir } from "../config/paths.ts";
import type { AgentDef, MachineCfg, WorkerKind } from "../config/schema.ts";

export function effectiveKind(
	def: AgentDef,
	machine: MachineCfg,
	role: string,
): WorkerKind {
	return (
		machine.workers?.roles?.[role]?.kind ??
		def.workers?.roles?.[role]?.kind ??
		def.workers?.kind ??
		(machine.platform?.os === "android" ? "durable-conversation" : "pi-session")
	);
}
export function requiredSkills(
	def: AgentDef,
	machine: MachineCfg,
	role: string,
): string[] {
	if (effectiveKind(def, machine, role) === "durable-conversation")
		return def.workers?.durable?.skills ?? [];
	return (
		machine.workers?.roles?.[role]?.skills ??
		(role === "worker"
			? ["idea-to-pr", "pr", "build"]
			: role === "reviewer"
				? ["review-code"]
				: [])
	);
}
export function assertRoleDispatchReady(
	def: AgentDef,
	machine: MachineCfg,
	role: string,
	root = piAgentDir(),
): void {
	if (!["worker", "reviewer"].includes(role)) {
		if (def.profile === "default" && machine.profiles?.allowDefault !== true)
			throw new Error("default requires profiles.allowDefault: true");
		return;
	}
	const kind = effectiveKind(def, machine, role);
	if (kind === "durable-conversation") {
		const enabled =
			def.workers?.durable?.enabledRoles ??
			(machine.platform?.os === "android" ? ["worker", "reviewer"] : []);
		if (!enabled.includes(role)) throw new Error(`role-not-enabled: ${role}`);
	}
	if (
		def.profile === "default" &&
		(machine.profiles?.allowDefault !== true || kind === "pi-session")
	)
		throw new Error(
			"use a named profile; default is only permitted for explicitly opted-in in-process users",
		);
	const result = checkRoleSkills(def, machine, role, root);
	if (!result.ok)
		throw new Error(`${kind}/${role}: ${result.detail}; ${result.fix}`);
}
export function checkRoleSkills(
	def: AgentDef,
	machine: MachineCfg,
	role: string,
	root = piAgentDir(),
): { ok: boolean; detail: string; fix: string } {
	const missing = requiredSkills(def, machine, role).filter(
		(name) =>
			!/^[A-Za-z0-9._-]+$/.test(name) ||
			name === "." ||
			name === ".." ||
			!existsSync(join(root, "skills", name, "SKILL.md")),
	);
	return {
		ok: missing.length === 0,
		detail: missing.length
			? `missing: ${missing.join(", ")}`
			: "all required skills present",
		fix: "install the skills repo integration or copy the skill trees",
	};
}
