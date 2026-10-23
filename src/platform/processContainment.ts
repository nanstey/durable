import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Containment, Invocation } from "./containment.ts";
import { gatedProcess } from "./gatedProcess.ts";

export type ProcessInfo = {
	pid: number;
	pgid: number;
	startTime: string;
	marker?: string;
	uid: number;
};
async function scanProcesses(): Promise<ProcessInfo[]> {
	const results: ProcessInfo[] = [];
	for (const pid of await readdir("/proc")) {
		if (!/^\d+$/.test(pid)) continue;
		try {
			const base = `/proc/${pid}`;
			const [stat, status, env] = await Promise.all([
				readFile(`${base}/stat`, "utf8"),
				readFile(`${base}/status`, "utf8"),
				readFile(`${base}/environ`, "utf8"),
			]);
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			results.push({
				pid: Number(pid),
				pgid: Number(fields[2]),
				startTime: fields[19],
				uid: Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]),
				marker: env
					.split("\0")
					.find((s) => s.startsWith("DURABLE_INVOCATION="))
					?.slice(19),
			});
		} catch {
			/* Processes can exit or deny inspection while scanning. */
		}
	}
	return results;
}
export function markerTargets(
	record: Invocation,
	processes: ProcessInfo[],
	uid: number,
) {
	return processes.filter(
		(p) =>
			p.uid === uid &&
			(p.marker === record.marker ||
				(p.pid === record.pid && p.startTime === record.startTime)),
	);
}
export class ProcessContainment implements Containment {
	readonly confirmed = false;
	private scan: typeof scanProcesses;
	private signal: (pid: number, signal: NodeJS.Signals) => unknown;
	constructor(
		scan = scanProcesses,
		signal = (pid: number, signal: NodeJS.Signals) => process.kill(pid, signal),
	) {
		this.scan = scan;
		this.signal = signal;
	}
	spawn(
		record: Invocation,
		hash: string,
		argv: string[],
		env: NodeJS.ProcessEnv,
	) {
		return gatedProcess(
			process.execPath,
			[
				fileURLToPath(new URL("../../bin/durable-gate", import.meta.url)),
				hash,
				...argv,
			],
			{ ...env, DURABLE_INVOCATION: record.marker },
			async (identity) => identity,
			true,
		);
	}
	async empty(record: Invocation) {
		return (
			markerTargets(record, await this.scan(), process.getuid?.() ?? -1)
				.length === 0
		);
	}
	async kill(record: Invocation) {
		for (const signal of ["SIGTERM", "SIGKILL"] as const) {
			const targets = markerTargets(
				record,
				await this.scan(),
				process.getuid?.() ?? -1,
			);
			const leader = targets.find(
				(target) =>
					target.pid === record.pid &&
					target.startTime === record.startTime &&
					target.pgid === record.pgid,
			);
			if (leader && leader.pgid > 1) {
				try {
					this.signal(-leader.pgid, signal);
				} catch {
					/* The group may already have exited. */
				}
			}
			for (const target of targets) {
				try {
					// Recheck identity immediately before signalling; never signal a reused PID.
					const current = (await this.scan()).find((p) => p.pid === target.pid);
					if (current?.startTime !== target.startTime) continue;
					this.signal(target.pid, signal);
				} catch {
					/* Exit races are harmless; emptiness is checked separately. */
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		// A process may have removed the marker. /proc cannot prove exclusive ownership.
		return false;
	}
}
