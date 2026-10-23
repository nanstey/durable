import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { startApi } from "../api/server.ts";
import { localToken } from "../api/tokens.ts";
import { loadAgent, loadMachine } from "../config/load.ts";
import { loadManifest } from "../config/manifest.ts";
import type { AgentDef, MachineCfg } from "../config/schema.ts";
import { doctor, type Report } from "../identity/doctor.ts";
import { buildAgentEnv } from "../identity/env.ts";
import { resolveProfile } from "../identity/profiles.ts";
import { type Capabilities, detectCapabilities } from "../platform/detect.ts";
import { containmentFor } from "../platform/runtime.ts";
import { audit, logger, setAuditIdentity } from "./audit.ts";
import { agentDir } from "./files.ts";
import { type HarnessConfig, openHarness } from "./harness.ts";
import { queueInbox } from "./inbox.ts";
import { ProcessManager } from "./procs.ts";

export function assignedPort(agent: string, machine = loadMachine()) {
	const index = machine.agents.findIndex(
		(entry) => (typeof entry === "string" ? entry : entry.id) === agent,
	);
	if (index < 0) throw Error("agent is not assigned to this machine");
	const assignment = machine.agents[index];
	return typeof assignment === "object" && assignment.port
		? assignment.port
		: (machine.daemon?.portBase ?? 7330) + index;
}
export async function acquireAgentLock(agent: string) {
	const path = join(agentDir(agent), "lock");
	closeSync(openSync(path, "a", 0o600));
	try {
		return await lockfile.lock(path, { stale: 10000, update: 2000 });
	} catch {
		throw Error(
			"steward already running (a crashed owner's lock expires after 10 seconds)",
		);
	}
}
function requireHealthy(agent: string, report: Report) {
	if (report.ok) return;
	queueInbox(agent, "identity-failure");
	const failed = report.checks.filter((check) => !check.ok);
	for (const check of failed)
		audit(agent, {
			event: "identity-failure",
			check: check.name,
			detail: check.detail,
			fix: check.fix,
		});
	throw Error(
		failed
			.map(
				(check) =>
					`${check.name}: ${check.detail}. Fix: ${check.fix ?? "correct machine configuration"}`,
			)
			.join("\n"),
	);
}
export async function identityProbe(
	processes: Pick<ProcessManager, "launch" | "terminate">,
	argv: string[],
	env: NodeJS.ProcessEnv,
	timeoutMs = 10000,
) {
	const task = `identity-${randomUUID()}`;
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			const fail = () =>
				reject(
					Error(
						"identity probe timed out; check connectivity and profile token",
					),
				);
			void processes.terminate({ task }).then(fail, fail);
		}, timeoutMs);
	});
	try {
		return await Promise.race([
			processes.launch(argv, env, { task, allowWhenDisabled: true }),
			deadline,
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function preflight(
	agent: string,
	definition: AgentDef,
	machine: MachineCfg,
	caps: Capabilities,
	processes: ProcessManager,
) {
	const profile = resolveProfile(definition.profile);
	let env: NodeJS.ProcessEnv;
	try {
		env = buildAgentEnv(profile, "steward", { agent });
	} catch {
		requireHealthy(
			agent,
			doctor(agent, definition, machine, {
				capabilities: caps,
				github: () => {
					throw Error("identity unavailable");
				},
			}),
		);
		throw Error(
			"profile environment unavailable; initialize its manifest and secrets",
		);
	}
	const responses = new Map<string, string>();
	for (const args of [
		["api", "user", "--jq", ".login"],
		["api", "user", "--include"],
		["api", "user/repos?per_page=100", "--jq", "[.[].full_name]"],
	]) {
		try {
			const result = await identityProbe(processes, ["gh", ...args], env);
			if (result.exitCode === 0)
				responses.set(JSON.stringify(args), result.stdout.trim());
		} catch {
			/* The doctor reports missing probe results with non-secret remediation text. */
		}
	}
	setAuditIdentity(
		agent,
		definition.profile,
		loadManifest(profile.manifestFile).github.login,
	);
	return doctor(agent, definition, machine, {
		capabilities: caps,
		github: (args) => {
			const result = responses.get(JSON.stringify(args));
			if (result === undefined) throw Error("identity probe failed");
			return result;
		},
	});
}

type RuntimeDependencies = {
	models?: HarnessConfig["models"];
	extensions?: HarnessConfig["extensions"];
	/** In-process test seam only; neither CLI nor configuration can supply it. */
	preflight?: typeof preflight;
};
export async function run(
	agent: string,
	dependencies: RuntimeDependencies = {},
) {
	const machine = loadMachine(),
		definition = loadAgent(agent);
	const port = assignedPort(agent, machine);
	setAuditIdentity(agent, definition.profile);
	const unlock = await acquireAgentLock(agent);
	let close: (() => Promise<void>) | undefined;
	try {
		const caps = detectCapabilities();
		const processes = new ProcessManager(
			agent,
			containmentFor(caps),
			undefined,
			definition.schedule?.quietHours,
		);
		if (!(await processes.sweep()))
			throw Error(
				"recovery containment unconfirmed; records and recovery fences retained; inspect containment before restart",
			);
		// The journal and hold fences are loaded before Harness.open can resume any task.
		requireHealthy(
			agent,
			await (dependencies.preflight ?? preflight)(
				agent,
				definition,
				machine,
				caps,
				processes,
			),
		);
		const harness = await openHarness({
			agent,
			definition,
			storage: caps.sqlite ? "sqlite" : "jsonl",
			processes,
			models: dependencies.models,
			extensions: dependencies.extensions,
			checkoutFor: (repo) =>
				machine.checkouts?.overrides?.[repo] ??
				(machine.checkouts?.root
					? join(machine.checkouts.root, repo)
					: undefined),
		});
		localToken(agent);
		const server = startApi({
			agent,
			machine: machine.name,
			profile: definition.profile,
			port,
			definition,
			harness,
			bind: definition.network?.bind ?? machine.network?.bind,
		});
		let closing = false;
		const onSignal = () => {
			void close!().then(
				() => process.exit(0),
				() => process.exit(1),
			);
		};
		close = async () => {
			if (closing) return;
			closing = true;
			process.removeListener("SIGTERM", onSignal);
			process.removeListener("SIGINT", onSignal);
			server.close();
			if ("closeAllConnections" in server) server.closeAllConnections();
			await harness.close();
			await processes.terminate();
			audit(agent, { event: "shutdown" });
			await unlock();
		};
		await new Promise<void>((resolve, reject) => {
			server.once("listening", resolve);
			server.once("error", reject);
		});
		process.once("SIGTERM", onSignal);
		process.once("SIGINT", onSignal);
		harness.start();
		audit(agent, { event: "start", profile: definition.profile });
		logger.info({ agent, port }, "steward listening on loopback");
		void harness.native.closed.then((end) => {
			if (!closing && end.reason === "failed") {
				logger.error({ agent }, "harness failed; restart required");
				void close!().finally(() => process.exit(1));
			}
		});
		return { harness, server, close, processes };
	} catch (error) {
		audit(agent, { event: "start-failed" });
		if (close) await close();
		else await unlock();
		throw error;
	}
}
