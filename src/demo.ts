import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ApprovalNonces } from "./approval/nonce.ts";
import { startApi } from "./api/server.ts";
import { localToken } from "./api/tokens.ts";
import { startConsole } from "./console/main.ts";
import { saveDevices } from "./console/registry.ts";
import { pauseOrganization } from "./steward/killswitch.ts";
import { openHarness } from "./steward/harness.ts";
import { inboxEvent } from "./steward/inbox.ts";
import { workItemId, type WorkItem } from "./steward/workItems.ts";

const repo = "durable/demo-repository";

type DemoAgent = {
	agent: string;
	organization: "acme-platform" | "side-projects" | "oss-maintenance";
	status: "running" | "idle" | "waiting-followup" | "held" | "done" | "error";
	gate: "waiting-approval" | "approved" | "wait-human";
	paused?: boolean;
};

const demoAgents: DemoAgent[] = [
	{
		agent: "acme-dispatch",
		organization: "acme-platform",
		status: "running",
		gate: "waiting-approval",
	},
	{
		agent: "acme-quality",
		organization: "acme-platform",
		status: "done",
		gate: "approved",
	},
	{
		agent: "side-lab",
		organization: "side-projects",
		status: "waiting-followup",
		gate: "wait-human",
		paused: true,
	},
	{
		agent: "side-research",
		organization: "side-projects",
		status: "held",
		gate: "approved",
	},
	{
		agent: "oss-triage",
		organization: "oss-maintenance",
		status: "error",
		gate: "waiting-approval",
	},
];

async function freePort() {
	const socket = createServer();
	await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
	const address = socket.address();
	if (!address || typeof address === "string")
		throw Error("could not reserve demo port");
	await new Promise<void>((resolve) => socket.close(() => resolve()));
	return address.port;
}

function definition(agent: DemoAgent) {
	return {
		profile: "demo",
		organization: agent.organization,
		network: { bind: "loopback" as const },
		models: { steward: { provider: "faux", model: "demo" } },
		scope: { repos: [{ slug: repo }] },
	};
}

function writeDemoConfig(
	home: string,
	assignments: Array<DemoAgent & { port: number }>,
	consolePort: number,
) {
	const agents = join(home, "agents");
	const pi = join(home, "pi-agent");
	mkdirSync(agents, { recursive: true, mode: 0o700 });
	mkdirSync(join(pi, "profile-meta"), { recursive: true, mode: 0o700 });
	mkdirSync(join(pi, "auth-profiles"), { recursive: true, mode: 0o700 });
	mkdirSync(join(pi, "secrets"), { recursive: true, mode: 0o700 });
	mkdirSync(join(home, "organizations"), { recursive: true, mode: 0o700 });
	writeFileSync(join(pi, "auth-profiles", "demo.json"), "{}\n", {
		mode: 0o600,
	});
	writeFileSync(
		join(pi, "secrets", "demo.env"),
		"# No credentials: demo uses only in-process fakes.\n",
		{ mode: 0o600 },
	);
	writeFileSync(
		join(pi, "profile-meta", "demo.json"),
		`${JSON.stringify({ version: 1, label: "Credential-free demo", github: { host: "example.invalid", login: "demo-operator" }, git: { name: "Demo Operator", email: "demo@example.invalid" }, providers: [] })}\n`,
		{ mode: 0o600 },
	);
	writeFileSync(
		join(home, "machine.yaml"),
		`name: demo-machine\nnetwork:\n  bind: loopback\nagents:\n${assignments.map(({ agent, port }) => `  - id: ${agent}\n    port: ${port}\n`).join("")}`,
	);
	for (const entry of assignments) {
		writeFileSync(
			join(agents, `${entry.agent}.yaml`),
			`description: Credential-free local sandbox (${entry.status})\nprofile: demo\norganization: ${entry.organization}\nnetwork:\n  bind: loopback\nmodels:\n  steward:\n    provider: faux\n    model: demo\nconnectors:\n  - id: fake-github\n    provider: fake\n    connection: seeded-issues\n    tools:\n      - id: issues.read\n        access: read\n`,
		);
	}
	for (const organization of new Set(
		assignments.map((entry) => entry.organization),
	)) {
		const members = assignments
			.filter((entry) => entry.organization === organization)
			.map((entry) => `  - ${entry.agent}`)
			.join("\n");
		writeFileSync(
			join(home, "organizations", `${organization}.yaml`),
			`name: ${organization}\nmemberAgents:\n${members}\nscope:\n  repos:\n    - ${repo}\n`,
		);
	}
	const consoleDir = join(home, "console");
	mkdirSync(consoleDir, { recursive: true, mode: 0o700 });
	writeFileSync(
		join(consoleDir, "console.yaml"),
		`version: 1\nport: ${consolePort}\nallowedUsers: []\npush:\n  enabled: false\n  subject: mailto:demo@example.invalid\n`,
		{ mode: 0o600 },
	);
	return { agents, pi, consoleDir };
}

