import type {
	HostedProcess,
	ProcessSpec,
	WorkerDispatcher,
	Workspace,
	WorkspaceSpec,
} from "./types.ts";

/** Apply the persisted fence to every daemon workspace/process write, including cleanup. */
export function fencedDispatcher(
	dispatcher: WorkerDispatcher,
	agent: string,
	fenced: (item: string) => boolean,
): WorkerDispatcher {
	const check = (workspace: Workspace | WorkspaceSpec) => {
		const item = workspace.id.replace(`durable-${agent}-`, "");
		if (fenced(item))
			throw Object.assign(Error("item is human-held"), { code: "held" });
	};
	return new Proxy(dispatcher, {
		get(target, property) {
			if (property === "createWorkspace")
				return async (spec: WorkspaceSpec) => {
					check(spec);
					return target.createWorkspace(spec);
				};
			if (property === "removeWorkspace")
				return async (workspace: Workspace, options?: { held?: boolean }) => {
					check(workspace);
					return target.removeWorkspace(workspace, options);
				};
			if (property === "hostProcess")
				return async (spec: ProcessSpec) => {
					check(spec.workspace);
					return target.hostProcess(spec);
				};
			if (property === "sendInput" && target.sendInput)
				return async (process: HostedProcess, text: string) => {
					check(process.workspace);
					return target.sendInput!(process, text);
				};
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export type Hold = {
	item: string;
	holdEpoch: number;
	state: "holding" | "held";
	by: string;
	via: string;
	reason?: string;
};
export type Holds = Record<string, Hold>;

export function isHeld(holds: Holds, item: string): boolean {
	const state = holds[item]?.state;
	return state === "holding" || state === "held";
}
// fallow-ignore-next-line unused-export
export function assertNotHeld(holds: Holds, item: string): void {
	if (isHeld(holds, item))
		throw Object.assign(Error("item is human-held"), { code: "held" });
}

/** Fence first, then stop work and confirm containment before acknowledging exclusive ownership. */
export async function holdItem(input: {
	holds: Holds;
	item: string;
	by: string;
	via: string;
	interrupt: (mode: "soft" | "hard") => Promise<void>;
	waitForEmpty: () => Promise<boolean>;
	drainMs?: number;
}): Promise<Hold> {
	const prior = input.holds[input.item];
	const hold: Hold = {
		item: input.item,
		holdEpoch: (prior?.holdEpoch ?? 0) + 1,
		state: "holding",
		by: input.by,
		via: input.via,
	};
	input.holds[input.item] = hold;
	await input.interrupt("soft");
	await new Promise((resolve) => setTimeout(resolve, input.drainMs ?? 10_000));
	await input.interrupt("hard");
	if (await input.waitForEmpty()) hold.state = "held";
	else
		hold.reason =
			"containment could not be confirmed empty; independent verification is required";
	return hold;
}

// fallow-ignore-next-line unused-export
export function releaseHold(holds: Holds, item: string, epoch: number): void {
	if (holds[item]?.holdEpoch !== epoch)
		throw Error("hold epoch does not match");
	delete holds[item];
}
