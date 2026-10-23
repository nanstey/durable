import { rememberProcess, rememberWorkspace, workspaceList } from "./memory.ts";
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

/** In-memory adapter used by contract and API tests. */
export class FakeDispatcher implements WorkerDispatcher {
	readonly name = "fake" as const;
	private readonly workspaces = new Map<string, Workspace>();
	private readonly processes = new Map<string, HostedProcess>();
	private readonly states = new Map<
		string,
		{ status: ProcessStatus; output: string }
	>();
	createWorkspace(spec: WorkspaceSpec): Promise<Workspace> {
		const current = this.workspaces.get(spec.id);
		if (current) return Promise.resolve(current);
		return Promise.resolve(
			rememberWorkspace(this.workspaces, spec, spec.path ?? `fake/${spec.id}`),
		);
	}
	async removeWorkspace(
		workspace: Workspace,
		options: { held?: boolean } = {},
	): Promise<void> {
		if (options.held) throw Error("workspace is human-held");
		this.workspaces.delete(workspace.id);
	}
	async listWorkspaces(): Promise<Workspace[]> {
		return workspaceList(this.workspaces);
	}
	async hostProcess(spec: ProcessSpec): Promise<HostedProcess> {
		const existing = this.processes.get(spec.id);
		if (existing) return existing;
		const process = rememberProcess(this.processes, spec, `fake:${spec.id}`);
		this.states.set(spec.id, { status: "running", output: "" });
		return process;
	}
	async processStatus(process: HostedProcess): Promise<ProcessStatus> {
		return this.states.get(process.id)?.status ?? "unknown";
	}
	async interruptProcess(
		process: HostedProcess,
		_mode: "soft" | "hard",
	): Promise<void> {
		const found = this.states.get(process.id);
		if (found) found.status = "exited";
	}
	async sendInput(process: HostedProcess, text: string): Promise<void> {
		const found = this.states.get(process.id);
		if (found) found.output += text;
	}
	async readOutput(process: HostedProcess): Promise<string> {
		return this.states.get(process.id)?.output ?? "";
	}
	async openViewer(
		_workspace: Workspace,
		viewer: { title: string; command: string },
	): Promise<AttachInfo> {
		return { kind: "command", command: viewer.command };
	}
	async workspaceTerminals(_workspace: Workspace): Promise<TerminalInfo[]> {
		return [];
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
