import { open, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ConversationId, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { credentialLike } from "../../api/chat.ts";
import { blockedWorkerCommand } from "../../guard/commands.ts";
import type { ProcessManager } from "../../steward/procs.ts";
import type { JobSpec } from "../kind.ts";
import { confinedPath } from "./confine.ts";

export const durableWorkerToolNames = [
	"read",
	"search",
	"edit",
	"write",
	"bash",
	"commit",
	"push_branch",
	"open_draft_pr",
	"report",
] as const;

export function screenToolOutput(text: string): string {
	if (credentialLike(text)) return "[credential-like output redacted]";
	return text
		.slice(0, 100_000)
		.replace(/(?:ghp_|github_pat_|sk-ant-|sk-)[A-Za-z0-9_\-.]+/gi, "[redacted]")
		.replace(/Bearer\s+\S+/gi, "[redacted]")
		.replace(
			/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
			"[redacted]",
		);
}

const readFileBytes = 100_000;
const searchFileBytes = 1024 * 1024;

export class DurableFileTools {
	private readonly worktree: string;
	constructor(worktree: string) {
		this.worktree = worktree;
	}
	async read(path: string): Promise<string> {
		const file = await open(await confinedPath(this.worktree, path), "r");
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > readFileBytes)
				throw Error("read requires a regular file no larger than 100 KB");
			return screenToolOutput(await file.readFile({ encoding: "utf8" }));
		} finally {
			await file.close();
		}
	}
	async write(path: string, text: string): Promise<void> {
		await writeFile(await confinedPath(this.worktree, path), text, "utf8");
	}
	async edit(path: string, before: string, after: string): Promise<void> {
		if (!before) throw Error("edit text must not be empty");
		const resolved = await confinedPath(this.worktree, path);
		const text = await readFile(resolved, "utf8");
		if (text.split(before).length !== 2)
			throw Error("edit text must match exactly once");
		await writeFile(resolved, text.replace(before, after), "utf8");
	}
	private async searchText(path: string): Promise<string | undefined> {
		const file = await open(await confinedPath(this.worktree, path), "r");
		try {
			if ((await file.stat()).size > searchFileBytes) return;
			const chunks: Buffer[] = [];
			// Read at most cap + 1 bytes, even if the file grows after stat().
			for await (const chunk of file.createReadStream({
				end: searchFileBytes,
				autoClose: false,
			}))
				chunks.push(chunk as Buffer);
			const bytes = Buffer.concat(chunks);
			if (bytes.length > searchFileBytes || bytes.includes(0)) return;
			try {
				return screenToolOutput(
					new TextDecoder("utf-8", { fatal: true }).decode(bytes),
				);
			} catch {
				return;
			}
		} finally {
			await file.close();
		}
	}
	async search(needle: string): Promise<string> {
		const matches: string[] = [];
		let visited = 0;
		const walk = async (directory: string) => {
			for (const entry of await readdir(join(this.worktree, directory), {
				withFileTypes: true,
			})) {
				if (++visited > 10_000 || matches.length >= 100) return;
				if (entry.name === ".git" || entry.isSymbolicLink()) continue;
				const path = join(directory, entry.name);
				if (entry.isDirectory()) await walk(path);
				else if (entry.isFile()) {
					const text = await this.searchText(path);
					if (text === undefined) continue;
					const lines = text.split("\n");
					for (const [i, line] of lines.entries()) {
						if (line.includes(needle)) matches.push(`${path}:${i + 1}:${line}`);
						if (matches.length >= 100) break;
					}
				}
			}
		};
		await walk("");
		return screenToolOutput(matches.join("\n"));
	}
}

export function assertCommand(command: string): void {
	if (blockedWorkerCommand(command))
		throw Error("command refused by durable worker guard");
}

/** Advisory only: interpreters and scripts can access same-user files outside cwd. */
export async function durableBash(input: {
	command: string;
	job: JobSpec;
	env: NodeJS.ProcessEnv;
	processes: Pick<ProcessManager, "launch" | "terminate">;
	signal?: AbortSignal;
}): Promise<string> {
	assertCommand(input.command);
	const { job, processes } = input;
	const abort = () => {
		void processes.terminate({ attemptId: job.id }).catch(() => {});
	};
	input.signal?.throwIfAborted();
	input.signal?.addEventListener("abort", abort, { once: true });
	try {
		const result = await processes.launch(
			[
				"sh",
				"-c",
				'cd -- "$1" && eval "$2"',
				"durable-shell",
				job.workspace.path,
				input.command,
			],
			input.env,
			{ item: job.item, attemptId: job.id },
		);
		return screenToolOutput(
			`exit=${result.exitCode}\n${result.stdout}\n${result.stderr}`,
		);
	} finally {
		input.signal?.removeEventListener("abort", abort);
	}
}

export function fileTools(jobFor: (id: ConversationId) => Promise<JobSpec>) {
	const files = async (id: ConversationId) =>
		new DurableFileTools((await jobFor(id)).workspace.path);
	const output = (text: string) => ({
		output: [{ type: "text" as const, text: screenToolOutput(text) }],
	});
	return [
		defineTool({
			name: "read",
			description: "Read a worktree file.",
			parameters: Type.Object({ path: Type.String() }),
			replay: "safe",
			execute: async ({ path }, api) =>
				output(await (await files(api.conversationId)).read(path)),
		}),
		defineTool({
			name: "search",
			description:
				"Search worktree UTF-8 text literally. Skip symlinks, binary files and files over 1 MiB.",
			parameters: Type.Object({ needle: Type.String() }),
			replay: "safe",
			execute: async ({ needle }, api) =>
				output(await (await files(api.conversationId)).search(needle)),
		}),
		defineTool({
			name: "write",
			description: "Write a worktree file, never .git.",
			parameters: Type.Object({ path: Type.String(), text: Type.String() }),
			execute: async ({ path, text }, api) => {
				await (await files(api.conversationId)).write(path, text);
				return output("written");
			},
		}),
		defineTool({
			name: "edit",
			description: "Replace one exact match in a worktree file.",
			parameters: Type.Object({
				path: Type.String(),
				before: Type.String(),
				after: Type.String(),
			}),
			execute: async ({ path, before, after }, api) => {
				await (await files(api.conversationId)).edit(path, before, after);
				return output("edited");
			},
		}),
	];
}
