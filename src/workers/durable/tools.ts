import {
	mkdtemp,
	open,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
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

/** PR titles are metadata, not a channel for bodies, trailers, or credentials. */
export function screenPrTitle(title: string): string {
	const screened = title.trim();
	if (!screened || screened.length > 256)
		throw Error("draft PR title must be 1-256 characters");
	if (/[\r\n]/.test(screened) || screened.includes(String.fromCharCode(0)))
		throw Error("draft PR title must be a single line");
	if (credentialLike(screened))
		throw Error("draft PR title contains credential-like content");
	return screened;
}

const readFileBytes = 100_000;
const searchFileBytes = 1024 * 1024;
const bashOutputBytes = 100_000;
const bashTimeoutMs = 60_000;

async function boundedOutput(path: string): Promise<string> {
	const file = await open(path, "r").catch(() => undefined);
	if (!file) return "";
	try {
		const bytes = Buffer.alloc(bashOutputBytes + 1);
		const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
		const suffix = bytesRead > bashOutputBytes ? "\n[output truncated]" : "";
		return (
			bytes.subarray(0, Math.min(bytesRead, bashOutputBytes)).toString() +
			suffix
		);
	} finally {
		await file.close();
	}
}

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
	/** Test seam; production calls are capped at one minute. */
	timeoutMs?: number;
}): Promise<string> {
	assertCommand(input.command);
	const { job, processes } = input;
	const abort = () => {
		void processes.terminate({ attemptId: job.id }).catch(() => {});
	};
	const outputDir = await mkdtemp(join(tmpdir(), "durable-bash-"));
	input.signal?.throwIfAborted();
	input.signal?.addEventListener("abort", abort, { once: true });
	try {
		const launched = processes.launch(
			[
				"sh",
				"-c",
				'cd -- "$1" && eval "$2" > "$3/stdout" 2> "$3/stderr"',
				"durable-shell",
				job.workspace.path,
				input.command,
				outputDir,
			],
			input.env,
			{ item: job.item, attemptId: job.id },
		);
		// Do not leave an abandoned rejection if a timeout wins the race.
		void launched.catch(() => {});
		const result = await new Promise<Awaited<typeof launched>>(
			(resolve, reject) => {
				const timer = setTimeout(() => {
					abort();
					reject(Error("bash timed out"));
				}, input.timeoutMs ?? bashTimeoutMs);
				launched.then(
					(value) => {
						clearTimeout(timer);
						resolve(value);
					},
					(error) => {
						clearTimeout(timer);
						reject(error);
					},
				);
			},
		);
		return screenToolOutput(
			`exit=${result.exitCode}\n${await boundedOutput(join(outputDir, "stdout"))}\n${await boundedOutput(join(outputDir, "stderr"))}`,
		);
	} finally {
		input.signal?.removeEventListener("abort", abort);
		await rm(outputDir, { recursive: true, force: true });
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