function seededWork(agent: DemoAgent, now: number): WorkItem {
	const index = demoAgents.findIndex((entry) => entry.agent === agent.agent);
	const candidate = {
		ref: `${repo}#${42 + index}`,
		repo,
		kind: "issue" as const,
		title: `Seeded ${agent.status} demo issue`,
		author: "demo-operator",
		authorAssociation: "OWNER",
		labels: ["durable-demo", agent.status],
		updatedAt: new Date(now).toISOString(),
	};
	const id = workItemId(candidate);
	const sha = `demo-sha-${agent.agent}`;
	const item: WorkItem = {
		id,
		intakeRef: candidate.ref,
		repo,
		candidate,
		workerLogin: "demo-operator",
		attempts: [
			{
				id: `fake-worker-${agent.agent}`,
				startedAt: now - 30_000,
				...(agent.status === "running" ? {} : { endedAt: now - 20_000 }),
				cost: 0,
				...(agent.status === "held" ? { outcome: "held" as const } : {}),
			},
		],
		prs: [
			{
				number: 101 + index,
				url: `https://example.invalid/durable/demo-repository/pull/${101 + index}`,
				headSha: sha,
				primary: true,
				openedAt: now - 20_000,
				state: agent.status === "done" ? "merged" : "open",
			},
		],
		...(agent.status === "error"
			? {
					review: {
						sha,
						failed: true as const,
						reason: "Seeded reviewer error",
					},
				}
			: {
					review: {
						sha,
						result: {
							verdict: "approve" as const,
							risk: "low" as const,
							summary: "Fake independent review approved the seeded draft.",
							headSha: sha,
						},
						provenance: {
							provider: "faux",
							model: "reviewer",
							family: "demo-reviewer",
							entries: 1,
							source: "durable-entries" as const,
						},
						reviewedAt: now - 10_000,
					},
				}),
		gate: {
			pr: 101 + index,
			sha,
			state: agent.gate,
			reasons: [
				agent.gate === "waiting-approval"
					? "human-approval-required"
					: "seeded-demo-state",
			],
		},
		...(agent.status === "held" ? { outcome: "held" as const } : {}),
		...(agent.status === "done" ? { outcome: "merged" as const } : {}),
		stage: "gate",
		createdAt: now - 60_000,
		updatedAt: now,
	};
	return item;
}

