import type {
	HostedProcess,
	ProcessSpec,
	Workspace,
	WorkspaceSpec,
} from "./types.ts";

export function rememberWorkspace(
	workspaces: Map<string, Workspace>,
	spec: WorkspaceSpec,
	path: string,
): Workspace {
	const workspace = { id: spec.id, path, branch: spec.branch };
	workspaces.set(spec.id, workspace);
	return workspace;
}
export function workspaceList(workspaces: Map<string, Workspace>): Workspace[] {
	return [...workspaces.values()];
}
export function rememberProcess(
	processes: Map<string, HostedProcess>,
	spec: ProcessSpec,
	handle: string,
): HostedProcess {
	const process = { id: spec.id, handle, workspace: spec.workspace };
	processes.set(spec.id, process);
	return process;
}
