export const PROFILE_NAME = /^[A-Za-z0-9._-]+$/;
export type WorkerKind = "pi-session" | "durable-conversation";
export type AgentDef = {
	id?: string;
	profile: string;
	scope?: {
		repos?: Array<{
			slug: string;
			policySource?: { kind: "none" | "fixture" };
		}>;
	};
	merge?: {
		mode?: "human-approval" | "auto-when-safe" | "never";
		shadow?: boolean;
		tighten?: Record<string, unknown>;
	};
	chat?: {
		startableKinds?: string[];
		maxMessageBytes?: number;
		rateLimit?: Record<string, unknown>;
	};
	workers?: {
		dispatcher?: "orca" | "git-process";
		kind?: WorkerKind;
		roles?: Record<string, { kind?: WorkerKind }>;
		durable?: {
			enabledRoles?: string[];
			maxConcurrent?: number;
			skills?: string[];
			viewer?: "on-start" | "on-demand" | "never";
		};
	};
	notify?: Record<string, string[]>;
};
export type MachineCfg = {
	name: string;
	agents: Array<string | { id: string; port?: number }>;
	daemon?: { portBase?: number };
	profiles?: { allowDefault?: boolean };
	platform?: {
		os?: "linux" | "android";
		service?: "systemd-user" | "termux-runit";
		tailscaleCli?: boolean;
		allowAutoMerge?: boolean;
	};
	network?: {
		bind?: "loopback";
		peerCheck?: "required" | "optional" | "off";
		tailnetAddress?: string;
	};
	channels?: Record<
		string,
		{ kind: "console" | "desktop" | "command" | "github"; targetLogin?: string }
	>;
	workers?: {
		roles?: Record<string, { kind?: WorkerKind; skills?: string[] }>;
	};
};
export type ProfileManifest = {
	version: 1;
	label: string;
	github: { host: string; login: string };
	git: { name: string; email: string };
	providers: string[];
};
export function assertProfileName(name: string): void {
	if (!PROFILE_NAME.test(name) || name === "." || name === "..")
		throw new Error("profile must match ^[A-Za-z0-9._-]+$");
}
export function validateAgent(value: unknown): AgentDef {
	const x = value as AgentDef;
	if (!x || typeof x !== "object" || typeof x.profile !== "string")
		throw new Error("definition requires profile");
	assertProfileName(x.profile);
	const json = JSON.stringify(x);
	if (/(^|["'])\s*(\/|~)/.test(json))
		throw new Error("definition path fields must be relative");
	if (
		x.workers?.durable?.maxConcurrent !== undefined &&
		x.workers.durable.maxConcurrent < 1
	)
		throw new Error("maxConcurrent must be positive");
	return x;
}
export function validateMachine(value: unknown): MachineCfg {
	const x = value as MachineCfg;
	if (
		!x ||
		typeof x !== "object" ||
		typeof x.name !== "string" ||
		!Array.isArray(x.agents)
	)
		throw new Error("machine requires name and agents");
	if (x.network?.bind && x.network.bind !== "loopback")
		throw new Error("network.bind must be loopback");
	return x;
}
export function validateManifest(value: unknown): ProfileManifest {
	const x = value as ProfileManifest;
	if (
		x?.version !== 1 ||
		!x.github?.login ||
		!x.git?.email ||
		!Array.isArray(x.providers)
	)
		throw new Error("invalid profile manifest");
	return x;
}
