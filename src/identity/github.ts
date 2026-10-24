import { execaSync } from "execa";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSecrets } from "./env.ts";
import type { ResolvedProfile } from "./profiles.ts";

export type GithubRunner = (args: string[], token: string) => string;
export type GithubDeviceRunner = (
	args: string[],
	env: NodeJS.ProcessEnv,
) => string;

const deviceRunner: GithubDeviceRunner = (args, env) => {
	// The login step must talk to the operator: gh prints the one-time code and
	// waits for Enter. Only the token read-back is captured.
	const interactive = args[1] === "login";
	const result = execaSync("gh", args, {
		reject: false,
		extendEnv: false,
		env,
		encoding: "utf8",
		timeout: interactive ? 600000 : 30000,
		maxBuffer: 1048576,
		...(interactive ? { stdio: "inherit" as const } : {}),
	});
	if (result.exitCode === undefined) throw Error("gh missing");
	if (result.exitCode !== 0) throw Error("device flow cancelled or failed");
	return String(result.stdout ?? "").trim();
};

/**
 * Runs gh's browser device flow in an isolated config directory and returns only
 * the token. The directory is always removed and never touches ambient gh auth.
 */
export function githubDeviceToken(
	run: GithubDeviceRunner = deviceRunner,
): string {
	const config = mkdtempSync(join(tmpdir(), "durable-gh-"));
	chmodSync(config, 0o700);
	try {
		// gh needs HOME (git config) and the desktop session variables to open a
		// browser. None of these carry credentials; GH_TOKEN and friends are not
		// forwarded, so the ambient gh login stays untouched.
		const env: Record<string, string | undefined> = {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			TERM: process.env.TERM,
			DISPLAY: process.env.DISPLAY,
			WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
			XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
			DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
			BROWSER: process.env.BROWSER,
			GH_CONFIG_DIR: config,
			// gh offers to set up git credentials; keep that inside the temp dir so
			// the operator's own git config is never modified.
			GIT_CONFIG_GLOBAL: join(config, "gitconfig"),
			GIT_CONFIG_SYSTEM: "/dev/null",
			GH_HOST: "github.com",
		};
		// gh can finish authentication and still exit non-zero on a later step
		// (git protocol setup, no browser opener). The token read-back below is
		// the real success test, so a login failure alone is not fatal.
		try {
			run(
				[
					"auth",
					"login",
					"--web",
					"--hostname",
					"github.com",
					"--scopes",
					"repo",
					"--git-protocol",
					"https",
				],
				env,
			);
		} catch {
			// verified by the token read-back
		}
		const token = run(["auth", "token", "--hostname", "github.com"], env);
		if (!token) throw Error("device flow cancelled or failed");
		return token;
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (/ENOENT|not found|gh missing/i.test(message))
			throw Error(
				"gh is required for browser sign-in; install GitHub CLI and retry",
			);
		throw Error(
			"GitHub device flow cancelled; retry browser sign-in or paste a token",
		);
	} finally {
		rmSync(config, { recursive: true, force: true });
	}
}
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
