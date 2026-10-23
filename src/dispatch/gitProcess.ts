import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { rememberProcess, rememberWorkspace } from "./memory.ts";
import type {
	AttachInfo,
	DispatcherCapabilities,
	HostedProcess,
	ProcessSpec,
	ProcessStatus,
	WorkerDispatcher,
	Workspace,
	WorkspaceSpec,
} from "./types.ts";

/** Git worktrees plus detached, clean-environment processes; no Orca dependency. */
export class GitProcessDispatcher implements WorkerDispatcher {
	readonly name = "git-process" as const;
	private readonly workspaces = new Map<string, Workspace>();
	private readonly processes = new Map<string, HostedProcess>();
	private readonly root: string;
	constructor(root: string) {
		this.root = root;
		mkdirSync(root, { recursive: true, mode: 0o700 });
	}
	async createWorkspace(spec: WorkspaceSpec): Promise<Workspace> {
		const existing = this.workspaces.get(spec.id);
		if (existing) return existing;
		const path = spec.path ?? join(this.root, spec.id);
		if (!existsSync(path))
			await execa("git", [
				"-C",
				spec.repo,
				"worktree",
				"add",
				"--detach",
				path,
				spec.base ?? "HEAD",
			]);
		return rememberWorkspace(this.workspaces, spec, path);
	}
	async removeWorkspace(
		workspace: Workspace,
		options: { held?: boolean } = {},
	): Promise<void> {
		if (options.held) throw Error("workspace is human-held");
		const dirty = await execa(
			"git",
			["-C", workspace.path, "status", "--porcelain"],
			{ reject: false },
		);
		if (dirty.stdout.trim()) throw Error("refusing to remove dirty workspace");
		await execa(
			"git",
			["-C", workspace.path, "worktree", "remove", workspace.path],
			{ reject: false },
		);
		if (existsSync(workspace.path))
			rmSync(workspace.path, { recursive: true, force: true });
		this.workspaces.delete(workspace.id);
	}
	async listWorkspaces(): Promise<Workspace[]> {
		return Array.from(this.workspaces.values());
	}
	async hostProcess(spec: ProcessSpec): Promise<HostedProcess> {
		const existing = this.processes.get(spec.id);
		if (existing) return existing;
		const log = join(spec.workspace.path, `.durable-${spec.id}.log`);
		const pid = `${log}.pid`;
		const child = execa(spec.command, spec.args ?? [], {
			cwd: spec.workspace.path,
			env: spec.env,
			extendEnv: false,
			detached: true,
			stdin: spec.headless ? "ignore" : "pipe",
			stdout: "pipe",
			stderr: "pipe",
			reject: false,
		});
		child.stdout?.pipe(createWriteStream(log, { flags: "a", mode: 0o600 }));
		child.stderr?.pipe(createWriteStream(log, { flags: "a", mode: 0o600 }));
		writeFileSync(pid, String(child.pid), { mode: 0o600 });
		return rememberProcess(this.processes, spec, pid);
	}
	async processStatus(process: HostedProcess): Promise<ProcessStatus> {
		try {
			globalThis.process.kill(Number(readFileSync(process.handle, "utf8")), 0);
			return "running";
		} catch {
			return existsSync(process.handle) ? "exited" : "unknown";
		}
	}
	async interruptProcess(
		process: HostedProcess,
		mode: "soft" | "hard",
	): Promise<void> {
		try {
			globalThis.process.kill(
				-Number(readFileSync(process.handle, "utf8")),
				mode === "soft" ? "SIGINT" : "SIGKILL",
			);
		} catch {
			/* an exited worker is already interrupted */
		}
	}
	// fallow-ignore-next-line unused-class-member -- dispatcher contract capability
	async readOutput(process: HostedProcess, tail = 65536): Promise<string> {
		const log = process.handle.slice(0, -4);
		if (!existsSync(log)) return "";
		const value = readFileSync(log, "utf8");
		return value.slice(-tail);
	}
	async openViewer(
		_workspace: Workspace,
		viewer: { title: string; command: string },
	): Promise<AttachInfo> {
		return { kind: "command", command: viewer.command };
	}
	capabilities(): DispatcherCapabilities {
		return {
			attach: "read",
			steer: false,
			transcript: true,
			workspaceTerminals: false,
		};
	}
}
