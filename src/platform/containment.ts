import type { Readable, Writable } from "node:stream";

export type Invocation = {
	invocationId: string;
	attemptId: string;
	item?: string;
	task?: string;
	unit: string;
	slice: string;
	state: "intent" | "registered" | "releasing" | "running";
	pid?: number;
	pgid?: number;
	startTime?: string;
	cgroup?: string;
	marker: string;
};
export type Identity = {
	pid: number;
	pgid: number;
	startTime: string;
	cgroup?: string;
};
export type Launch = {
	identity: Promise<Identity>;
	release: Writable;
	output: Readable;
	done: Promise<{ exitCode: number; stdout: string; stderr: string }>;
};
export interface Containment {
	readonly confirmed: boolean;
	/** Terminal-hosted equivalent of spawn: the command still runs behind a registered gate. */
	hostedArgv?(record: Invocation, argv: string[]): string[];
	hostedEnv?(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
	spawn(
		record: Invocation,
		hash: string,
		argv: string[],
		env: NodeJS.ProcessEnv,
	): Launch;
	kill(record: Invocation): Promise<boolean>;
	empty(record: Invocation): Promise<boolean>;
}
