import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolveProfile } from "../identity/profiles.ts";
import type { OnboardAnswers } from "./answers.ts";

export type OnboardingPlan = {
	stage: "profile";
	profile: string;
	github: "device" | "skip" | "bind" | `token-env:${string}`;
	providers: string[];
	anthropicOAuth: boolean;
	hash: string;
};

export function createPlan(answers: OnboardAnswers): OnboardingPlan {
	const plan = {
		stage: "profile" as const,
		profile: answers.profile,
		github: answers.github ?? "skip",
		providers: [...new Set(answers.providers ?? [])].sort(),
		anthropicOAuth: answers.anthropicOAuth === true,
	};
	return {
		...plan,
		hash: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
	};
}

export type PlannedFile = { path: string; before: string; after: string };

export function plannedFiles(
	plan: OnboardingPlan,
	root?: string,
): PlannedFile[] {
	const profile = resolveProfile(plan.profile, root);
	const before = existsSync(profile.manifestFile)
		? readFileSync(profile.manifestFile, "utf8")
		: "";
	if (before) {
		const manifest = JSON.parse(before) as Record<string, unknown>;
		const providers = Array.isArray(manifest.providers)
			? manifest.providers
			: [];
		if (
			JSON.stringify(providers) === JSON.stringify(plan.providers) ||
			plan.providers.length === 0
		)
			return [];
		manifest.providers = plan.providers;
		return [
			{
				path: profile.manifestFile,
				before,
				after: `${JSON.stringify(manifest, null, 2)}\n`,
			},
		];
	}
	const after = `${JSON.stringify(
		{
			version: 1,
			label: plan.profile,
			github: { host: "github.com", login: "" },
			git: { name: "", email: "operator@example.invalid" },
			providers: plan.providers,
		},
		null,
		2,
	)}\n`;
	return [{ path: profile.manifestFile, before, after }];
}
