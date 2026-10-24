import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
		"profile: work\ngithub: pending\nproviders: [openrouter]\n",
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
	assert.match(first.output, /pending operator/);
	assert.match(second.output, /pending operator/);
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
	assert.match(result.output, /onboarding state/);
	assert.ok(!existsSync(join(paths.home, "profile-meta", "work.json")));
	assert.ok(!existsSync(paths.state));
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
	assert.ok(existsSync(join(paths.home, "profile-meta", "demo.json")));
});
