import { existsSync } from "node:fs";
import { join } from "node:path";
import { durableHome } from "../config/paths.ts";
import type { AgentDef, MachineCfg } from "../config/schema.ts";
import { derivedAuthSafe } from "./pidir.ts";
import { listProviders, resolveProfile } from "./profiles.ts";
export type Check = { name: string; ok: boolean; detail: string; fix?: string };
export type Report = { ok: boolean; checks: Check[] };
export function effectiveKind(
	def: AgentDef,
	machine: MachineCfg,
	role: string,
): "pi-session" | "durable-conversation" {
	return (
		machine.workers?.roles?.[role]?.kind ||
		def.workers?.roles?.[role]?.kind ||
		def.workers?.kind ||
		(machine.platform?.os === "android" ? "durable-conversation" : "pi-session")
	);
}
export function doctor(id: string, def: AgentDef, machine: MachineCfg): Report {
	const checks: Check[] = [];
	const assigned = machine.agents.some(
		(a) => (typeof a === "string" ? a : a.id) === id,
	);
	checks.push({
		name: "machine assignment",
		ok: assigned,
		detail: assigned ? "assigned" : "agent is not assigned",
	});
	const p = resolveProfile(def.profile);
	const defaultOk = !p.isDefault || machine.profiles?.allowDefault === true;
	checks.push({
		name: "named profile",
		ok: defaultOk,
		detail: defaultOk ? p.name : "default requires profiles.allowDefault: true",
		fix: "use a named profile or explicitly opt in",
	});
	checks.push({
		name: "profile",
		ok: existsSync(p.authFile),
		detail: existsSync(p.authFile) ? "present" : "missing",
		fix: "run Pi /login for named providers",
	});
	checks.push({
		name: "manifest",
		ok: existsSync(p.manifestFile),
		detail: existsSync(p.manifestFile) ? "present" : "missing",
		fix: `durable profile init ${p.name}`,
	});
	checks.push({
		name: "providers",
		ok: listProviders(p).length > 0,
		detail: listProviders(p).length ? listProviders(p).join(", ") : "none",
	});
	const pi = join(durableHome(), "agents", id, "pi");
	checks.push({
		name: "derived auth",
		ok: derivedAuthSafe(pi),
		detail: derivedAuthSafe(pi)
			? "absent or empty"
			: "credential or symlink found",
	});
	for (const role of ["worker", "reviewer"]) {
		const kind = effectiveKind(def, machine, role);
		const enabled = def.workers?.durable?.enabledRoles || [];
		checks.push({
			name: `${role} kind`,
			ok: kind !== "durable-conversation" || enabled.includes(role),
			detail: kind,
		});
	}
	if (
		machine.platform?.os === "android" &&
		def.merge?.mode === "auto-when-safe" &&
		!machine.platform.allowAutoMerge
	)
		checks.push({
			name: "android merge ceiling",
			ok: false,
			detail: "auto merge needs allowAutoMerge",
		});
	return { checks, ok: checks.every((x) => x.ok) };
}
