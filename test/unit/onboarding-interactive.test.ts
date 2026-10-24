import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { onboard } from "../../src/onboarding/index.ts";
import type { OnboardPrompts } from "../../src/onboarding/interactive.ts";
import type { ProviderLogin } from "../../src/onboarding/providers.ts";

function rig(choices: unknown[]) {
	const root = mkdtempSync(join(tmpdir(), "onboard-ui-"));
	const events: string[] = [];
	const menus: Array<{
		message: string;
		initialValue?: unknown;
		options?: Array<{ value: unknown; label: string }>;
	}> = [];
	const prompt = async (menu: (typeof menus)[number]) => {
		menus.push(menu);
		events.push(menu.message);
		assert.ok(choices.length, `unexpected prompt: ${menu.message}`);
		return choices.shift();
	};
	const prompts = {
		select: prompt as OnboardPrompts["select"],
		text: prompt as OnboardPrompts["text"],
		password: prompt as OnboardPrompts["password"],
		confirm: prompt as OnboardPrompts["confirm"],
		report: (line: string) => events.push(line),
	};
	const login: ProviderLogin = async (profile, provider) => {
		events.push(`LOGIN ${provider}`);
		let auth = {};
		try {
			auth = JSON.parse(readFileSync(profile.authFile, "utf8"));
		} catch {}
		writeFileSync(
			profile.authFile,
			JSON.stringify({
				...auth,
				[provider]: { type: "api_key", key: "fake-key-not-a-credential" },
			}),
		);
	};
	const options = {
		root,
		stateFile: join(root, "state.json"),
		prompts,
		github: {
			deviceRun: (args: string[], env: NodeJS.ProcessEnv) => {
				events.push(`GH ${args[1]}`);
				assert.equal(env.GH_PROMPT_DISABLED, undefined);
				if (args[1] === "login") assert.ok(args.includes("--skip-ssh-key"));
				return args[1] === "token" ? "github_pat_fake_test" : "";
			},
			run: () => {
				events.push("GH probe");
				return "octocat";
			},
		},
		providers: { login },
	};
	return { root, events, menus, choices, options };
}

test("browser and each provider execute before the next question; defaults and numbering are consistent", async () => {
	const r = rig([
		"__custom",
		"work",
		"device",
		"openai-codex",
		"anthropic",
		true,
		"openrouter",
		"done",
	]);
	const result = await onboard(r.options);
	assert.ok(
		r.events.indexOf("GH login") <
			r.events.indexOf("Sign in to a model provider now?"),
	);
	for (const provider of ["openai-codex", "anthropic", "openrouter"]) {
		const i = r.events.indexOf(`LOGIN ${provider}`);
		assert.ok(i > 0);
		assert.equal(r.events[i + 1], `Provider ${provider}: ready`);
		assert.equal(r.events[i + 2], "Sign in to a model provider now?");
	}
	const providerMenus = r.menus.filter((menu) =>
		menu.message.startsWith("Sign in"),
	);
	assert.deepEqual(
		providerMenus.map((menu) => menu.initialValue),
		["openai-codex", "anthropic", "openrouter", "done"],
	);
	for (const menu of r.menus.filter((menu) => menu.options))
		menu.options?.forEach((option, i) => {
			assert.match(option.label, new RegExp(`^${i + 1}\\.`));
		});
	assert.match(result.output, /Profile ready/);
	assert.match(result.output, /Next: durable doctor <agent>/);
	assert.doesNotMatch(
		result.output,
		/Next: durable onboard|fake-key|github_pat/,
	);
	assert.deepEqual(result.state?.completedStages, ["profile"]);
});

test("failed GitHub and provider print exact repairs immediately and in the summary without leaking exceptions", async () => {
	const r = rig(["__custom", "work", "device", "openrouter", "done"]);
	r.options.github.run = () => {
		throw Error("forbidden secret-must-not-leak");
	};
	r.options.providers.login = async () => {
		throw Error("secret-must-not-leak");
	};
	const result = await onboard(r.options);
	assert.match(
		result.output,
		/GitHub: failed\n  Fix: GitHub token lacks required scope/,
	);
	assert.match(
		result.output,
		/Provider openrouter: failed\n  Fix: Provider openrouter: sign-in or credential probe failed/,
	);
	assert.match(
		result.output,
		/finish GitHub authentication, openrouter sign-in/,
	);
	assert.ok(r.events.some((line) => /GitHub: failed\n  Fix:/.test(line)));
	assert.ok(
		r.events.some((line) => /Provider openrouter: failed\n  Fix:/.test(line)),
	);
	assert.doesNotMatch(
		result.output + r.events.join(""),
		/secret-must-not-leak/,
	);
	assert.deepEqual(result.state?.completedStages, []);
});

test("Done and Anthropic refusal are explicit skips, not silent successful completion", async () => {
	const r = rig(["__custom", "work", "skip", "anthropic", false, "done"]);
	const result = await onboard(r.options);
	assert.ok(!r.events.some((line) => line.startsWith("LOGIN")));
	assert.match(result.output, /GitHub: skipped/);
	assert.match(result.output, /Provider anthropic: skipped/);
	assert.match(
		result.output,
		/finish GitHub authentication, a model provider sign-in/,
	);
	assert.deepEqual(result.state?.completedStages, []);
});

test("hidden GitHub paste binds immediately; cancellation stops instead of skipping", async () => {
	const r = rig(["__custom", "work", "paste", "github_pat_fake_test", "done"]);
	const result = await onboard(r.options);
	assert.match(result.output, /GitHub: bound as octocat/);
	assert.ok(
		r.events.indexOf("GH probe") <
			r.events.indexOf("Sign in to a model provider now?"),
	);
	assert.doesNotMatch(result.output, /github_pat/);
	const cancelled = rig([Symbol("cancel")]);
	await assert.rejects(onboard(cancelled.options), /cancelled/);
});

test("configured profiles offer finish, re-verify and replacement; credential deletion is not hidden by saved completion", async () => {
	const r = rig(["__custom", "work", "device", "openrouter", "done"]);
	await onboard(r.options);
	for (const mode of ["finish", "verify", "replace"]) {
		r.events.length = 0;
		r.choices.push(
			"work",
			mode,
			...(mode === "replace" ? ["bind", "openrouter", "done"] : []),
		);
		const result = await onboard(r.options);
		assert.ok(
			r.events.includes(
				"work: GitHub bound as octocat, providers ready: openrouter",
			),
		);
		assert.match(result.output, /GitHub: bound as octocat/);
		assert.equal(r.events.includes("LOGIN openrouter"), mode === "replace");
		assert.equal(r.events.includes("GH probe"), mode !== "finish");
	}
	rmSync(join(r.root, "auth-profiles", "work.json"));
	r.choices.push("work", "bind", "done");
	const result = await onboard(r.options);
	assert.match(result.output, /a model provider sign-in/);
	assert.deepEqual(result.state?.completedStages, []);
});

test("interactive dry run asks only for profile and never opens credential handoffs", async () => {
	const r = rig(["__custom", "work"]);
	const result = await onboard({ ...r.options, dryRun: true });
	assert.match(result.output, /work.json/);
	assert.ok(!r.events.some((line) => /^(GH|LOGIN)/.test(line)));
});
