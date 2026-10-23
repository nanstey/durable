import { readSecrets } from "./env.ts";
import { type GithubRunner, runGithub } from "./github.ts";
import type { ResolvedProfile } from "./profiles.ts";

/** Advisory only: token contents never appear in returned diagnostics. */
export function tokenWarnings(
	profile: ResolvedProfile,
	repos: string[],
	run: GithubRunner = runGithub,
): string[] {
	const secrets = readSecrets(profile.secretsFile);
	const token = secrets.GH_TOKEN || secrets.GITHUB_TOKEN;
	if (!token) return ["GitHub token missing"];
	const warnings: string[] = [];
	if (token.startsWith("ghp_") || token.startsWith("gho_"))
		warnings.push(
			"classic/OAuth token: prefer a fine-grained token scoped to the configured repositories",
		);
	try {
		const headers = run(["api", "user", "--include"], token);
		const scopes =
			/^x-oauth-scopes:\s*(.*)$/im
				.exec(headers)?.[1]
				.split(",")
				.map((scope) => scope.trim()) ?? [];
		if (scopes.some((scope) => scope === "repo" || scope.startsWith("admin:")))
			warnings.push("token has broad repo/admin scopes");
	} catch {
		warnings.push("token scope inspection unavailable");
	}
	try {
		const reachable: unknown = JSON.parse(
			run(["api", "user/repos?per_page=100", "--jq", "[.[].full_name]"], token),
		);
		if (
			Array.isArray(reachable) &&
			reachable.some(
				(repo) => typeof repo === "string" && !repos.includes(repo),
			)
		)
			warnings.push(
				"token can reach repositories outside the definition scope (first page inspected)",
			);
	} catch {
		warnings.push("repository reachability inspection unavailable");
	}
	return warnings;
}
