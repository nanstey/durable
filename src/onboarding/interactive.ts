import { confirm, password, select, text } from "@clack/prompts";
import { existsSync } from "node:fs";
import { profileCommand } from "../cli/profile.ts";
import { loadManifest } from "../config/manifest.ts";
import { readSecrets } from "../identity/env.ts";
import { resolveProfile } from "../identity/profiles.ts";
import type { OnboardAnswers } from "./answers.ts";
import {
	finishProfile,
	probeProvider,
	setupGithub,
	setupProvider,
	type ApplyOptions,
	type ApplyResult,
	type ProviderStatus,
} from "./apply.ts";
import { createPlan, type OnboardingPlan } from "./plan.ts";

export const supportedProviders = ["openai-codex", "anthropic", "openrouter"];
const terminalPrompts = {
	select,
	text,
	password,
	confirm,
	report: (message: string) => console.log(message),
};
export type OnboardPrompts = typeof terminalPrompts;

function chosen(value: unknown): string {
	if (typeof value !== "string") throw Error("onboarding cancelled");
	return value;
}

export function profileNames(root?: string): string[] {
	return profileCommand("list", undefined, { root })
		.split("\n")
		.filter(Boolean);
}

async function chooseProfile(
	ui: OnboardPrompts,
	root?: string,
): Promise<string> {
	const existing = profileNames(root);
	const recommended = existing[0];
	const choice = chosen(
		await ui.select({
			message: `Start a profile (recommended: ${recommended ?? "work"})`,
			options: [
				...existing.map((name, index) => ({
					value: name,
					label: `${index + 1}. ${name}${name === recommended ? " — recommended default" : ""}`,
				})),
				{
					value: "__custom",
					label: `${existing.length + 1}. create a new profile (type a name)`,
				},
			],
			initialValue: recommended ?? "__custom",
		}),
	);
	if (choice !== "__custom") return choice;
	return chosen(
		await ui.text({
			message: "Profile name (letters, digits, . _ -)",
			defaultValue: "work",
			validate: (value) => {
				if (!/^[A-Za-z0-9._-]+$/.test(value ?? ""))
					return "Use letters, digits, '.', '_' or '-'";
				if (existing.includes(value ?? ""))
					return "That profile already exists; select it above";
				return undefined;
			},
		}),
	);
}

async function chooseGithub(
	ui: OnboardPrompts,
	profile: string,
	options: ApplyOptions,
): Promise<OnboardAnswers["github"]> {
	const hasToken = Boolean(
		readSecrets(resolveProfile(profile, options.root).secretsFile).GH_TOKEN,
	);
	const choices = [
		...(hasToken
			? [{ value: "bind", label: "keep stored token and verify — recommended" }]
			: []),
		{
			value: "device",
			label: `${hasToken ? "replace with browser sign-in" : "sign in with your browser — recommended"} (GitHub CLI device flow; repo scope grants broad private-repository access)`,
		},
		{ value: "paste", label: "paste a fine-grained token (hidden)" },
		{ value: "skip", label: "skip for now" },
	];
	const choice = chosen(
		await ui.select({
			message: "GitHub authentication",
			options: choices.map((entry, index) => ({
				...entry,
				label: `${index + 1}. ${entry.label}`,
			})),
			initialValue: choices[0].value,
		}),
	);
	if (choice !== "paste") return choice as OnboardAnswers["github"];
	const token = chosen(
		await ui.password({
			message:
				"Paste GitHub token (hidden; stored only in this profile's secrets file)",
			validate: (value) => (value ? undefined : "A token is required"),
		}),
	);
	options.github = {
		...options.github,
		env: {
			...(options.github?.env ?? process.env),
			DURABLE_ONBOARD_TOKEN: token,
		},
	};
	return "token-env:DURABLE_ONBOARD_TOKEN";
}

export function githubLine(result: {
	githubLogin?: string;
	githubSkipped?: boolean;
	githubFix?: string;
}): string {
	return result.githubLogin
		? `GitHub: bound as ${result.githubLogin}`
		: result.githubSkipped
			? "GitHub: skipped"
			: `GitHub: failed\n  Fix: ${result.githubFix}`;
}
export function providerLine(status: ProviderStatus): string {
	return `Provider ${status.provider}: ${status.state}${status.state === "failed" ? `\n  Fix: ${status.fix}` : ""}`;
}

