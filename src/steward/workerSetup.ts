import { join } from "node:path";
import { ApprovalNonces } from "../approval/nonce.ts";
import { loadManifest } from "../config/manifest.ts";
import { piAgentDir } from "../config/paths.ts";
import type { AgentDef, MachineCfg } from "../config/schema.ts";
import { fencedDispatcher } from "../dispatch/hold.ts";
import { selectDispatcher } from "../dispatch/select.ts";
import { buildAgentEnv } from "../identity/env.ts";
import { createDerivedPiDir } from "../identity/pidir.ts";
import { resolveProfile } from "../identity/profiles.ts";
import { workerToolEnv } from "../identity/workerTools.ts";
import { Notifier } from "../notify/notifier.ts";
import {
	HardenedWorkerGit,
	WorkerGithubCli,
} from "../workers/durable/gitops.ts";
import { type JobSpec, WorkerKindRegistry } from "../workers/kind.ts";
import { PiSessionKind } from "../workers/piSession.ts";
import { WorkerRegistry } from "../workers/registry.ts";
import { agentDir } from "./files.ts";
import { Github } from "./github.ts";
import { disabled } from "./killswitch.ts";
import type { ProcessManager } from "./procs.ts";
import { workItemId } from "./workItems.ts";
import type { WorkRuntimeOptions } from "./workRuntime.ts";

type SetupOptions = {
	agent: string;
	definition: AgentDef;
	machine: MachineCfg;
	processes: ProcessManager;
	orcaAvailable: boolean;
	checkIdentity: () => Promise<void>;
};
export function checkoutFor(machine: MachineCfg, repo: string) {
	return (
		machine.checkouts?.overrides?.[repo] ??
		(machine.checkouts?.root ? join(machine.checkouts.root, repo) : undefined)
	);
}
async function prepareBranch(
	processes: ProcessManager,
	env: NodeJS.ProcessEnv,
	job: JobSpec,
) {
	const git = ["git", "-C", job.workspace.path];
	const invocation = { item: job.item, attemptId: job.id };
	const exists = await processes.launch(
		[...git, "show-ref", "--verify", `refs/heads/${job.workspace.branch}`],
		env,
		invocation,
	);
	const result = await processes.launch(
		[
			...git,
			"switch",
			...(exists.exitCode === 0 ? [] : ["-c"]),
			job.workspace.branch,
		],
		env,
		invocation,
	);
	if (result.exitCode !== 0) throw Error("worker branch could not be selected");
}
function workerIdentity(agent: string, definition: AgentDef) {
	if (!definition.models?.worker) return;
	const profile = resolveProfile(definition.profile);
	const manifest = loadManifest(profile.manifestFile);
	const piDir = join(agentDir(agent), "pi");
	createDerivedPiDir(piDir, piAgentDir(), profile);
	return {
		profile,
		manifest,
		piDir,
		env: workerToolEnv(
			agent,
			definition.profile,
			manifest.github.login,
			buildAgentEnv(profile, "worker", { agent }),
		),
		stewardEnv: buildAgentEnv(profile, "steward", { agent }),
	};
}

/** Production wiring, kept separate from service lifecycle and injectable orchestration. */
export function setupWorkers(options: SetupOptions) {
	const { agent, definition, machine, processes } = options;
	const identity = workerIdentity(agent, definition);
	const dispatcher = fencedDispatcher(
		selectDispatcher({
			definition,
			machine,
			root: join(agentDir(agent), "workspaces"),
			orcaAvailable: options.orcaAvailable,
		}),
		agent,
		(item) => processes.fenced(item),
	);
	const workers = new WorkerRegistry((item) => {
		if (processes.fenced(item) || disabled(agent))
			throw Error("worker fenced or paused");
	});
	const notifier = new Notifier({
		agent,
		definition,
		machine,
		profileLogin: identity?.manifest.github.login,
	});
	const check = async () => {
		if (disabled(agent, definition.schedule?.quietHours))
			throw Error("dispatch paused");
	};
	const kinds = new WorkerKindRegistry();
	kinds.register(
		new PiSessionKind(dispatcher, join(agentDir(agent), "launchers"), {
			check: async (item) => {
				if (processes.fenced(item)) throw Error("item fenced");
				await check();
				await options.checkIdentity();
			},
			prepare: async (job) => {
				if (!identity) throw Error("worker profile unavailable");
				await prepareBranch(processes, identity.stewardEnv, job);
			},
			host: (command, job, start) =>
				processes.host(
					command,
					job.env,
					{ item: job.item, attemptId: job.id },
					start,
				),
		}),
	);
	const work: Omit<WorkRuntimeOptions, "scout"> | undefined = identity
		? {
				agent,
				definition,
				machine,
				durable: {
					verifyIdentity: options.checkIdentity,
					git: new HardenedWorkerGit({
						root: join(agentDir(agent), "git"),
						identity: identity.manifest.git,
						token: identity.stewardEnv.GH_TOKEN!,
						env: identity.stewardEnv,
						processes,
					}),
					github: new WorkerGithubCli({ env: identity.stewardEnv, processes }),
					shellEnv: (job) =>
						buildAgentEnv(identity.profile, "durable-shell", {
							agent,
							item: job.item,
						}),
				},
				dispatcher,
				workers,
				kinds,
				processes,
				login: identity.manifest.github.login,
				github: new Github({
					agent,
					login: identity.manifest.github.login,
					env: identity.stewardEnv,
					processes,
					itemForIssue: (repo, issue) =>
						workItemId({ repo, ref: `${repo}#${issue}` }),
				}),
				env: identity.env,
				piDir: identity.piDir,
				skillsRoot: piAgentDir(),
				checkoutFor: (repo) => checkoutFor(machine, repo),
				check,
				notify: async (event, target) => {
					await notifier.notify({ agent, event, target });
				},
				notifyApproval: async (item, sha) => {
					await notifier.notify({
						agent,
						event: "approval-needed",
						target: item,
						sha,
					});
				},
				issueApproval: async (item, sha) =>
					notifier.approvalNonce(
						item,
						new ApprovalNonces(agent).issue("approve", item, sha),
					),
			}
		: undefined;
	return { dispatcher, workers, notifier, work };
}
