import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { listProviders, type ResolvedProfile } from "./profiles.ts";

/** Open exactly the selected profile; refresh uses Pi's serialized in-place store. */
export function createModelsFor(
	profile: ResolvedProfile,
	providers: string[] = [],
	variant: "plain" | "anthropicShaped" = "plain",
): Promise<ModelRuntime> {
	if (variant !== "plain") throw new Error("not-configured: anthropicShaped");
	const available = listProviders(profile);
	if (providers.some((provider) => !available.includes(provider)))
		throw new Error(
			`profile ${profile.name} is missing configured providers; run Pi /login`,
		);
	return ModelRuntime.create({
		authPath: profile.authFile,
		modelsPath: null,
		refreshOnCreate: false,
	});
}