export async function runDemo() {
	const environment = Object.fromEntries(
		[
			"DURABLE_HOME",
			"DURABLE_AGENTS_DIR",
			"DURABLE_MACHINE_FILE",
			"PI_AGENT_DIR",
			"DURABLE_CONSOLE_DIR",
		].map((name) => [name, process.env[name]]),
	);
	const home = mkdtempSync(join(tmpdir(), "durable-demo-"));
	const assignments = await Promise.all(
		demoAgents.map(async (entry) => ({ ...entry, port: await freePort() })),
	);
	const consolePort = await freePort();
	const offlinePort = await freePort();
	const paths = writeDemoConfig(home, assignments, consolePort);
	process.env.DURABLE_HOME = home;
	process.env.DURABLE_AGENTS_DIR = paths.agents;
	process.env.DURABLE_MACHINE_FILE = join(home, "machine.yaml");
	process.env.PI_AGENT_DIR = paths.pi;
	process.env.DURABLE_CONSOLE_DIR = paths.consoleDir;
	pauseOrganization("side-projects");
	for (const entry of assignments.filter((candidate) => candidate.paused)) {
		mkdirSync(join(paths.agents, entry.agent), {
			recursive: true,
			mode: 0o700,
		});
		writeFileSync(join(paths.agents, entry.agent, "disabled"), "paused\n", {
			mode: 0o600,
		});
	}
	const now = Date.now();
	const running = [] as Array<{
		entry: DemoAgent & { port: number };
		harness: Awaited<ReturnType<typeof openHarness>>;
		api: Awaited<ReturnType<typeof startApi>>;
		nonces: ApprovalNonces;
		item: WorkItem;
	}>;
	for (const entry of assignments) {
		const item = seededWork(entry, now);
		const faux = fauxProvider({ provider: "faux", models: [{ id: "demo" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const harness = await openHarness({
			agent: entry.agent,
			definition: definition(entry),
			storage: "jsonl",
			models,
			initial: {
				queue: {
					items: {
						[item.intakeRef]: {
							...item.candidate,
							state: "eligible",
							reasons: ["trusted-author", `work-item:${item.id}`],
							firstSeen: now - 60_000,
							lastSeen: now,
						},
					},
				},
				work: {
					work: {
						items: { [item.id]: item },
						byIntakeRef: { [item.intakeRef]: item.id },
					},
					tasks: {},
				},
				inbox: [
					inboxEvent(
						entry.agent,
						entry.status,
						`Seeded ${entry.status} demo work item.`,
						now,
					),
				],
				conversations: [
					{ kind: "worker-durable", item: item.id },
					{ kind: "reviewer-durable", item: item.id },
				],
			},
		});
		harness.start();
		await harness.create("chat", `demo-chat-${entry.agent}`);
		await harness.create("scout", `demo-scout-${entry.agent}`, item.id);
		const nonces = new ApprovalNonces(entry.agent);
		const api = await startApi({
			agent: entry.agent,
			machine: "demo-machine",
			profile: "demo",
			organization: { id: entry.organization, bundleHash: "demo-seed" },
			port: entry.port,
			bind: "loopback",
			definition: definition(entry),
			harness,
			nonces,
		});
		running.push({ entry, harness, api, nonces, item });
	}
	saveDevices([
		...running.map(({ entry }) => ({
			id: entry.agent,
			url: `http://127.0.0.1:${entry.port}`,
			token: localToken(entry.agent),
			agents: [entry.agent],
		})),
		{
			id: "offline",
			url: `http://127.0.0.1:${offlinePort}`,
			token: localToken("offline"),
			agents: ["offline"],
		},
	]);
	const consoleServer = startConsole();
	const attachmentInstructions = (
		await Promise.all(
			running.map(async ({ entry, harness }) => {
				const steward = (await harness.tree()).find(
					(node) => node.kind === "steward",
				);
				return `durable attach ${entry.agent}/${steward?.id ?? "<steward-id>"}`;
			}),
		)
	).join("\n");
	const approvalInstructions = running
		.filter(({ entry }) => entry.gate === "waiting-approval")
		.map(({ entry, nonces, item }) => {
			const pr = item.prs[0].number;
			const code = nonces.issue("approve", item.id, item.gate?.sha ?? "");
			return `durable approve ${entry.agent} ${pr} --code ${code}`;
		})
		.join("\n");
	console.log(
		`Demo ready. It uses only temporary files and in-process fakes; no real profile or network credential is read.\n\nIn another terminal, run:\nexport DURABLE_HOME=${home}\nexport DURABLE_AGENTS_DIR=${paths.agents}\nexport DURABLE_MACHINE_FILE=${join(home, "machine.yaml")}\nexport PI_AGENT_DIR=${paths.pi}\nexport DURABLE_CONSOLE_DIR=${paths.consoleDir}\n\ndurable status --agent acme-dispatch\ndurable status --agent acme-quality\ndurable status --agent side-lab\ndurable status --agent side-research\ndurable status --agent oss-triage\ndurable queue --agent acme-dispatch\ndurable inbox --agent side-lab\n\nAttach to each seeded steward:\n${attachmentInstructions}\n\nApproval codes (one per pending gate):\n${approvalInstructions}\n\ndurable metrics --agent oss-triage\ndurable org list\ndurable connectors list --agent acme-dispatch\n\nConsole: http://127.0.0.1:${consolePort}\nThe console includes five online agents across three organizations and one deliberately offline device. side-projects is organization-paused (and side-lab is individually paused). Demo API tokens are prepared in the temporary sandbox. Stop with Ctrl-C; the sandbox is removed automatically.`,
	);
	let stopped = false;
	const close = async () => {
		if (stopped) return;
		stopped = true;
		await Promise.all(running.map(({ harness }) => harness.close()));
		for (const { api } of running) api.close();
		consoleServer.close();
		rmSync(home, { recursive: true, force: true });
		for (const [name, value] of Object.entries(environment)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
	const first = running[0];
	return {
		agent: first.entry.agent,
		url: `http://127.0.0.1:${first.entry.port}`,
		close,
	};
}
