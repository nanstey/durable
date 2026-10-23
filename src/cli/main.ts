import { defineCommand, runMain, type SubCommandsDef } from "citty";
import {
	createToken,
	listTokens,
	localToken,
	revokeToken,
	type Scope,
} from "../api/tokens.ts";
import { loadMachine } from "../config/load.ts";
import { DurableClient } from "../client/client.ts";
import { attachTui } from "../tui/main.ts";
import { durableHome } from "../config/paths.ts";
import { startConsole } from "../console/main.ts";
import { ensureConsoleConfig } from "../console/registry.ts";
import { ConsoleServiceManager } from "../platform/service/console.ts";
import { SystemdUserServiceManager } from "../platform/service/systemdUser.ts";
import { resumeLocal } from "../steward/killswitch.ts";
import { assignedPort, run } from "../steward/main.ts";
import { doctorCommand, formatDoctor } from "./doctor.ts";
import { notifyCommand } from "./notify.ts";
import { profileCommand } from "./profile.ts";
import { queueCommand } from "./queue.ts";

const agentArg = {
	agent: { type: "positional", description: "Agent assigned to this machine" },
	"dry-run": { type: "boolean", default: false },
} as const;
function selected(value?: string) {
	if (value) return value;
	const assignments = loadMachine().agents;
	if (assignments.length !== 1)
		throw Error("agent required unless exactly one agent is assigned");
	return typeof assignments[0] === "string"
		? assignments[0]
		: assignments[0].id;
}
const subCommands: SubCommandsDef = {};
const remoteArgs = {
	agent: { type: "positional", description: "Agent assigned to this machine" },
	json: { type: "boolean", default: false },
} as const;
function clientFor(agent?: string) {
	const id = selected(agent);
	return new DurableClient(
		`http://127.0.0.1:${assignedPort(id)}`,
		localToken(id),
	);
}
function print(value: unknown, json = false) {
	console.log(JSON.stringify(value, null, json ? 2 : 2));
}
function readCommand(
	name: "queue" | "inbox" | "audit" | "status",
	path: string,
) {
	subCommands[name] = defineCommand({
		meta: { name },
		args: { ...remoteArgs, all: { type: "boolean", default: false } },
		async run({ args }) {
			const suffix = args.all
				? `${path.includes("?") ? "&" : "?"}all=true`
				: "";
			print(await clientFor(args.agent).request(`${path}${suffix}`), args.json);
		},
	});
}
readCommand("queue", "/v1/conversations?tree=true");
readCommand("inbox", "/v1/inbox");
readCommand("audit", "/v1/audit");
readCommand("status", "/v1/device");
subCommands.inbox = defineCommand({
	meta: { name: "inbox" },
	subCommands: {
		ack: defineCommand({
			meta: { name: "ack" },
			args: { ...remoteArgs, id: { type: "positional", required: true } },
			async run({ args }) {
				print(
					await clientFor(args.agent).request(
						`/v1/inbox/${encodeURIComponent(args.id)}/ack`,
						{ method: "POST" },
					),
					args.json,
				);
			},
		}),
	},
});
subCommands.ask = defineCommand({
	meta: { name: "ask" },
	args: { ...remoteArgs, text: { type: "positional", required: true } },
	async run({ args }) {
		const client = clientFor(args.agent);
		const { nodes } = await client.conversations();
		const steward = nodes.find((node) => node.kind === "steward");
		if (!steward) throw Error("steward conversation not found");
		print(await client.message(steward.id, args.text), args.json);
	},
});
subCommands.attach = defineCommand({
	meta: { name: "attach" },
	args: { target: { type: "positional", required: true } },
	async run({ args }) {
		const [agent, conversation] = args.target.split("/", 2);
		await attachTui(clientFor(agent), conversation);
	},
});
subCommands.chat = defineCommand({
	meta: { name: "chat" },
	subCommands: {
		new: defineCommand({
			meta: { name: "new" },
			args: {
				...remoteArgs,
				kind: { type: "string", default: "chat" },
				item: { type: "string" },
				name: { type: "string" },
			},
			async run({ args }) {
				if (args.kind !== "chat" && args.kind !== "scout")
					throw Error("kind must be chat or scout");
				print(
					await clientFor(args.agent).createConversation(args.kind, {
						item: args.item,
						name: args.name,
					}),
					args.json,
				);
			},
		}),
		list: defineCommand({
			meta: { name: "list" },
			args: {
				...remoteArgs,
				kind: { type: "string" },
				item: { type: "string" },
			},
			async run({ args }) {
				const query = new URLSearchParams();
				if (args.kind) query.set("kind", args.kind);
				if (args.item) query.set("item", args.item);
				print(
					await clientFor(args.agent).conversations(
						query.size ? `?${query}` : "",
					),
					args.json,
				);
			},
		}),
		resume: defineCommand({
			meta: { name: "resume" },
			args: {
				...remoteArgs,
				id: { type: "positional", required: true },
				text: { type: "positional", required: true },
				steer: { type: "boolean", default: false },
			},
			async run({ args }) {
				print(
					await clientFor(args.agent).message(
						args.id,
						args.text,
						args.steer ? "steer" : "followUp",
					),
					args.json,
				);
			},
		}),
	},
});
for (const action of ["enable", "disable", "start", "stop", "logs"] as const) {
	subCommands[action] = defineCommand({
		meta: { name: action },
		args: {
			...agentArg,
			...(action === "stop" ? { workers: { type: "boolean" as const } } : {}),
		},
		async run({ args }) {
			if ("workers" in args && args.workers)
				throw Error(
					"worker-only stop requires the worker dispatcher (slice 6); the service was not stopped",
				);
			const agent = selected(args.agent);
			assignedPort(agent);
			if (action === "enable" && !args["dry-run"]) {
				const report = doctorCommand(agent);
				if (!report.ok) throw Error(formatDoctor(report));
			}
			const manager = new SystemdUserServiceManager({
				dryRun: args["dry-run"],
				home: process.env.DURABLE_HOME ? durableHome() : undefined,
			});
			if (action === "logs")
				for await (const line of manager.logs(agent))
					process.stdout.write(line);
			else await manager[action](agent);
		},
	});
}
subCommands.run = defineCommand({
	meta: { name: "run" },
	args: { agent: { type: "positional", required: true } },
	async run({ args }) {
		await run(args.agent);
	},
});
subCommands.steward = defineCommand({
	meta: { name: "steward" },
	subCommands: { run: subCommands.run },
});
subCommands.queue = defineCommand({
	meta: { name: "queue" },
	args: agentArg,
	async run({ args }) {
		console.log(await queueCommand(selected(args.agent), args["dry-run"]));
	},
});
subCommands.pause = defineCommand({
	meta: { name: "pause" },
	args: agentArg,
	async run({ args }) {
		const agent = selected(args.agent);
		const url = `http://127.0.0.1:${assignedPort(agent)}/v1/pause`;
		if (args["dry-run"]) {
			console.log(`POST ${url}`);
			return;
		}
		const result = await fetch(url, {
			method: "POST",
			headers: { authorization: `Bearer ${localToken(agent)}` },
			signal: AbortSignal.timeout(15000),
		});
		if (!result.ok) throw Error("pause failed; inspect daemon status");
		console.log("paused");
	},
});
subCommands.resume = defineCommand({
	meta: { name: "resume" },
	args: agentArg,
	run({ args }) {
		const agent = selected(args.agent);
		assignedPort(agent);
		if (args["dry-run"]) {
			console.log(`resume ${agent} (local TTY only)`);
			return;
		}
		resumeLocal(agent);
		console.log(
			"resumed; global/env kill switches and quiet hours still apply",
		);
	},
});
subCommands.doctor = defineCommand({
	meta: { name: "doctor" },
	args: {
		id: { type: "positional", required: true },
		json: { type: "boolean" },
	},
	run({ args }) {
		const report = doctorCommand(args.id);
		console.log(
			args.json ? JSON.stringify(report, null, 2) : formatDoctor(report),
		);
		process.exitCode = report.ok ? 0 : 1;
	},
});
const profileCommands: SubCommandsDef = {};
for (const action of ["init", "bind-github", "show", "list", "check"])
	profileCommands[action] = defineCommand({
		meta: { name: action },
		args: { name: { type: "positional" }, "dry-run": { type: "boolean" } },
		run({ args }) {
			console.log(
				profileCommand(action, args.name, { dryRun: args["dry-run"] }),
			);
		},
	});
