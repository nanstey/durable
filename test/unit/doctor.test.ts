import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { formatDoctor } from "../../src/cli/doctor.ts";
import type { AgentDef, MachineCfg } from "../../src/config/schema.ts";
import { doctor } from "../../src/identity/doctor.ts";
import { resolveProfile } from "../../src/identity/profiles.ts";
import { assertRoleDispatchReady } from "../../src/identity/skills.ts";
import { tokenWarnings } from "../../src/identity/token.ts";
import type { Capabilities } from "../../src/platform/detect.ts";

const capabilities: Capabilities = {
	os: "linux",
	service: "systemd-user",
	serviceAvailable: true,
	tailscaleCli: true,
	sqlite: true,
	orca: true,
	containment: true,
	gh: true,
};
function github(args: string[]) {
	return args.includes("--include")
		? "x-oauth-scopes: read:user"
		: args.some((arg) => arg.startsWith("user/repos"))
			? "[]"
			: "operator";
}
function setup(root: string) {
	for (const dir of ["auth-profiles", "secrets", "profile-meta"])
		mkdirSync(join(root, dir));
	writeFileSync(
		join(root, "auth-profiles/work.json"),
		JSON.stringify({ openrouter: { type: "api_key", key: "fabricated" } }),
	);
	writeFileSync(join(root, "secrets/work.env"), "GH_TOKEN=fabricated");
	writeFileSync(
		join(root, "profile-meta/work.json"),
		JSON.stringify({
			version: 1,
			label: "work",
			github: { host: "github.com", login: "operator" },
			git: { name: "Operator", email: "operator@example.invalid" },
			providers: ["openrouter"],
		}),
	);
}
const cases: Array<
	[string, (d: AgentDef, m: MachineCfg, c: Capabilities, root: string) => void]
