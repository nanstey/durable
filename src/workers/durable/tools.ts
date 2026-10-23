import { readFile, writeFile } from "node:fs/promises";
import { execa } from "execa";
import { blockedWorkerCommand } from "../../guard/commands.ts";
import { buildAgentEnv } from "../../identity/env.ts";
import type { ResolvedProfile } from "../../identity/profiles.ts";
import { confinedPath } from "./confine.ts";

// fallow-ignore-next-line unused-export
export const durableWorkerToolNames = [
	"read",
	"edit",
	"write",
	"bash",
	"commit",
	"push_branch",
	"open_draft_pr",
	"report",
] as const;
// fallow-ignore-next-line unused-export
export const durableReviewerToolNames = [
	"read",
	"search",
	"pr_diff",
	"report_verdict",
] as const;

// fallow-ignore-next-line unused-export
export function screenToolOutput(text: string): string {
	return text
		.replace(/(?:ghp_|github_pat_|Bearer\s+)[A-Za-z0-9_\-.]+/gi, "[redacted]")
		.replace(
			/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
			"[redacted]",
		);
}

export class DurableFileTools {
	private readonly worktree: string;
	constructor(worktree: string) {
		this.worktree = worktree;
	}
	async read(path: string): Promise<string> {
		return screenToolOutput(
			await readFile(await confinedPath(this.worktree, path), "utf8"),
		);
	}
	// fallow-ignore-next-line unused-class-member
	async write(path: string, text: string): Promise<void> {
		await writeFile(await confinedPath(this.worktree, path), text, "utf8");
	}
	// fallow-ignore-next-line unused-class-member
	async edit(path: string, before: string, after: string): Promise<void> {
		const resolved = await confinedPath(this.worktree, path);
		const text = await readFile(resolved, "utf8");
		if (!text.includes(before)) throw Error("edit text was not found");
		await writeFile(resolved, text.replace(before, after), "utf8");
	}
}

/** Advisory command checks; a same-user shell is explicitly not a sandbox. */
// fallow-ignore-next-line unused-export
export async function durableBash(input: {
	command: string;
	worktree: string;
	profile: ResolvedProfile;
	agent: string;
	item: string;
}): Promise<string> {
	if (blockedWorkerCommand(input.command))
		throw Error("command refused by durable worker guard");
	const env = buildAgentEnv(input.profile, "durable-shell", {
		agent: input.agent,
		item: input.item,
	});
	const result = await execa("sh", ["-c", input.command], {
		cwd: input.worktree,
		env,
		reject: false,
	});
	return screenToolOutput(
		`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`,
	);
}
