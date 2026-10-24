import type { PlannedFile } from "./plan.ts";
import type { OnboardingState } from "./state.ts";

function lines(value: string): string[] {
	return value ? value.trimEnd().split("\n") : [];
}

export function renderDiff(
	files: PlannedFile[],
	state: OnboardingState,
): string {
	const parts = files.map((file) => {
		const before = lines(file.before)
			.map((line) => `-${line}`)
			.join("\n");
		const after = lines(file.after)
			.map((line) => `+${line}`)
			.join("\n");
		return `--- ${file.path}\n+++ ${file.path}\n${before}${before && after ? "\n" : ""}${after}`;
	});
	parts.push(
		`--- onboarding state\n+++ onboarding state\n+${JSON.stringify(state)}`,
	);
	return parts.join("\n");
}
