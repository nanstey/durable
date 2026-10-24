import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolveProfile } from "../identity/profiles.ts";
import type { OnboardAnswers } from "./answers.ts";

export type OnboardingPlan = {
	stage: "profile";
	profile: string;
	github: "pending" | "bind";
	providers: string[];
	anthropicOAuth: boolean;
	hash: string;
};

export function createPlan(answers: OnboardAnswers): OnboardingPlan {
	const plan = {
		stage: "profile" as const,
		profile: answers.profile,
		github: answers.github ?? "pending",
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
	if (existsSync(profile.manifestFile)) return [];
	const after = `${JSON.stringify(
		{
			version: 1,
			label: plan.profile,
			github: { host: "github.com", login: "" },
			git: { name: "", email: "operator@example.invalid" },
			providers: [],
		},
		null,
		2,
	)}\n`;
	return [
		{
			path: profile.manifestFile,
			before: existsSync(profile.manifestFile)
				? readFileSync(profile.manifestFile, "utf8")
				: "",
			after,
		},
	];
}