async function providerMenu(
	ui: OnboardPrompts,
	plan: OnboardingPlan,
	options: ApplyOptions,
	statuses: Map<string, ProviderStatus>,
): Promise<void> {
	while (true) {
		const missing = supportedProviders.find(
			(provider) => statuses.get(provider)?.state !== "ready",
		);
		const choices = supportedProviders.map((name) => ({
			value: name,
			label: `${name} — ${statuses.get(name)?.state === "ready" ? "ready" : "not signed in"}`,
		}));
		choices.sort(
			(a, b) =>
				Number(statuses.get(a.value)?.state === "ready") -
				Number(statuses.get(b.value)?.state === "ready"),
		);
		if (missing) choices.push({ value: "done", label: "Done" });
		else choices.unshift({ value: "done", label: "Done — recommended" });
		const provider = chosen(
			await ui.select({
				message: "Sign in to a model provider now?",
				options: choices.map((choice, index) => ({
					...choice,
					label: `${index + 1}. ${choice.label}`,
				})),
				initialValue: missing ?? "done",
			}),
		);
		if (provider === "done") return;
		if (provider === "anthropic") {
			const acknowledgement = await ui.confirm({
				message:
					"Acknowledge Anthropic OAuth shaping and provider terms risk? (required)",
				initialValue: false,
			});
			if (typeof acknowledgement !== "boolean")
				throw Error("onboarding cancelled");
			if (!acknowledgement) {
				ui.report(
					"Anthropic sign-in skipped: OAuth risk acknowledgement required.",
				);
				continue;
			}
			plan.anthropicOAuth = true;
		}
		const status = await setupProvider(plan, provider, options, true);
		statuses.set(provider, status);
		ui.report(providerLine(status));
	}
}

export async function interactiveOnboard(
	options: ApplyOptions & { dryRun?: boolean },
	ui: OnboardPrompts = terminalPrompts,
): Promise<{ plan: OnboardingPlan; result?: ApplyResult }> {
	const profile = await chooseProfile(ui, options.root);
	let plan = createPlan({ profile, github: "skip" });
	if (options.dryRun) return { plan };
	const resolved = resolveProfile(profile, options.root);
	const existed = existsSync(resolved.manifestFile);
	if (!existed) profileCommand("init", profile, { root: options.root });
	const manifest = loadManifest(resolved.manifestFile);
	const statuses = new Map<string, ProviderStatus>();
	for (const provider of new Set([
		...supportedProviders,
		...manifest.providers,
	])) {
		if (await probeProvider(profile, provider, options.root))
			statuses.set(provider, { provider, state: "ready" });
		else if (manifest.providers.includes(provider))
			statuses.set(provider, {
				provider,
				state: "failed",
				fix: `Provider ${provider}: configured credential is missing or unreadable; run durable onboard and sign in again`,
			});
	}
	let mode = "setup";
	if (
		manifest.github.login &&
		readSecrets(resolved.secretsFile).GH_TOKEN &&
		[...statuses.values()].some((status) => status.state === "ready") &&
		manifest.providers.every(
			(provider) => statuses.get(provider)?.state === "ready",
		)
	) {
		ui.report(
			`${profile}: GitHub bound as ${manifest.github.login}, providers ready: ${[...statuses.keys()].join(", ")}`,
		);
		mode = chosen(
			await ui.select({
				message: "Profile already configured",
				options: [
					{ value: "verify", label: "1. re-verify — recommended" },
					{ value: "replace", label: "2. add/replace a credential" },
					{ value: "finish", label: "3. finish" },
				],
				initialValue: "verify",
			}),
		);
	}
	plan = createPlan({
		profile,
		github:
			mode === "finish" || mode === "verify"
				? "bind"
				: await chooseGithub(ui, profile, options),
	});
	// Authentication is executed before asking about any provider.
	const github =
		mode === "finish"
			? { githubLogin: manifest.github.login }
			: await setupGithub(plan, options);
	ui.report(githubLine(github));
	if (mode !== "finish" && mode !== "verify")
		await providerMenu(ui, plan, options, statuses);
	const providers = [...statuses.values()];
	plan = createPlan({
		profile,
		github: plan.github,
		providers: providers.map((status) => status.provider),
		anthropicOAuth: plan.anthropicOAuth,
	});
	if (plan.providers.length)
		profileCommand("configure-providers", profile, {
			root: options.root,
			providers: [...manifest.providers, ...plan.providers],
		});
	return {
		plan,
		result: finishProfile(plan, options, github, providers, !existed),
	};
}
