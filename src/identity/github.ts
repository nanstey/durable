import { execaSync } from "execa";
import { readSecrets } from "./env.ts";
import type { ResolvedProfile } from "./profiles.ts";

export type GithubRunner = (args: string[], token: string) => string;
export const runGithub: GithubRunner = (args, token) => {
	const result = execaSync("gh", args, {
		reject: false,
		extendEnv: false,
		env: {
			PATH: process.env.PATH,
			GH_TOKEN: token,
			GH_PROMPT_DISABLED: "1",
			GH_HOST: "github.com",
		},
		encoding: "utf8",
		timeout: 10000,
		maxBuffer: 1048576,
	});
	// Never include subprocess stderr: it may contain credential material.
	if (result.exitCode !== 0)
		throw new Error(
			"GitHub identity probe failed; check profile token and gh installation",
		);
	return result.stdout.trim();
};
export function githubLogin(
	profile: ResolvedProfile,
	run: GithubRunner = runGithub,
): string {
	const secrets = readSecrets(profile.secretsFile);
	const token = secrets.GH_TOKEN || secrets.GITHUB_TOKEN;
	if (!token) throw new Error(`pi-secret -p ${profile.name} set GH_TOKEN`);
	const login = run(["api", "user", "--jq", ".login"], token);
	if (!/^[A-Za-z0-9-]+$/.test(login))
		throw new Error("GitHub returned an invalid login");
	return login;
}
