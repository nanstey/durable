import { existsSync } from "node:fs";
import { profileCommand } from "../cli/profile.ts";
import { writeSecret } from "../identity/env.ts";
import {
	githubDeviceToken,
	type GithubDeviceRunner,
	type GithubRunner,
} from "../identity/github.ts";
import { createModelsFor } from "../identity/modelAuth.ts";
import { resolveProfile } from "../identity/profiles.ts";
import type { OnboardingPlan } from "./plan.ts";
import { loadState, saveState, type OnboardingState } from "./state.ts";

export type ApplyResult = {
	state: OnboardingState;
	pending: string[];
	githubLogin?: string;
};
export type GithubSetup = {
	run?: GithubRunner;
	deviceRun?: GithubDeviceRunner;
	env?: NodeJS.ProcessEnv;
};

const tokenPattern = /^(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+$/i;

function githubRepair(profile: string, cause?: unknown): string {
	const message = cause instanceof Error ? cause.message : "";
	if (/scope|resource not accessible|forbidden/i.test(message))
		return `GitHub token lacks required scope; use a fine-grained selected-repository token with the least privileges needed (no Administration or workflow-write), then resume durable onboard`;
	if (/device flow/i.test(message))
		return "GitHub device flow cancelled; retry browser sign-in, paste a token, or skip for now";
	if (/gh is required/i.test(message)) return message;
	return `GitHub probe failed; check the token has access, then run durable profile bind-github ${profile}`;
}

function tokenFromEnvironment(
	choice: `token-env:${string}`,
	env: NodeJS.ProcessEnv,
): string {
	const variable = choice.slice("token-env:".length);
	const token = env[variable];
	if (!token)
		throw Error(`GitHub token environment variable ${variable} is not set`);
	return token;
}

function bindGithub(
	profile: string,
	root: string | undefined,
	run: GithubRunner | undefined,
): string {
	return profileCommand("bind-github", profile, { root, run });
}

/** Applies profile metadata and stores GitHub credentials only in profile secrets. */
export async function applyPlan(
	plan: OnboardingPlan,
	options: {
		root?: string;
		stateFile?: string;
		demo?: boolean;
		github?: GithubSetup;
	} = {},
): Promise<ApplyResult> {
	const state = loadState(options.stateFile);
	if (
		state?.completedStages.includes("profile") &&
		state.planHash === plan.hash
	)
		return { state, pending: [] };
	const profile = resolveProfile(plan.profile, options.root);
	const existed = existsSync(profile.manifestFile);
	if (!existed) profileCommand("init", plan.profile, { root: options.root });
	if (plan.providers.length)
		profileCommand("configure-providers", plan.profile, {
			root: options.root,
			providers: plan.providers,
		});
	if (options.demo) {
		const complete: OnboardingState = {
			version: 1,
			planHash: plan.hash,
			profile: plan.profile,
			completedStages: ["profile"],
		};
		saveState(complete, options.stateFile);
		return { state: complete, pending: [] };
	}

	const pending: string[] = [];
	let githubLogin: string | undefined;
	try {
		let token: string | undefined;
		if (plan.github === "device")
			token = githubDeviceToken(options.github?.deviceRun);
		else if (plan.github.startsWith("token-env:"))
			token = tokenFromEnvironment(
				plan.github as `token-env:${string}`,
				options.github?.env ?? process.env,
			);
		if (token) {
			if (!tokenPattern.test(token))
				throw Error(
					"GitHub token is invalid; paste a fine-grained token or retry browser sign-in",
				);
			writeSecret(profile.secretsFile, "GH_TOKEN", token);
		}
		if (plan.github === "skip")
			pending.push(
				`GitHub: skipped; resume durable onboard after browser sign-in or storing GH_TOKEN for ${plan.profile}`,
			);
		else {
			githubLogin = bindGithub(plan.profile, options.root, options.github?.run);
		}
	} catch (error) {
		pending.push(githubRepair(plan.profile, error));
	}
	for (const provider of plan.providers) {
		try {
			await createModelsFor(profile, [provider]);
		} catch {
			pending.push(
				`Provider ${provider}: select profile ${plan.profile} in Pi and run /login; then resume durable onboard`,
			);
		}
	}
	const next: OnboardingState = {
		version: 1,
		planHash: plan.hash,
		profile: plan.profile,
		completedStages: pending.length ? [] : ["profile"],
	};
	saveState(next, options.stateFile);
	return { state: next, pending, githubLogin };
}
