import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { durableHome } from "../config/paths.ts";

export type OnboardingState = {
	version: 1;
	planHash: string;
	profile: string;
	completedStages: Array<"profile" | "organization" | "agent">;
};

const statePath = () => join(durableHome(), "onboarding", "state.json");

export function loadState(path = statePath()): OnboardingState | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as OnboardingState;
		if (value.version !== 1 || !Array.isArray(value.completedStages))
			throw Error("invalid onboarding state");
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function saveState(state: OnboardingState, path = statePath()): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	chmodSync(dirname(path), 0o700);
	writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}
