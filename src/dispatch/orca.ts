/* Orca CLI flags verified against `orca --help` (2026-10-23). Keep CLI drift here. */
import { execa, execaSync } from "execa";
import {
	assertRemovableWorkspace,
	rememberWorkspace,
	workspaceList,
} from "./memory.ts";
import type {
	AttachInfo,
	DispatcherCapabilities,
	HostedProcess,
	ProcessSpec,
	ProcessStatus,
	TerminalInfo,
	WorkerDispatcher,
	Workspace,
	WorkspaceSpec,
} from "./types.ts";

export function resolveOrcaCommand(
	machineCommand?: string,
	env = process.env,
): string {
	if (env.ORCA_CLI_COMMAND) return env.ORCA_CLI_COMMAND;
	if (machineCommand) return machineCommand;
	if (execaSync("orca-dev", ["--help"], { reject: false }).exitCode === 0)
		return "orca-dev";
	if (
		process.platform === "linux" &&
		!env.ORCA_WORKTREE &&
		execaSync("orca-ide", ["--help"], { reject: false }).exitCode === 0
	)
		return "orca-ide";
	return "orca";
}
type OrcaTerminal = {
	handle?: string;
	id?: string;
	title?: string;
	status?: string;
	state?: string;
};
function array(value: string): OrcaTerminal[] {
	const parsed = JSON.parse(value) as unknown;
	return Array.isArray(parsed)
		? (parsed as OrcaTerminal[])
		: ((parsed as { terminals?: OrcaTerminal[] }).terminals ?? []);
}
function terminalHandle(value: unknown): string {
	const terminal = value as OrcaTerminal;
	const handle = terminal.handle ?? terminal.id;
	if (!handle) throw Error("Orca did not return a terminal handle");
	return handle;
}
export class OrcaDispatcher implements WorkerDispatcher {
	readonly name = "orca" as const;
	private readonly workspaces = new Map<string, Workspace>();
	private readonly processes = new Map<string, HostedProcess>();
	private readonly command: string;
	constructor(command = resolveOrcaCommand()) {
		this.command = command;
	}
	private run(args: string[], cwd?: string) {
		return execa(this.command, [...args, "--json"], { cwd, reject: true });
	}
	async createWorkspace(spec: WorkspaceSpec): Promise<Workspace> {
		const existing = this.workspaces.get(spec.id);
		if (existing) return existing;
		const listed = JSON.parse(
			(await this.run(["worktree", "list"], spec.repo)).stdout,
		) as
			| Array<{ name?: string; path?: string }>
			| { worktrees?: Array<{ name?: string; path?: string }> };
		const entries = Array.isArray(listed) ? listed : (listed.worktrees ?? []);
		const found = entries.find((entry) => entry.name === spec.id);
		if (found?.path)
			return rememberWorkspace(this.workspaces, spec, found.path);
		const result = await this.run(
			["worktree", "create", "--name", spec.id, "--no-parent"],
			spec.repo,
		);
		const data = JSON.parse(result.stdout) as {
			path?: string;
			worktree?: { path?: string };
		};
		const path = spec.path ?? data.path ?? data.worktree?.path;
		if (!path) throw Error("Orca did not return a worktree path");
		return rememberWorkspace(this.workspaces, spec, path);
	}
	async removeWorkspace(
		workspace: Workspace,
		options: { held?: boolean } = {},
	): Promise<void> {
		await assertRemovableWorkspace(workspace, options);
		await this.run(["worktree", "rm", "--worktree", `path:${workspace.path}`]);
		this.workspaces.delete(workspace.id);
	}
	async listWorkspaces(): Promise<Workspace[]> {
		return workspaceList(this.workspaces);
	}
	async terminals(workspace: Workspace): Promise<OrcaTerminal[]> {
		return array(
			(
				await this.run([
					"terminal",
					"list",
					"--worktree",
					`path:${workspace.path}`,
				])
			).stdout,
		);
	}
	async hostProcess(spec: ProcessSpec): Promise<HostedProcess> {
		const existing = this.processes.get(spec.id);
		if (existing) return existing;
		const title = spec.title ?? `durable:${spec.id}`;
		const listed = await this.terminals(spec.workspace);
		const found = listed.find((terminal) => terminal.title === title);
		const handle = found
			? terminalHandle(found)
			: terminalHandle(
					JSON.parse(
						(
							await this.run([
								"terminal",
								"create",
								"--worktree",
								`path:${spec.workspace.path}`,
								"--title",
								title,
								"--command",
								[
									"env",
									"-i",
									...Object.entries(spec.env)
										.filter((entry) => entry[1] !== undefined)
										.map(([key, value]) => `${key}=${value}`),
									spec.command,
									...(spec.args ?? []),
								]
									.map((value) => `'${value.replaceAll("'", "'\\''")}'`)
									.join(" "),
							])
						).stdout,
					),
				);
		const process = { id: spec.id, handle, workspace: spec.workspace };
		this.processes.set(spec.id, process);
		return process;
	}
	async processStatus(process: HostedProcess): Promise<ProcessStatus> {
		const terminal = (await this.terminals(process.workspace)).find(
			(entry) => terminalHandle(entry) === process.handle,
		);
		return !terminal
			? "exited"
			: /exit|closed|dead/i.test(terminal.status ?? terminal.state ?? "")
				? "exited"
				: "running";
	}
	async interruptProcess(
		process: HostedProcess,
		mode: "soft" | "hard",
	): Promise<void> {
		if (mode === "soft")
			await this.run([
				"terminal",
				"send",
				"--terminal",
				process.handle,
				"--interrupt",
			]);
		else await this.run(["terminal", "close", "--terminal", process.handle]);
	}
	async sendInput(process: HostedProcess, text: string): Promise<void> {
		await this.run([
			"terminal",
			"send",
			"--terminal",
			process.handle,
			"--text",
			text,
			"--enter",
		]);
	}
	async readOutput(process: HostedProcess): Promise<string> {
		return (await this.run(["terminal", "read", "--terminal", process.handle]))
			.stdout;
	}
	async openViewer(
		workspace: Workspace,
		viewer: { title: string; command: string },
	): Promise<AttachInfo> {
		try {
			const terminal = (await this.terminals(workspace)).find(
				(entry) => entry.title === viewer.title,
			);
			if (terminal)
				return { kind: "orca-terminal", handle: terminalHandle(terminal) };
			const created = await this.run([
				"terminal",
				"create",
				"--worktree",
				`path:${workspace.path}`,
				"--title",
				viewer.title,
				"--command",
				viewer.command,
			]);
			return {
				kind: "orca-terminal",
				handle: terminalHandle(JSON.parse(created.stdout)),
			};
		} catch {
			return { kind: "command", command: viewer.command };
		}
	}
	// fallow-ignore-next-line unused-class-member -- advisory human-terminal check
	async workspaceTerminals(workspace: Workspace): Promise<TerminalInfo[]> {
		return (await this.terminals(workspace)).map((terminal) => ({
			handle: terminalHandle(terminal),
			title: terminal.title,
			status: terminal.status ?? terminal.state,
		}));
	}
	capabilities(): DispatcherCapabilities {
		return {
			attach: "interactive",
			steer: true,
			transcript: true,
			workspaceTerminals: true,
		};
	}
}
