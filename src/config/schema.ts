import { Ajv } from "ajv";
import { agentSchema, machineSchema, manifestSchema } from "./jsonSchemas.ts";

const ajv = new Ajv({ allErrors: true, useDefaults: true });
const agentValidator = ajv.compile(agentSchema);
const machineValidator = ajv.compile(machineSchema);
const manifestValidator = ajv.compile(manifestSchema);

export const PROFILE_NAME = /^[A-Za-z0-9._-]+$/;
export type WorkerKind = "pi-session" | "durable-conversation";
export type ModelDef = {
	provider?: string;
	model: string;
	family?: string;
	thinking?: string;
};
export type AgentDef = {
	version?: 1;
	description?: string;
	network?: { bind: "loopback" };
	schedule?: { pollSeconds?: number; quietHours?: string };
	limits?: Record<string, number>;
	sources?: Array<{
		kind: string;
		repo: string;
		labels?: string[];
		exclude?: string[];
		trustedAuthors?: string[];
		own?: boolean;
		glob?: string;
		statusField?: string;
		readyValue?: string;
		requiredLabels?: string[];
		maxItems?: number;
		maxAttempts?: number;
		maxSize?: number;
		maxAgeMs?: number;
		checkout?: string;
	}>;
	id?: string;
	profile: string;
	peers?: never[];
	models?: {
		steward?: ModelDef;
		worker?: ModelDef;
		reviewer?: ModelDef | "auto";
		judge?: ModelDef;
	};
	scope?: {
		repos?: Array<{
			slug: string;
			base?: string;
			merge?: AgentDef["merge"];
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
	notify?: Record<
		string,
		| string[]
		| number
		| {
				channels: string[];
				priority?: string;
				reminders?: {
					afterMinutes?: number;
					everyMinutes?: number;
					max?: number;
				};
		  }
	>;
};
export type MachineCfg = {
	version?: 1;
	checkouts?: { root?: string; overrides?: Record<string, string> };
	orca?: { command?: string };
	name: string;
	approval?: { rpId?: string; origin?: string };
	peers?: never[];
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
		{
			kind: "inbox" | "console" | "desktop" | "command" | "github";
			targetLogin?: string;
			argv?: string[];
		}
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
function checkBind(value: unknown) {
	const bind = (value as { network?: { bind?: unknown } } | null)?.network
		?.bind;
	if (bind !== undefined && bind !== "loopback")
		throw new Error(
			"network.bind must be loopback; other listeners are available from slice 11",
		);
}
export function validateAgent(value: unknown): AgentDef {
	checkBind(value);
	if (!agentValidator(value))
		throw new Error(
			`invalid definition: ${ajv.errorsText(agentValidator.errors)}`,
		);
	const x = value as AgentDef;
	assertProfileName(x.profile);
	const json = JSON.stringify(x);
	if (
		/(^|["'])\s*(\/|~)/.test(json) ||
		/[A-Za-z0-9-]+\.(?:com|net|org|local|ts\.net)(?:["'/]|$)/i.test(json)
	)
		throw new Error("definition path fields must be relative");
	if (
		x.workers?.durable?.maxConcurrent !== undefined &&
		x.workers.durable.maxConcurrent < 1
	)
		throw new Error("maxConcurrent must be positive");
	return x;
}
export function validateMachine(value: unknown): MachineCfg {
	checkBind(value);
	if (!machineValidator(value))
		throw new Error(
			`invalid machine: ${ajv.errorsText(machineValidator.errors)}`,
		);
	const x = value as MachineCfg;
	if (x.network?.bind && x.network.bind !== "loopback")
		throw new Error("network.bind must be loopback");
	return x;
}
export function validateManifest(value: unknown): ProfileManifest {
	if (!manifestValidator(value))
		throw new Error(
			`invalid profile manifest: ${ajv.errorsText(manifestValidator.errors)}`,
		);
	return value as ProfileManifest;
}
