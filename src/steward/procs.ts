import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	Containment,
	Invocation,
	Launch,
} from "../platform/containment.ts";
import { workspaceWriters } from "../platform/workspaceWriters.ts";
import { audit } from "./audit.ts";
import { agentDir, loadJson, saveJson } from "./files.ts";
import { queueInbox } from "./inbox.ts";
import { disabled } from "./killswitch.ts";

type Fence = {
	state: "holding" | "held" | "recovery";
	holdEpoch: number;
	by?: string;
	via?: string;
	reason?: string;
};
type ProcJournal = {
	invocations: Invocation[];
	holds: Record<string, Fence>;
	epochs?: Record<string, number>;
};
export type FaultHook = (
	boundary: string,
	record: Invocation,
) => void | Promise<void>;
export class ProcessManager {
	private path: string;
	private journal: ProcJournal;
	private active = new Map<
		string,
		{ record: Invocation; cancelled: boolean }
	>();
	readonly agent: string;
	private backend: Containment;
	private fault: FaultHook;
	private quiet?: string;
	constructor(
		agent: string,
		backend: Containment,
		fault: FaultHook = () => {},
		quiet?: string,
	) {
		this.agent = agent;
		this.backend = backend;
		this.fault = fault;
		this.quiet = quiet;
		this.path = join(agentDir(agent), "procs.json");
		this.journal = loadJson(this.path, () => ({ invocations: [], holds: {} }));
	}
	fenced(item?: string) {
		return Boolean(item && this.journal.holds[item]);
	}
	snapshot() {
		return structuredClone(this.journal);
	}
	beginHold(item: string, by: string, via: string) {
		if (
			this.journal.holds[item]?.state !== "recovery" &&
			this.journal.holds[item]
		)
			return this.journal.holds[item];
		this.journal.epochs ??= {};
		const holdEpoch =
			Math.max(
				this.journal.epochs[item] ?? 0,
				this.journal.holds[item]?.holdEpoch ?? 0,
			) + 1;
		this.journal.epochs[item] = holdEpoch;
		this.journal.holds[item] = { state: "holding", holdEpoch, by, via };
		saveJson(this.path, this.journal);
		return this.journal.holds[item];
	}
	async finishHold(item: string) {
		const hold = this.journal.holds[item];
		if (!hold) throw Error("hold fence missing");
		const records = this.journal.invocations.filter(
			(record) => record.item === item,
		);
		const units = records.map((record) => record.slice).join(", ");
		let empty = false;
		try {
			empty = await this.terminate({ item });
		} catch {
			queueInbox(this.agent, "escalation");
		}
		if (empty && this.backend.confirmed) {
			hold.state = "held";
			delete hold.reason;
		} else {
			hold.state = "holding";
			hold.reason = this.backend.confirmed
				? `Stop ${units} with systemctl --user stop <slice> and confirm cgroup.events populated 0 before editing; run durable hold --verify.`
				: "Containment unconfirmed. Force-stop Termux in Android Settings or reboot the device (cgroup v1 Linux: reboot) before editing. Stopping the steward and /proc inspection cannot establish ownership; writers with cwd / may be invisible.";
		}
		saveJson(this.path, this.journal);
		return structuredClone(hold);
	}
	async verifyHold(item: string, workspace?: string) {
		const hold = this.journal.holds[item];
		if (!hold) throw Error("item is not held");
		const records = this.journal.invocations.filter(
			(record) => record.item === item,
		);
		const confirmedEmpty =
			this.backend.confirmed &&
			(
				await Promise.all(records.map((record) => this.backend.empty(record)))
			).every(Boolean);
		if (confirmedEmpty && hold.state === "holding" && hold.reason) {
			hold.state = "held";
			delete hold.reason;
			saveJson(this.path, this.journal);
		}
		return {
			...hold,
			confirmedEmpty,
			slices: records.map((record) => record.slice),
			writers: workspace ? await workspaceWriters(workspace) : [],
			advisory:
				"cwd/open-file inspection cannot find future absolute-path writers with cwd /. Without cgroup v2 confirmation, force-stop Termux or reboot (cgroup v1 Linux: reboot) before editing.",
		};
	}
	releaseHold(item: string, epoch: number) {
		if (this.journal.holds[item]?.holdEpoch !== epoch)
			throw Error("hold epoch changed");
		delete this.journal.holds[item];
		saveJson(this.path, this.journal);
	}
	private async persist(
		record: Invocation,
		action: string,
		change: () => void,
	) {
		await this.fault(`before:${action}`, record);
		change();
		saveJson(this.path, this.journal);
		await this.fault(`after:${action}`, record);
	}
	private async cleanup(record: Invocation) {
		const active = this.active.get(record.invocationId);
		if (active) active.cancelled = true;
		await this.fault("before:kill", record);
		audit(this.agent, {
			event: "process-kill",
			invocationId: record.invocationId,
			state: record.state,
			item: record.item,
		});
		const empty = await this.backend.kill(record);
		await this.fault("after:kill", record);
		if (empty && this.backend.confirmed) {
			await this.persist(record, "delete", () => {
				this.journal.invocations = this.journal.invocations.filter(
					(r) => r.invocationId !== record.invocationId,
				);
			});
			return true;
		}
		if (record.item && !this.journal.holds[record.item])
			this.journal.holds[record.item] = {
				state: "recovery",
				holdEpoch: (this.journal.holds[record.item]?.holdEpoch ?? 0) + 1,
			};
		saveJson(this.path, this.journal);
		queueInbox(this.agent, "escalation");
		audit(this.agent, {
			event: "escalation",
			reason: "containment-unconfirmed",
			item: record.item,
			invocationId: record.invocationId,
		});
		return false;
	}
	/** Must finish before opening a scheduler, even for records still in intent. */
	async sweep() {
		let clean = true;
		for (const record of [...this.journal.invocations])
			if (!(await this.cleanup(record))) clean = false;
		return clean;
	}
	async terminate(
		filter: { item?: string; attemptId?: string; task?: string } = {},
	) {
		let clean = true;
		// Cancel even launches that are waiting immediately before their intent commit.
		for (const active of this.active.values())
			if (matches(active.record, filter)) active.cancelled = true;
		for (const record of [...this.journal.invocations]) {
			if (matches(record, filter) && !(await this.cleanup(record)))
				clean = false;
		}
		return clean;
	}
	/** Register a terminal-hosted gate before releasing any worker code. */
	async host<T>(
		command: string,
		env: NodeJS.ProcessEnv,
		opts: { item: string; attemptId: string },
		start: (argv: string[], env: NodeJS.ProcessEnv) => Promise<T>,
	): Promise<T> {
		if (this.fenced(opts.item) || disabled(this.agent, this.quiet))
			throw Error("host refused by safety fence");
		const invocationId = randomUUID();
		const label = createHash("sha256")
			.update(`${this.agent}:${opts.item}:${opts.attemptId}`)
			.digest("hex")
			.slice(0, 20);
		const record: Invocation = {
			invocationId,
			item: opts.item,
			attemptId: opts.attemptId,
			unit: `durable-${label}-${invocationId}.scope`,
			slice: `durable-${label}.slice`,
			marker: invocationId,
			state: "intent",
		};
		const directory = join(agentDir(this.agent), "gates", invocationId);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const token = randomBytes(32).toString("hex");
		const argv = [
			process.execPath,
			fileURLToPath(new URL("../../bin/durable-host-gate", import.meta.url)),
			directory,
			createHash("sha256").update(token).digest("hex"),
			resolveExecutable(command, env.PATH ?? ""),
		];
		const active = { record, cancelled: false };
		this.active.set(invocationId, active);
		const check = () => {
			if (
				active.cancelled ||
				this.fenced(opts.item) ||
				disabled(this.agent, this.quiet)
			)
				throw Error("host cancelled before gate release");
		};
		try {
			await this.persist(record, "intent", () =>
				this.journal.invocations.push(record),
			);
			check();
			const hosted = await start(
				this.backend.hostedArgv?.(record, argv) ?? argv,
				{
					...(this.backend.hostedEnv?.(env) ?? env),
					DURABLE_INVOCATION: record.marker,
				},
			);
			const deadline = Date.now() + 15000;
			const identityPath = join(directory, "identity.json");
			while (!existsSync(identityPath)) {
				check();
				if (Date.now() >= deadline) throw Error("host gate identity timed out");
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			const identity = JSON.parse(
				readFileSync(identityPath, "utf8"),
			) as Partial<Invocation>;
			if (
				!identity.pid ||
				!identity.startTime ||
				(this.backend.confirmed && !identity.cgroup?.includes(record.unit))
			)
				throw Error("host gate containment identity invalid");
			await this.persist(record, "registered", () =>
				Object.assign(record, {
					pid: identity.pid,
					pgid: identity.pgid,
					startTime: identity.startTime,
					cgroup: identity.cgroup,
					state: "registered",
				}),
			);
			await this.persist(record, "releasing", () => {
				record.state = "releasing";
			});
			check();
			writeFileSync(join(directory, "release.tmp"), token, {
				mode: 0o600,
				flag: "wx",
			});
			renameSync(join(directory, "release.tmp"), join(directory, "release"));
			await this.persist(record, "running", () => {
				record.state = "running";
			});
			return hosted;
		} catch (error) {
			await this.cleanup(record);
			throw error;
		} finally {
			this.active.delete(invocationId);
		}
	}
	async launch(
		argv: string[],
		env: NodeJS.ProcessEnv,
		opts: {
			item?: string;
			attemptId?: string;
			task?: string;
			allowWhenDisabled?: boolean;
		} = {},
	) {
		if (!argv.length || this.fenced(opts.item))
			throw Error("invocation refused: item fenced or empty command");
		const executable = resolveExecutable(argv[0], env.PATH ?? "");
		const invocationId = randomUUID();
		const attemptId = opts.attemptId ?? "steward";
		// Hash untrusted item/attempt labels; names are deterministic from the durable intent.
		const label = createHash("sha256")
			.update(`${this.agent}:${opts.item ?? "steward"}:${attemptId}`)
			.digest("hex")
			.slice(0, 20);
		const record: Invocation = {
			invocationId,
			attemptId,
			item: opts.item,
			task: opts.task,
			unit: `durable-${label}-${invocationId}.scope`,
			slice: `durable-${label}.slice`,
			marker: invocationId,
			state: "intent",
		};
		const token = randomBytes(32).toString("hex");
		const active = { record, cancelled: false };
		this.active.set(invocationId, active);
		const assertAllowed = () => {
			if (
				active.cancelled ||
				this.fenced(opts.item) ||
				(!opts.allowWhenDisabled && disabled(this.agent, this.quiet))
			)
				throw Error("invocation refused: cancelled, disabled or item fenced");
		};
		let launch: Launch | undefined;
		try {
			assertAllowed();
			await this.persist(record, "intent", () =>
				this.journal.invocations.push(record),
			);
			await this.fault("before:spawn", record);
			assertAllowed();
			launch = this.backend.spawn(
				record,
				createHash("sha256").update(token).digest("hex"),
				[executable, ...argv.slice(1)],
				env,
			);
			await this.fault("after:spawn", record);
			const identity = await launch.identity;
			assertAllowed();
			await this.persist(record, "registered", () => {
				Object.assign(record, identity, { state: "registered" });
			});
			await this.persist(record, "releasing", () => {
				record.state = "releasing";
			});
			await this.fault("before:token-write", record);
			assertAllowed();
			const release = launch.release;
			await new Promise<void>((resolve, reject) =>
				release.end(`${token}\n`, (error?: Error | null) =>
					error ? reject(error) : resolve(),
				),
			);
			await this.fault("after:token-write", record);
			await this.persist(record, "running", () => {
				record.state = "running";
			});
			const result = await launch.done;
			if ((await this.backend.empty(record)) && this.backend.confirmed)
				await this.persist(record, "delete", () => {
					this.journal.invocations = this.journal.invocations.filter(
						(r) => r.invocationId !== invocationId,
					);
				});
			return result;
		} catch (error) {
			launch?.release.destroy();
			await this.cleanup(record);
			throw error;
		} finally {
			this.active.delete(invocationId);
		}
	}
}
function matches(
	record: Invocation,
	filter: { item?: string; attemptId?: string; task?: string },
) {
	return Object.entries(filter).every(
		([key, value]) => record[key as keyof Invocation] === value,
	);
}
function resolveExecutable(command: string, path: string) {
	const choices = isAbsolute(command)
		? [command]
		: path
				.split(":")
				.filter(Boolean)
				.map((dir) => join(dir, command));
	for (const candidate of choices) {
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			/* Try the next PATH entry. */
		}
	}
	throw Error("executable not found in explicit environment");
}
