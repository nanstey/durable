// JSON Schema is the shared source for runtime validation and published schemas.
const text = { type: "string" };
const positive = { type: "integer", minimum: 1 };
const strings = { type: "array", items: text, uniqueItems: true };
const kind = { enum: ["pi-session", "durable-conversation"] };
function object(properties: Record<string, unknown>, required: string[] = []) {
	return { type: "object", properties, required, additionalProperties: false };
}
const model = object(
	{
		provider: text,
		model: text,
		family: text,
		thinking: { enum: ["off", "minimal", "low", "medium", "high", "xhigh"] },
	},
	["model"],
);
const merge = {
	...object({
		mode: {
			enum: ["human-approval", "auto-when-safe", "never"],
			default: "human-approval",
		},
		shadow: { type: "boolean" },
		tighten: object({
			maxFiles: positive,
			maxChangedLines: positive,
			maxRisk: { enum: ["low", "medium"] },
			authors: strings,
			baseBranches: strings,
			pathAllow: strings,
			pathDeny: strings,
			methods: {
				type: "array",
				items: { enum: ["squash", "merge", "rebase"] },
			},
			requiredChecks: { anyOf: [strings, { const: "github-required" }] },
			requireCrossFamilyReview: { type: "boolean" },
			coolingOffMinutes: { type: "integer", minimum: 0 },
			requireHumanApproval: { type: "boolean" },
		}),
	}),
	default: { mode: "human-approval" },
};
const role = object({ kind });
const roles = { type: "object", additionalProperties: role };
const policySource = {
	...object({ kind: { enum: ["none", "fixture"], default: "none" } }, ["kind"]),
	default: { kind: "none" },
};
export const agentSchema = object(
	{
		version: { const: 1 },
		description: text,
		network: object({ bind: { const: "loopback" } }),
		schedule: object({ pollSeconds: positive, quietHours: text }),
		limits: object({
			maxConcurrentWorkers: positive,
			maxWorkersPerDay: positive,
			maxAttemptsPerItem: positive,
			itemMinutes: positive,
			maxMergesPerDay: positive,
		}),
		sources: {
			type: "array",
			items: object(
				{
					kind: { enum: ["github-issues", "github-prs", "local-files"] },
					repo: {
						type: "string",
						pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
					},
					labels: strings,
					exclude: strings,
					trustedAuthors: strings,
					own: { type: "boolean" },
					glob: text,
					statusField: text,
					readyValue: text,
				},
				["kind", "repo"],
			),
		},
		id: { type: "string", pattern: "^[A-Za-z0-9._-]+$" },
		profile: { type: "string", pattern: "^(?!\\.\\.?$)[A-Za-z0-9._-]+$" },
		peers: { type: "array", maxItems: 0 },
		scope: object({
			repos: {
				type: "array",
				items: object(
					{
						slug: {
							type: "string",
							pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
						},
						policySource,
						base: text,
						merge,
					},
					["slug"],
				),
			},
		}),
		models: object({
			steward: model,
			worker: model,
			reviewer: { anyOf: [model, { const: "auto" }] },
			judge: model,
		}),
		merge,
		chat: object({
			startableKinds: { type: "array", items: { enum: ["chat", "scout"] } },
			maxMessageBytes: { ...positive, default: 1048576 },
			rateLimit: object({ perMinute: positive, perDay: positive }),
		}),
		workers: object({
			dispatcher: { enum: ["orca", "git-process"] },
			kind,
			roles,
			durable: object({
				enabledRoles: strings,
				maxConcurrent: { ...positive, default: 2 },
				skills: strings,
				viewer: { enum: ["on-start", "on-demand", "never"] },
			}),
		}),
		notify: {
			type: "object",
			properties: { staleDays: positive },
			additionalProperties: {
				anyOf: [
					strings,
					object(
						{
							channels: strings,
							priority: { enum: ["low", "normal", "high"] },
							reminders: object({
								afterMinutes: positive,
								everyMinutes: positive,
								max: positive,
							}),
						},
						["channels"],
					),
				],
			},
		},
	},
	["profile"],
);
export const machineSchema = object(
	{
		version: { const: 1 },
		checkouts: object({
			root: text,
			overrides: { type: "object", additionalProperties: text },
		}),
		orca: object({ command: text }),
		name: { type: "string", minLength: 1 },
		agents: {
			type: "array",
			items: {
				anyOf: [
					text,
					object(
						{ id: text, port: { type: "integer", minimum: 1, maximum: 65535 } },
						["id"],
					),
				],
			},
		},
		daemon: object({
			portBase: { type: "integer", minimum: 1, maximum: 65535 },
		}),
		profiles: object({ allowDefault: { type: "boolean" } }),
		platform: object({
			os: { enum: ["linux", "android"] },
			service: { enum: ["systemd-user", "termux-runit"] },
			tailscaleCli: { type: "boolean" },
			allowAutoMerge: { type: "boolean" },
		}),
		network: object({
			bind: { const: "loopback" },
			peerCheck: { enum: ["required", "optional", "off"] },
			tailnetAddress: text,
			allowedPeers: strings,
		}),
		approval: object({
			rpId: text,
			origin: text,
			webauthn: object({ rpId: text, origins: strings }, ["rpId", "origins"]),
		}),
		peers: { type: "array", maxItems: 0 },
		channels: {
			type: "object",
			additionalProperties: object(
				{
					kind: { enum: ["console", "desktop", "command", "github"] },
					targetLogin: text,
					command: text,
					argv: strings,
				},
				["kind"],
			),
		},
		workers: object({
			roles: {
				type: "object",
				additionalProperties: object({ kind, skills: strings }),
			},
		}),
	},
	["name", "agents"],
);
export const manifestSchema = object(
	{
		version: { const: 1 },
		label: text,
		github: object({ host: { const: "github.com" }, login: text }, [
			"host",
			"login",
		]),
		git: object(
			{
				name: text,
				email: { type: "string", pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" },
			},
			["name", "email"],
		),
		providers: strings,
	},
	["version", "label", "github", "git", "providers"],
);
