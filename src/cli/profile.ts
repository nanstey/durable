import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { loadManifest } from "../config/manifest.ts";
import { piAgentDir } from "../config/paths.ts";
import type { ProfileManifest } from "../config/schema.ts";
import { type GithubRunner, githubLogin } from "../identity/github.ts";
import { listProviders, resolveProfile } from "../identity/profiles.ts";

export function profileCommand(
	command: string,
	name?: string,
	options: { root?: string; run?: GithubRunner; dryRun?: boolean } = {},
): string {
	const root = options.root ?? piAgentDir();
	if (command === "list") {
		const dir = join(root, "profile-meta");
		return existsSync(dir)
			? readdirSync(dir)
					.filter((x) => x.endsWith(".json"))
					.map((x) => x.slice(0, -5))
					.sort()
					.join("\n")
			: "";
	}
	if (!name) throw new Error("profile name required");
	const profile = resolveProfile(name, root);
	if (command === "init") {
		if (existsSync(profile.manifestFile))
			throw new Error("manifest already exists");
		if (!options.dryRun) {
			mkdirSync(dirname(profile.manifestFile), {
				recursive: true,
				mode: 0o700,
			});
			chmodSync(dirname(profile.manifestFile), 0o700);
			const skeleton: ProfileManifest = {
				version: 1,
				label: name,
				github: { host: "github.com", login: "" },
				git: { name: "", email: "operator@example.invalid" },
				providers: [],
			};
			writeFileSync(
				profile.manifestFile,
				`${JSON.stringify(skeleton, null, 2)}\n`,
				{ flag: "wx", mode: 0o600 },
			);
		}
		return `created ${name}`;
	}
	const manifest = loadManifest(profile.manifestFile);
	if (command === "show") return JSON.stringify(manifest, null, 2);
	if (command === "bind-github") {
		const login = githubLogin(profile, options.run);
		if (!options.dryRun) {
			manifest.github.login = login;
			writeFileSync(
				profile.manifestFile,
				`${JSON.stringify(manifest, null, 2)}\n`,
				{ mode: 0o600 },
			);
			chmodSync(profile.manifestFile, 0o600);
		}
		return `GitHub login: ${login}`;
	}
	if (command === "check") {
		if (!existsSync(profile.authFile))
			throw new Error(
				"profile credentials missing; select this named profile in Pi and run /login",
			);
		if (!manifest.git.name || !manifest.github.login)
			throw new Error("complete manifest git identity and bind-github first");
		if (
			githubLogin(profile, options.run).toLowerCase() !==
			manifest.github.login.toLowerCase()
		)
			throw new Error("GitHub login does not match manifest");
		const providers = listProviders(profile);
		if (
			providers.length === 0 ||
			manifest.providers.some((provider) => !providers.includes(provider))
		)
			throw new Error("missing manifest provider credentials; run Pi /login");
		return `${name}: PASS`;
	}
	throw new Error(
		"unknown profile command: use list, init, show, bind-github or check",
	);
}
