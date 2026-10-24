import { existsSync } from "node:fs";
import { profileCommand } from "../cli/profile.ts";
import { createModelsFor } from "../identity/modelAuth.ts";
import { resolveProfile } from "../identity/profiles.ts";
import type { OnboardingPlan } from "./plan.ts";
import { supportsDeviceFlow } from "./prerequisites.ts";
import { loadState, saveState, type OnboardingState } from "./state.ts";

function githubRepair(profile: string): string {
	const manual = `GitHub: use a fine-grained selected-repository token (least privilege; no Administration or workflow-write), then run pi-secret -p ${profile} set GH_TOKEN and durable profile bind-github ${profile}`;
	return supportsDeviceFlow()
		? `${manual}. gh supports device flow; complete that handoff before pi-secret.`
		: `${manual}. gh has no supported device-flow handoff; use the manual pi-secret step.`;
}

export type ApplyResult = { state: OnboardingState; pending: string[] };

/** Applies only non-secret profile metadata; credential handoffs stay with Pi/pi-secret. */
export async function applyPlan(
	plan: OnboardingPlan,
	options: { root?: string; stateFile?: string; demo?: boolean } = {},
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
	// Keep provider intent in the existing non-secret profile manifest rather than state.
	if (plan.providers.length)
		profileCommand("configure-providers", plan.profile, {
			root: options.root,
			providers: plan.providers,
		});
	const pending: string[] = [];
	if (options.demo) {
		const complete: OnboardingState = {
			version: 1,
			planHash: plan.hash,
			profile: plan.profile,
			completedStages: ["profile"],
		};
		saveState(complete, options.stateFile);
		return { state: complete, pending };
	}
	if (existed && plan.github === "pending" && plan.providers.length === 0) {
		try {
			profileCommand("check", plan.profile, { root: options.root });
			const complete: OnboardingState = {
				version: 1,
				planHash: plan.hash,
				profile: plan.profile,
				completedStages: ["profile"],
			};
			saveState(complete, options.stateFile);
			return { state: complete, pending: [] };
		} catch {
			// The explicit handoffs below supply the exact repair without credential output.
		}
	}
	if (plan.github === "bind") {
		try {
			profileCommand("bind-github", plan.profile, { root: options.root });
		} catch {
			pending.push(githubRepair(plan.profile));
		}
	} else {
		pending.push(githubRepair(plan.profile));
	}
	for (const provider of plan.providers) {
		try {
			// ModelRuntime creation is a bounded credential/provider probe and never exposes it.
			await createModelsFor(profile, [provider]);
		} catch {
			pending.push(
				`Provider ${provider}: select profile ${plan.profile} in Pi and run /login; then resume durable onboard`,
			);
		}
	}
	if (pending.length === 0) {
		try {
			profileCommand("check", plan.profile, { root: options.root });
		} catch {
			pending.push(
				`Profile ${plan.profile}: complete manifest identity and run durable profile check ${plan.profile}`,
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
	return { state: next, pending };
}
