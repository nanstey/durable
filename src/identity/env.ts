import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadManifest } from "../config/manifest.ts";
import { durableHome } from "../config/paths.ts";
import { assertProfileName } from "../config/schema.ts";
import type { ResolvedProfile } from "./profiles.ts";

/** Parse profile-owned dotenv entries; never consult the ambient environment. */
export function readSecrets(path: string): Record<string, string> {
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	const entries: Record<string, string> = {};
	for (const line of contents.split(/\r?\n/)) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
		if (!match) throw new Error("invalid profile secrets entry");
		let value = match[2];
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		)
			value = value.slice(1, -1);
		entries[match[1]] = value;
	}
	return entries;
}
function privateDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
}
function gitValue(value: string): string {
	return JSON.stringify(value);
}
export function buildAgentEnv(
	profile: ResolvedProfile,
	role: "steward" | "worker" | "reviewer" | "durable-shell",
	ctx: { agent: string; item?: string; parent?: NodeJS.ProcessEnv },
): NodeJS.ProcessEnv {
	assertProfileName(ctx.agent);
	assertProfileName(ctx.item || "default");
	const parent = ctx.parent || process.env;
	const base: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(parent)) {
		if (
			["PATH", "LANG", "TERM", "TZ"].includes(key) ||
			/^LC_[A-Z_]+$/.test(key)
		)
			base[key] = value;
	}
	const state = join(durableHome(), "agents", ctx.agent);
	const shell = role === "durable-shell";
	const home = shell ? join(state, "scratch", ctx.item || "default") : state;
	privateDirectory(home);
	const gh = shell ? mkdtempSync(join(home, "gh-")) : join(home, "gh");
	privateDirectory(gh);
	const git = join(home, "gitconfig");
	let identity = "[user]\n\tname = Durable Worker\n";
	try {
		const manifest = loadManifest(profile.manifestFile);
		identity = `[user]\n\tname = ${gitValue(manifest.git.name)}\n\temail = ${gitValue(manifest.git.email)}\n`;
	} catch (error) {
		// A shell needs no credential or manifest. Other roles fail closed.
		if (!shell) throw error;
	}
	const credentials = shell
		? ""
		: '[credential]\n\thelper =\n\thelper = !gh auth git-credential\n[url "https://github.com/"]\n\tinsteadOf = git@github.com:\n[trailer "Durable-Agent"]\n\tkey = Durable-Agent\n';
	writeFileSync(git, identity + credentials, { mode: 0o600 });
	chmodSync(git, 0o600);
	const common = {
		...base,
		HOME: home,
		TMPDIR: home,
		GH_CONFIG_DIR: gh,
		GIT_CONFIG_GLOBAL: git,
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
	};
	if (shell) return { ...common, DURABLE_WORKER: "1" };
	const secrets = readSecrets(profile.secretsFile);
	const token = secrets.GH_TOKEN || secrets.GITHUB_TOKEN;
	if (!token)
		throw new Error(
			`missing GitHub token; pi-secret -p ${profile.name} set GH_TOKEN`,
		);
	// Structural controls cannot be overridden by a secrets file.
	delete secrets.SSH_AUTH_SOCK;
	delete secrets.DURABLE_HOME;
	return {
		...secrets,
		...common,
		GH_TOKEN: token,
		GITHUB_TOKEN: token,
		PI_CODING_AGENT_DIR: join(state, "pi"),
	};
}
