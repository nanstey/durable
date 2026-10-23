import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { piAgentDir } from "../config/paths.ts";
import { assertProfileName } from "../config/schema.ts";
export type ResolvedProfile = {
	name: string;
	authFile: string;
	secretsFile: string;
	manifestFile: string;
	isDefault: boolean;
};
export function resolveProfile(
	name: string,
	root = piAgentDir(),
): ResolvedProfile {
	assertProfileName(name);
	const isDefault = name === "default";
	return {
		name,
		isDefault,
		authFile: isDefault
			? join(root, "auth.json")
			: join(root, "auth-profiles", `${name}.json`),
		secretsFile: join(root, "secrets", `${name}.env`),
		manifestFile: join(root, "profile-meta", `${name}.json`),
	};
}
export function listProviders(profile: ResolvedProfile): string[] {
	if (!existsSync(profile.authFile)) return [];
	let x: Record<string, unknown>;
	try {
		x = JSON.parse(readFileSync(profile.authFile, "utf8")) as Record<
			string,
			unknown
		>;
	} catch {
		throw new Error(
			"invalid or unreadable profile credential file; run Pi /login for this profile",
		);
	}
	if (!x || typeof x !== "object" || Array.isArray(x))
		throw new Error("invalid profile credential object");
	return Object.keys(x).filter(
		(provider) =>
			readStoredCredential(provider, profile.authFile) !== undefined,
	);
}
