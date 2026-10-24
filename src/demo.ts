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
import { openHarness } from "./steward/harness.ts";
import { inboxEvent } from "./steward/inbox.ts";
import { workItemId, type WorkItem } from "./steward/workItems.ts";

const agent = "demo";
const repo = "durable/demo-repository";

async function freePort() {
	const socket = createServer();
	await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
	const address = socket.address();
	if (!address || typeof address === "string")
		throw Error("could not reserve demo port");
	await new Promise<void>((resolve) => socket.close(() => resolve()));
	return address.port;
}

function writeDemoConfig(home: string, apiPort: number, consolePort: number) {
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
		`name: demo-machine\nnetwork:\n  bind: loopback\nagents:\n  - id: ${agent}\n    port: ${apiPort}\n`,
	);
	writeFileSync(
		join(agents, "demo.yaml"),
		`description: Credential-free local sandbox\nprofile: demo\norganization: demo-org\nnetwork:\n  bind: loopback\nmodels:\n  steward:\n    provider: faux\n    model: demo\nconnectors:\n  - id: fake-github\n    provider: fake\n    connection: seeded-issues\n    tools:\n      - id: issues.read\n        access: read\n`,
	);
	writeFileSync(
		join(home, "organizations", "demo-org.yaml"),
		`name: demo-org\nmemberAgents:\n  - demo\nscope:\n  repos:\n    - ${repo}\n`,
	);
	const consoleDir = join(home, "console");
	mkdirSync(consoleDir, { recursive: true, mode: 0o700 });
	writeFileSync(
		join(consoleDir, "console.yaml"),
		`version: 1\nport: ${consolePort}\nallowedUsers: []\npush:\n  enabled: false\n  subject: mailto:demo@example.invalid\n`,
		{ mode: 0o600 },
	);
	return { agents, pi, consoleDir };
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
	const apiPort = await freePort();
	const consolePort = await freePort();
	const paths = writeDemoConfig(home, apiPort, consolePort);
	process.env.DURABLE_HOME = home;
	process.env.DURABLE_AGENTS_DIR = paths.agents;
	process.env.DURABLE_MACHINE_FILE = join(home, "machine.yaml");
	process.env.PI_AGENT_DIR = paths.pi;
	process.env.DURABLE_CONSOLE_DIR = paths.consoleDir;
	const now = Date.now();
	const candidate = {
		ref: `${repo}#42`,
		repo,
		kind: "issue" as const,
		title: "Seeded demo issue",
		author: "demo-operator",
		authorAssociation: "OWNER",
		labels: ["durable-demo"],
		updatedAt: new Date(now).toISOString(),
	};
	const id = workItemId(candidate);
	const item: WorkItem = {
		id,
		intakeRef: candidate.ref,
		repo,
		candidate,
		workerLogin: "demo-operator",
		attempts: [
			{
				id: "fake-worker",
				startedAt: now - 30_000,
				endedAt: now - 20_000,
				cost: 0,
			},
		],
		prs: [
			{
				number: 101,
				url: "https://example.invalid/durable/demo-repository/pull/101",
				headSha: "demo-sha-101",
				primary: true,
				openedAt: now - 20_000,
				state: "open",
			},
		],
		review: {
			sha: "demo-sha-101",
			result: {
				verdict: "approve",
				risk: "low",
				summary: "Fake independent review approved the seeded draft.",
				headSha: "demo-sha-101",
			},
			provenance: {
				provider: "faux",
				model: "reviewer",
				family: "demo-reviewer",
				entries: 1,
				source: "durable-entries",
			},
			reviewedAt: now - 10_000,
		},
		gate: {
			pr: 101,
			sha: "demo-sha-101",
			state: "waiting-approval",
			reasons: ["human-approval-required"],
		},
		stage: "gate",
		createdAt: now - 60_000,
		updatedAt: now,
	};
	const faux = fauxProvider({ provider: "faux", models: [{ id: "demo" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await openHarness({
		agent,
		definition: {
			profile: "demo",
			organization: "demo-org",
			network: { bind: "loopback" },
			models: { steward: { provider: "faux", model: "demo" } },
			scope: { repos: [{ slug: repo }] },
		},
		storage: "jsonl",
		models,
		initial: {
			queue: {
				items: {
					[candidate.ref]: {
						...candidate,
						state: "eligible",
						reasons: ["trusted-author", `work-item:${id}`],
						firstSeen: now - 60_000,
						lastSeen: now,
					},
				},
			},
			work: {
				work: { items: { [id]: item }, byIntakeRef: { [candidate.ref]: id } },
				tasks: {},
			},
			inbox: [
				inboxEvent(
					agent,
					"approval-needed",
					"Fake draft PR #101 awaits your approval.",
					now,
				),
			],
		},
	});
	harness.start();
	const nonces = new ApprovalNonces(agent);
	const approvalCode = nonces.issue("approve", id, "demo-sha-101");
	const token = localToken(agent);
	const api = await startApi({
		agent,
		machine: "demo-machine",
		profile: "demo",
		organization: { id: "demo-org", bundleHash: "demo-seed" },
		port: apiPort,
		bind: "loopback",
		definition: {
			profile: "demo",
			organization: "demo-org",
			network: { bind: "loopback" },
			models: { steward: { provider: "faux", model: "demo" } },
			scope: { repos: [{ slug: repo }] },
		},
		harness,
		nonces,
	});
	saveDevices([
		{
			id: "demo-machine-demo",
			url: `http://127.0.0.1:${apiPort}`,
			token,
			agents: [agent],
		},
	]);
	const consoleServer = startConsole();
	const steward = (await harness.tree()).find(
		(node) => node.kind === "steward",
	);
	console.log(
		`Demo ready. It uses only temporary files and in-process fakes; no real profile or network credential is read.\n\nIn another terminal, run:\nexport DURABLE_HOME=${home}\nexport DURABLE_AGENTS_DIR=${paths.agents}\nexport DURABLE_MACHINE_FILE=${join(home, "machine.yaml")}\nexport PI_AGENT_DIR=${paths.pi}\nexport DURABLE_CONSOLE_DIR=${paths.consoleDir}\n\ndurable status\ndurable queue\ndurable inbox\ndurable attach ${agent}/${steward?.id ?? "<steward-id>"}\ndurable approve ${agent} 101 --code ${approvalCode}\ndurable metrics\ndurable org list\ndurable connectors list\n\nConsole: http://127.0.0.1:${consolePort}\nDemo API token is prepared in the temporary sandbox. Stop with Ctrl-C; the sandbox is removed automatically.`,
	);
	let stopped = false;
	const close = async () => {
		if (stopped) return;
		stopped = true;
		await harness.close();
		api.close();
		consoleServer.close();
		rmSync(home, { recursive: true, force: true });
		for (const [name, value] of Object.entries(environment)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
	return { agent, url: `http://127.0.0.1:${apiPort}`, close };
}