> = [
	[
		"machine assignment",
		(_d, m) => {
			m.agents = [];
		},
	],
	[
		"named profile",
		(d) => {
			d.profile = "default";
		},
	],
	[
		"profile",
		(_d, _m, _c, root) => rmSync(join(root, "auth-profiles/work.json")),
	],
	[
		"manifest",
		(_d, _m, _c, root) => rmSync(join(root, "profile-meta/work.json")),
	],
	[
		"providers",
		(_d, _m, _c, root) =>
			writeFileSync(join(root, "auth-profiles/work.json"), "{}"),
	],
	[
		"worker kind",
		(d) => {
			d.workers = {
				kind: "durable-conversation",
				durable: { enabledRoles: [] },
			};
		},
	],
	[
		"platform os",
		(_d, m) => {
			m.platform = { os: "android" };
		},
	],
	[
		"platform service",
		(_d, m) => {
			m.platform = { service: "termux-runit" };
		},
	],
	[
		"platform tailscaleCli",
		(_d, m) => {
			m.platform = { tailscaleCli: false };
		},
	],
	[
		"service",
		(_d, _m, c) => {
			c.serviceAvailable = false;
		},
	],
	[
		"containment",
		(_d, _m, c) => {
			c.containment = false;
		},
	],
	[
		"gh",
		(_d, _m, c) => {
			c.gh = false;
		},
	],
	[
		"peer check",
		(_d, m, c) => {
			m.network = { peerCheck: "required" };
			c.tailscaleCli = false;
		},
	],
	[
		"future configuration",
		(_d, m) => {
			m.approval = { rpId: "localhost" };
		},
	],
	[
		"ports",
		(_d, m) => {
			m.agents = [
				{ id: "a", port: 5000 },
				{ id: "b", port: 5000 },
			];
		},
	],
	[
		"worker skills",
		(_d, m) => {
			m.workers = {};
		},
	],
	[
		"worker default profile",
		(d, m) => {
			d.profile = "default";
			m.profiles = { allowDefault: true };
		},
	],
	[
		"channel absent",
		(d) => {
			d.notify = { escalation: { channels: ["absent"] } };
		},
	],
	[
		"git identity",
		(_d, _m, _c, root) => {
			const path = join(root, "profile-meta/work.json");
			const data = JSON.parse(readFileSync(path, "utf8"));
			data.git.name = "";
			writeFileSync(path, JSON.stringify(data));
		},
	],
	[
		"GitHub login",
		(_d, _m, _c, root) => {
			const path = join(root, "profile-meta/work.json");
			const manifest = JSON.parse(readFileSync(path, "utf8"));
			manifest.github.login = "different";
			writeFileSync(path, JSON.stringify(manifest));
		},
	],
	[
		"derived auth",
		(_d, _m, _c, root) => {
			const dir = join(root, "state/agents/a/pi");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "auth.json"),
				'{"fabricated":{"type":"api_key","key":"fixture"}}',
			);
		},
	],
	[
		"android merge ceiling",
		(d, m) => {
			m.platform = { os: "android" };
			d.merge = { mode: "auto-when-safe" };
		},
	],
	[
		"Android private storage",
		(_d, m, c) => {
			m.platform = { os: "android" };
			c.os = "android";
			c.service = "termux-runit";
		},
	],
	[
		"worker provider",
		(d) => {
			d.models = { worker: { provider: "missing", model: "example" } };
		},
	],
	[
		"reviewer family",
		(d) => {
			d.models = {
				worker: { model: "openrouter/example" },
				reviewer: { model: "openrouter/other" },
			};
		},
	],
];
for (const [name, mutate] of cases) {
	test(`doctor fails ${name}`, (t) => {
		const root = mkdtempSync(join(tmpdir(), "durable-doctor-"));
		const previous = { ...process.env };
		t.after(() => {
			process.env = previous;
			rmSync(root, { recursive: true, force: true });
		});
		process.env.PI_CODING_AGENT_DIR = root;
		process.env.DURABLE_HOME = join(root, "state");
		setup(root);
		const def: AgentDef = {
			profile: "work",
			models: {
				steward: { model: "openrouter/openai/example" },
				worker: { model: "openrouter/openai/example" },
				reviewer: { model: "openrouter/anthropic/example" },
			},
		};
		const machine: MachineCfg = {
			name: "test",
			agents: ["a"],
			network: { bind: "loopback" },
			workers: { roles: { worker: { skills: [] }, reviewer: { skills: [] } } },
		};
		const caps = { ...capabilities };
		assert.equal(
			doctor("a", def, machine, { capabilities: caps, github }).ok,
			true,
		);
		mutate(def, machine, caps, root);
		const report = doctor("a", def, machine, { capabilities: caps, github });
		assert.equal(
			report.checks.find((row) => row.name === name)?.ok,
			false,
			JSON.stringify(report),
		);
		assert.equal(report.ok, false);
	});
}
test("role dispatch fails only the pair requiring unavailable skills", () => {
	const def: AgentDef = {
		profile: "work",
		workers: {
			roles: { worker: { kind: "durable-conversation" } },
			durable: { enabledRoles: ["worker"] },
		},
	};
	const machine: MachineCfg = { name: "test", agents: [] };
	assert.doesNotThrow(() =>
		assertRoleDispatchReady(def, machine, "worker", "missing-fixture"),
	);
	assert.throws(
		() => assertRoleDispatchReady(def, machine, "reviewer", "missing-fixture"),
		/install the skills repo integration/,
	);
});
test("role dispatch refuses durable selection without enablement", () =>
	assert.throws(
		() =>
			assertRoleDispatchReady(
				{ profile: "work", workers: { kind: "durable-conversation" } },
				{ name: "test", agents: [] },
				"worker",
			),
		/role-not-enabled/,
	));
test("token inspection warnings never include token or outside repository names", (t) => {
	const root = mkdtempSync(join(tmpdir(), "durable-token-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	setup(root);
	const p = resolveProfile("work", root);
	writeFileSync(p.secretsFile, "GH_TOKEN=ghp_fabricated");
	const result = tokenWarnings(p, ["acme/api"], (args) =>
		args.includes("--include")
			? "X-OAuth-Scopes: repo, admin:org"
			: '["outside/private"]',
	);
	assert.equal(result.length, 3);
	assert.doesNotMatch(JSON.stringify(result), /fabricated|outside\/private/);
});
test("doctor output includes actionable fix and warnings", () =>
	assert.match(
		formatDoctor({
			ok: false,
			checks: [
				{ name: "test", ok: false, detail: "missing", fix: "install fixture" },
				{ name: "guidance", ok: true, warning: true, detail: "advisory" },
			],
		}),
		/Fix: install fixture\nWARN/,
	));
test("doctor CLI fails closed with JSON for missing config", (t) => {
	const root = mkdtempSync(join(tmpdir(), "durable-cli-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const result = spawnSync(
		process.execPath,
		[
			"--experimental-strip-types",
			resolve("bin/durable.ts"),
			"doctor",
			"missing",
			"--json",
		],
		{
			encoding: "utf8",
			timeout: 10000,
			env: {
				...process.env,
				DURABLE_AGENTS_DIR: root,
				DURABLE_MACHINE_FILE: join(root, "missing.yaml"),
			},
		},
	);
	assert.equal(result.status, 1, result.stderr);
	assert.equal(JSON.parse(result.stdout).ok, false);
});
