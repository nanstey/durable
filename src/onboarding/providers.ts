import { password, select } from "@clack/prompts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { ResolvedProfile } from "../identity/profiles.ts";

export type ProviderLogin = (
	profile: ResolvedProfile,
	provider: string,
) => Promise<void>;

function report(event: AuthEvent): void {
	if (event.type === "auth_url") {
		console.log(event.instructions ?? "Open this URL to sign in:");
		console.log(event.url);
	} else if (event.type === "device_code") {
		console.log(
			`Open ${event.verificationUri} and enter code: ${event.userCode}`,
		);
	} else console.log(event.message);
}

async function promptForLogin(prompt: AuthPrompt): Promise<string> {
	if (prompt.type === "select") {
		const value = await select({
			message: prompt.message,
			options: prompt.options.map((option) => ({
				value: option.id,
				label: option.label,
				hint: option.description,
			})),
		});
		if (typeof value !== "string") throw Error("provider login cancelled");
		return value;
	}
	const value = await password({ message: prompt.message });
	if (typeof value !== "string") throw Error("provider login cancelled");
	return value;
}

/** Runs Pi's supported login flow directly against this named profile's auth file. */
export const loginProvider: ProviderLogin = async (profile, provider) => {
	const runtime = await ModelRuntime.create({
		authPath: profile.authFile,
		modelsPath: null,
		refreshOnCreate: false,
	});
	await runtime.login(
		provider,
		provider === "openrouter" ? "api_key" : "oauth",
		{ prompt: promptForLogin, notify: report },
	);
};
