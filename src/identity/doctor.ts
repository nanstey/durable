import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import {
	familyFor,
	oppositeProvider,
	providerFor,
	tighteningWarnings,
} from "../config/agent.ts";
import { durableHome } from "../config/paths.ts";
import {
	type AgentDef,
	type MachineCfg,
	validateAgent,
	validateMachine,
	validateManifest,
} from "../config/schema.ts";
import { type Capabilities, detectCapabilities } from "../platform/detect.ts";
import { type GithubRunner, githubLogin } from "./github.ts";
import { checkRoleSkills, effectiveKind } from "./skills.ts";
import { tokenWarnings } from "./token.ts";

export { effectiveKind } from "./skills.ts";

import { derivedAuthSafe } from "./pidir.ts";
import { listProviders, resolveProfile } from "./profiles.ts";
export type Check = {
	name: string;
	ok: boolean;
	detail: string;
	fix?: string;
	warning?: boolean;
};
export type Report = { ok: boolean; checks: Check[] };
export function doctor(
	id: string,
	def: AgentDef,
	machine: MachineCfg,
	options: {
		capabilities?: Capabilities;
		github?: GithubRunner;
		resolvedPolicies?: Record<string, Record<string, unknown>>;
	} = {},
): Report {
	const checks: Check[] = [];
	try {
		validateAgent(def);
		checks.push({
			name: "definition valid",
			ok: true,
			detail: "schema validated",
		});
		validateMachine(machine);
		checks.push({
			name: "machine valid",
			ok: true,
			detail: "schema validated",
		});
	} catch {
		checks.push({
			name: "configuration valid",
			ok: false,
			detail: "invalid definition or machine configuration",
			fix: "validate against schema/ and remove unsupported or unknown keys",
		});
		return { ok: false, checks };
	}
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
	let providers: string[] = [];
	try {
		providers = listProviders(p);
	} catch {
		/* Invalid credentials are reported without their contents. */
	}
	checks.push({
		name: "providers",
		ok: providers.length > 0,
		detail: providers.length ? providers.join(", ") : "missing or invalid",
		fix: `run Pi /login using profile ${p.name}`,
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
		const enabled =
			def.workers?.durable?.enabledRoles ??
			(machine.platform?.os === "android" ? ["worker", "reviewer"] : []);
		checks.push({
			name: `${role} kind`,
			ok: kind !== "durable-conversation" || enabled.includes(role),
			detail: kind,
		});
	}
	if (
		machine.platform?.os === "android" &&
		(def.merge?.mode === "auto-when-safe" ||
			def.scope?.repos?.some(
				(repo) => repo.merge?.mode === "auto-when-safe",
			)) &&
		!machine.platform.allowAutoMerge
	)
		checks.push({
			name: "android merge ceiling",
			ok: false,
			detail: "auto merge needs allowAutoMerge",
		});
	for (const repo of def.scope?.repos ?? []) {
		const policy = options.resolvedPolicies?.[repo.slug];
		const tighten = repo.merge?.tighten ?? def.merge?.tighten;
		if (policy && tighten)
			for (const detail of tighteningWarnings(tighten, policy))
				checks.push({
					name: `policy ${repo.slug}`,
					ok: true,
					warning: true,
					detail,
				});
		else if (tighten)
			checks.push({
				name: `policy ${repo.slug}`,
				ok: true,
				warning: true,
				detail:
					"tighten constraints cannot be evaluated without a resolved trusted repository policy; auto-merge remains unavailable",
			});
	}
	const caps = options.capabilities ?? detectCapabilities();
	const [major, minor] = process.versions.node.split(".").map(Number);
	checks.push({
		name: "Node",
		ok: major > 22 || (major === 22 && minor >= 19),
		detail: "requires >=22.19.0",
		fix: "upgrade Node",
	});
	checks.push({
		name: "storage",
		ok: true,
		detail: caps.sqlite ? "node:sqlite" : "JSONL fallback",
	});
	checks.push({
		name: "dispatcher",
		ok: def.workers?.dispatcher !== "orca" || caps.orca,
		detail: def.workers?.dispatcher ?? "git-process",
		fix: "install/configure Orca or select git-process explicitly",
	});
	if (caps.os === "android") {
		const home = process.env.HOME;
		const state = durableHome();
		checks.push({
			name: "Android private storage",
			ok: Boolean(
				home &&
					state.startsWith(`${home}/`) &&
					!state.startsWith("/storage/") &&
					!state.startsWith(`${home}/storage/`),
			),
			detail: "DURABLE_HOME must be under Termux private HOME",
			fix: "move DURABLE_HOME into Termux private HOME",
		});
		if (
			Object.values(machine.channels ?? {}).some(
				(channel) => channel.kind === "desktop",
			)
		)
			checks.push({
				name: "Android nonce delivery",
				ok: true,
				warning: true,
				detail:
					"Termux desktop notifications are not nonce-safe; use passkeys or merge on GitHub",
			});
	}
	for (const field of ["os", "service", "tailscaleCli"] as const) {
		const declared = machine.platform?.[field];
		checks.push({
			name: `platform ${field}`,
			ok: declared === undefined || declared === caps[field],
			detail: `detected ${caps[field]}; declared ${declared ?? "unset"}`,
			fix: "correct machine platform declarations",
		});
	}
	checks.push({
		name: "service",
		ok: caps.serviceAvailable,
		detail: caps.service,
		fix: "enable the platform user service manager",
	});
	checks.push({
		name: "containment",
		ok: caps.containment,
		detail: caps.containment ? "available" : "unavailable",
		fix: "make systemd-run --user --scope true succeed before dispatch",
	});
	checks.push({
		name: "gh",
		ok: caps.gh,
		detail: caps.gh ? "installed" : "missing",
		fix: "install gh",
	});
	checks.push({
		name: "peer check",
		ok: machine.network?.peerCheck !== "required" || caps.tailscaleCli,
		detail: caps.tailscaleCli ? "available" : "unavailable (optional)",
		fix: "install tailscale or declare optional peer checking",
	});
	if (machine.network || machine.approval)
		checks.push({
			name: "future configuration",
			ok: false,
			detail: "network/approval: not-yet-supported",
			fix: "remove these blocks until slices 11/12",
		});
	const ports = machine.agents.map((agent, index) =>
		typeof agent === "object" && agent.port
			? agent.port
			: (machine.daemon?.portBase ?? 7330) + index,
	);
	checks.push({
		name: "ports",
		ok:
			new Set(ports).size === ports.length &&
			ports.every((port) => port <= 65535),
		detail: "unique valid port assignments required",
		fix: "assign unique ports in machine.yaml",
	});
	for (const role of ["worker", "reviewer"]) {
		const kind = effectiveKind(def, machine, role);
		checks.push({
			name: `${role} skills`,
			...checkRoleSkills(def, machine, role),
		});
		checks.push({
			name: `${role} default profile`,
			ok: !p.isDefault || kind !== "pi-session",
			detail: kind,
			fix: "use a named profile for Pi-session workers",
		});
	}
	for (const channel of Object.values(def.notify ?? {}).flatMap((value) =>
		Array.isArray(value)
			? value
			: typeof value === "object"
				? value.channels
				: [],
	))
		checks.push({
			name: `channel ${channel}`,
			ok: Boolean(machine.channels?.[channel]),
			detail: machine.channels?.[channel]?.kind ?? "missing",
			fix: "define the channel in machine.yaml",
		});
	try {
		const manifest = validateManifest(
			JSON.parse(readFileSync(p.manifestFile, "utf8")),
		);
		for (const warning of tokenWarnings(
			p,
			def.scope?.repos?.map((repo) => repo.slug) ?? [],
			options.github,
		))
			checks.push({
				name: "token guidance",
				ok: true,
				warning: true,
				detail: warning,
			});
		for (const channel of Object.values(machine.channels ?? {}))
			if (
				channel.kind === "github" &&
				channel.targetLogin?.toLowerCase() ===
					manifest.github.login.toLowerCase()
			)
				checks.push({
					name: "GitHub notification",
					ok: true,
					warning: true,
					detail:
						"target login equals profile login: notifications will be silent",
				});
		checks.push({
			name: "git identity",
			ok: Boolean(manifest.git.name && manifest.git.email),
			detail: "manifest identity",
			fix: `edit profile-meta/${p.name}.json git identity`,
		});
		try {
			checks.push({
				name: "GitHub login",
				ok:
					githubLogin(p, options.github).toLowerCase() ===
					manifest.github.login.toLowerCase(),
				detail: "token must match manifest",
				fix: `pi-secret -p ${p.name} set GH_TOKEN; durable profile bind-github ${p.name}`,
			});
		} catch {
			checks.push({
				name: "GitHub login",
				ok: false,
				detail: "unable to verify token",
				fix: `pi-secret -p ${p.name} set GH_TOKEN`,
			});
		}
	} catch {
		checks.push({
			name: "manifest valid",
			ok: false,
			detail: "invalid or missing manifest",
			fix: `durable profile init ${p.name}`,
		});
	}
	for (const role of ["steward", "worker", "reviewer"] as const)
		checks.push({
			name: `${role} model configured`,
			ok: Boolean(def.models?.[role]),
			detail: def.models?.[role] ? "configured" : "missing",
			fix: `configure models.${role} in the agent definition`,
		});
	for (const [role, model] of Object.entries(def.models ?? {})) {
		if (model === "auto") continue;
		const provider = providerFor(model);
		checks.push({
			name: `${role} provider`,
			ok: providers.includes(provider),
			detail: provider,
			fix: `run Pi /login with profile ${p.name}`,
		});
	}
	if (
		def.models?.worker &&
		def.models.reviewer &&
		def.models.reviewer !== "auto"
	) {
		checks.push({
			name: "reviewer family",
			ok: familyFor(def.models.worker) !== familyFor(def.models.reviewer),
			detail: "reviewer must use a different model family",
			fix: "choose a reviewer from the opposite family",
		});
	}
	if (def.models?.reviewer === "auto" && def.models.worker) {
		const opposite = oppositeProvider(def.models.worker, providers);
		checks.push({
			name: "reviewer family",
			ok: Boolean(opposite),
			detail: opposite
				? `opposite provider: ${opposite}`
				: "cannot prove an opposite-family reviewer",
			fix: "configure an explicit opposite-family reviewer model and log in to its provider",
		});
	}
	for (const role of ["worker", "reviewer"] as const) {
		if (effectiveKind(def, machine, role) !== "durable-conversation") continue;
		const model = def.models?.[role];
		const provider =
			model === "auto" && def.models?.worker
				? oppositeProvider(def.models.worker, providers)
				: model && model !== "auto"
					? providerFor(model)
					: undefined;
		let supported = Boolean(provider && providers.includes(provider));
		try {
			if (
				provider === "anthropic" &&
				readStoredCredential(provider, p.authFile)?.type === "oauth"
			)
				supported = false;
		} catch {
			supported = false;
		}
		checks.push({
			name: `${role} durable model`,
			ok: supported,
			detail: supported
				? "profile can provide model auth"
				: "missing model auth or unconfigured Anthropic OAuth shaping",
			fix: "choose a supported profile model or Pi-session role; shaped Anthropic auth is not configured",
		});
		checks.push({
			name: `${role} durable skills warning`,
			ok: true,
			warning: true,
			detail:
				"durable workers cannot load user skills/extensions; only the explicit text allowlist is available",
		});
	}
	return { checks, ok: checks.every((x) => x.ok) };
}
