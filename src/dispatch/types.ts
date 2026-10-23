/*
 * WorkerDispatcher invariants:
 * W1: adapters receive only the allowlist-built ProcessSpec.env and never copy
 * process.env. W2: callers use opaque workspace/process handles, not local paths.
 * W3: every implementation is exercised by the dispatcher contract suite.
 */
export type WorkspaceSpec = {
	id: string;
	repo: string;
	branch: string;
	base?: string;
	path?: string;
	/** A held workspace is never removed by Durable. */
	held?: boolean;
};
export type Workspace = { id: string; path: string; branch: string };
export type ProcessSpec = {
	id: string;
	workspace: Workspace;
	command: string;
	args?: string[];
	env: Record<string, string | undefined>;
	title?: string;
	headless?: boolean;
};
export type HostedProcess = {
	id: string;
	handle: string;
	workspace: Workspace;
};
export type ProcessStatus = "running" | "exited" | "unknown";
export type AttachInfo =
	| { kind: "orca-terminal"; handle: string }
	| { kind: "command"; command: string };
export type TerminalInfo = { handle: string; title?: string; status?: string };
export type DispatcherCapabilities = {
	attach: "interactive" | "read" | "none";
	steer: boolean;
	transcript: boolean;
	workspaceTerminals: boolean;
};
export interface WorkerDispatcher {
	readonly name: "orca" | "git-process" | "fake";
	createWorkspace(spec: WorkspaceSpec): Promise<Workspace>;
	removeWorkspace(
		workspace: Workspace,
		options?: { held?: boolean },
	): Promise<void>;
	listWorkspaces(): Promise<Workspace[]>;
	hostProcess(spec: ProcessSpec): Promise<HostedProcess>;
	processStatus(process: HostedProcess): Promise<ProcessStatus>;
	interruptProcess(
		process: HostedProcess,
		mode: "soft" | "hard",
	): Promise<void>;
	sendInput?(process: HostedProcess, text: string): Promise<void>;
	readOutput?(process: HostedProcess, tail?: number): Promise<string>;
	openViewer(
		workspace: Workspace,
		viewer: { title: string; command: string },
	): Promise<AttachInfo>;
	workspaceTerminals?(workspace: Workspace): Promise<TerminalInfo[]>;
	capabilities(): DispatcherCapabilities;
}
