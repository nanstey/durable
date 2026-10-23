import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { profileCommand } from "../../src/cli/profile.ts";
import { familyFor, tighteningWarnings } from "../../src/config/agent.ts";
import {
	agentSchema,
	machineSchema,
	manifestSchema,
} from "../../src/config/jsonSchemas.ts";
import {
	validateAgent,
	validateMachine,
	validateManifest,
} from "../../src/config/schema.ts";
import { buildAgentEnv, readSecrets } from "../../src/identity/env.ts";
import { githubLogin, runGithub } from "../../src/identity/github.ts";
import {
	createDerivedPiDir,
	derivedAuthSafe,
} from "../../src/identity/pidir.ts";
import { listProviders, resolveProfile } from "../../src/identity/profiles.ts";
import {
	checkRoleSkills,
	effectiveKind,
	requiredSkills,
} from "../../src/identity/skills.ts";
import { detectCapabilities } from "../../src/platform/detect.ts";

function temporary(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "durable-identity-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}
const validManifest = {
	version: 1,
	label: "test",
	github: { host: "github.com", login: "operator" },
	git: { name: "Operator", email: "operator@example.invalid" },
	providers: ["openrouter"],
};
for (const [label, value] of Object.entries({
	unknown: { profile: "work", surprise: true },
	traversal: { profile: ".." },
	slash: { profile: "a/b" },
	missing: {},
	peers: { profile: "work", peers: ["other"] },
	workers: { profile: "work", workers: { kind: "invalid" } },
	durable: { profile: "work", workers: { durable: { maxConcurrent: 0 } } },
	policy: {
		profile: "work",
		scope: { repos: [{ slug: "acme/api", policySource: { kind: "" } }] },
	},
	repo: { profile: "work", scope: { repos: [{ slug: "/absolute" }] } },
	chat: { profile: "work", chat: { startableKinds: ["worker"] } },
	nested: { profile: "work", workers: { durable: { sandbox: true } } },
})) {
	test(`definition rejects ${label}`, () =>
		assert.throws(() => validateAgent(value)));
}
for (const [label, value] of Object.entries({
	unknown: { name: "m", agents: [], surprise: true },
	missing: { name: "m" },
	peers: { name: "m", agents: [], peers: ["remote"] },
	bind: { name: "m", agents: [], network: { bind: "public" } },
	channel: { name: "m", agents: [], channels: { alert: { kind: "ntfy" } } },
	port: { name: "m", agents: [{ id: "a", port: 65536 }] },
	nested: { name: "m", agents: [], profiles: { fallback: true } },
})) {
	test(`machine rejects ${label}`, () =>
		assert.throws(() => validateMachine(value)));
}
for (const [name, schema] of Object.entries({
	agent: agentSchema,
	machine: machineSchema,
	"profile-meta": manifestSchema,
})) {
	test(`${name} schema matches runtime source`, () =>
		assert.deepEqual(
			JSON.parse(readFileSync(`schema/${name}.schema.json`, "utf8")),
			schema,
		));
}
test("definition defaults merge ceiling", () =>
	assert.equal(
		validateAgent({ profile: "work", merge: {} }).merge?.mode,
		"human-approval",
	));
test("manifest rejects unknown properties", () =>
	assert.throws(() =>
		validateManifest({ ...validManifest, secret: "fabricated" }),
	));
test("profile resolution never falls back", (t) => {
	const root = temporary(t);
	writeFileSync(join(root, "auth.json"), "{}");
	assert.equal(existsSync(resolveProfile("missing", root).authFile), false);
});
test("default resolves canonical auth path", (t) => {
	const root = temporary(t);
	assert.equal(
		resolveProfile("default", root).authFile,
		join(root, "auth.json"),
	);
});
test("provider enumeration exposes names only", (t) => {
	const root = temporary(t);
	const p = resolveProfile("work", root);
	mkdirSync(join(root, "auth-profiles"));
	writeFileSync(
		p.authFile,
		JSON.stringify({
			openrouter: { type: "api_key", key: "fabricated-value" },
		}),
	);
	assert.deepEqual(listProviders(p), ["openrouter"]);
});
test("profile init uses private permissions and refuses overwrite", (t) => {
	const root = temporary(t);
	profileCommand("init", "work", { root });
	const p = resolveProfile("work", root);
	assert.equal(lstatSync(p.manifestFile).mode & 0o777, 0o600);
	assert.equal(lstatSync(join(root, "profile-meta")).mode & 0o777, 0o700);
	assert.throws(() => profileCommand("init", "work", { root }));
});
test("profile init dry run has no effect", (t) => {
	const root = temporary(t);
	profileCommand("init", "work", { root, dryRun: true });
	assert.equal(existsSync(join(root, "profile-meta")), false);
});
test("profile list is sorted", (t) => {
	const root = temporary(t);
	for (const name of ["z", "a"]) profileCommand("init", name, { root });
	assert.equal(profileCommand("list", undefined, { root }), "a\nz");
});
test("bind GitHub uses profile token and prints only login", (t) => {
	const root = temporary(t);
	profileCommand("init", "work", { root });
	mkdirSync(join(root, "secrets"));
	writeFileSync(
		resolveProfile("work", root).secretsFile,
		"GH_TOKEN=fabricated-token\n",
	);
	const result = profileCommand("bind-github", "work", {
		root,
		run: (args, token) => {
			assert.deepEqual(args, ["api", "user", "--jq", ".login"]);
			assert.equal(token, "fabricated-token");
			return "operator";
		},
	});
	assert.equal(result, "GitHub login: operator");
});
test("GitHub missing token fails closed", (t) =>
	assert.throws(
		() => githubLogin(resolveProfile("work", temporary(t)), () => "unused"),
		/pi-secret/,
	));
test("GitHub runner is injectable", () =>
	assert.equal(typeof runGithub, "function"));
test("secrets parse export and quoted values", (t) => {
	const path = join(temporary(t), "secrets");
	writeFileSync(path, "# comment\nexport FOO='a=b'\n");
	assert.deepEqual(readSecrets(path), { FOO: "a=b" });
});
test("malformed secrets rejected", (t) => {
	const path = join(temporary(t), "secrets");
	writeFileSync(path, "malformed");
	assert.throws(() => readSecrets(path));
});
for (const shape of ["absent", "empty", "credential", "symlink", "dangling"]) {
	test(`derived auth ${shape}`, (t) => {
		const root = temporary(t);
		const file = join(root, "auth.json");
		if (shape === "empty") writeFileSync(file, "{}");
		if (shape === "credential") writeFileSync(file, '{"openrouter":{}}');
		if (shape === "symlink" || shape === "dangling") {
			const source = join(root, "source");
			if (shape === "symlink") writeFileSync(source, "{}");
			symlinkSync(source, file);
		}
		assert.equal(
			derivedAuthSafe(root),
			shape === "absent" || shape === "empty",
		);
	});
}
test("derived layout links directories, never auth.json", (t) => {
	const root = temporary(t);
	const source = join(root, "source");
	const target = join(root, "target");
	mkdirSync(source);
	createDerivedPiDir(target, source, resolveProfile("work", source));
	assert.equal(lstatSync(join(target, "auth-profiles")).isSymbolicLink(), true);
	assert.equal(existsSync(join(target, "auth.json")), false);
	assert.equal(
		JSON.parse(readFileSync(join(target, "auth-profiles.json"), "utf8"))
			.defaultProfile,
		"work",
	);
});
test("durable shell strips fabricated profile and parent credentials", (t) => {
	const root = temporary(t);
	const prior = process.env.DURABLE_HOME;
	process.env.DURABLE_HOME = root;
	t.after(() => {
		if (prior === undefined) delete process.env.DURABLE_HOME;
		else process.env.DURABLE_HOME = prior;
	});
	const profile = resolveProfile("work", root);
	mkdirSync(join(root, "secrets"));
	const names = [
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"OPENROUTER_API_KEY",
		"ANTHROPIC_API_KEY",
		"FOO_SECRET",
	];
	writeFileSync(
		profile.secretsFile,
		names.map((name) => `${name}=fabricated-${name}`).join("\n"),
	);
	const parent = Object.fromEntries(
		names.map((name) => [name, `parent-${name}`]),
	);
	const env = buildAgentEnv(profile, "durable-shell", {
		agent: "a",
		item: "item",
		parent: {
			...parent,
			PATH: "/bin",
			LC_ALL: "C",
			SSH_AUTH_SOCK: "fabricated-socket",
			UNSAFE: "not-allowlisted",
		},
	});
	const serialized = JSON.stringify(env);
	for (const name of names) assert.equal(serialized.includes(name), false);
	assert.equal(env.UNSAFE, undefined);
	assert.equal(env.LC_ALL, "C");
	assert.equal(env.HOME, env.TMPDIR);
	assert.doesNotMatch(
		readFileSync(env.GIT_CONFIG_GLOBAL as string, "utf8"),
		/helper|insteadOf/,
	);
});
test("env refuses scratch traversal", (t) =>
	assert.throws(() =>
		buildAgentEnv(resolveProfile("work", temporary(t)), "durable-shell", {
			agent: "a",
			item: "../escape",
		}),
	));
test("worker env is allowlisted, not inherited", (t) => {
	const root = temporary(t);
	const prior = process.env.DURABLE_HOME;
	process.env.DURABLE_HOME = root;
	t.after(() => {
		if (prior === undefined) delete process.env.DURABLE_HOME;
		else process.env.DURABLE_HOME = prior;
	});
	profileCommand("init", "work", { root });
	const p = resolveProfile("work", root);
	writeFileSync(p.manifestFile, JSON.stringify(validManifest));
	chmodSync(p.manifestFile, 0o600);
	mkdirSync(join(root, "secrets"));
	writeFileSync(p.secretsFile, "GH_TOKEN=fabricated-token");
	const env = buildAgentEnv(p, "worker", {
		agent: "a",
		parent: { PATH: "/bin", UNKNOWN: "bad", OPENAI_API_KEY: "ambient" },
	});
	assert.equal(env.UNKNOWN, undefined);
	assert.equal(env.OPENAI_API_KEY, undefined);
	assert.equal(env.GITHUB_TOKEN, "fabricated-token");
	assert.match(
		readFileSync(env.GIT_CONFIG_GLOBAL as string, "utf8"),
		/credential/,
	);
});
test("Linux worker skill contract", () =>
	assert.deepEqual(
		requiredSkills({ profile: "work" }, { name: "m", agents: [] }, "worker"),
		["idea-to-pr", "pr", "build"],
	));
test("Android durable role needs no default skills", (t) =>
	assert.equal(
		checkRoleSkills(
			{ profile: "work" },
			{ name: "m", agents: [], platform: { os: "android" } },
			"worker",
			temporary(t),
		).ok,
		true,
	));
test("Pi-session missing skills fails with fix", (t) => {
	const result = checkRoleSkills(
		{ profile: "work" },
		{ name: "m", agents: [] },
		"worker",
		temporary(t),
	);
	assert.equal(result.ok, false);
	assert.match(result.fix, /install the skills repo integration/);
});
test("durable allowlist missing only fails selected pair", (t) => {
	const root = temporary(t);
	const def = {
		profile: "work",
		workers: {
			roles: {
				worker: { kind: "durable-conversation" as const },
				reviewer: { kind: "pi-session" as const },
			},
			durable: { skills: ["custom"] },
		},
	};
	const machine = {
		name: "m",
		agents: [],
		workers: { roles: { reviewer: { skills: [] } } },
	};
	assert.equal(checkRoleSkills(def, machine, "worker", root).ok, false);
	assert.equal(checkRoleSkills(def, machine, "reviewer", root).ok, true);
});
test("machine kind override has precedence", () =>
	assert.equal(
		effectiveKind(
			{ profile: "work", workers: { kind: "durable-conversation" } },
			{
				name: "m",
				agents: [],
				workers: { roles: { worker: { kind: "pi-session" } } },
			},
			"worker",
		),
		"pi-session",
	));
test("platform probes are injectable", () => {
	const caps = detectCapabilities(() => false, {});
	assert.equal(caps.os, "linux");
	assert.equal(caps.gh, false);
	assert.equal(caps.containment, false);
});
test("tighten loosening is advisory and identified per field", () => {
	assert.equal(
		tighteningWarnings(
			{
				maxChangedLines: 100,
				requireHumanApproval: false,
				coolingOffMinutes: 0,
				methods: ["merge"],
			},
			{
				maxChangedLines: 50,
				requireHumanApproval: true,
				coolingOffMinutes: 60,
				methods: ["squash"],
			},
		).length,
		4,
	);
	assert.deepEqual(
		tighteningWarnings(
			{
				maxChangedLines: 25,
				requireHumanApproval: true,
				coolingOffMinutes: 120,
			},
			{
				maxChangedLines: 50,
				requireHumanApproval: true,
				coolingOffMinutes: 60,
			},
		),
		[],
	);
});
test("family inference treats Codex and OpenAI as the same family", () =>
	assert.equal(
		familyFor({ provider: "openai-codex", model: "example" }),
		familyFor({ provider: "openai", model: "example" }),
	));
test("Termux capability detection", () => {
	const caps = detectCapabilities(() => true, { TERMUX_VERSION: "test" });
	assert.equal(caps.os, "android");
	assert.equal(caps.service, "termux-runit");
});
