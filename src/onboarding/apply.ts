import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { profileCommand } from "../cli/profile.ts";
import { loadManifest } from "../config/manifest.ts";
import { writeSecret } from "../identity/env.ts";
import {
	githubDeviceToken,
	type GithubDeviceRunner,
	type GithubRunner,
} from "../identity/github.ts";
import { createModelsFor } from "../identity/modelAuth.ts";
import { resolveProfile } from "../identity/profiles.ts";
import { loginProvider, type ProviderLogin } from "./providers.ts";
import type { OnboardingPlan } from "./plan.ts";
import { saveState, type OnboardingState } from "./state.ts";

export type ProviderStatus =
	| { provider: string; state: "ready" }
	| { provider: string; state: "failed"; fix: string };
export type GithubStatus = {
	githubLogin?: string;
	githubSkipped?: boolean;
	githubFix?: string;
};
export type ApplyResult = GithubStatus & {
	state: OnboardingState;
	pending: string[];
	providers: ProviderStatus[];
	profileCreated: boolean;
};
export type GithubSetup = {
	run?: GithubRunner;
	deviceRun?: GithubDeviceRunner;
	env?: NodeJS.ProcessEnv;
};
export type ProviderSetup = { login?: ProviderLogin };
export type ApplyOptions = {
	root?: string;
	stateFile?: string;
	demo?: boolean;
	github?: GithubSetup;
	providers?: ProviderSetup;
};
const tokenPattern = /^(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+$/i;

function githubRepair(profile: string, cause: unknown): string {
	const message = cause instanceof Error ? cause.message : "";
	if (/scope|resource not accessible|forbidden/i.test(message))
		return "GitHub token lacks required scope; use a fine-grained selected-repository token with the least privileges needed (no Administration or workflow-write), then resume durable onboard";
	if (/device flow/i.test(message))
		return "GitHub device flow cancelled; retry browser sign-in, paste a token, or skip for now";
	if (/gh is required/i.test(message))
		return "gh is required for browser sign-in; install GitHub CLI and retry";
	if (/environment variable/i.test(message))
		return "GitHub token environment variable is not set; set the named variable and retry";
	return `GitHub probe failed; check the token has access, then run durable profile bind-github ${profile}`;
}

export async function setupGithub(
	plan: OnboardingPlan,
	options: ApplyOptions,
): Promise<GithubStatus> {
	if (plan.github === "skip") return { githubSkipped: true };
	try {
		let token: string | undefined;
		if (plan.github === "device")
			token = githubDeviceToken(options.github?.deviceRun);
		else if (plan.github.startsWith("token-env:")) {
			token = (options.github?.env ?? process.env)[
				plan.github.slice("token-env:".length)
			];
			if (!token) throw Error("token environment variable missing");
		}
		if (token) {
			if (!tokenPattern.test(token)) throw Error("invalid GitHub token");
			writeSecret(
				resolveProfile(plan.profile, options.root).secretsFile,
				"GH_TOKEN",
				token,
			);
		}
		return {
			githubLogin: profileCommand("bind-github", plan.profile, {
				root: options.root,
				run: options.github?.run,
			}).replace("GitHub login: ", ""),
		};
	} catch (error) {
		return { githubFix: githubRepair(plan.profile, error) };
	}
}

export async function probeProvider(
	profile: string,
	provider: string,
	root?: string,
): Promise<boolean> {
	try {
		await createModelsFor(resolveProfile(profile, root), [provider], "plain", {
			allowAnthropicOAuth: true,
		});
		return true;
	} catch {
		return false;
	}
}

export async function setupProvider(
	plan: OnboardingPlan,
	provider: string,
	options: ApplyOptions,
	force = false,
): Promise<ProviderStatus> {
	if (!force && (await probeProvider(plan.profile, provider, options.root)))
		return { provider, state: "ready" };
	const profile = resolveProfile(plan.profile, options.root);
	try {
		if (provider === "anthropic" && !plan.anthropicOAuth)
			throw Error("acknowledgement required");
		if (!options.providers?.login && !process.stdin.isTTY)
			throw Error("terminal required");
		mkdirSync(dirname(profile.authFile), { recursive: true, mode: 0o700 });
		await (options.providers?.login ?? loginProvider)(profile, provider);
		chmodSync(profile.authFile, 0o600);
		if (!(await probeProvider(plan.profile, provider, options.root)))
			throw Error("probe failed");
		return { provider, state: "ready" };
	} catch {
		// Provider/subprocess errors can contain credentials. Emit only our own repair.
		const fix =
			!options.providers?.login && !process.stdin.isTTY
				? `Provider ${provider}: interactive provider login requires a terminal; retry durable onboard in a terminal`
				: `Provider ${provider}: sign-in or credential probe failed; retry durable onboard and sign in again${provider === "anthropic" ? " with the OAuth risk acknowledgement" : ""}`;
		return { provider, state: "failed", fix };
	}
}

export function finishProfile(
	plan: OnboardingPlan,
	options: ApplyOptions,
	github: GithubStatus,
	providers: ProviderStatus[],
	profileCreated: boolean,
): ApplyResult {
	const pending = [
		...(github.githubFix ? [github.githubFix] : []),
		...providers.flatMap((status) =>
			status.state === "failed" ? [status.fix] : [],
		),
	];
	const complete =
		options.demo ||
		(!pending.length &&
			Boolean(github.githubLogin) &&
			providers.some((status) => status.state === "ready"));
	const state: OnboardingState = {
		version: 1,
		planHash: plan.hash,
		profile: plan.profile,
		completedStages: complete ? ["profile"] : [],
	};
	saveState(state, options.stateFile);
	return { ...github, state, pending, providers, profileCreated };
}

/** Apply and re-verify the actual credentials, never infer readiness from saved progress. */
export async function applyPlan(
	plan: OnboardingPlan,
	options: ApplyOptions = {},
): Promise<ApplyResult> {
	const profile = resolveProfile(plan.profile, options.root);
	const existed = existsSync(profile.manifestFile);
	if (!existed) profileCommand("init", plan.profile, { root: options.root });
	if (plan.providers.length) {
		const existing = loadManifest(profile.manifestFile).providers;
		profileCommand("configure-providers", plan.profile, {
			root: options.root,
			providers: [...existing, ...plan.providers],
		});
	}
	if (options.demo) return finishProfile(plan, options, {}, [], !existed);
	const github = await setupGithub(plan, options);
	const providers: ProviderStatus[] = [];
	for (const provider of plan.providers)
		providers.push(await setupProvider(plan, provider, options));
	return finishProfile(plan, options, github, providers, !existed);
}
