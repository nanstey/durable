import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAnswers, validateAnswers } from "../../src/onboarding/answers.ts";
import { onboard } from "../../src/onboarding/index.ts";

function fixture() {
	const home = mkdtempSync(join(tmpdir(), "durable-onboard-"));
	return {
		home,
		state: join(home, "state.json"),
		answers: join(home, "answers.yaml"),
	};
}

test("onboard resumes a pending profile without duplicate manifests or secret state", async () => {
	const paths = fixture();
	writeFileSync(
		paths.answers,
		"profile: work\ngithub: skip\nproviders: [openrouter]\n",
	);
	const first = await onboard({
		nonInteractive: true,
		answers: paths.answers,
		root: paths.home,
		stateFile: paths.state,
	});
	const manifest = join(paths.home, "profile-meta", "work.json");
	assert.ok(existsSync(manifest));
	const before = readFileSync(manifest, "utf8");
	const second = await onboard({
		nonInteractive: true,
		answers: paths.answers,
		root: paths.home,
		stateFile: paths.state,
	});
	assert.equal(readFileSync(manifest, "utf8"), before);
	assert.match(first.output, /Provider openrouter: failed/);
	assert.match(second.output, /Provider openrouter: failed/);
	const state = readFileSync(paths.state, "utf8");
	assert.doesNotMatch(state, /token|secret|credential|openrouter/i);
});

test("non-interactive answers reject credentials before writes", async () => {
	const paths = fixture();
	writeFileSync(paths.answers, "profile: work\ntoken: ghp_not-a-real-token\n");
	await assert.rejects(
		() =>
			onboard({
				nonInteractive: true,
				answers: paths.answers,
				root: paths.home,
				stateFile: paths.state,
			}),
		/credentials|not permitted/,
	);
	assert.ok(!existsSync(join(paths.home, "profile-meta", "work.json")));
	assert.ok(!existsSync(paths.state));
	assert.throws(
		() => validateAnswers({ profile: "work", providers: ["anthropic"] }),
		/Anthropic OAuth/,
	);
	assert.throws(() => readAnswers(paths.answers), /credentials|not permitted/);
});

test("dry run renders every write and does not create profile or state", async () => {
	const paths = fixture();
	const result = await onboard({
		yes: true,
		dryRun: true,
		root: paths.home,
		stateFile: paths.state,
	});
	assert.match(result.output, /profile-meta\/work\.json/);
	assert.match(result.output, /state\.json/);
	assert.ok(!existsSync(join(paths.home, "profile-meta", "work.json")));
	assert.ok(!existsSync(paths.state));
});

test("Anthropic OAuth requires an explicit acknowledgement and failed probes give a repair", async () => {
	const paths = fixture();
	assert.throws(
		() =>
			validateAnswers({
				profile: "work",
				providers: ["anthropic"],
				anthropicOAuth: false,
			}),
		/Anthropic OAuth/,
	);
	writeFileSync(
		paths.answers,
		"profile: work\ngithub: skip\nproviders: [openrouter]\n",
	);
	const result = await onboard({
		nonInteractive: true,
		answers: paths.answers,
		root: paths.home,
		stateFile: paths.state,
	});
	assert.match(
		result.output,
		/Provider openrouter: interactive provider login requires a terminal/,
	);
	assert.doesNotMatch(result.output, /ghp_|sk-|bearer /i);
});

test("every interrupted profile step resumes without duplicate manifests", async () => {
	const paths = fixture();
	for (const answers of [
		"profile: profile-only\ngithub: skip\n",
		"profile: github-pending\ngithub: bind\n",
		"profile: provider-pending\ngithub: skip\nproviders: [openrouter]\n",
	]) {
		writeFileSync(paths.answers, answers);
		const first = await onboard({
			nonInteractive: true,
			answers: paths.answers,
			root: paths.home,
			stateFile: paths.state,
		});
		const second = await onboard({
			nonInteractive: true,
			answers: paths.answers,
			root: paths.home,
			stateFile: paths.state,
		});
		assert.match(first.output, /Next: durable onboard/);
		assert.match(second.output, /Next: durable onboard/);
	}
	for (const profile of ["profile-only", "github-pending", "provider-pending"])
		assert.ok(existsSync(join(paths.home, "profile-meta", `${profile}.json`)));
});

