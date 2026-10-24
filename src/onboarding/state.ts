import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { durableHome } from "../config/paths.ts";

export type OnboardingState = {
	version: 1;
	planHash: string;
	profile: string;
	completedStages: Array<"profile" | "organization" | "agent">;
};

export const onboardingStatePath = () =>
	join(durableHome(), "onboarding", "state.json");

export function saveState(
	state: OnboardingState,
	path = onboardingStatePath(),
): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	chmodSync(dirname(path), 0o700);
	writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}