subCommands.profile = defineCommand({
	meta: { name: "profile" },
	subCommands: profileCommands,
});
subCommands.console = defineCommand({
	meta: { name: "console" },
	subCommands: {
		run: defineCommand({
			meta: { name: "run" },
			async run() {
				startConsole();
				await new Promise<void>(() => {});
			},
		}),
		enable: defineCommand({
			meta: { name: "enable" },
			args: { "dry-run": { type: "boolean", default: false } },
			async run({ args }) {
				const config = ensureConsoleConfig();
				if (args["dry-run"]) {
					console.log(`console enable (port ${config.port})`);
					return;
				}
				await new ConsoleServiceManager().enable();
			},
		}),
		disable: defineCommand({
			meta: { name: "disable" },
			async run() {
				await new ConsoleServiceManager().disable();
			},
		}),
		status: defineCommand({
			meta: { name: "status" },
			async run() {
				console.log(await new ConsoleServiceManager().status());
			},
		}),
	},
});
subCommands.notify = defineCommand({
	meta: { name: "notify" },
	args: {
		agent: { type: "string" },
		event: { type: "string" },
		test: { type: "string" },
		status: { type: "boolean" },
		json: { type: "boolean" },
	},
	async run({ args }) {
		await notifyCommand({
			agent: selected(args.agent),
			event: args.event,
			test: args.test,
			status: args.status,
			json: args.json,
		});
	},
});
subCommands.token = defineCommand({
	meta: { name: "token" },
	subCommands: {
		create: defineCommand({
			meta: { name: "create" },
			args: {
				...agentArg,
				client: { type: "string", required: true },
				scopes: { type: "string", required: true },
				expires: { type: "string", default: "90d" },
			},
			run({ args }) {
				if (!/^\d+(?:d)?$/.test(args.expires))
					throw Error("expires must be a positive duration in days, e.g. 90d");
				const agent = selected(args.agent);
				assignedPort(agent);
				if (args["dry-run"]) {
					console.log(`token create ${agent} (prints once)`);
					return;
				}
				console.log(
					createToken(
						agent,
						args.client,
						args.scopes.split(",") as Scope[],
						Number(args.expires.replace(/d$/, "")),
					),
				);
			},
		}),
		list: defineCommand({
			meta: { name: "list" },
			args: agentArg,
			run({ args }) {
				console.log(JSON.stringify(listTokens(selected(args.agent)), null, 2));
			},
		}),
		revoke: defineCommand({
			meta: { name: "revoke" },
			args: { ...agentArg, client: { type: "string", required: true } },
			run({ args }) {
				if (args["dry-run"])
					console.log(`token revoke ${selected(args.agent)} ${args.client}`);
				else revokeToken(selected(args.agent), args.client);
			},
		}),
	},
});
await runMain(
	defineCommand({
		meta: { name: "durable", description: "Profile-isolated durable agents" },
		subCommands,
	}),
);
