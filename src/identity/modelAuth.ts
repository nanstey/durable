import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ResolvedProfile } from "./profiles.ts";
export function createModelsFor(
	profile: ResolvedProfile,
	variant: "plain" | "anthropicShaped" = "plain",
) {
	if (variant !== "plain") throw new Error("not-configured: anthropicShaped");
	return ModelRuntime.create({ authPath: profile.authFile });
}
export function configureModel<T extends { configure: (x: unknown) => T }>(
	conversation: T,
	agent: unknown,
): T {
	return conversation.configure({ agent });
}
