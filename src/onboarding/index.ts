import { confirm, multiselect, select } from "@clack/prompts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAnswers, type OnboardAnswers } from "./answers.ts";
import { applyPlan } from "./apply.ts";
import { renderDiff } from "./diff.ts";
import { createPlan, plannedFiles } from "./plan.ts";
import { onboardingStatePath, type OnboardingState } from "./state.ts";
import { checkPrerequisites, formatPrerequisites } from "./prerequisites.ts";

const defaults: OnboardAnswers = { profile: "work", github: "pending" };

export type OnboardOptions = {
	yes?: boolean;
	nonInteractive?: boolean;
	answers?: string;
	dryRun?: boolean;
	demo?: boolean;
	root?: string;
	stateFile?: string;
};
export type OnboardResult = {
	output: string;
	state?: OnboardingState;
	pending: string[];
};

async function interactiveAnswers(): Promise<OnboardAnswers> {
	const profile = await select({
		message: "Start a profile (recommended: work)",
		options: [
			{ value: "work", label: "1. work — recommended default" },
			{ value: "personal", label: "2. personal" },
		],
		initialValue: "work",
	});
	if (typeof profile !== "string") throw Error("onboarding cancelled");
	const github = await select({
		message: "GitHub identity (recommended: configure later)",
		options: [
			{ value: "pending", label: "1. configure later — recommended default" },
			{ value: "bind", label: "2. bind an already stored pi-secret token" },
		],
		initialValue: "pending",
	});
	if (github !== "pending" && github !== "bind")
		throw Error("onboarding cancelled");
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
	if (anthropicOAuth !== true && providers.includes("anthropic"))
		return {
			profile,
			github,
			providers: providers.filter((x) => x !== "anthropic"),
		};
	return {
		profile,
		github,
		providers,
		anthropicOAuth: anthropicOAuth === true,
	};
}

export async function onboard(
	options: OnboardOptions = {},
): Promise<OnboardResult> {
	if (options.nonInteractive && !options.answers && !options.yes)
		throw Error("--non-interactive requires --answers <file> or --yes");
	let answers = options.answers ? readAnswers(options.answers) : undefined;
	if (options.demo)
		answers = { profile: "demo", github: "pending", providers: ["faux"] };
	else if (!answers && options.yes) answers = defaults;
	if (!answers) answers = await interactiveAnswers();
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
			output: `Demo profile created in temporary state. No Pi login, pi-secret, device flow, or GitHub client was opened.\nNext stage: organization (reserved).`,
			state: { ...result.state, completedStages: ["profile"] },
			pending: [],
		};
	}
	const result = await applyPlan(plan, { root, stateFile: options.stateFile });
	const prerequisites = formatPrerequisites(checkPrerequisites(root));
	const output = `${prerequisites}\n\n${
		result.pending.length
			? `Profile ${plan.profile} is pending operator setup.\n${result.pending.join("\n")}\nResume: durable onboard --yes`
			: `Profile ${plan.profile} completed. Next stage: organization (reserved).\nResume: durable onboard --yes`
	}`;
	return { output, state: result.state, pending: result.pending };
}
