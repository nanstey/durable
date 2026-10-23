import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import type { AgentDef } from "../../src/config/schema.ts";
import { buildAgentEnv } from "../../src/identity/env.ts";
import { prMarker } from "../../src/steward/github.ts";
import { ProcessManager } from "../../src/steward/procs.ts";
import {
	type DraftPr,
	HardenedWorkerGit,
	type WorkerGithub,
} from "../../src/workers/durable/gitops.ts";
import { WorkerRegistry } from "../../src/workers/registry.ts";
import { fixture, isolate } from "./harness.ts";
import { candidate, workDependencies } from "./work.ts";

/** Fake containment dispatcher: records cancellation and runs real local git/shell, not a Linux scope probe. */
class TestProcesses extends ProcessManager {
	terminations = 0;
	commands: string[][] = [];
	private liveCommands = new Set<AbortController>();
	constructor() {
		super("agent", {
			confirmed: true,
			spawn: () => {
				throw Error("use fake launch");
			},
			kill: async () => true,
			empty: async () => true,
		});
	}
	override async launch(argv: string[], env: NodeJS.ProcessEnv) {
		this.commands.push(argv);
		const controller = new AbortController();
		this.liveCommands.add(controller);
		try {
			const child = execa(argv[0], argv.slice(1), {
				env,
				extendEnv: false,
				reject: false,
				detached: true,
			});
			controller.signal.addEventListener(
				"abort",
				() => {
					try {
						if (child.pid) process.kill(-child.pid, "SIGKILL");
					} catch {
						/* Already exited. */
					}
				},
				{ once: true },
			);
			const result = await child;
			return {
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode ?? 1,
			};
		} finally {
			this.liveCommands.delete(controller);
		}
	}
	override async terminate() {
		this.terminations++;
		for (const controller of this.liveCommands) controller.abort();
		return true;
	}
}

export async function durableRig(
	limits: Record<string, number> = {},
	existingHome?: string,
) {
	const home = existingHome ?? isolate();
	process.env.DURABLE_HOME = home;
	const checkout = join(home, "checkout");
	const remote = join(home, "remote.git");
	mkdirSync(checkout, { recursive: true });
	const git = async (...args: string[]) =>
		(
			await execa("git", args, {
				env: {
					PATH: process.env.PATH,
					HOME: home,
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_SYSTEM: "/dev/null",
				},
				extendEnv: false,
			})
		).stdout.trim();
	if (!existsSync(join(checkout, ".git"))) {
		await git("init", "--bare", remote);
		await git("init", checkout);
		writeFileSync(join(checkout, "file.txt"), "before\n");
		await git("-C", checkout, "add", ".");
		await git(
			"-C",
			checkout,
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-m",
			"initial",
		);
	}
	const deps = workDependencies(home);
	const create = deps.dispatcher.createWorkspace.bind(deps.dispatcher);
	deps.dispatcher.createWorkspace = (spec) =>
		create({ ...spec, path: checkout });
	const processes = new TestProcesses();
	const definition: AgentDef = {
		profile: "fixture",
		scope: { repos: [{ slug: "acme/repo" }] },
		sources: [{ kind: "github-issues", repo: "acme/repo" }],
		workers: {
			kind: "durable-conversation",
			durable: { enabledRoles: ["worker", "reviewer"] },
		},
		schedule: { pollSeconds: 1 },
		limits: { itemMinutes: 60, maxAttemptsPerItem: 2, ...limits },
		models: {
			steward: { provider: "faux", model: "one" },
			worker: { provider: "faux", model: "one" },
		},
	};
	const profile = {
		name: "fixture",
		authFile: join(home, "auth.json"),
		secretsFile: join(home, "secrets.env"),
		manifestFile: join(home, "manifest.json"),
		isDefault: false,
	};
	writeFileSync(
		profile.secretsFile,
		"GH_TOKEN=fixture-token\nGITHUB_TOKEN=fixture-alias\nPROFILE_SECRET=fixture-secret\nANTHROPIC_API_KEY=fixture-provider\nCOMPOSIO_API_KEY=fixture-connector\n",
	);
	let pushes = 0;
	const nativeGit = new HardenedWorkerGit({
		root: join(home, "git"),
		identity: { name: "Manifest Worker", email: "worker@example.invalid" },
		token: "fixture-token",
		env: { PATH: process.env.PATH },
		processes,
		url: () => remote,
	});
	const drafts: DraftPr[] = [];
	const github: WorkerGithub = {
		remoteHead: async (_repo, branch) => {
			const out = await git(
				"--git-dir",
				remote,
				"for-each-ref",
				"--format=%(objectname)",
				`refs/heads/${branch}`,
			);
			return out || undefined;
		},
		findPr: async () => drafts,
		createPr: async (input) => {
			const headSha = (await github.remoteHead(input.repo, input.branch))!;
			const pr = {
				number: drafts.length + 1,
				body: input.body,
				headSha,
				draft: true,
			};
			drafts.push(pr);
			deps.github.open(input.branch);
			return pr;
		},
	};
	const config = {
		definition,
		pollCandidates: async () => [candidate()],
		work: {
			...deps,
			processes,
			agent: "agent",
			login: "operator-login",
			definition,
			machine: { name: "fixture", agents: ["agent"] },
			env: {},
			checkoutFor: () => checkout,
			scout: async () => "Implement the small change.",
			check: async () => {},
			notify: async () => {},
			drainMs: 0,
			durable: {
				prDiff: async () => "diff --git a/file.txt b/file.txt\n",
				shellEnv: () =>
					buildAgentEnv(profile, "durable-shell", {
						agent: "agent",
						item: "item",
					}),
				git: {
					head: nativeGit.head.bind(nativeGit),
					commit: nativeGit.commit.bind(nativeGit),
					push: async (...args: Parameters<typeof nativeGit.push>) => {
						pushes++;
						await nativeGit.push(...args);
					},
				},
				github,
			},
		},
	};
	let current = await fixture(config);
	const items = async () =>
		Object.values((await current.harness.workItems()).items);
	return {
		home,
		checkout,
		remote,
		git,
		config,
		deps,
		processes,
		drafts,
		github,
		nativeGit,
		profile,
		items,
		pushes: () => pushes,
		get harness() {
			return current.harness;
		},
		get faux() {
			return current.faux;
		},
		async restart() {
			await current.harness.close();
			config.work.workers = new WorkerRegistry();
			current = await fixture(config);
			return current;
		},
		marker: (item: string) => prMarker("agent", item),
	};
}
