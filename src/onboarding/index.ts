import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAnswers } from "./answers.ts";
import {
	applyPlan,
	type ApplyResult,
	type GithubSetup,
	type ProviderSetup,
} from "./apply.ts";
import { renderDiff } from "./diff.ts";
import {
	githubLine,
	interactiveOnboard,
	profileNames,
	providerLine,
	supportedProviders,
	type OnboardPrompts,
} from "./interactive.ts";
import { createPlan, plannedFiles } from "./plan.ts";
import { checkPrerequisites } from "./prerequisites.ts";
import { onboardingStatePath, type OnboardingState } from "./state.ts";

export type OnboardOptions = {
	yes?: boolean;
	nonInteractive?: boolean;
	answers?: string;
	dryRun?: boolean;
	demo?: boolean;
	root?: string;
	stateFile?: string;
	github?: GithubSetup;
	providers?: ProviderSetup;
	prompts?: OnboardPrompts;
};
export type OnboardResult = {
	output: string;
	state?: OnboardingState;
	pending: string[];
};

function summary(profile: string, result: ApplyResult): string {
	const statuses = new Map(
		result.providers.map((status) => [status.provider, status]),
	);
	const unfinished = [
		...(!result.githubLogin ? ["GitHub authentication"] : []),
		...result.providers
			.filter((status) => status.state === "failed")
			.map((status) => `${status.provider} sign-in`),
		...(!result.providers.some((status) => status.state === "ready")
			? ["a model provider sign-in"]
			: supportedProviders
					.filter((provider) => !statuses.has(provider))
					.map((provider) => `${provider} sign-in (skipped)`)),
	];
	return [
		`Profile ${profile}: ${result.profileCreated ? "created" : "selected"}`,
		githubLine(result),
		...[...new Set([...supportedProviders, ...statuses.keys()])].map(
			(provider) => {
				const status = statuses.get(provider);
				return status ? providerLine(status) : `Provider ${provider}: skipped`;
			},
		),
		...(result.state.completedStages.includes("profile")
			? [
					"Profile ready. Organization and agent stages are not built yet.",
					"Manual setup (docs/operator.md): fill in profile-meta/<profile>.json git identity; write the agent definition and machine.yaml assignments.",
					`durable profile check ${profile}`,
					"Next: durable doctor <agent>",
					"Then: loginctl enable-linger (Linux); durable enable <agent>",
				]
			: []),
		...(unfinished.length
			? [`Run durable onboard to finish ${unfinished.join(", ")}.`]
			: []),
	].join("\n");
}

async function prepare(
	options: OnboardOptions,
): Promise<Awaited<ReturnType<typeof interactiveOnboard>>> {
	if (options.nonInteractive && !options.answers && !options.yes)
		throw Error("--non-interactive requires --answers <file> or --yes");
	if (options.demo)
		return {
			plan: createPlan({
				profile: "demo",
				github: "skip",
				providers: ["faux"],
			}),
		};
	if (options.answers)
		return { plan: createPlan(readAnswers(options.answers)) };
	if (options.yes)
		return {
			plan: createPlan({
				profile: profileNames(options.root)[0] ?? "work",
				github: "skip",
			}),
		};
	// Copy the setup container: hidden pasted tokens must not mutate caller options.
	return interactiveOnboard({ ...options }, options.prompts);
}

export async function onboard(
	options: OnboardOptions = {},
): Promise<OnboardResult> {
	const prepared = await prepare(options);
	const { plan } = prepared;
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
	const result =
		prepared.result ?? (await applyPlan(plan, { ...options, root }));
	if (options.demo)
		return {
			output:
				"Demo profile created in temporary state. No Pi login, pi-secret, device flow, or GitHub client was opened.\nOrganization and agent stages are not built yet; see docs/operator.md for manual setup.",
			state: result.state,
			pending: [],
		};
	const failures = checkPrerequisites(root)
		.filter((check) => !check.ok)
		.map((check) => `Prerequisite: ${check.detail}`);
	return {
		output: [summary(plan.profile, result), ...failures].join("\n"),
		state: result.state,
		pending: result.pending,
	};
}