test("GitHub device flow is isolated, writes private profile secrets, and binds identity", async () => {
	const paths = fixture();
	writeFileSync(paths.answers, "profile: work\ngithub: device\n");
	const calls: Array<{ args: string[]; config?: string }> = [];
	const result = await onboard({
		nonInteractive: true,
		answers: paths.answers,
		root: paths.home,
		stateFile: paths.state,
		github: {
			deviceRun: (args, env) => {
				calls.push({ args, config: env.GH_CONFIG_DIR });
				return args[1] === "token" ? "github_pat_fake_token_123456" : "";
			},
			run: (_args, token) => {
				assert.equal(token, "github_pat_fake_token_123456");
				return "octocat";
			},
		},
	});
	const secret = join(paths.home, "secrets", "work.env");
	assert.equal(statSync(secret).mode & 0o777, 0o600);
	assert.match(readFileSync(secret, "utf8"), /GH_TOKEN/);
	assert.match(result.output, /GitHub: bound as octocat/);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].config, calls[1].config);
	assert.ok(!existsSync(calls[0].config ?? ""));
	assert.doesNotMatch(
		readFileSync(paths.state, "utf8"),
		/github_pat_fake_token/,
	);
	assert.doesNotMatch(result.output, /github_pat_fake_token/);
});

test("token-env never accepts literals and skip does not create a secret", async () => {
	assert.throws(
		() =>
			validateAnswers({ profile: "work", github: "ghp_literal_secret_123456" }),
		/credentials|github/,
	);
	const paths = fixture();
	writeFileSync(
		paths.answers,
		"profile: work\ngithub: token-env:GH_FOR_TEST\n",
	);
	const result = await onboard({
		nonInteractive: true,
		answers: paths.answers,
		root: paths.home,
		stateFile: paths.state,
		github: {
			env: { GH_FOR_TEST: "ghp_fake_token_123456" },
			run: () => "octocat",
		},
	});
	assert.match(result.output, /bound as octocat/);
	assert.doesNotMatch(result.output, /ghp_fake_token/);
});

test("provider login is injected, probed, and never leaks credentials", async () => {
	const paths = fixture();
	writeFileSync(
		paths.answers,
		"profile: work\ngithub: skip\nproviders: [openrouter]\n",
	);
	let loginCalls = 0;
	const result = await onboard({
		nonInteractive: true,
		answers: paths.answers,
		root: paths.home,
		stateFile: paths.state,
		providers: {
			login: async (profile, provider) => {
				loginCalls++;
				assert.equal(provider, "openrouter");
				writeFileSync(
					profile.authFile,
					'{"openrouter":{"type":"api_key","key":"sk_fake_provider_secret_123456"}}',
					{ mode: 0o600 },
				);
			},
		},
	});
	assert.equal(loginCalls, 1);
	assert.match(result.output, /Provider openrouter: ready/);
	assert.doesNotMatch(result.output, /sk_fake_provider_secret/);
	assert.doesNotMatch(
		readFileSync(paths.state, "utf8"),
		/sk_fake_provider_secret/,
	);
});

test("demo never opens credential handoffs and uses temporary profile state", async () => {
	const paths = fixture();
	const result = await onboard({
		demo: true,
		root: paths.home,
		stateFile: paths.state,
	});
	assert.match(
		result.output,
		/No Pi login, pi-secret, device flow, or GitHub client/,
	);
	const manifest = readFileSync(
		join(paths.home, "profile-meta", "demo.json"),
		"utf8",
	);
	assert.match(manifest, /"faux"/);
});
