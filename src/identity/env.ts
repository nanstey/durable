import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { durableHome } from "../config/paths.ts";
import type { ResolvedProfile } from "./profiles.ts";

const blocked =
	/(?:TOKEN|API_KEY|SECRET|PASSWORD|SSH_AUTH_SOCK|PI_CODING_AGENT_DIR|DURABLE_HOME)/i;
function secrets(path: string): Record<string, string> {
	try {
		return Object.fromEntries(
			readFileSync(path, "utf8")
				.split(/\r?\n/)
				.filter((x) => x && !x.startsWith("#"))
				.map((x) => {
					const i = x.indexOf("=");
					return [x.slice(0, i), x.slice(i + 1)];
				}),
		);
	} catch {
		return {};
	}
}
export function buildAgentEnv(
	profile: ResolvedProfile,
	role: "steward" | "worker" | "reviewer" | "durable-shell",
	ctx: { agent: string; item?: string; parent?: NodeJS.ProcessEnv },
): NodeJS.ProcessEnv {
	const parent = ctx.parent || process.env;
	const base: NodeJS.ProcessEnv = {
		PATH: parent.PATH,
		LANG: parent.LANG,
		TERM: parent.TERM,
		TZ: parent.TZ,
	};
	const scratch = join(
		durableHome(),
		"agents",
		ctx.agent,
		"scratch",
		ctx.item || "default",
	);
	if (role === "durable-shell") {
		mkdirSync(scratch, { recursive: true });
		const gh = join(scratch, "gh");
		mkdirSync(gh, { recursive: true });
		const git = join(scratch, "gitconfig");
		writeFileSync(git, "[user]\n\tname = Durable Worker\n");
		return {
			...base,
			HOME: scratch,
			TMPDIR: scratch,
			GH_CONFIG_DIR: gh,
			GIT_CONFIG_GLOBAL: git,
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
			DURABLE_WORKER: "1",
		};
	}
	const clean = Object.fromEntries(
		Object.entries(parent).filter(([k]) => !blocked.test(k)),
	);
	const state = join(durableHome(), "agents", ctx.agent);
	mkdirSync(state, { recursive: true });
	return {
		...clean,
		...base,
		...secrets(profile.secretsFile),
		GH_CONFIG_DIR: join(state, "gh"),
		GIT_CONFIG_GLOBAL: join(state, "gitconfig"),
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		PI_CODING_AGENT_DIR: join(state, "pi"),
	};
}
