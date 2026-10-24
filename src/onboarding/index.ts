import { confirm, multiselect, password, select, text } from "@clack/prompts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileCommand } from "../cli/profile.ts";
import { readSecrets } from "../identity/env.ts";
import { resolveProfile } from "../identity/profiles.ts";
import { readAnswers, type OnboardAnswers } from "./answers.ts";
import { applyPlan, type GithubSetup } from "./apply.ts";
import { renderDiff } from "./diff.ts";
import { createPlan, plannedFiles } from "./plan.ts";
import { checkPrerequisites, formatPrerequisites } from "./prerequisites.ts";
import { onboardingStatePath, type OnboardingState } from "./state.ts";

const defaults: OnboardAnswers = { profile: "work", github: "skip" };
export type OnboardOptions = {
	yes?: boolean;
	nonInteractive?: boolean;
	answers?: string;
	dryRun?: boolean;
	demo?: boolean;
	root?: string;
	stateFile?: string;
	github?: GithubSetup;
};
export type OnboardResult = {
	output: string;
	state?: OnboardingState;
	pending: string[];
};
type InteractiveResult = { answers: OnboardAnswers; pastedToken?: string };

function profiles(root?: string): string[] {
	const listed = profileCommand("list", undefined, { root });
	return listed ? listed.split("\n") : [];
}

async function interactiveAnswers(root?: string): Promise<InteractiveResult> {
	const existing = profiles(root);
	const recommended = existing[0] ?? "work";
	const choice = await select({
		message: `Start a profile (recommended: ${recommended})`,
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
		initialValue: recommended,
	});
	if (typeof choice !== "string") throw Error("onboarding cancelled");
	let profile = choice;
	if (choice === "__custom") {
		const typed = await text({
			message: "Profile name (letters, digits, . _ -)",
			validate: (value) => {
				if (!/^[A-Za-z0-9._-]+$/.test(value ?? ""))
					return "Use letters, digits, '.', '_' or '-'";
				if (existing.includes(value ?? ""))
					return "That profile already exists; select it above";
				return undefined;
			},
		});
		if (typeof typed !== "string") throw Error("onboarding cancelled");
		profile = typed;
	}
	const hasToken = Boolean(
		readSecrets(resolveProfile(profile, root).secretsFile).GH_TOKEN,
	);
	const github = await select({
		message: "GitHub authentication",
		options: [
			...(hasToken
				? [
						{
							value: "bind",
							label: "1. keep stored token and verify — recommended",
						},
					]
				: []),
			{
				value: "device",
				label: `${hasToken ? "2" : "1"}. ${hasToken ? "replace with browser sign-in" : "sign in with your browser"} (opens after the remaining questions; GitHub CLI device flow; requests repo scope, which grants broad private-repository access)`,
			},
			{
				value: "paste",
				label: `${hasToken ? "3" : "2"}. ${hasToken ? "replace by pasting" : "paste"} a fine-grained token`,
			},
			{ value: "skip", label: `${hasToken ? "4" : "3"}. skip for now` },
		],
		initialValue: hasToken ? "bind" : "device",
	});
	if (!["bind", "device", "paste", "skip"].includes(String(github)))
		throw Error("onboarding cancelled");
	let pastedToken: string | undefined;
	if (github === "paste") {
		const token = await password({
			message:
				"Paste GitHub token (hidden; stored only in this profile's secrets file)",
			validate: (value) => (value ? undefined : "A token is required"),
		});
		if (typeof token !== "string") throw Error("onboarding cancelled");
		pastedToken = token;
	}
	const providers = await multiselect({
		message: "Providers to verify after Pi /login (optional)",
		options: [
			{ value: "openai-codex", label: "1. OpenAI Codex" },
			{ value: "openrouter", label: "2. OpenRouter" },
			{
				value: "anthropic",
				label:
					"3. Anthropic subscription OAuth (terms risk acknowledgement required)",
			},
		],
		required: false,
	});
	if (!Array.isArray(providers)) throw Error("onboarding cancelled");
	const anthropicOAuth = providers.includes("anthropic")
		? await confirm({
				message:
					"Acknowledge Anthropic OAuth shaping and provider terms risk? (required)",
				initialValue: false,
			})
		: false;
	return {
		answers: {
			profile,
			github:
				github === "paste"
					? "token-env:DURABLE_ONBOARD_TOKEN"
					: (github as OnboardAnswers["github"]),
			providers: providers.filter(
				(x) => x !== "anthropic" || anthropicOAuth === true,
			),
			anthropicOAuth: anthropicOAuth === true,
		},
		pastedToken,
	};
}

export async function onboard(
	options: OnboardOptions = {},
): Promise<OnboardResult> {
	if (options.nonInteractive && !options.answers && !options.yes)
		throw Error("--non-interactive requires --answers <file> or --yes");
	let pastedToken: string | undefined;
	let answers = options.answers ? readAnswers(options.answers) : undefined;
	if (options.demo)
		answers = { profile: "demo", github: "skip", providers: ["faux"] };
	else if (!answers && options.yes)
		answers = {
			...defaults,
			profile: profiles(options.root)[0] ?? defaults.profile,
		};
	else if (!answers) {
		const interactive = await interactiveAnswers(options.root);
		answers = interactive.answers;
		pastedToken = interactive.pastedToken;
	}
	const plan = createPlan(answers);
	const root = options.demo
		? (options.root ?? mkdtempSync(join(tmpdir(), "durable-onboard-demo-")))
		: options.root;
	const candidate: OnboardingState = {
		version: 1,
		planHash: plan.hash,
		profile: plan.profile,
		completedStages: options.demo ? ["profile"] : [],
	};
	if (options.dryRun)
		return {
			output: renderDiff(
				plannedFiles(plan, root),
				candidate,
				options.stateFile ?? onboardingStatePath(),
			),
			pending: [],
		};
	if (options.demo) {
		const result = await applyPlan(plan, {
			root,
			stateFile: options.stateFile,
			demo: true,
		});
		return {
			output:
				"Demo profile created in temporary state. No Pi login, pi-secret, device flow, or GitHub client was opened.\nNext stage: organization (reserved).",
			state: result.state,
			pending: [],
		};
	}
	const result = await applyPlan(plan, {
		root,
		stateFile: options.stateFile,
		demo: options.demo,
		github: {
			...options.github,
			env: pastedToken
				? {
						...(options.github?.env ?? process.env),
						DURABLE_ONBOARD_TOKEN: pastedToken,
					}
				: options.github?.env,
		},
	});
	const prerequisites = formatPrerequisites(checkPrerequisites(root));
	const github = result.githubLogin
		? `\nGitHub: bound as ${result.githubLogin.replace("GitHub login: ", "")}`
		: "";
	const status = result.pending.length
		? `Profile ${plan.profile} is pending operator setup.\n${result.pending.join("\n")}\nResume: durable onboard --yes`
		: `Profile ${plan.profile} completed. Next stage: organization (reserved).\nResume: durable onboard --yes`;
	return {
		output: `${prerequisites}\n\n${status}${github}`,
		state: result.state,
		pending: result.pending,
	};
}
